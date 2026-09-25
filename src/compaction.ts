import { z } from "zod";
import { check, digest, id, type Session } from "./core.js";
import type { Store } from "./store.js";
import type { Identity } from "./identity.js";
import type { Artifact, Artifacts } from "./workflow.js";
import type { Operation } from "./operations.js";
import type { ModelResponse, modelRequestSchema } from "./model-channel.js";
import { TokenCounter, type Tokenizer } from "./tokens.js";
export interface AuthoritativeState {
  goals: string[];
  constraints: string[];
  decisions: string[];
  findings: string[];
  artifacts: Record<string, string>;
  approvals: string[];
  pending: string[];
  policy: string;
  skills: Record<string, string>;
  stage: string;
}
export interface ContextState {
  session: string;
  capacity: number;
  reserved: number;
  used: number;
  exchange?: { id: string; reserved: number };
  failures: number;
  checkpoint?: string;
  paused: boolean;
  tokenizer?: Tokenizer;
  inference?: string;
  compacting?: string;
  requested?: boolean;
  history?: { checkpoint: string; prefix: string[] };
  optionalMessages?: string[];
  calls?: Record<
    string,
    { tool: string; arguments: string; reserved: number; result?: string }
  >;
  measured?: {
    input: number;
    output: number;
    providerInput?: number;
    providerOutput?: number;
  };
}
const checkpointSchema = z
  .object({
    state: z
      .object({
        goals: z.array(z.string()),
        constraints: z.array(z.string()),
        decisions: z.array(z.string()),
        findings: z.array(z.string()),
        artifacts: z.record(z.string()),
        approvals: z.array(z.string()),
        pending: z.array(z.string()),
        policy: z.string(),
        skills: z.record(z.string()),
        stage: z.string(),
      })
      .strict(),
    segments: z
      .array(
        z
          .object({
            text: z.string().max(16000),
            sources: z.array(z.string()),
            trust: z.literal("untrusted"),
          })
          .strict(),
      )
      .max(128),
  })
  .strict();
