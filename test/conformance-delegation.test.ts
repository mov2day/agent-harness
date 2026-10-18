import test from "node:test";
import assert from "node:assert/strict";
import { digest, type Role, type Session } from "../src/core.js";
import { Learning, type Suite } from "../src/learning.js";
import { Operations, type Tool } from "../src/operations.js";
import { defaultPolicy, type Policy } from "../src/policy.js";
import { Artifacts, Workflow } from "../src/workflow.js";
import { fixture } from "./helpers.js";

// Delegation and registration cells of conformance/matrix.json: children inherit
// the root's restrictions, and registration grants only Conductor authority.
const policy: Policy = {
  ...defaultPolicy,
  deletion: true,
  tools: [
    "read",
    "change",
    "delete",
    "rename",
    "execute",
    "research",
    "artifact",
    "review",
    "compact",
    "delegate",
    "learn",
  ],
  domains: ["example.com"],
  commands: [{ executable: "/bin/echo", args: ["ok"], env: {}, cwd: "src" }],
  maxSpecialists: 4,
};
function setup() {
  const f = fixture();
  f.policies.publish("global", policy, true);
  const root = f.register().session;
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
    );
  const stage = (value: Session["stage"]) =>
    f.identity.saveSession({
      ...f.identity.session(root.session),
      stage: value,
    });
  const child = (role: Exclude<Role, "Conductor">) => {
    const { session } = workflow.admit(f.identity.session(root.session), role);
    session.enforcement = "enforced";
    f.identity.saveSession(session);
    return session;
  };
  return { ...f, root, operations, artifacts, workflow, stage, child };
}

test("delegation: a child holds only its own role's tools and cannot delegate further", () => {
  const f = setup();
  try {
    const researcher = f.child("Researcher");
    assert.equal(researcher.policy, f.root.policy);
    assert.equal(researcher.repository, f.root.repository);
    for (const tool of [
      "change",
      "delete",
      "rename",
      "execute",
      "delegate",
      "review",
      "learn",
    ] as Tool[])
      assert.throws(
        () => f.operations.authorize(researcher, tool, {}),
        /role_authority/,
        tool,
      );
    assert.throws(
      () => f.workflow.admit(researcher, "Reviewer"),
      /delegation_authority/,
    );
    assert.throws(
      () => f.workflow.admit(f.child("Implementer"), "Implementer"),
      /delegation_authority/,
    );
  } finally {
    f.close();
  }
});

test("delegation: children are bound to the root's command and domain allowlists", () => {
  const f = setup();
  try {
    f.stage("execution");
    const verifier = f.child("Executor");
    for (const patch of [
      { executable: "/bin/sh" },
      { args: ["ok", "extra"] },
      { env: { LD_PRELOAD: "/tmp/x" } },
      { cwd: "." },
    ])
      assert.throws(
        () =>
          f.operations.authorize(verifier, "execute", {
            executable: "/bin/echo",
            args: ["ok"],
            env: {},
            cwd: "src",
            snapshot: "x",
            approval: "x",
            ...patch,
          }),
        /command_denied/,
        JSON.stringify(patch),
      );
    f.stage("research");
    const researcher = f.child("Researcher");
    for (const url of [
      "https://evil.net/",
      "https://sub.example.com/",
      "https://example.com.evil.net/",
    ])
      assert.throws(
        () => f.operations.authorize(researcher, "research", { url }),
        /domain_denied/,
        url,
      );
    f.operations.authorize(researcher, "research", {
      url: "https://example.com/",
    });
  } finally {
    f.close();
  }
});

test("delegation: tightening policy stops existing children, whatever their lease or role", () => {
  const f = setup();
  try {
    f.stage("research");
    const researcher = f.child("Researcher"),
      before = f.identity.issue(researcher).capability;
    f.operations.authorize(researcher, "research", {
      url: "https://example.com/",
    });
    f.policies.publish("global", { ...policy, domains: [] }, true);
    assert.throws(
      () =>
        f.operations.authorize(researcher, "research", {
          url: "https://example.com/",
        }),
      /policy_changed/,
    );
    const stored = f.identity.session(researcher.session);
    assert.throws(
      () => f.identity.authenticate(before, researcher.connection),
      /policy_changed|capability_/,
    );
    assert.notEqual(stored.status, "active");
    assert.throws(
      () =>
        f.identity.authenticate(
          f.identity.issue(stored).capability,
          researcher.connection,
        ),
      /policy_changed|session_inactive|capability_/,
    );
  } finally {
    f.close();
  }
});

test("delegation: a child keeps the approved material captured by its root and sees no later publication", async () => {
  const f = setup();
  try {
    const reviewer = f.child("Reviewer");
    assert.deepEqual(reviewer.skills, f.root.skills);
    const learning = new Learning(f.store, f.artifacts, f.operations),
      source = f.artifacts.create(f.root, {
        kind: "observation",
        content: "public fact",
        dependencies: [],
        sources: [],
      }),
      candidate = learning.propose(f.root, {
        kind: "skill",
        target: "late-skill",
        baseVersion: "initial",
        before: "",
        after: "Prefer small reviewed changes.",
        sources: [source.id],
      }),
      base = {
        version: "v1",
        cases: [
          {
            id: "mandatory",
            kind: "control",
            split: "fixture",
            modelDependent: false,
          },
          {
            id: "quality",
            kind: "quality",
            split: "fixture",
            modelDependent: true,
          },
          {
            id: "heldout",
            kind: "quality",
            split: "heldout",
            modelDependent: true,
          },
        ],
      } as const,
      suite: Suite = { ...base, cases: [...base.cases], id: digest(base) };
    learning.installSuite(suite);
    await learning.evaluate(
      f.root,
      candidate.id,
      suite.id,
      async (content, c) => ({
        passed: true,
        score: c.kind === "control" ? 1 : content?.length ? 0.8 : 0.6,
      }),
    );
    learning.promote(f.root, candidate.id, true);
    assert.ok("late-skill" in f.identity.approvedSkills(f.repo.id));
    const stored = f.identity.session(reviewer.session);
    assert.equal("late-skill" in stored.skills, false);
    let loaded: unknown[] = [];
    try {
      loaded = f.identity.materials(stored);
    } catch {
      // Promotion invalidates running children; either outcome is safe.
    }
    assert.equal(JSON.stringify(loaded).includes("late-skill"), false);
  } finally {
    f.close();
  }
});

test("registration: policy changes void the registered session and a fresh Conductor holds no review or change authority", () => {
  const f = setup();
  try {
    const conductor = f.identity.session(f.root.session);
    assert.equal(conductor.role, "Conductor");
    for (const tool of ["review", "change", "execute", "delete"] as Tool[])
      assert.throws(
        () => f.operations.authorize(conductor, tool, {}),
        /role_authority/,
        tool,
      );
    assert.equal(
      f.store.list<Session>("session").filter((s) => s.role !== "Conductor")
        .length,
      0,
    );
    const capability = f.identity.issue(conductor).capability;
    f.identity.authenticate(capability, conductor.connection);
    f.policies.publish("global", { ...policy, maxDepth: 1 }, true);
    const stored = f.identity.session(conductor.session),
      fresh = f.identity.issue(stored).capability;
    for (const token of [capability, fresh]) {
      assert.throws(
        () => f.identity.authenticate(token, conductor.connection),
        /policy_changed|capability_/,
      );
      assert.throws(
        () => f.identity.renew(token, conductor.connection),
        /policy_changed|capability_|renewal_/,
      );
    }
    assert.notEqual(stored.status, "active");
  } finally {
    f.close();
  }
});
