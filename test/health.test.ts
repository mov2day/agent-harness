import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/core.js";
import {
  Containment,
  HEALTH_MAX_AGE_MS,
  runtimeScenarios,
  type RuntimeCertificate,
  type ContainerInspection,
} from "../src/containment.js";
import { Operations } from "../src/operations.js";
import { fixture } from "./helpers.js";
function setup() {
  const f = fixture(),
    session = f.register().session;
  let inspections = 0;
  const inspect = (): ContainerInspection => ({
    Id: "a".repeat(64),
    Image: "sha256:" + "b".repeat(64),
    State: { Running: true },
    Config: {
      User: "1000:1000",
      Env: [],
      Labels: {
        "agent-harness.session": session.runtimeSession,
        "agent-harness.connection": session.connection,
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
  });
  const containment = new Containment(f.store, "fixture-source", () => {
    inspections++;
    return inspect();
  });
  const value = {
    runtime: "opencode" as const,
    version: "fixture",
    models: {},
    platform: process.platform as "linux" | "darwin",
    image: inspect().Image,
    sourceHash: "fixture-source",
    author: "fixture-author",
    reviewer: "fixture-reviewer",
    scenarios: Object.fromEntries(
      runtimeScenarios.map((name) => [
        name,
        { passed: true, evidence: "c".repeat(64) },
      ]),
    ) as RuntimeCertificate["scenarios"],
    approved: true,
    expires: 2_000_000,
  };
  const certificate = { ...value, id: digest(value) };
  containment.install(certificate);
  containment.attach(session, inspect().Id, certificate.id);
  const operations = new Operations(f.store, f.identity, f.policies, (s) =>
    containment.healthy(s),
  );
  containment.setInvalidator((id) =>
    operations.invalidate(id, "enforcement_unhealthy"),
  );
  return {
    ...f,
    session,
    inspect,
    inspections: () => inspections,
    containment,
    operations,
  };
}
test("runtime health: fresh checks avoid synchronous inspection; exact staleness revokes authority", async () => {
  const f = setup();
  try {
    for (let n = 0; n < 100; n++)
      assert.equal(f.containment.healthy(f.session), true);
    assert.equal(f.inspections(), 1);
    f.clock.tick(750);
    await f.containment.refresh(async () => [f.inspect()]);
    f.clock.tick(HEALTH_MAX_AGE_MS - 1);
    assert.equal(f.containment.healthy(f.session), true);
    f.clock.tick(1);
    assert.equal(f.containment.healthy(f.session), false);
    assert.equal(f.identity.session(f.session.session).status, "paused");
    assert.equal(
      f.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM audit WHERE event='runtime.health_failed'",
        )
        .get()!.n,
      1,
    );
  } finally {
    f.containment.close();
    f.close();
  }
});
test("runtime health: stopped containers and failed inspections cancel running operations", async () => {
  for (const failure of ["stopped", "unavailable", "slow"] as const) {
    const f = setup();
    try {
      const token = f.identity.issue(f.session).capability,
        op = f.operations.begin(token, f.session.connection, {
          tool: "artifact",
          args: {
            kind: "plan",
            content: "draft",
            dependencies: [],
            trust: "untrusted",
            sources: [],
          },
          idempotencyKey: "pending",
        });
      const running = f.operations.run(
        op,
        (signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          ),
      );
      await f.containment.refresh(async () => {
        if (failure === "unavailable") throw new Error("daemon unavailable");
        const c = f.inspect();
        if (failure === "stopped") c.State.Running = false;
        else f.clock.tick(HEALTH_MAX_AGE_MS);
        return [c];
      });
      const result = await running;
      assert.equal(
        result.invalidated?.reason,
        "enforcement_unhealthy",
        failure,
      );
      assert.notEqual(result.status, "completed");
      assert.equal(f.identity.session(f.session.session).status, "paused");
    } finally {
      f.containment.close();
      f.close();
    }
  }
});
