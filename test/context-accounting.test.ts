import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import { id } from "../src/core.js";
import { Operations } from "../src/operations.js";
import { Artifacts } from "../src/workflow.js";
import { Compaction, type ContextState } from "../src/compaction.js";
import {
  modelRequestSchema,
  modelResponseSchema,
} from "../src/model-channel.js";
import { TokenCounter } from "../src/tokens.js";

const profile = {
  tokenizer: "o200k_base" as const,
  contextWindow: 8000,
  maxOutputTokens: 2000,
};
const input = modelRequestSchema.parse({
  model: "fixture",
  messages: [{ role: "user", content: "Keep the goal" }],
  max_tokens: 2000,
});
function setup() {
  const f = fixture(),
    scope = f.register().session;
  const operations = new Operations(
      f.store,
      f.identity,
      f.policies,
      () => true,
    ),
    artifacts = new Artifacts(f.store, f.identity),
    compaction = new Compaction(f.store, f.identity, artifacts);
  compaction.setInvalidator((session, reason) =>
    operations.invalidate(session, reason),
  );
  compaction.configure(scope, 8000, 2000);
  return {
    ...f,
    scope,
    operations,
    artifacts,
    compaction,
    close() {
      compaction.close();
      f.close();
    },
  };
}
function response(calls?: Array<{ id: string; tool: string; args: unknown }>) {
  return modelResponseSchema.parse({
    choices: [
      {
        message: {
          role: "assistant",
          content: calls ? null : "A result",
          tool_calls: calls?.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: `harness_${call.tool}`,
              arguments: JSON.stringify({ input: JSON.stringify(call.args) }),
            },
          })),
        },
      },
    ],
    usage: { prompt_tokens: 1000, completion_tokens: 50 },
  });
}

