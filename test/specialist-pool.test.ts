import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import { id, type Session } from "../src/core.js";
import { Operations, type Operation } from "../src/operations.js";
import { Artifacts, Workflow } from "../src/workflow.js";
import {
  Specialists,
  type Delegation,
  type SpecialistTask,
} from "../src/specialists.js";
import {
  SpecialistPool,
  type SpecialistProcess,
} from "../src/adapters/specialist-pool.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
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
  const bridge = {
    async operation(tool: string, args: unknown, key: string) {
      const op = operations.begin(auth.capability, root.connection, {
        tool,
        args,
        idempotencyKey: key,
      });
      return operations.run(op, async () =>
        specialists.execute(root, op.args as Delegation),
      );
    },
    async context() {
      return f.identity.authenticate(auth.capability, root.connection);
    },
    async claimTask(task: string, claim: string) {
      return specialists.claim(auth.capability, root.connection, task, claim);
    },
    async completeTask(task: string, claim: string, artifact: string) {
      return specialists.complete(
        auth.capability,
        root.connection,
        task,
        claim,
        artifact,
      );
    },
    async failTask(task: string, claim: string) {
      return specialists.fail(auth.capability, root.connection, task, claim);
    },
    async releaseSpecialist(session: string) {
      specialists.release(auth.capability, root.connection, session);
      return { session, status: "stopped" as const };
    },
    async abandonTask(task: string) {
      return specialists.abandon(auth.capability, root.connection, task);
    },
  };
  const children: Array<{
    session: Session;
    starts: number;
    prompts: string[];
    stopped: boolean;
    released: boolean;
  }> = [];
  let answer = async (_session: Session): Promise<unknown> => ({
    parts: [{ type: "text", text: "Untrusted specialist findings" }],
  });
  const pool = new SpecialistPool(bridge, (session): SpecialistProcess => {
    const child = {
      session,
      starts: 0,
      prompts: [] as string[],
      stopped: false,
      released: false,
    };
    children.push(child);
    const token = f.identity.issue(session).capability;
    return {
      bridge: {
        async operation(tool, args, key) {
          const op = operations.begin(token, session.connection, {
            tool,
            args,
            idempotencyKey: key,
          });
          return operations.run(op, async () =>
            artifacts.create(
              f.identity.session(session.session),
              op.args as any,
            ),
          );
        },
      },
      async start() {
        child.starts++;
        session.enforcement = "enforced";
        f.identity.saveSession(session);
      },
      async prompt(text) {
        child.prompts.push(text);
        return answer(session);
      },
      quiesce() {},
      async stop() {
        child.stopped = true;
      },
      async release() {
        child.released = true;
      },
    };
  });
  return {
    ...f,
    root,
    auth,
    operations,
    specialists,
    bridge,
    pool,
    children,
    answer(fn: typeof answer) {
      answer = fn;
    },
    assign(
      args: unknown = { role: "Researcher", task: "Find evidence" },
      key = id(),
    ) {
      return bridge.operation("delegate", args, key);
    },
  };
}

test("specialist host: duplicate requests share one process/turn, reuse retains context and finish confirms cleanup", async () => {
  const f = setup();
  try {
    const admission = await f.assign();
    const results = (await Promise.all([
      f.pool.delegated(admission),
      f.pool.delegated(admission),
    ])) as Operation[];
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0]!.starts, 1);
    assert.equal(f.children[0]!.prompts.length, 1);
    const result = results[0]!.result as { task: SpecialistTask };
    assert.equal(result.task.status, "completed");
    assert.equal(result.task.result?.trust, "untrusted");
    await f.pool.delegated(admission);
    assert.equal(f.children[0]!.prompts.length, 1);
    const next = await f.assign({
      action: "message",
      session: result.task.session,
      task: "Continue with retained context",
      artifacts: [result.task.result!.artifact],
    });
    await f.pool.delegated(next);
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0]!.prompts.length, 2);
    assert.match(f.children[0]!.prompts[1]!, /Continue with retained context/);
    const finish = await f.assign({
      action: "finish",
      session: result.task.session,
    });
    assert.equal(
      ((await f.pool.delegated(finish)) as Operation).status,
      "completed",
    );
    assert.equal(f.children[0]!.released, true);
    assert.equal(f.identity.session(result.task.session).status, "terminated");
    await f.pool.stop();
  } finally {
    f.close();
  }
});

test("specialist host: revoked authority while awaiting results cannot return stale success", async () => {
  const f = setup(),
    started = deferred<void>(),
    finish = deferred<unknown>();
  try {
    f.answer(async () => {
      started.resolve();
      return finish.promise;
    });
    const admission = await f.assign(),
      running = f.pool.delegated(admission);
    const rejected = assert.rejects(running, /capability|authority/);
    await started.promise;
    f.operations.invalidate(f.root.session, "policy_changed");
    finish.resolve({ parts: [{ type: "text", text: "Late result" }] });
    await rejected;
    const task = f.store.list<SpecialistTask>("specialist-task")[0]!;
    assert.equal(task.status, "requires_reconciliation");
    assert.equal(task.result, undefined);
    await f.pool.stop();
  } finally {
    f.close();
  }
});

test("specialist host: failed runtime turns pause the root instead of publishing a result", async () => {
  for (const response of [
    { info: { error: "runtime failed" }, parts: [] },
    { parts: [] },
  ]) {
    const f = setup();
    try {
      f.answer(async () => response);
      await assert.rejects(
        f.pool.delegated(await f.assign()),
        /specialist_turn_failed|specialist_result_size/,
      );
      assert.equal(f.identity.session(f.root.session).status, "paused");
      const task = f.store.list<SpecialistTask>("specialist-task")[0]!;
      assert.equal(task.status, "failed");
      assert.equal(task.result, undefined);
      await f.pool.stop();
    } finally {
      f.close();
    }
  }
});

test("specialist host: an orphaned claim is never replayed as a new runtime turn", async () => {
  const f = setup();
  try {
    const admission = await f.assign(),
      task = (admission.result as { task: SpecialistTask }).task;
    await f.bridge.claimTask(task.id, id());
    await assert.rejects(
      f.pool.delegated(admission),
      /specialist_task_not_replayable/,
    );
    assert.equal(f.children.length, 0);
    assert.equal(
      f.store.get<SpecialistTask>("specialist-task", task.id)!.status,
      "requires_reconciliation",
    );
    assert.equal(f.identity.session(f.root.session).status, "paused");
  } finally {
    f.close();
  }
});

test("specialist host: finish rechecks authority after asynchronous container cleanup", async () => {
  const f = setup(),
    cleaning = deferred<void>(),
    cleaned = deferred<void>();
  try {
    const admission = await f.assign();
    await f.pool.delegated(admission);
    const task = (admission.result as { task: SpecialistTask }).task;
    f.bridge.releaseSpecialist = async (session) => {
      cleaning.resolve();
      await cleaned.promise;
      return { session, status: "stopped" };
    };
    const finish = f.pool.delegated(
      await f.assign({ action: "finish", session: task.session }),
    );
    const rejected = assert.rejects(finish, /capability|authority/);
    await cleaning.promise;
    f.operations.invalidate(f.root.session, "capability_revoked");
    cleaned.resolve();
    await rejected;
    assert.equal(f.children[0]!.released, true);
    await f.pool.stop();
  } finally {
    f.close();
  }
});
