import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import { id, type Session } from "../src/core.js";
import { Operations } from "../src/operations.js";
import { Artifacts, Workflow } from "../src/workflow.js";
import {
  Specialists,
  delegateSchema,
  type SpecialistTask,
} from "../src/specialists.js";

function setup() {
  const f = fixture(),
    auth = f.register(),
    root = auth.session;
  root.enforcement = "enforced";
  f.identity.saveSession(root);
  const operations = new Operations(
      f.store,
      f.identity,
      f.policies,
      () => true,
    ),
    artifacts = new Artifacts(f.store, f.identity),
    workflow = new Workflow(
      f.store,
      f.identity,
      f.policies,
      artifacts,
      operations,
    ),
    specialists = new Specialists(
      f.store,
      f.identity,
      operations,
      workflow,
      artifacts,
    );
  const start = (inputs: string[] = []) => {
    const value = specialists.execute(
      root,
      delegateSchema.parse({
        role: "Researcher",
        task: "Investigate the assigned question",
        artifacts: inputs,
      }),
    );
    assert.ok(value.task && typeof value.session === "object");
    return { task: value.task, session: value.session };
  };
  const claim = (key: string, claim = id()) => {
    const value = specialists.claim(
      auth.capability,
      root.connection,
      key,
      claim,
    );
    return { ...value, claim };
  };
  const result = (
    child: Session,
    dependencies: string[] = [],
    shared = true,
  ) => {
    child.enforcement = "enforced";
    f.identity.saveSession(child);
    return artifacts.create(child, {
      kind: "specialist-result",
      content: "An untrusted result",
      dependencies,
      sources: [],
      shareWithRoot: shared,
    });
  };
  const complete = (task: string, claim: string, artifact: string) =>
    specialists.complete(
      auth.capability,
      root.connection,
      task,
      claim,
      artifact,
    );
  return {
    ...f,
    root,
    auth,
    operations,
    artifacts,
    workflow,
    specialists,
    start,
    claim,
    result,
    complete,
  };
}

test("specialist tasks: admission and explicit artifact sharing are atomic and bounded", async () => {
  const f = setup();
  try {
    const source = f.artifacts.create(f.root, {
      kind: "assignment",
      content: "Context",
      sources: [],
      dependencies: [],
    });
    assert.throws(() => f.start([source.id, id()]), /Artifact not found/);
    assert.equal(f.store.list<Session>("session").length, 1);
    assert.equal(f.store.list("specialist-task").length, 0);
    assert.deepEqual(f.artifacts.get(f.root, source.id).sharedWith, []);
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        Promise.resolve().then(() => f.start([source.id])),
      ),
    );
    assert.equal(attempts.filter((v) => v.status === "fulfilled").length, 4);
    assert.equal(f.store.list("specialist-task").length, 4);
    const tasks = f.store.list<SpecialistTask>("specialist-task");
    assert.ok(tasks.every((task) => task.artifacts[source.id] === source.hash));
    assert.throws(() =>
      delegateSchema.parse({
        role: "Reviewer",
        task: "Review",
        model: "model",
      }),
    );
    assert.throws(() =>
      delegateSchema.parse({ role: "Conductor", task: "Escalate" }),
    );
    assert.throws(() => delegateSchema.parse({ role: "Researcher", task: "" }));
  } finally {
    f.close();
  }
});

test("specialist tasks: forwarding preserves explicit access, root ownership and untrusted content", () => {
  const f = setup();
  try {
    const producer = f.workflow.admit(f.root, "Planner").session;
    const privateResult = f.result(producer, [], false);
    assert.throws(() => f.start([privateResult.id]), /Artifact not found/);
    f.artifacts.share(producer, privateResult.id, f.root.session);
    const assigned = f.start([privateResult.id]);
    const shared = f.artifacts.get(assigned.session, privateResult.id);
    assert.equal(shared.session, producer.session);
    assert.equal(shared.trust, "untrusted");
    assert.deepEqual(
      shared.sharedWith.sort(),
      [f.root.session, assigned.session.session].sort(),
    );
    const foreignRootId = id(),
      foreignRoot = { ...f.root, session: foreignRootId, root: foreignRootId };
    f.identity.saveSession(foreignRoot);
    const foreign = f.artifacts.create(foreignRoot, {
      kind: "private",
      content: "Other retained context",
      dependencies: [],
      sources: [],
    });
    f.artifacts.share(foreignRoot, foreign.id, f.root.session);
    assert.throws(() => f.start([foreign.id]), /specialist_input_scope/);
    const altered = { ...shared, content: "Altered after review" };
    f.store.put(
      "artifact",
      altered.id,
      altered,
      altered.repository,
      altered.session,
    );
    assert.throws(
      () => f.artifacts.get(assigned.session, altered.id),
      /artifact_integrity/,
    );
  } finally {
    f.close();
  }
});

