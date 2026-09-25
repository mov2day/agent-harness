import { z } from "zod";
import {
  check,
  digest,
  hash,
  id,
  type Session,
  type Role,
  type Stage,
} from "./core.js";
import type { Store } from "./store.js";
import type { Identity, Capability } from "./identity.js";
import type { Policies } from "./policy.js";
import { DenialMonitor } from "./monitoring.js";
import { modelRequestSchema } from "./model-channel.js";
import { delegateSchema } from "./specialists.js";
const path = z.string().min(1).max(2048);
export const toolSchemas = {
  model: z.object({ request: modelRequestSchema }).strict(),
  read: z.object({ path }).strict(),
  change: z
    .object({
      path,
      base: z.string().nullable(),
      content: z.string().max(2_000_000),
      approval: z.string(),
    })
    .strict(),
  delete: z.object({ path, base: z.string(), approval: z.string() }).strict(),
  rename: z
    .object({ path, to: path, base: z.string(), approval: z.string() })
    .strict(),
  research: z.object({ url: z.string().url().max(4096) }).strict(),
  execute: z
    .object({
      executable: z.string(),
      args: z.array(z.string()).max(128),
      env: z.record(z.string()),
      cwd: path,
      snapshot: z.string(),
      approval: z.string(),
    })
    .strict(),
  delegate: delegateSchema,
  artifact: z.union([
    z.object({ action: z.literal("snapshot") }).strict(),
    z
      .object({
        action: z.literal("create").optional(),
        kind: z.string(),
        content: z.string().max(2_000_000),
        dependencies: z.array(z.string()),
        trust: z.literal("untrusted"),
        sources: z.array(z.string()),
        shareWithRoot: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        action: z.enum(["get", "invalidate", "submit", "evidence"]),
        id: z.string(),
      })
      .strict(),
    z
      .object({
        action: z.literal("share"),
        id: z.string(),
        session: z.string(),
      })
      .strict(),
  ]),
  review: z
    .object({
      kind: z.enum(["stage", "change"]).optional(),
      artifact: z.string(),
      findings: z.array(
        z.object({ message: z.string(), blocking: z.boolean() }).strict(),
      ),
    })
    .strict(),
  compact: z.union([
    z.object({ checkpoint: z.unknown() }).strict(),
    z.object({ action: z.enum(["context", "request"]) }).strict(),
    z.object({ action: z.literal("get"), id: z.string() }).strict(),
  ]),
  learn: z.object({ candidate: z.unknown() }).strict(),
};
export type Tool = keyof typeof toolSchemas;
const permissions: Record<Role, Tool[]> = {
  Conductor: ["delegate", "artifact", "compact", "learn", "model"],
  Researcher: ["read", "research", "artifact", "compact", "model"],
  Planner: ["read", "artifact", "compact", "model"],
  Implementer: [
    "read",
    "change",
    "delete",
    "rename",
    "artifact",
    "compact",
    "model",
  ],
  Reviewer: ["read", "review", "artifact", "compact", "learn", "model"],
  Verifier: ["read", "execute", "artifact", "compact", "model"],
};
const toolStages: Partial<Record<Tool, Stage[]>> = {
  research: ["research"],
  change: ["implementation"],
  delete: ["implementation"],
  rename: ["implementation"],
  execute: ["execution", "verification"],
};
export interface Operation {
  id: string;
  key: string;
  requestHash: string;
  session: string;
  repository: string;
  generation: number;
  tool: Tool;
  args: Record<string, any>;
  policy: string;
  expires: number;
  status:
    | "intent"
    | "running"
    | "admitted"
    | "completed"
    | "cancelled"
    | "failed"
    | "requires_reconciliation";
  invalidated?: {
    reason: string;
    time: number;
    outcome:
      | "cancelled_without_effects"
      | "partially_completed"
      | "completed_before_invalidation"
      | "requires_reconciliation";
  };
  result?: unknown;
  error?: string;
  worker?: {
    container: string;
    image: string;
    snapshot: string;
    admitted: boolean;
  };
  created: number;
}
export interface ActionApproval {
  id: string;
  repository: string;
  session: string;
  action: string;
  policy: string;
  human: boolean;
  valid: boolean;
  dependencies: string[];
}
export class Operations {
  readonly monitor: DenialMonitor;
  private aborts = new Map<string, AbortController>();
  private cancelHooks = new Map<string, () => Promise<boolean>>();
  private invalidationListeners = new Set<
    (sessions: ReadonlySet<string>, reason: string) => void
  >();
  onInvalidation(
    listener: (sessions: ReadonlySet<string>, reason: string) => void,
  ) {
    this.invalidationListeners.add(listener);
  }
  constructor(
    readonly store: Store,
    readonly identity: Identity,
    readonly policies: Policies,
    private health: (session: Session) => boolean,
  ) {
    this.monitor = new DenialMonitor(store);
    store.onAuditFailure(() => {
      for (const controller of this.aborts.values())
        controller.abort(new Error("required_audit_failed"));
      for (const cancel of this.cancelHooks.values())
        void cancel().catch((error) =>
          process.stderr.write(
            `Cancellation after audit failure: ${String(error)}\n`,
          ),
        );
    });
    identity.hooks(
      (session, reason) => this.invalidate(session, reason),
      (session) => session.enforcement === "unverified" || this.health(session),
      (session, expires) => this.extend(session, expires),
    );
    policies.setInvalidator((repository) => {
      for (const s of store
        .list<Session>("session", repository)
        .filter((s) => !s.parent && s.status !== "terminated"))
        this.invalidate(s.session, "policy_changed");
    });
  }
  begin(
    token: string,
    connection: string,
    input: { tool: string; args: unknown; idempotencyKey: string },
  ): Operation {
    let session: Session | undefined;
    try {
      this.store.assertHealthy();
      // Authentication can invalidate expired authority. Keep that durable change
      // outside the transaction whose failed admission must be rolled back.
      session = this.identity.authenticate(token, connection);
      return this.store.transaction(() => {
        session = this.identity.authenticate(token, connection);
        check(
          input.idempotencyKey.length > 0 && input.idempotencyKey.length <= 128,
          "idempotency_key",
        );
        check(Object.hasOwn(toolSchemas, input.tool), "tool_unlisted");
        const tool = input.tool as Tool,
          args = toolSchemas[tool].parse(input.args) as Record<string, any>,
          key = digest([session.session, input.idempotencyKey]),
          requestHash = digest({ tool, args });
        const existing = this.store.get<Operation>("operation", key);
        if (existing) {
          check(existing.requestHash === requestHash, "idempotency_conflict");
          return existing;
        }
        this.authorize(session, tool, args);
        const c = this.store.get<Capability>("capability", hash(token))!;
        const operation: Operation = {
          id: id(),
          key,
          requestHash,
          session: session.session,
          repository: session.repository,
          generation: session.generation,
          tool,
          args,
          policy: session.policy,
          expires: c.expires,
          status: "intent",
          created: this.store.clock.now(),
        };
        this.save(operation);
        this.store.audit(
          "operation.intent",
          {
            id: operation.id,
            tool,
            requestHash,
            policy: operation.policy,
            rules: this.policies.effective(session.repository).rules,
          },
          session.repository,
          session.session,
        );
        return operation;
      });
    } catch (error) {
      if (session) {
        if (opExpired(error))
          this.invalidate(session.session, "capability_expired");
        this.monitor.record(
          session,
          error instanceof Error ? error.message : "denied",
        );
      }
      throw error;
    }
  }
  authorize(s: Session, tool: Tool, args: Record<string, any>) {
    this.store.assertHealthy();
    check(
      s.status === "active" && s.enforcement === "enforced" && this.health(s),
      "enforcement_unhealthy",
    );
    const e = this.policies.effective(s.repository);
    check(e.id === s.policy, "policy_changed");
    check(permissions[s.role].includes(tool), "role_authority");
    check(e.policy.tools.includes(tool), "policy_tool_denied");
    if (tool === "model")
      check(
        s.model &&
          args.request.model === s.model.model &&
          (!args.request.reasoning_effort ||
            args.request.reasoning_effort === s.model.reasoning),
        "model_override_denied",
      );
    const root = this.identity.session(s.root);
    check(root.status === "active", "root_inactive");
    if (toolStages[tool])
      check(toolStages[tool]!.includes(root.stage), "wrong_stage");
    if (args.path) check(this.policies.path(e, args.path), "path_denied");
    if (args.to) check(this.policies.path(e, args.to), "path_denied");
    if (tool === "delete") check(e.policy.deletion, "deletion_disabled");
    if (tool === "research") {
      const url = new URL(args.url);
      check(e.policy.domains.includes(url.hostname), "domain_denied");
    }
    if (tool === "execute")
      check(
        e.policy.commands.some(
          (c) =>
            digest(c) ===
            digest({
              executable: args.executable,
              args: args.args,
              env: args.env,
              cwd: args.cwd,
            }),
        ),
        "command_denied",
      );
    if (["change", "delete", "rename", "execute"].includes(tool)) {
      const approval = this.store.get<ActionApproval>(
        "action-approval",
        args.approval,
      );
      check(
        approval?.valid &&
          approval.repository === s.repository &&
          approval.session === s.root &&
          approval.policy === e.id &&
          approval.action === this.actionHash(tool, args),
        "review_required",
      );
      if (
        tool === "delete" ||
        tool === "rename" ||
        (tool === "change" && e.policy.humanGates.includes("implementation"))
      )
        check(approval.human, "human_approval_required");
      for (const dependency of approval.dependencies)
        check(
          this.store.get<{ valid: boolean }>("artifact", dependency)?.valid,
          "approval_dependency_stale",
        );
    }
    return e;
  }
  actionHash(tool: string, args: Record<string, unknown>) {
    return digest({ tool, args: { ...args, approval: undefined } });
  }
  save(op: Operation) {
    this.store.put("operation", op.key, op, op.repository, op.session);
  }
  current(op: Operation): Operation {
    const fresh = this.store.get<Operation>("operation", op.key);
    check(fresh, "operation_unknown");
    return fresh;
  }
  validate(op: Operation) {
    this.store.assertHealthy();
    const current = this.current(op),
      s = this.identity.session(op.session);
    check(
      !current.invalidated &&
        s.generation === current.generation &&
        current.expires > this.store.clock.now(),
      "operation_authority_lost",
    );
    check(
      !["cancelled", "failed", "completed", "requires_reconciliation"].includes(
        current.status,
      ),
      "operation_terminal",
    );
    this.authorize(s, current.tool, current.args);
    return current;
  }
  async run(
    op: Operation,
    effect: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<Operation> {
    if (op.status !== "intent") return op;
    this.store.transaction(() => {
      op = this.validate(op);
      check(op.status === "intent", "operation_running");
      op.status = "running";
      this.save(op);
      this.store.audit(
        "operation.started",
        { id: op.id },
        op.repository,
        op.session,
      );
    });
    const controller = new AbortController();
    this.aborts.set(op.id, controller);
    const deadline =
      op.created + this.policies.effective(op.repository).policy.timeoutMs;
    let timer: ReturnType<typeof setTimeout>;
    const armDeadline = () => {
      const current = this.current(op),
        now = this.store.clock.now();
      if (current.invalidated) return;
      if (now >= deadline || now >= current.expires) {
        this.invalidate(
          op.session,
          now >= deadline ? "operation_timeout" : "capability_expired",
        );
        return;
      }
      timer = setTimeout(
        armDeadline,
        Math.max(1, Math.min(deadline, current.expires) - now),
      );
      timer.unref();
    };
    armDeadline();
    try {
      const result = await effect(controller.signal);
      this.store.transaction(() => {
        if (this.store.fault)
          this.invalidate(op.session, "required_audit_failed");
        op = this.current(op);
        op.result = result;
        if (op.invalidated) {
          op.status = "requires_reconciliation";
          op.invalidated.outcome = "partially_completed";
        } else if (op.expires <= this.store.clock.now()) {
          this.invalidate(op.session, "capability_expired");
          op = this.current(op);
          op.result = result;
          op.status = "requires_reconciliation";
        } else op.status = "completed";
        this.save(op);
        this.store.audit(
          "operation.outcome",
          { id: op.id, status: op.status, invalidated: op.invalidated },
          op.repository,
          op.session,
        );
      });
    } catch (error) {
      this.store.transaction(() => {
        if (this.store.fault)
          this.invalidate(op.session, "required_audit_failed");
        op = this.current(op);
        op.error = String(error);
        if (
          op.status === "admitted" ||
          op.worker ||
          op.invalidated?.outcome === "requires_reconciliation"
        ) {
          op.status = "requires_reconciliation";
        } else {
          op.status = op.invalidated ? "cancelled" : "failed";
          if (op.invalidated)
            op.invalidated.outcome = "cancelled_without_effects";
        }
        this.save(op);
        this.store.audit(
          "operation.outcome",
          {
            id: op.id,
            status: op.status,
            error: op.error,
            invalidated: op.invalidated,
          },
          op.repository,
          op.session,
        );
      });
    } finally {
      clearTimeout(timer!);
      this.aborts.delete(op.id);
      this.cancelHooks.delete(op.id);
    }
    return this.current(op);
  }
  /** No await between final admission and the synchronous filesystem effect. Invalidation uses the same event-loop writer. */
  commit<T>(op: Operation, effect: () => T): T {
    this.store.transaction(() => {
      const current = this.validate(op);
      current.status = "admitted";
      this.save(current);
      this.store.audit(
        "operation.mutation_admitted",
        { id: op.id },
        op.repository,
        op.session,
      );
    });
    return effect();
  }
  onCancel(op: Operation, fn: () => Promise<boolean>) {
    this.cancelHooks.set(op.id, fn);
  }
  invalidate(sessionId: string, reason: string) {
    const cancelling: Operation[] = [];
    this.store.transaction(() => {
      const all = this.store.list<Session>("session"),
        affected = new Set([sessionId]);
      for (let changed = true; changed;) {
        changed = false;
        for (const s of all)
          if (s.parent && affected.has(s.parent) && !affected.has(s.session)) {
            affected.add(s.session);
            changed = true;
          }
      }
      for (const s of all.filter((s) => affected.has(s.session))) {
        s.generation++;
        s.status = reason === "session_terminated" ? "terminated" : "paused";
        this.identity.saveSession(s);
        this.identity.revokeTokens(s.session);
        for (const op of this.store.list<Operation>(
          "operation",
          s.repository,
          s.session,
        )) {
          if (op.invalidated) continue;
          if (op.status === "completed") {
            op.invalidated = {
              reason,
              time: this.store.clock.now(),
              outcome: "completed_before_invalidation",
            };
            this.save(op);
            continue;
          }
          if (["failed", "cancelled"].includes(op.status)) continue;
          const noEffects = op.status === "intent";
          op.invalidated = {
            reason,
            time: this.store.clock.now(),
            outcome: noEffects
              ? "cancelled_without_effects"
              : "requires_reconciliation",
          };
          op.status = noEffects ? "cancelled" : "requires_reconciliation";
          this.save(op);
          cancelling.push(op);
        }
        this.store.audit(
          "authority.invalidated",
          { reason, generation: s.generation },
          s.repository,
          s.session,
        );
      }
      for (const listener of this.invalidationListeners)
        listener(affected, reason);
    });
    for (const op of cancelling) {
      this.aborts.get(op.id)?.abort(new Error(reason));
      const cancel = this.cancelHooks.get(op.id);
      if (cancel)
        void cancel().then(
          (ok) => {
            if (!ok)
              this.store.audit(
                "operation.cancellation_failed",
                { id: op.id },
                op.repository,
                op.session,
              );
          },
          (error) =>
            this.store.audit(
              "operation.cancellation_failed",
              { id: op.id, error: String(error) },
              op.repository,
              op.session,
            ),
        );
    }
  }
  extend(s: Session, expires: number) {
    for (const op of this.store.list<Operation>(
      "operation",
      s.repository,
      s.session,
    )) {
      if (
        !["intent", "running", "admitted"].includes(op.status) ||
        op.invalidated
      )
        continue;
      this.authorize(s, op.tool, op.args);
      op.expires = expires;
      this.save(op);
    }
  }
  sweep() {
    for (const session of this.store.list<Session>("session")) {
      if (session.status !== "active") continue;
      const capabilities = this.store.list<Capability>(
        "capability",
        session.repository,
        session.session,
      );
      if (
        capabilities.length &&
        !capabilities.some(
          (c) => !c.revoked && c.expires > this.store.clock.now(),
        )
      )
        this.invalidate(session.session, "capability_expired");
    }
    for (const op of this.store.list<Operation>("operation"))
      if (
        ["intent", "running", "admitted"].includes(op.status) &&
        op.expires <= this.store.clock.now()
      )
        this.invalidate(op.session, "capability_expired");
  }
  recover() {
    // A process restart loses live adapter state and cancellation handles.
    // Retained capabilities cannot prove a clean runtime continuation.
    for (const session of this.store.list<Session>("session"))
      if (!session.parent && session.status !== "terminated")
        this.invalidate(session.session, "engine_restarted");
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE nonces SET used=1 WHERE used=0").run();
    });
  }
  reconcile(key: string, outcome: string, evidence: string) {
    this.store.transaction(() => {
      const op = this.store.get<Operation>("operation", key);
      check(
        op?.status === "requires_reconciliation",
        "reconciliation_not_needed",
      );
      check(
        outcome.length > 0 && evidence.length > 0,
        "reconciliation_evidence",
      );
      op.result = { outcome, evidence };
      op.status = "cancelled";
      this.save(op);
      this.store.audit(
        "operation.reconciled",
        { id: op.id, outcome, evidence },
        op.repository,
        op.session,
      );
    });
  }
}

function opExpired(error: unknown) {
  return error instanceof Error && error.message === "capability_expired";
}
