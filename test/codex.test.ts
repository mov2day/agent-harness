import test from "node:test";
import assert from "node:assert/strict";
import { CodexAdapter, codexRuntimeProfile } from "../src/adapters/codex.js";
import { readFileSync } from "node:fs";
test("Codex adapter: independently deny native command/file approvals, overrides and permissions", async () => {
  let calls = 0;
  const adapter = new CodexAdapter(
    {
      async execute() {
        calls++;
        return {};
      },
      async context() {
        return {};
      },
    },
    "thread",
  );
  adapter.turnStarted("thread", "turn");
  for (const method of [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
  ])
    assert.deepEqual(
      (
        await adapter.handle({
          id: 1,
          method,
          params: {
            threadId: "thread",
            turnId: "turn",
            additionalPermissions: { network: { enabled: true } },
            command: "rm -rf src",
          },
        })
      ).result,
      { decision: "decline" },
    );
  assert.deepEqual(
    (
      await adapter.handle({
        id: 2,
        method: "item/permissions/requestApproval",
        params: { threadId: "thread", turnId: "turn" },
      })
    ).result,
    { permissions: {}, scope: "turn", strictAutoReview: true },
  );
  for (const tool of [
    "bash",
    "harness_policy",
    "harness_shell",
    "harness_plugin",
  ])
    assert.ok(
      (
        await adapter.handle({
          id: 3,
          method: "item/tool/call",
          params: {
            threadId: "thread",
            turnId: "turn",
            callId: "native",
            tool,
            arguments: {},
          },
        })
      ).error,
    );
  assert.equal(calls, 0);
  assert.equal(codexRuntimeProfile.certified, false);
});
test("Codex adapter: thread/turn identity, safe idempotency, lifecycle and independent schema shape", async () => {
  let calls = 0,
    stopped = "";
  const adapter = new CodexAdapter(
    {
      async execute() {
        calls++;
        return {
          status: "completed",
          id: "operation",
          result: { content: "safe" },
        };
      },
      async context() {
        return { policy: "p1" };
      },
    },
    "thread",
    (reason) => (stopped = reason),
  );
  adapter.turnStarted("thread", "turn");
  const request = {
    id: 1,
    method: "item/tool/call",
    params: {
      threadId: "thread",
      turnId: "turn",
      callId: "call",
      tool: "harness_read",
      arguments: { path: "src/a" },
    },
  };
  const response = await adapter.handle(request);
  assert.deepEqual(response.result, {
    success: true,
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify({
          operation: "operation",
          status: "completed",
          result: { content: "safe" },
        }),
      },
    ],
  });
  assert.equal((await adapter.handle({ ...request, id: 2 })).id, 2);
  assert.equal(calls, 1);
  for (const params of [
    { ...request.params, threadId: "other" },
    { ...request.params, turnId: "old" },
    { ...request.params, arguments: { path: "src/b" } },
    { ...request.params, namespace: "untrusted_plugin" },
  ])
    assert.ok((await adapter.handle({ ...request, params })).error);
  assert.deepEqual(await adapter.beforeCompaction(), { policy: "p1" });
  adapter.terminated("thread");
  assert.equal(stopped, "codex_connection_lost");
  assert.ok((await adapter.handle(request)).error);
  const schema = JSON.parse(
    readFileSync("docs/runtime-protocols/codex.json", "utf8"),
  );
  assert.equal(
    schema.dynamicToolResponse.properties.contentItems.items.$ref,
    "#/definitions/DynamicToolCallOutputContentItem",
  );
  assert.ok(
    schema.dynamicToolResponse.definitions.DynamicToolCallOutputContentItem.oneOf.some(
      (v: any) => v.properties.type.enum.includes("inputText"),
    ),
  );
});
test("Codex adapter: compaction cannot cross an incomplete tool exchange", async () => {
  let finish!: (value: unknown) => void;
  const adapter = new CodexAdapter(
    {
      execute() {
        return new Promise((resolve) => (finish = resolve));
      },
      async context() {
        return {};
      },
    },
    "thread",
  );
  adapter.turnStarted("thread", "turn");
  const pending = adapter.handle({
    id: 1,
    method: "item/tool/call",
    params: {
      threadId: "thread",
      turnId: "turn",
      callId: "call",
      tool: "harness_read",
      arguments: { path: "a" },
    },
  });
  await assert.rejects(
    adapter.beforeCompaction(),
    /codex_tool_exchange_incomplete/,
  );
  finish({ status: "completed" });
  await pending;
  assert.deepEqual(await adapter.beforeCompaction(), {});
});