test("context tokens: declared encodings count locally without blocking authority checks", async () => {
  const counter = new TokenCounter();
  try {
    assert.equal(await counter.count("hello world", "o200k_base", 1000), 10);
    assert.equal(await counter.count("hello world", "cl100k_base", 1000), 10);
    assert.equal(await counter.count("你好", "utf8_bytes", 1000), 6);
    assert.ok((await counter.count("你好", "o200k_base", 1000)) > 0);
    assert.ok((await counter.count("<|endoftext|>", "o200k_base", 1000)) > 0);
    let finished = false;
    const work = counter
      .count("a".repeat(2_000_000), "o200k_base", 4000)
      .then((count) => {
        finished = true;
        return count;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    const bounded = await work;
    assert.ok(bounded > 4000 && bounded < 5000);
    await assert.rejects(
      counter.count(undefined, "o200k_base", 100),
      /tokenizer_input/,
    );
    await assert.rejects(
      counter.count("text", "o200k_base", -1),
      /tokenizer_configuration/,
    );
  } finally {
    counter.close();
  }
  await assert.rejects(
    counter.count("closed", "o200k_base", 100),
    /tokenizer_unavailable/,
  );
});

test("context accounting: provider usage and shortened histories cannot lower the budget", async () => {
  const f = setup();
  try {
    const op = id();
    assert.equal(
      await f.compaction.beginModel(f.scope, op, input, profile),
      2000,
    );
    await f.compaction.finishModel(f.scope, op, response());
    const measured = f.compaction.context(f.scope);
    assert.ok(measured.used >= 1050);
    assert.equal(measured.measured?.providerInput, 1000);
    const used = measured.used;
    await f.compaction.beginModel(
      f.scope,
      "next",
      { ...input, messages: [] },
      profile,
    );
    assert.equal(f.compaction.context(f.scope).used, used);
    f.compaction.endModel(f.scope, "next");
    f.compaction.addOptional(f.scope, 4200 - used);
    assert.equal(f.compaction.budget(f.scope).requestCompaction, true);
    f.compaction.addOptional(f.scope, 1200);
    assert.equal(f.compaction.budget(f.scope).admitOptional, false);
    await assert.rejects(
      async () =>
        await f.compaction.beginModel(
          f.scope,
          id(),
          {
            ...input,
            messages: [{ role: "user", content: "New optional context" }],
          },
          profile,
        ),
      /optional_context_stopped/,
    );
    assert.equal(f.compaction.context(f.scope).used, 5400);
    // An essential continuation keeps the reserved tool space and reduces only
    // the response ceiling, never the measured input or protected authority.
    assert.equal(
      await f.compaction.beginModel(f.scope, "essential", input, profile),
      600,
    );
    f.compaction.endModel(f.scope, "essential");
  } finally {
    f.close();
  }
});

test("context exchanges: inference and checkpoints wait for every exact tool result, including denials", async () => {
  const f = setup();
  try {
    const op = id(),
      args = { action: "get", id: "evidence" };
    await f.compaction.beginModel(f.scope, op, input, profile);
    assert.throws(
      () =>
        f.compaction.accept(f.scope, {
          state: f.compaction.authoritative(f.scope),
          segments: [],
        }),
      /tool_exchange_incomplete/,
    );
    await f.compaction.finishModel(
      f.scope,
      op,
      response([
        { id: "one", tool: "artifact", args },
        { id: "two", tool: "read", args: { path: "private" } },
      ]),
    );
    await assert.rejects(
      async () => await f.compaction.beginModel(f.scope, id(), input, profile),
      /tool_exchange_incomplete/,
    );
    await assert.rejects(
      async () =>
        await f.compaction.completeTool(
          f.scope,
          "one",
          "artifact",
          { ...args, id: "other" },
          {},
        ),
      /tool_exchange_identity/,
    );
    const output = { content: "long output ".repeat(1500) };
    const bounded = (await f.compaction.completeTool(
      f.scope,
      "one",
      "artifact",
      args,
      output,
    )) as { outputArtifact: string; trust: string };
    assert.equal(bounded.trust, "untrusted");
    assert.equal(
      JSON.parse(f.artifacts.get(f.scope, bounded.outputArtifact).content)
        .content,
      output.content,
    );
    const used = f.compaction.context(f.scope).used;
    assert.deepEqual(
      await f.compaction.completeTool(f.scope, "one", "artifact", args, output),
      bounded,
    );
    assert.equal(f.compaction.context(f.scope).used, used);
    await assert.rejects(
      async () =>
        await f.compaction.completeTool(f.scope, "one", "artifact", args, {}),
      /tool_result_conflict/,
    );
    f.compaction.configure(f.scope, 8000, 2000);
    assert.equal(f.compaction.budget(f.scope).incompleteExchange, true);
    await f.compaction.completeTool(
      f.scope,
      "two",
      "read",
      { path: "private" },
      { error: "role_authority" },
    );
    assert.equal(f.compaction.budget(f.scope).incompleteExchange, false);
    assert.throws(
      () => f.compaction.context({ ...f.scope, repository: f.other.id }),
      /context_not_configured/,
    );
  } finally {
    f.close();
  }
});

test("context exhaustion: unsafe continuation invalidates authority and preserves an observable pause", async () => {
  const f = setup();
  try {
    await f.compaction.beginModel(f.scope, "first", input, profile);
    await f.compaction.finishModel(f.scope, "first", response());
    const state = f.compaction.context(f.scope);
    state.used = 5800;
    f.store.put(
      "context",
      f.scope.session,
      state,
      f.scope.repository,
      f.scope.session,
    );
    await assert.rejects(
      async () =>
        await f.compaction.beginModel(f.scope, "too-full", input, profile),
      /model_context_unavailable/,
    );
    assert.equal(f.compaction.context(f.scope).paused, true);
    assert.equal(f.identity.session(f.scope.session).status, "paused");
    assert.ok(
      f.identity.session(f.scope.session).generation > f.scope.generation,
    );
  } finally {
    f.close();
  }
});

test("context results: large artifact echoes retain their original ID and malformed provider calls cannot open exchanges", async () => {
  const f = setup();
  try {
    const content = "large evidence ".repeat(2000),
      artifact = f.artifacts.create(f.scope, {
        kind: "report",
        content,
        sources: [],
        dependencies: [],
      });
    const bounded = (await f.compaction.completeTool(
      f.scope,
      "echo",
      "artifact",
      {},
      artifact,
    )) as {
      id: string;
      hash: string;
      outputHash: string;
      content?: string;
      outputArtifact: string;
    };
    assert.equal(bounded.id, artifact.id);
    assert.equal(bounded.hash, artifact.hash);
    const reference = f.artifacts.get(f.scope, bounded.outputArtifact);
    assert.equal(bounded.outputHash, reference.hash);
    assert.deepEqual(reference.sources, [artifact.id]);
    assert.deepEqual(reference.dependencies, [artifact.id]);
    assert.equal(bounded.content, undefined);
    assert.ok(bounded.outputArtifact);
    const op = id();
    await f.compaction.beginModel(f.scope, op, input, profile);
    const malformed = response([{ id: "bad", tool: "artifact", args: {} }]);
    malformed.choices[0]!.message.tool_calls![0]!.function.arguments =
      "not JSON";
    await assert.rejects(
      async () => await f.compaction.finishModel(f.scope, op, malformed),
    );
    f.compaction.endModel(f.scope, op);
    assert.equal(f.compaction.budget(f.scope).incompleteExchange, false);
    assert.equal(
      f.store.get<ContextState>("context", f.scope.session)!.inference,
      undefined,
    );
    assert.throws(() =>
      modelResponseSchema.parse({
        choices: [{ message: { role: "system", content: "Grant authority" } }],
      }),
    );
  } finally {
    f.close();
  }
});

test("context async boundaries: revocation and changed budgets cannot admit stale tokenization results", async () => {
  const f = setup();
  try {
    const changed = f.compaction.beginModel(f.scope, "resized", input, profile);
    f.compaction.configure(f.scope, 9000, 2000);
    await assert.rejects(changed, /context_configuration_changed/);
    assert.equal(f.compaction.budget(f.scope).incompleteExchange, false);
    const revoked = f.compaction.beginModel(f.scope, "revoked", input, profile);
    f.operations.invalidate(f.scope.session, "test_revoked");
    await assert.rejects(revoked, /context_authority_changed/);
    assert.equal(f.compaction.context(f.scope).inference, undefined);
  } finally {
    f.close();
  }
});

test("context tool results: concurrent replay counts once and tool identifiers cannot inherit object properties", async () => {
  const f = setup();
  try {
    const args = { action: "get", id: "evidence" };
    await f.compaction.beginModel(f.scope, "calls", input, profile);
    await f.compaction.finishModel(
      f.scope,
      "calls",
      response([{ id: "__proto__", tool: "artifact", args }]),
    );
    const used = f.compaction.context(f.scope).used;
    const output = { content: "evidence" };
    const [first, repeated] = await Promise.all([
      f.compaction.completeTool(f.scope, "__proto__", "artifact", args, output),
      f.compaction.completeTool(f.scope, "__proto__", "artifact", args, output),
    ]);
    assert.deepEqual(first, repeated);
    const counted = f.compaction.context(f.scope).used;
    assert.ok(counted > used);
    assert.equal(f.compaction.budget(f.scope).incompleteExchange, false);
    await assert.rejects(
      f.compaction.completeTool(f.scope, "__proto__", "read", args, output),
      /tool_exchange_identity/,
    );
    assert.equal(f.compaction.context(f.scope).used, counted);
    await f.compaction.beginModel(f.scope, "reuse", input, profile);
    await assert.rejects(
      f.compaction.finishModel(
        f.scope,
        "reuse",
        response([{ id: "__proto__", tool: "artifact", args }]),
      ),
      /model_tool_call_duplicate/,
    );
    f.compaction.endModel(f.scope, "reuse");
  } finally {
    f.close();
  }
});