test("specialist tasks: only one host claim wins and claim material never reaches task views", async () => {
  const f = setup();
  try {
    const assigned = f.start(),
      claims = Array.from({ length: 12 }, () => id());
    const attempts = await Promise.allSettled(
      claims.map((claim) =>
        Promise.resolve().then(() => f.claim(assigned.task.id, claim)),
      ),
    );
    const succeeded = attempts.filter((v) => v.status === "fulfilled");
    assert.equal(succeeded.length, 1);
    const first = succeeded[0];
    assert.ok(first?.status === "fulfilled");
    const retry = f.claim(assigned.task.id, first.value.claim);
    assert.equal(retry.session.connection, assigned.session.connection);
    assert.equal(retry.task.status, "running");
    assert.equal("claimHash" in retry.task, false);
    const status = f.specialists.execute(f.root, {
      action: "status",
      task: assigned.task.id,
    });
    assert.equal("claimHash" in status.task!, false);
    assert.throws(
      () =>
        f.specialists.claim(f.auth.capability, "wrong", assigned.task.id, id()),
      /capability_scope/,
    );
    const childToken = f.identity.issue(assigned.session).capability;
    assert.throws(
      () =>
        f.specialists.claim(
          childToken,
          assigned.session.connection,
          assigned.task.id,
          id(),
        ),
      /enforcement_unhealthy|role_authority/,
    );
    assert.throws(
      () => f.specialists.execute(f.root, { action: "status", task: id() }),
      /Specialist task not found/,
    );
  } finally {
    f.close();
  }
});

test("specialist tasks: completion binds child, lineage, claim and integrity with exact replay", () => {
  const f = setup();
  try {
    const input = f.artifacts.create(f.root, {
      kind: "context",
      content: "Input",
      dependencies: [],
      sources: [],
    });
    const assigned = f.start([input.id]),
      claimed = f.claim(assigned.task.id);
    const noLineage = f.result(assigned.session);
    assert.throws(
      () => f.complete(assigned.task.id, claimed.claim, noLineage.id),
      /specialist_result_lineage/,
    );
    const unshared = f.result(assigned.session, [input.id], false);
    assert.throws(
      () => f.complete(assigned.task.id, claimed.claim, unshared.id),
      /Artifact not found/,
    );
    const output = f.result(assigned.session, [input.id]);
    assert.throws(
      () => f.complete(assigned.task.id, id(), output.id),
      /specialist_claim_mismatch/,
    );
    assert.throws(
      () => f.complete(assigned.task.id, claimed.claim, input.id),
      /specialist_result_scope/,
    );
    const token = f.identity.issue(assigned.session).capability;
    const active = f.operations.begin(token, assigned.session.connection, {
      tool: "artifact",
      args: { action: "get", id: input.id },
      idempotencyKey: id(),
    });
    assert.throws(
      () => f.complete(assigned.task.id, claimed.claim, output.id),
      /specialist_operation_pending/,
    );
    active.status = "completed";
    f.operations.save(active);
    const completed = f.complete(assigned.task.id, claimed.claim, output.id);
    assert.deepEqual(completed.result, {
      artifact: output.id,
      hash: output.hash,
      trust: "untrusted",
    });
    assert.deepEqual(
      f.complete(assigned.task.id, claimed.claim, output.id),
      completed,
    );
    assert.throws(
      () => f.complete(assigned.task.id, claimed.claim, noLineage.id),
      /specialist_result_conflict/,
    );
    output.content = "Corrupted";
    f.store.put(
      "artifact",
      output.id,
      output,
      output.repository,
      output.session,
    );
    assert.throws(
      () => f.complete(assigned.task.id, claimed.claim, output.id),
      /artifact_integrity/,
    );
  } finally {
    f.close();
  }
});

