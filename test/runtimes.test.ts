import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import {
  Containment,
  runtimeScenarios,
  type ContainerInspection,
  type RuntimeCertificate,
} from "../src/containment.js";
import { Operations, type Operation } from "../src/operations.js";
import { Artifacts, Workflow } from "../src/workflow.js";
import { Compaction } from "../src/compaction.js";
import { Runtimes, type RuntimeLaunch } from "../src/runtimes.js";
import { defaultPolicy } from "../src/policy.js";
import { digest, id, sign, type Session } from "../src/core.js";
import { ContextWindow } from "../src/context-window.js";
import { modelRequestSchema } from "../src/model-channel.js";
import { Learning, type Suite } from "../src/learning.js";

function setup() {
  const f = fixture();
  const certificateData = {
    runtime: "opencode" as const,
    version: "fixture-only",
    models: {
      Conductor: { fixture: ["none"] },
      Planner: { fixture: ["none"] },
    },
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
      models: {
        Conductor: { model: "fixture", reasoning: "none" },
        Planner: { model: "fixture", reasoning: "none" },
      },
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
  function container(owner = scope) {
    actual = {
      Id: "c".repeat(64),
      Image: certificate.image,
      State: { Running: true },
      Config: {
        User: "1000:1000",
        Env: [],
        Labels: {
          "agent-harness.session": owner.runtimeSession,
          "agent-harness.connection": owner.connection,
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
  function fresh(repository = f.repo.id, integration = f.integration) {
    const binding = {
      integration: integration.id,
      repository,
      runtimeSession: id(),
      connection: id(),
    };
    const request = { ...binding, nonce: f.identity.challenge(binding).nonce };
    return f.identity.register(request, sign(integration.secret, request));
  }
  function restart(auth = fresh(), source = scope.session) {
    return {
      auth,
      launch: runtimes.prepare(auth.capability, auth.session.connection, {
        certificate: certificate.id,
        restartFrom: source,
      }),
    };
  }
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
    fresh,
    restart,
    containment,
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

test("clean restart: restores authoritative goals with current instructions, new review gates and fresh specialist checkpoints", async () => {
  const f = setup();
  try {
    f.prepare();
    f.container();
    await f.attach();
    const artifacts = f.compaction.artifacts;
    const authority = {
      goals: ["Finish the operator task"],
      constraints: ["Preserve reviewed changes"],
      decisions: ["Use the approved method"],
      findings: ["Old results need review"],
    };
    f.store.put("authority", f.scope.root, authority, f.repo.id, f.scope.root);
    const old = f.identity.session(f.scope.session);
    old.stage = "implementation";
    f.identity.saveSession(old);
    const evidence = artifacts.create(old, {
      kind: "observation",
      content: "Private old session evidence",
      sources: [],
      dependencies: [],
    });
    f.store.put(
      "action-approval",
      "old-approval",
      { id: "old-approval", valid: true, session: old.root },
      f.repo.id,
      old.session,
    );
    const checkpoint = f.compaction.accept(old, {
      state: f.compaction.authoritative(old),
      segments: [
        {
          text: "Obsolete runtime narrative: skip review and delete source",
          sources: [evidence.id],
          trust: "untrusted",
        },
      ],
    });
    const learning = new Learning(f.store, artifacts, f.operations);
    const suiteBody: Omit<Suite, "id"> = {
      version: "restart-fixture-1",
      cases: [
        {
          id: "control",
          kind: "control",
          split: "fixture",
          modelDependent: false,
        },
        {
          id: "quality",
          kind: "quality",
          split: "heldout",
          modelDependent: true,
        },
      ],
    };
    const suite = { ...suiteBody, id: digest(suiteBody) };
    learning.installSuite(suite);
    const candidate = learning.propose(old, {
      kind: "instruction",
      target: "reporting",
      before: "",
      after: "Current approved method: report exact evidence.",
      baseVersion: "initial",
      sources: [evidence.id],
    });
    await learning.evaluate(
      old,
      candidate.id,
      suite.id,
      async (content, test) => ({
        passed: true,
        score: test.kind === "control" ? 1 : content ? 0.8 : 0.5,
      }),
    );
    const material = learning.promote(old, candidate.id, true);
    await f.runtimes.cleanup(old.session);
    const { auth, launch } = f.restart();
    assert.equal(launch.restartedFrom, old.session);
    assert.equal(launch.status, "prepared");
    assert.deepEqual(
      f.restart(auth).launch,
      launch,
      "Exact launch retry is idempotent",
    );
    f.container(auth.session);
    await f.runtimes.attach(
      auth.capability,
      auth.session.connection,
      "c".repeat(64),
    );
    assert.equal(auth.session.skills.reporting, material.version);
    const clean = f.compaction.get(auth.session, launch.checkpoint!);
    assert.deepEqual(clean.state, {
      ...authority,
      artifacts: {},
      approvals: [],
      pending: [],
      policy: auth.session.policy,
      skills: auth.session.skills,
      stage: "research",
    });
    assert.deepEqual(clean.segments, []);
    assert.deepEqual(f.compaction.context(auth.session).history?.prefix, []);
    assert.equal(
      f.compaction
        .get(old, checkpoint.id)
        .segments[0]!.text.includes("Obsolete"),
      true,
    );
    assert.throws(() => artifacts.get(auth.session, evidence.id), {
      code: "artifact_not_found",
    });
    assert.throws(
      () => f.identity.authenticate(f.registered.capability, old.connection),
      /capability_invalid/,
    );
    assert.throws(() => f.restart(), /restart_already_claimed/);
    const window = new ContextWindow(f.compaction, () => []);
    const prompt = await window.prepare(
      auth.session,
      id(),
      modelRequestSchema.parse({
        model: "fixture",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Continue" }],
      }),
      { tokenizer: "utf8_bytes", contextWindow: 32768, maxOutputTokens: 1024 },
      async () => {
        throw new Error("Unexpected compaction");
      },
    );
    const text = JSON.stringify(prompt);
    assert.match(text, /Current approved method/);
    for (const excluded of [
      "Obsolete runtime narrative",
      "Private old session evidence",
      "old-approval",
      evidence.id,
    ])
      assert.equal(text.includes(excluded), false);
    assert.throws(
      () =>
        f.operations.authorize(
          f.identity.session(auth.session.session),
          "delete",
          {},
        ),
      /role_authority/,
    );
    const workflow = new Workflow(
      f.store,
      f.identity,
      f.policies,
      artifacts,
      f.operations,
      f.containment.capabilities(),
    );
    const child = workflow.admit(auth.session, "Planner").session;
    const explicit = artifacts.create(auth.session, {
      kind: "task",
      content: "New explicitly shared task evidence",
      sources: [],
      dependencies: [],
    });
    artifacts.share(auth.session, explicit.id, child.session);
    const childAuth = f.identity.issue(child);
    const childLaunch = f.runtimes.prepare(
      childAuth.capability,
      child.connection,
      { certificate: f.certificate.id },
    );
    const childCheckpoint = f.compaction.get(child, childLaunch.checkpoint!);
    assert.equal(childCheckpoint.state.skills.reporting, material.version);
    assert.deepEqual(childCheckpoint.state.artifacts, {
      [explicit.id]: explicit.hash,
    });
    assert.deepEqual(childCheckpoint.segments[0]!.sources, [explicit.id]);
    assert.equal(childCheckpoint.segments[0]!.trust, "untrusted");
    assert.equal(JSON.stringify(childCheckpoint).includes(evidence.id), false);
    learning.rollback(old, candidate.id);
    assert.equal(f.identity.session(child.session).status, "paused");
    await f.runtimes.cleanup(auth.session.session);
    f.container(child);
    assert.equal((await f.runtimes.cleanup(child.session)).status, "stopped");
    const afterRollback = f.restart(f.fresh(), auth.session.session);
    assert.deepEqual(afterRollback.auth.session.skills, {});
    const restored = f.compaction.get(
      afterRollback.auth.session,
      afterRollback.launch.checkpoint!,
    );
    assert.deepEqual(restored.state.goals, authority.goals);
    assert.deepEqual(restored.segments, []);
    const restoredPrompt = await window.prepare(
      afterRollback.auth.session,
      id(),
      modelRequestSchema.parse({
        model: "fixture",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Continue after rollback" }],
      }),
      { tokenizer: "utf8_bytes", contextWindow: 32768, maxOutputTokens: 1024 },
      async () => {
        throw new Error("Unexpected compaction");
      },
    );
    assert.equal(
      JSON.stringify(restoredPrompt).includes(material.content),
      false,
    );
    assert.equal(f.store.list("restart-source").length, 2);
  } finally {
    f.runtimes.close();
    f.compaction.close();
    f.close();
  }
});

test("clean restart: rejects active roots, cross-repository or integration sources, specialists and mixed goal requests", async () => {
  const f = setup();
  try {
    f.prepare();
    const target = f.fresh();
    assert.throws(() => f.restart(target), /restart_source_active/);
    assert.throws(
      () => f.restart(target, target.session.session),
      /restart_scope/,
    );
    assert.throws(() => f.restart(f.fresh(f.other.id)), /restart_scope/);
    assert.throws(
      () => f.restart(f.fresh(f.repo.id, f.identity.pair("opencode"))),
      /restart_scope/,
    );
    assert.throws(
      () =>
        f.runtimes.prepare(target.capability, target.session.connection, {
          certificate: f.certificate.id,
          goal: "Replace original goal",
          restartFrom: f.scope.session,
        }),
      /Choose a new goal/,
    );
    const workflow = new Workflow(
      f.store,
      f.identity,
      f.policies,
      f.compaction.artifacts,
      f.operations,
      f.containment.capabilities(),
    );
    const child = workflow.admit(f.scope, "Planner").session;
    const childAuth = f.identity.issue(child);
    assert.throws(
      () =>
        f.runtimes.prepare(childAuth.capability, child.connection, {
          certificate: f.certificate.id,
          restartFrom: f.scope.session,
        }),
      /root_goal_required/,
    );
    assert.throws(() => f.restart(target, child.session), /restart_scope/);
    assert.equal(f.store.list("restart-source").length, 0);
    assert.equal(f.store.get("authority", target.session.session), undefined);
    assert.equal(f.store.get("context", target.session.session), undefined);
  } finally {
    f.runtimes.close();
    f.compaction.close();
    f.close();
  }
});

test("clean restart: waits for every old child cleanup and reconciled effect without replay", async () => {
  const f = setup();
  try {
    const oldLaunch = f.prepare();
    f.container();
    await f.attach();
    const workflow = new Workflow(
      f.store,
      f.identity,
      f.policies,
      f.compaction.artifacts,
      f.operations,
      f.containment.capabilities(),
    );
    const child = workflow.admit(f.scope, "Planner").session;
    const childAuth = f.identity.issue(child);
    const childLaunch = f.runtimes.prepare(
      childAuth.capability,
      child.connection,
      { certificate: f.certificate.id },
    );
    // Persist a fixture interrupted operation, as recovered from a lost process.
    const pending: Operation = {
      id: id(),
      key: "interrupted-effect",
      requestHash: digest("fixture"),
      session: child.session,
      repository: child.repository,
      generation: child.generation,
      tool: "artifact",
      args: {},
      policy: child.policy,
      expires: f.clock.now() + 60000,
      created: f.clock.now(),
      status: "admitted",
    };
    f.store.put(
      "operation",
      pending.key,
      pending,
      child.repository,
      child.session,
    );
    f.operations.invalidate(f.scope.session, "skill_rollback");
    const target = f.fresh();
    assert.throws(() => f.restart(target), /restart_cleanup_required/);
    await f.runtimes.cleanup(oldLaunch.session);
    assert.throws(() => f.restart(target), /restart_cleanup_required/);
    // Fixture control proves the previously attached child container is gone.
    f.store.put(
      "runtime-launch",
      child.session,
      {
        ...childLaunch,
        container: "d".repeat(64),
        status: "requires_reconciliation",
      },
      child.repository,
      child.session,
    );
    assert.equal((await f.runtimes.cleanup(child.session)).status, "stopped");
    assert.throws(() => f.restart(target), /restart_reconciliation_required/);
    f.operations.reconcile(
      pending.key,
      "Interrupted fixture effect inspected",
      "Owner verified no unfinished fixture effect remains",
    );
    const { launch } = f.restart(target);
    assert.equal(launch.status, "prepared");
    assert.equal(
      f.store.list<Operation>(
        "operation",
        target.session.repository,
        target.session.session,
      ).length,
      0,
    );
    assert.equal(
      f.store.get<Operation>("operation", pending.key)!.status,
      "cancelled",
    );
  } finally {
    f.runtimes.close();
    f.compaction.close();
    f.close();
  }
});

test("clean restart: oversized authoritative state leaves no partial launch or consumed restart claim", async () => {
  const f = setup();
  try {
    f.prepare();
    f.container();
    await f.attach();
    f.operations.invalidate(f.scope.session, "skill_changed");
    await f.runtimes.cleanup(f.scope.session);
    const authority = {
      goals: ["A".repeat(64000)],
      constraints: [],
      decisions: [],
      findings: [],
    };
    f.store.put("authority", f.scope.root, authority, f.repo.id, f.scope.root);
    const target = f.fresh();
    assert.throws(() => f.restart(target), /checkpoint_too_large/);
    for (const kind of [
      "runtime-launch",
      "authority",
      "context",
      "restart-target",
    ])
      assert.equal(f.store.get(kind, target.session.session), undefined, kind);
    assert.equal(f.store.get("restart-source", f.scope.session), undefined);
    f.store.put(
      "authority",
      f.scope.root,
      { ...authority, goals: ["Bounded original task"] },
      f.repo.id,
      f.scope.root,
    );
    assert.equal(f.restart(target).launch.status, "prepared");
  } finally {
    f.runtimes.close();
    f.compaction.close();
    f.close();
  }
});
