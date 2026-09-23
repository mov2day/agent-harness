import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import {
  Containment,
  runtimeScenarios,
  type ContainerInspection,
  type RuntimeCertificate,
} from "../src/containment.js";
import { Operations } from "../src/operations.js";
import { Artifacts } from "../src/workflow.js";
import { Compaction } from "../src/compaction.js";
import { Runtimes, type RuntimeLaunch } from "../src/runtimes.js";
import { defaultPolicy } from "../src/policy.js";
import { digest } from "../src/core.js";

function setup() {
  const f = fixture();
  const certificateData = {
    runtime: "opencode" as const,
    version: "fixture-only",
    models: { Conductor: { fixture: ["none"] } },
    platform: process.platform as "linux" | "darwin",
    image: "sha256:" + "a".repeat(64),
    sourceHash: "fixture-source",
    author: "fixture-author",
    reviewer: "fixture-reviewer",
    approved: true,
    expires: f.clock.now() + 100_000,
    scenarios: Object.fromEntries(
      runtimeScenarios.map((name) => [
        name,
        { passed: true, evidence: "b".repeat(64) },
      ]),
    ) as RuntimeCertificate["scenarios"],
  };
  const certificate = { ...certificateData, id: digest(certificateData) };
  let actual: ContainerInspection | undefined;
  const controls = {
    failedRemoval: false,
    inspections: 0,
    removed: [] as string[],
    hold: undefined as undefined | Promise<void>,
  };
  const containment = new Containment(f.store, "fixture-source", () => actual!);
  containment.install(certificate);
  f.policies.setModelCapabilities(() => containment.capabilities());
  f.policies.publish(
    "global",
    {
      ...defaultPolicy,
      models: { Conductor: { model: "fixture", reasoning: "none" } },
    },
    true,
  );
  const registered = f.register(),
    scope = registered.session;
  const operations = new Operations(f.store, f.identity, f.policies, (s) =>
    containment.healthy(s),
  );
  const compaction = new Compaction(
    f.store,
    f.identity,
    new Artifacts(f.store, f.identity),
  );
  const runtimes = new Runtimes(
    f.store,
    f.identity,
    operations,
    containment,
    compaction,
    {
      async inspect() {
        controls.inspections++;
        await controls.hold;
        return actual;
      },
      async remove(value) {
        controls.removed.push(value);
        if (controls.failedRemoval) throw new Error("fixture_cleanup_failed");
        actual = undefined;
      },
    },
  );
  function container() {
    actual = {
      Id: "c".repeat(64),
      Image: certificate.image,
      State: { Running: true },
      Config: {
        User: "1000:1000",
        Env: [],
        Labels: {
          "agent-harness.session": scope.runtimeSession,
          "agent-harness.connection": scope.connection,
        },
      },
      Mounts: [],
      HostConfig: {
        NetworkMode: "none",
        Privileged: false,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        CapAdd: [],
        SecurityOpt: ["no-new-privileges"],
        PidMode: "",
        IpcMode: "private",
        Devices: [],
        DeviceRequests: [],
        Binds: [],
        VolumesFrom: [],
        PidsLimit: 64,
        Memory: 512 * 1024 ** 2,
        PortBindings: {},
      },
    };
    return actual;
  }
  const prepare = () =>
    runtimes.prepare(registered.capability, scope.connection, {
      certificate: certificate.id,
      goal: "Operator goal",
    });
  const attach = () =>
    runtimes.attach(registered.capability, scope.connection, "c".repeat(64));
  return {
    ...f,
    certificate,
    scope,
    registered,
    operations,
    compaction,
    runtimes,
    controls,
    container,
    prepare,
    attach,
  };
}
test("runtime lifecycle: unprepared registration can terminate without a fictitious cleanup failure", async () => {
  const f = setup();
  try {
    assert.deepEqual(
      await f.runtimes.stop(f.registered.capability, f.scope.connection),
      { session: f.scope.session, status: "stopped" },
    );
    assert.equal(f.identity.session(f.scope.session).status, "terminated");
    assert.equal(f.controls.inspections, 0);
    assert.equal(f.store.list("runtime-launch").length, 0);
  } finally {
    f.runtimes.close();
    f.close();
  }
});
test("runtime lifecycle: durable launch intent, idempotent attachment and scoped termination", async () => {
  const f = setup();
  try {
    const prepared = f.prepare();
    assert.deepEqual(f.prepare(), prepared);
    assert.equal(prepared.status, "prepared");
    assert.equal(f.identity.session(f.scope.session).enforcement, "unverified");
    assert.deepEqual(f.compaction.authoritative(f.scope).goals, [
      "Operator goal",
    ]);
    assert.equal(f.compaction.budget(f.scope).used, 0);
    assert.throws(
      () =>
        f.runtimes.prepare(f.registered.capability, "different-connection", {
          certificate: f.certificate.id,
        }),
      /capability_scope/,
    );
    assert.throws(
      () =>
        f.runtimes.prepare(f.registered.capability, f.scope.connection, {
          certificate: f.certificate.id,
          goal: "Changed goal",
        }),
      /runtime_launch_conflict/,
    );
    await assert.rejects(f.attach(), /runtime_launch_identity/);
    f.container();
    const attached = await f.attach();
    assert.equal(attached.status, "attached");
    assert.deepEqual(await f.attach(), attached);
    assert.equal(f.identity.session(f.scope.session).enforcement, "enforced");
    await assert.rejects(
      f.runtimes.attach(
        f.registered.capability,
        f.scope.connection,
        "d".repeat(64),
      ),
      /runtime_already_bound/,
    );
    assert.equal(
      (await f.runtimes.stop(f.registered.capability, f.scope.connection))
        .status,
      "stopped",
    );
    assert.equal(f.identity.session(f.scope.session).status, "terminated");
    assert.deepEqual(f.controls.removed, ["c".repeat(64)]);
    assert.equal((await f.runtimes.cleanup(f.scope.session)).status, "stopped");
  } finally {
    f.runtimes.close();
    f.close();
  }
});
test("runtime lifecycle: invalidation while attachment is inspected cannot restore enforcement", async () => {
  const f = setup();
  try {
    f.prepare();
    f.container();
    let release!: () => void;
    f.controls.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attaching = f.attach();
    f.operations.invalidate(f.scope.session, "capability_revoked");
    release();
    await assert.rejects(attaching, /capability_invalid/);
    assert.equal(f.identity.session(f.scope.session).enforcement, "unverified");
    await f.runtimes.sweep();
    assert.equal(
      f.store.get<RuntimeLaunch>("runtime-launch", f.scope.session)?.status,
      "stopped",
    );
  } finally {
    f.runtimes.close();
    f.close();
  }
});
test("runtime lifecycle: restart cleans interrupted launch and retains ambiguous or failed cleanup", async () => {
  for (const mode of [
    "present",
    "missing",
    "mismatch",
    "cleanup-failed",
  ] as const) {
    const f = setup();
    try {
      f.prepare();
      if (mode !== "missing") {
        const c = f.container();
        if (mode === "mismatch") c.Image = "sha256:" + "f".repeat(64);
      }
      f.controls.failedRemoval = mode === "cleanup-failed";
      f.operations.recover();
      await Promise.all([f.runtimes.sweep(), f.runtimes.sweep()]);
      const record = f.store.get<RuntimeLaunch>(
        "runtime-launch",
        f.scope.session,
      )!;
      assert.equal(
        record.status,
        mode === "present" ? "stopped" : "requires_reconciliation",
        mode,
      );
      assert.notEqual(f.identity.session(f.scope.session).status, "active");
      assert.ok(f.controls.removed.length <= 1);
      if (mode === "mismatch" || mode === "missing")
        assert.equal(f.controls.removed.length, 0);
      if (mode === "missing")
        assert.match(record.error!, /creation_outcome_unknown/);
      const seen = f.controls.inspections;
      await f.runtimes.sweep();
      assert.equal(
        f.controls.inspections,
        seen,
        "Do not silently retry reconciliation failures",
      );
    } finally {
      f.runtimes.close();
      f.close();
    }
  }
});