test("specialist tasks: retained sessions are reused only within their root and released only when idle", () => {
  const f = setup();
  try {
    const assigned = f.start();
    assert.throws(
      () =>
        f.specialists.execute(f.root, {
          action: "finish",
          session: assigned.session.session,
        }),
      /specialist_busy/,
    );
    const claimed = f.claim(assigned.task.id),
      result = f.result(assigned.session);
    f.complete(assigned.task.id, claimed.claim, result.id);
    const otherRootId = id(),
      otherRoot = { ...f.root, session: otherRootId, root: otherRootId };
    f.identity.saveSession(otherRoot);
    assert.throws(
      () =>
        f.specialists.execute(otherRoot, {
          action: "message",
          session: assigned.session.session,
          task: "Steal context",
          artifacts: [],
        }),
      /delegation_scope/,
    );
    const next = f.specialists.execute(f.root, {
      action: "message",
      session: assigned.session.session,
      task: "Continue here",
      artifacts: [result.id],
    });
    assert.ok(next.task && typeof next.session === "object");
    assert.equal(next.session.connection, assigned.session.connection);
    assert.equal(next.session.runtimeSession, assigned.session.runtimeSession);
    const nextClaim = f.claim(next.task.id),
      nextResult = f.result(assigned.session, [result.id]);
    f.complete(next.task.id, nextClaim.claim, nextResult.id);
    f.specialists.execute(f.root, {
      action: "finish",
      session: assigned.session.session,
    });
    assert.equal(
      f.identity.session(assigned.session.session).status,
      "terminated",
    );
    assert.equal(f.identity.session(f.root.session).status, "active");
    assert.throws(
      () => f.workflow.terminate(f.root, f.root.session),
      /delegation_scope/,
    );
    assert.throws(
      () =>
        f.specialists.execute(f.root, {
          action: "message",
          session: assigned.session.session,
          task: "Reuse terminated context",
          artifacts: [],
        }),
      /specialist_inactive/,
    );
    assert.equal(
      f.complete(assigned.task.id, claimed.claim, result.id).status,
      "completed",
    );
    // The released process does not consume a concurrency slot.
    for (let i = 0; i < 4; i++) f.start();
  } finally {
    f.close();
  }
});

test("specialist tasks: child authority loss pauses the root and preserves interrupted outcomes", () => {
  for (const cause of [
    "child",
    "restart",
    "expiry",
    "failure",
    "evidence",
  ] as const) {
    const f = setup();
    try {
      const input = f.artifacts.create(f.root, {
        kind: "context",
        content: "Input",
        dependencies: [],
        sources: [],
      });
      const running = f.start([input.id]),
        queued = f.start(),
        claim = f.claim(running.task.id);
      if (cause === "child")
        f.operations.invalidate(
          running.session.session,
          "enforcement_unhealthy",
        );
      if (cause === "restart") f.operations.recover();
      if (cause === "expiry") {
        f.clock.tick(300_000);
        f.operations.sweep();
      }
      if (cause === "failure")
        f.specialists.fail(
          f.auth.capability,
          f.root.connection,
          running.task.id,
          claim.claim,
        );
      if (cause === "evidence") f.artifacts.invalidate(f.root, input.id);
      assert.equal(f.identity.session(f.root.session).status, "paused", cause);
      assert.equal(
        f.store.get<SpecialistTask>("specialist-task", running.task.id)!.status,
        cause === "failure" ? "failed" : "requires_reconciliation",
        cause,
      );
      assert.equal(
        f.store.get<SpecialistTask>("specialist-task", queued.task.id)!.status,
        "cancelled",
        cause,
      );
      assert.throws(() => f.claim(running.task.id, claim.claim));
      assert.throws(() => f.complete(running.task.id, claim.claim, id()));
    } finally {
      f.close();
    }
  }
});

test("specialist tasks: invalidating completed evidence pauses dependent work", () => {
  const f = setup();
  try {
    const assigned = f.start(),
      claim = f.claim(assigned.task.id),
      result = f.result(assigned.session);
    f.complete(assigned.task.id, claim.claim, result.id);
    f.artifacts.invalidate(assigned.session, result.id);
    assert.equal(
      f.store.get<SpecialistTask>("specialist-task", assigned.task.id)!.status,
      "requires_reconciliation",
    );
    assert.equal(f.identity.session(f.root.session).status, "paused");
  } finally {
    f.close();
  }
});
