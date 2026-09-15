import test from "node:test";
import assert from "node:assert/strict";
import { digest, HarnessError } from "../src/core.js";
import {
  Containment,
  runtimeScenarios,
  type RuntimeCertificate,
  type ContainerInspection,
} from "../src/containment.js";
import { defaultPolicy, type ModelCapabilities } from "../src/policy.js";
import { Artifacts, Workflow } from "../src/workflow.js";
import { Operations } from "../src/operations.js";
import { fixture } from "./helpers.js";

function certificate(
  models: ModelCapabilities,
  version = "fixture-1",
): RuntimeCertificate {
  const value = {
    runtime: "opencode" as const,
    version,
    models,
    platform: process.platform as "linux" | "darwin",
    image: "sha256:" + "a".repeat(64),
    sourceHash: "fixture-source",
    author: "test-author",
    reviewer: "test-reviewer",
    scenarios: Object.fromEntries(
      runtimeScenarios.map((name) => [
        name,
        { passed: true, evidence: "b".repeat(64) },
      ]),
    ) as RuntimeCertificate["scenarios"],
    approved: true,
    expires: 2_000_000,
  };
  return { ...value, id: digest(value) };
}
test("model policy: publication rejects unsupported role/reasoning combinations and preserves active policy", () => {
  const f = fixture();
  try {
    const previous = f.policies.active("global").id;
    assert.throws(
      () =>
        f.policies.publish(
          "global",
          {
            ...defaultPolicy,
            models: { Planner: { model: "unknown", reasoning: "high" } },
          },
          true,
        ),
      (error: unknown) =>
        error instanceof HarnessError &&
        !!(error.details as any)["models.Planner"],
    );
    assert.equal(f.policies.active("global").id, previous);
    f.policies.setModelCapabilities(() => ({ Planner: { tested: ["low"] } }));
    assert.throws(
      () =>
        f.policies.publish(
          "global",
          {
            ...defaultPolicy,
            models: { Planner: { model: "tested", reasoning: "high" } },
          },
          false,
        ),
      /Unsupported model/,
    );
    const valid = f.policies.publish(
      "global",
      {
        ...defaultPolicy,
        models: { Planner: { model: "tested", reasoning: "low" } },
      },
      true,
    );
    assert.equal(f.policies.active("global").id, valid.id);
  } finally {
    f.close();
  }
});
test("model catalogs: publication uses the intersection of current certified runtimes and rejects stale catalogs", () => {
  const f = fixture();
  try {
    const containment = new Containment(f.store, "fixture-source");
    const first = certificate({ Researcher: { tested: ["low", "high"] } });
    containment.install(first);
    containment.install(
      certificate({ Researcher: { tested: ["low"] } }, "fixture-2"),
    );
    assert.deepEqual(containment.capabilities(), {
      Researcher: { tested: ["low"] },
    });
    f.policies.setModelCapabilities(() => containment.capabilities());
    assert.throws(
      () =>
        f.policies.publish(
          "global",
          {
            ...defaultPolicy,
            models: { Researcher: { model: "tested", reasoning: "high" } },
          },
          true,
        ),
      /Unsupported model/,
    );
    f.clock.tick(1_000_000);
    assert.deepEqual(containment.capabilities(), {});
    assert.throws(
      () =>
        f.policies.publish(
          "global",
          {
            ...defaultPolicy,
            models: { Researcher: { model: "tested", reasoning: "low" } },
          },
          true,
        ),
      /Unsupported model/,
    );
  } finally {
    f.close();
  }
});
test("model settings: root and specialist keep assigned settings, and runtime attachment rechecks them", () => {
  const f = fixture();
  try {
    const cert = certificate({
      Conductor: { tested: ["high"] },
      Researcher: { tested: ["low", "high"] },
    });
    const containment = new Containment(f.store, "fixture-source", () => {
      const root = f.store.list<any>("session")[0];
      return {
        Id: "c".repeat(64),
        Image: cert.image,
        State: { Running: true },
        Config: {
          User: "1000:1000",
          Env: [],
          Labels: {
            "agent-harness.session": root.runtimeSession,
            "agent-harness.connection": root.connection,
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
      } satisfies ContainerInspection;
    });
    containment.install(cert);
    f.policies.setModelCapabilities(() => containment.capabilities());
    f.policies.publish(
      "global",
      {
        ...defaultPolicy,
        models: { Conductor: { model: "tested", reasoning: "high" } },
      },
      true,
    );
    const root = f.register().session;
    assert.deepEqual(root.model, { model: "tested", reasoning: "high" });
    containment.attach(root, "c".repeat(64), cert.id);
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
        (s) => containment.capabilities(s),
      );
    const child = workflow.admit(root, "Researcher", {
      model: "tested",
      reasoning: "low",
    }).session;
    assert.deepEqual(f.identity.session(child.session).model, {
      model: "tested",
      reasoning: "low",
    });
    assert.throws(
      () =>
        containment.attach(
          { ...root, model: { model: "override", reasoning: "high" } },
          "c".repeat(64),
          cert.id,
        ),
      /unsupported_model/,
    );
  } finally {
    f.close();
  }
});