export type Checkpoint = z.infer<typeof checkpointSchema> & {
  id: string;
  session: string;
  repository: string;
  created: number;
};
export class Compaction {
  private counter = new TokenCounter();
  private invalidate: (session: string, reason: string) => void;
  constructor(
    readonly store: Store,
    readonly identity: Identity,
    readonly artifacts: Artifacts,
  ) {
    this.invalidate = (session) => {
      const scope = identity.session(session);
      scope.status = "paused";
      identity.saveSession(scope);
    };
  }
  setInvalidator(invalidate: (session: string, reason: string) => void) {
    this.invalidate = invalidate;
  }
  close() {
    this.counter.close();
  }
  private current(scope: Session) {
    const session = this.identity.session(scope.session);
    check(
      session.repository === scope.repository &&
        session.generation === scope.generation &&
        session.status === "active",
      "context_authority_changed",
    );
  }
  configure(scope: Session, capacity: number, reserved = 8192) {
    check(
      Number.isInteger(capacity) &&
        capacity >= 1024 &&
        Number.isInteger(reserved) &&
        reserved > 0 &&
        reserved < capacity,
      "context_capacity",
    );
    const existing = this.store.get<ContextState>("context", scope.session);
    const value: ContextState = {
      session: scope.session,
      used: 0,
      failures: 0,
      paused: false,
      ...existing,
      capacity,
      reserved,
    };
    this.store.put(
      "context",
      scope.session,
      value,
      scope.repository,
      scope.session,
    );
    return value;
  }
  context(scope: Session) {
    const c = this.store.get<ContextState>("context", scope.session);
    check(
      c && this.identity.session(scope.session).repository === scope.repository,
      "context_not_configured",
    );
    return c;
  }
  authoritative(scope: Session): AuthoritativeState {
    const root = this.identity.session(scope.root),
      base = this.store.get<
        Pick<
          AuthoritativeState,
          "goals" | "constraints" | "decisions" | "findings"
        >
      >("authority", scope.root) ?? {
        goals: [],
        constraints: [],
        decisions: [],
        findings: [],
      };
    const artifacts = this.store
      .list<Artifact>("artifact", scope.repository)
      .filter(
        (a) =>
          a.valid &&
          (a.session === scope.session || a.sharedWith.includes(scope.session)),
      );
    return {
      ...base,
      artifacts: Object.fromEntries(artifacts.map((a) => [a.id, a.hash])),
      approvals: this.store
        .list<{ id: string; valid: boolean; session: string }>(
          "action-approval",
          scope.repository,
        )
        .filter((a) => a.valid && a.session === scope.root)
        .map((a) => a.id)
        .sort(),
      pending: this.store
        .list<Operation>("operation", scope.repository, scope.session)
        .filter(
          (o) =>
            !["completed", "failed", "cancelled"].includes(o.status) &&
            o.tool !== "compact",
        )
        .map((o) => o.id)
        .sort(),
      policy: root.policy,
      skills: scope.skills,
      stage: root.stage,
    };
  }
  budget(scope: Session) {
    const c = this.context(scope),
      ratio = c.used / (c.capacity - c.reserved);
    return {
      used: c.used,
      usable: c.capacity - c.reserved,
      reserved: c.reserved,
      requestCompaction: ratio >= 0.7,
      admitOptional: ratio < 0.9 && !c.paused,
      pause: c.paused || c.used >= c.capacity - c.reserved,
      incompleteExchange:
        !!c.exchange ||
        !!c.inference ||
        !!c.compacting ||
        Object.values(c.calls ?? {}).some((call) => !call.result),
    };
  }
  measure(value: unknown, tokenizer: Tokenizer, ceiling: number) {
    return this.counter.count(value, tokenizer, ceiling);
  }
  request(scope: Session) {
    this.current(scope);
    const c = this.context(scope);
    c.requested = true;
    this.saveContext(scope, c);
    return { requested: true, when: "after_tool_results" };
  }
  startCompaction(scope: Session, operation: string) {
    this.current(scope);
    check(!this.budget(scope).incompleteExchange, "tool_exchange_incomplete");
    const c = this.context(scope);
    check(!c.paused, "context_paused");
    c.compacting = operation;
    this.saveContext(scope, c);
  }
  endCompaction(scope: Session, operation: string) {
    const c = this.context(scope);
    if (c.compacting === operation) {
      delete c.compacting;
      this.saveContext(scope, c);
    }
  }
  async beginModel(
    scope: Session,
    operation: string,
    input: z.infer<typeof modelRequestSchema>,
    profile: {
      tokenizer: Tokenizer;
      contextWindow: number;
      maxOutputTokens: number;
    },
  ) {
    this.current(scope);
    const snapshot = this.context(scope);
    check(!this.budget(scope).incompleteExchange, "tool_exchange_incomplete");
    const measured =
      (await this.counter.count(
        { messages: input.messages, tools: input.tools },
        profile.tokenizer,
        Math.min(snapshot.capacity, profile.contextWindow),
      )) +
      256 +
      input.messages.length * 16;
    const result = this.store.transaction(() => {
      this.current(scope);
      const c = this.context(scope);
      check(
        c.capacity === snapshot.capacity && c.reserved === snapshot.reserved,
        "context_configuration_changed",
      );
      check(!this.budget(scope).incompleteExchange, "tool_exchange_incomplete");
      check(!c.paused, "context_paused");
      c.tokenizer = profile.tokenizer;
      c.capacity = Math.min(c.capacity, profile.contextWindow);
      const used = Math.max(c.used, measured),
        usable = c.capacity - c.reserved;
      const optional = [
        ...new Set(
          input.messages.filter((m) => m.role === "user").map((m) => digest(m)),
        ),
      ];
      const addsOptional = optional.some(
        (hash) => !c.optionalMessages?.includes(hash),
      );
      if (addsOptional && used >= usable * 0.9) {
        this.store.audit(
          "context.optional_stopped",
          { operation, measured, usable },
          scope.repository,
          scope.session,
        );
        return { error: "optional_context_stopped" };
      }
      const output = Math.min(
        input.max_completion_tokens ??
          input.max_tokens ??
          profile.maxOutputTokens,
        profile.maxOutputTokens,
        usable - used,
      );
      if (output < 256) {
        c.paused = true;
        this.saveContext(scope, c);
        this.invalidate(scope.session, "context_unavailable");
        return { error: "model_context_unavailable" };
      }
      c.used = used;
      c.inference = operation;
      c.optionalMessages = [
        ...new Set([...(c.optionalMessages ?? []), ...optional]),
      ];
      c.measured = { input: measured, output: 0 };
      this.saveContext(scope, c);
      this.store.audit(
        "context.model_admitted",
        { operation, input: measured, output, tokenizer: c.tokenizer },
        scope.repository,
        scope.session,
      );
      return { output };
    });
    check(!result.error, result.error ?? "model_context_unavailable");
    return result.output!;
  }
  async finishModel(
    scope: Session,
    operation: string,
    response: ModelResponse,
  ) {
    this.current(scope);
    const snapshot = this.context(scope);
    check(snapshot.inference === operation, "context_inference_identity");
    const output = await this.counter.count(
      response.choices[0]!.message,
      snapshot.tokenizer ?? "o200k_base",
      snapshot.capacity,
    );
    const outcome = this.store.transaction(() => {
      this.current(scope);
      const c = this.context(scope);
      check(
        c.capacity === snapshot.capacity &&
          c.reserved === snapshot.reserved &&
          c.tokenizer === snapshot.tokenizer,
        "context_configuration_changed",
      );
      check(c.inference === operation, "context_inference_identity");
      const message = response.choices[0]!.message;
      const calls = message.tool_calls ?? [];
      check(
        new Set(calls.map((call) => call.id)).size === calls.length,
        "model_tool_call_duplicate",
      );
      c.calls = Object.create(null) as NonNullable<ContextState["calls"]>;
      for (const call of calls) {
        check(
          !this.store.get(
            "context-tool-result",
            digest([scope.session, call.id]),
          ),
          "model_tool_call_duplicate",
        );
        const wrapper = JSON.parse(call.function.arguments);
        check(typeof wrapper.input === "string", "model_tool_arguments");
        const args = JSON.parse(wrapper.input);
        check(
          args && typeof args === "object" && !Array.isArray(args),
          "model_tool_arguments",
        );
        c.calls[call.id] = {
          tool: call.function.name.slice("harness_".length),
          arguments: digest(args),
          reserved: Math.floor(c.reserved / calls.length),
        };
      }
      c.used =
        Math.max(c.used, response.usage?.prompt_tokens ?? 0) +
        Math.max(output, response.usage?.completion_tokens ?? 0);
      c.measured = {
        input: c.measured!.input,
        output,
        providerInput: response.usage?.prompt_tokens,
        providerOutput: response.usage?.completion_tokens,
      };
      delete c.inference;
      this.saveContext(scope, c);
      this.store.audit(
        "context.model_observed",
        { operation, ...c.measured, used: c.used },
        scope.repository,
        scope.session,
      );
      if (c.used >= c.capacity) {
        c.paused = true;
        this.saveContext(scope, c);
        this.invalidate(scope.session, "context_unavailable");
        return false;
      }
      return true;
    });
    check(outcome, "model_context_unavailable");
  }
  endModel(scope: Session, operation: string) {
    const c = this.context(scope);
    if (c.inference === operation) {
      delete c.inference;
      this.saveContext(scope, c);
    }
  }
  claimTool(scope: Session, call: string, tool: string, args: unknown) {
    this.current(scope);
    const c = this.context(scope);
    check(
      !c.compacting && !c.inference && !c.paused,
      "tool_exchange_incomplete",
    );
    const expected =
      c.calls && Object.hasOwn(c.calls, call) ? c.calls[call] : undefined;
    const replay = this.store.get<{ tool: string; arguments: string }>(
      "context-tool-result",
      digest([scope.session, call]),
    );
    const bound = expected ?? replay;
    check(bound, "tool_exchange_unknown");
    check(
      bound.tool === tool && bound.arguments === digest(args),
      "tool_exchange_identity",
    );
    return { allowed: true };
  }
  async completeTool(
    scope: Session,
    call: string,
    tool: string,
    args: unknown,
    output: unknown,
  ) {
    this.current(scope);
    const snapshot = this.context(scope);
    const expectedCall =
      snapshot.calls && Object.hasOwn(snapshot.calls, call)
        ? snapshot.calls[call]
        : undefined;
    if (expectedCall)
      check(
        expectedCall.tool === tool && expectedCall.arguments === digest(args),
        "tool_exchange_identity",
      );
    const valueHash = digest(output),
      key = digest([scope.session, call]);
    const replay = this.store.get<{
      hash: string;
      output: unknown;
      tool: string;
      arguments: string;
    }>("context-tool-result", key);
    if (replay) {
      check(
        replay.tool === tool && replay.arguments === digest(args),
        "tool_exchange_identity",
      );
      check(replay.hash === valueHash, "tool_result_conflict");
      return replay.output;
    }
    const allowance =
      expectedCall?.reserved ?? Math.min(2048, snapshot.reserved);
    const encoding = snapshot.tokenizer ?? "o200k_base";
    const measured = await this.counter.count(output, encoding, allowance);
    const result = this.store.transaction(() => {
      this.current(scope);
      const c = this.context(scope),
        expected =
          c.calls && Object.hasOwn(c.calls, call) ? c.calls[call] : undefined;
      check(
        c.capacity === snapshot.capacity &&
          c.reserved === snapshot.reserved &&
          c.tokenizer === snapshot.tokenizer &&
          expected?.reserved === expectedCall?.reserved,
        "context_exchange_changed",
      );
      if (expected)
        check(
          expected.tool === tool && expected.arguments === digest(args),
          "tool_exchange_identity",
        );
      const prior = this.store.get<{
        hash: string;
        output: unknown;
        tool: string;
        arguments: string;
      }>("context-tool-result", key);
      if (prior) {
        check(
          prior.tool === tool && prior.arguments === digest(args),
          "tool_exchange_identity",
        );
        check(prior.hash === valueHash, "tool_result_conflict");
        return { output: prior.output };
      }
      let bounded = output;
      let count = measured;
      if (measured > allowance) {
        const value = output as {
          id?: string;
          hash?: string;
          content?: string;
        } | null;
        let original: Artifact | undefined;
        if (
          value &&
          typeof value.id === "string" &&
          typeof value.content === "string"
        ) {
          try {
            const candidate = this.artifacts.get(scope, value.id);
            if (
              candidate.hash === value.hash &&
              candidate.content === value.content
            )
              original = candidate;
          } catch {
            /* Unrecognized references remain untrusted output only. */
          }
        }
        const artifact = this.artifacts.create(scope, {
          kind: "tool-output",
          content: JSON.stringify(output),
          sources: original ? [original.id] : [],
          dependencies: original?.valid ? [original.id] : [],
        });
        // Preserve an artifact's own ID when its content is too large to echo.
        const metadata = original
          ? { id: original.id, hash: original.hash, kind: original.kind }
          : {};
        bounded = {
          ...metadata,
          outputArtifact: artifact.id,
          outputHash: artifact.hash,
          trust: "untrusted",
          truncated: true,
        };
        // The small reference uses a conservative byte count without another
        // CPU job or an asynchronous database transaction.
        count = Buffer.byteLength(JSON.stringify(bounded));
      }
      if (count > allowance || c.used + count > c.capacity) {
        c.paused = true;
        this.saveContext(scope, c);
        this.invalidate(scope.session, "context_unavailable");
        return { error: "tool_context_unavailable" };
      }
      c.used += count;
      if (expected) expected.result = valueHash;
      this.saveContext(scope, c);
      this.store.put(
        "context-tool-result",
        key,
        { hash: valueHash, output: bounded, tool, arguments: digest(args) },
        scope.repository,
        scope.session,
      );
      this.store.audit(
        "context.tool_completed",
        {
          call,
          tool,
          tokens: count,
          hash: valueHash,
          truncated: bounded !== output,
        },
        scope.repository,
        scope.session,
      );
      return { output: bounded };
    });
    check(!result.error, result.error ?? "tool_context_unavailable");
    return result.output;
  }
  private saveContext(scope: Session, context: ContextState) {
    this.store.put(
      "context",
      scope.session,
      context,
      scope.repository,
      scope.session,
    );
  }
  addOptional(scope: Session, tokens: number) {
    check(Number.isInteger(tokens) && tokens >= 0, "context_tokens");
    return this.store.transaction(() => {
      const c = this.context(scope);
      check(
        this.budget(scope).admitOptional &&
          c.used + tokens <= 0.9 * (c.capacity - c.reserved),
        "optional_context_stopped",
      );
      c.used += tokens;
      this.store.put(
        "context",
        scope.session,
        c,
        scope.repository,
        scope.session,
      );
      return this.budget(scope);
    });
  }
  startExchange(scope: Session, call: string, reserved: number) {
    this.store.transaction(() => {
      const c = this.context(scope);
      check(!c.exchange, "tool_exchange_incomplete");
      check(
        !c.paused &&
          reserved > 0 &&
          reserved <= c.reserved &&
          c.used + reserved <= c.capacity,
        "tool_context_unavailable",
      );
      c.exchange = { id: call, reserved };
      this.store.put(
        "context",
        scope.session,
        c,
        scope.repository,
        scope.session,
      );
    });
  }
  finishExchange(scope: Session, call: string, output: string) {
    return this.store.transaction(() => {
      const c = this.context(scope);
      check(c.exchange?.id === call, "tool_exchange_identity");
      const estimate = Math.ceil(Buffer.byteLength(output) / 3);
      let result: unknown = output;
      if (estimate > c.exchange.reserved) {
        const a = this.artifacts.create(scope, {
          kind: "tool-output",
          content: output,
          dependencies: [],
          sources: [],
        });
        result = {
          artifact: a.id,
          hash: a.hash,
          bytes: Buffer.byteLength(output),
          trust: a.trust,
        };
      }
      c.used += Math.min(estimate, c.exchange.reserved);
      delete c.exchange;
      if (c.used >= c.capacity - c.reserved) c.paused = true;
      this.store.put(
        "context",
        scope.session,
        c,
        scope.repository,
        scope.session,
      );
      return result;
    });
  }
  accept(
    scope: Session,
    input: unknown,
    automatic?: {
      operation: string;
      prefix: string[];
      used: number;
      capacity: number;
      reserved: number;
      tokenizer: Tokenizer;
    },
  ): Checkpoint {
    const context = this.context(scope);
    if (automatic) {
      this.current(scope);
      check(
        context.compacting === automatic.operation &&
          !context.exchange &&
          !context.inference &&
          !Object.values(context.calls ?? {}).some((call) => !call.result),
        "tool_exchange_incomplete",
      );
      check(
        context.capacity === automatic.capacity &&
          context.reserved === automatic.reserved,
        "context_configuration_changed",
      );
    } else
      check(!this.budget(scope).incompleteExchange, "tool_exchange_incomplete");
    try {
      return this.store.transaction(() => {
        const candidate = checkpointSchema.parse(input),
          state = this.authoritative(scope);
        check(
          digest(candidate.state) === digest(state),
          "checkpoint_state_mismatch",
        );
        const sources = new Set<string>();
        for (const segment of candidate.segments) {
          for (const source of segment.sources) {
            this.artifacts.source(scope, source);
            sources.add(source);
          }
        }
        const previous = context.checkpoint
          ? this.get(scope, context.checkpoint)
          : undefined;
        for (const source of previous?.segments.flatMap((s) => s.sources) ?? [])
          check(sources.has(source), "checkpoint_lineage_missing");
        for (const artifact of Object.keys(state.artifacts)) {
          const a = this.artifacts.get(scope, artifact);
          for (const source of a.sources)
            check(sources.has(source), "checkpoint_lineage_missing");
        }
        const checkpoint: Checkpoint = {
          ...candidate,
          id: id(),
          session: scope.session,
          repository: scope.repository,
          created: this.store.clock.now(),
        };
        const size =
          automatic?.used ?? Buffer.byteLength(JSON.stringify(checkpoint));
        check(
          size < 0.7 * (context.capacity - context.reserved),
          "checkpoint_too_large",
        );
        this.store.put(
          "checkpoint",
          checkpoint.id,
          checkpoint,
          scope.repository,
          scope.session,
        );
        context.checkpoint = checkpoint.id;
        context.failures = 0;
        context.paused = false;
        context.used = size;
        context.requested = false;
        if (automatic) {
          context.history = {
            checkpoint: checkpoint.id,
            prefix: automatic.prefix,
          };
          context.tokenizer = automatic.tokenizer;
        } else if (context.history) context.history.checkpoint = checkpoint.id;
        this.store.put(
          "context",
          scope.session,
          context,
          scope.repository,
          scope.session,
        );
        this.store.audit(
          "context.compacted",
          {
            checkpoint: checkpoint.id,
            stateHash: digest(state),
            lineage: [...sources],
          },
          scope.repository,
          scope.session,
        );
        return checkpoint;
      });
    } catch (error) {
      if (!automatic) this.failed(scope, error);
      throw error;
    }
  }
  failed(scope: Session, error: unknown) {
    this.store.transaction(() => {
      const latest = this.context(scope);
      latest.failures++;
      if (latest.failures >= 2) {
        latest.paused = true;
        this.invalidate(scope.session, "compaction_failed");
      }
      this.store.put(
        "context",
        scope.session,
        latest,
        scope.repository,
        scope.session,
      );
      this.store.audit(
        "context.compaction_failed",
        {
          attempt: latest.failures,
          paused: latest.paused,
          error: String(error),
        },
        scope.repository,
        scope.session,
      );
    });
  }
  get(scope: Session, key: string) {
    const c = this.store.get<Checkpoint>("checkpoint", key);
    check(
      c && c.repository === scope.repository && c.session === scope.session,
      "checkpoint_not_found",
    );
    return c;
  }
}
