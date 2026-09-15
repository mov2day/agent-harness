import test from "node:test";
import assert from "node:assert/strict";
import { Artifacts, Workflow, type Artifact } from "../src/workflow.js";
import { Operations } from "../src/operations.js";
import { defaultPolicy } from "../src/policy.js";
import { id, canonical, type Session, type Role } from "../src/core.js";
import { fixture } from "./helpers.js";
function setup(limit = 1, humanGates: typeof defaultPolicy.humanGates = []) {
  const f = fixture();
  f.policies.publish(
    "global",
    { ...defaultPolicy, revisionLimit: limit, humanGates, maxSpecialists: 4 },
    true,
  );
  const root = f.register().session;
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
      { Researcher: { model: ["high"] } },
    );
  artifacts.setInvalidator((root) =>
    operations.invalidate(root, "artifact_changed"),
  );
  const child = (role: Exclude<Role, "Conductor">) =>
    workflow.admit(root, role).session;
  return { ...f, root, operations, artifacts, workflow, child };
}
test("admission: concurrent limit, engine roles, depth, model validation and repository isolation", async () => {
  const f = setup();
  try {
    assert.throws(
      () =>
        f.workflow.admit(f.root, "Researcher", {
          model: "model",
          reasoning: "ultra",
        }),
      /unsupported_model/,
    );
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        Promise.resolve().then(() => f.child("Researcher")),
      ),
    );
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 4);
    const child = f.store.list<Session>("session").find((s) => s.parent)!;
    assert.throws(
      () => f.workflow.admit(child, "Reviewer"),
      /delegation_authority/,
    );
    assert.equal(child.enforcement, "unverified");
    assert.notEqual(child.session, f.root.session);
    assert.equal(child.repository, f.repo.id);
    const other = {
      ...f.root,
      session: "other",
      root: "other",
      repository: f.other.id,
    };
    f.identity.saveSession(other);
    assert.throws(
      () => f.workflow.terminate(other, child.session),
      /delegation_scope/,
    );
  } finally {
    f.close();
  }
});
test("artifacts: guessed identifiers, explicit sharing, diamond invalidation and cycle rejection", () => {
  const f = setup();
  try {
    const owner = f.child("Planner"),
      reviewer = f.child("Reviewer");
    const create = (dependencies: string[] = []) =>
      f.artifacts.create(owner, {
        kind: "plan",
        content: id(),
        dependencies,
        sources: [],
      });
    const a = create(),
      b = create([a.id]),
      c = create([a.id]),
      d = create([b.id, c.id]),
      unrelated = create();
    assert.throws(() => f.artifacts.get(reviewer, a.id), /Artifact not found/);
    f.artifacts.share(owner, a.id, reviewer.session);
    assert.equal(f.artifacts.get(reviewer, a.id).hash, a.hash);
    const foreign = { ...reviewer, repository: f.other.id };
    assert.throws(() => f.artifacts.get(foreign, a.id), /Artifact not found/);
    assert.throws(() => f.artifacts.share(owner, a.id, f.other.id));
    assert.deepEqual(
      new Set(f.artifacts.invalidate(owner, a.id)),
      new Set([a.id, b.id, c.id, d.id]),
    );
    assert.equal(f.artifacts.get(owner, unrelated.id).valid, true);
    a.dependencies = [d.id];
    f.store.put("artifact", a.id, a, f.repo.id, owner.session);
    assert.throws(() => f.artifacts.assertDag(f.repo.id), /dependency_cycle/);
  } finally {
    f.close();
  }
});
test("reviews: revision zero, one corrective review, last-pass advancement and last-fail attention", () => {
  for (const limit of [0, 1])
    for (const pass of [false, true]) {
      const f = setup(limit);
      try {
        const researcher = f.child("Researcher"),
          reviewer = f.child("Reviewer");
        const submit = () => {
          const a = f.artifacts.create(researcher, {
            kind: "research",
            content: id(),
            dependencies: [],
            sources: [],
          });
          f.artifacts.share(researcher, a.id, reviewer.session);
          f.workflow.submit(researcher, a.id);
          return a;
        };
        let a = submit();
        if (limit === 1) {
          f.workflow.review(reviewer, a.id, [
            { message: "correct", blocking: true },
          ]);
          assert.equal(f.identity.session(f.root.session).stage, "research");
          a = submit();
        }
        f.workflow.review(
          reviewer,
          a.id,
          pass ? [] : [{ message: "blocked", blocking: true }],
        );
        const root = f.identity.session(f.root.session);
        assert.equal(root.status, pass ? "active" : "needs_attention");
        assert.equal(root.stage, pass ? "plan" : "research");
      } finally {
        f.close();
      }
    }
});
test("human gates bind exact versions and upstream invalidation pauses workflow", () => {
  const f = setup(1, ["research"]);
  try {
    const researcher = f.child("Researcher"),
      reviewer = f.child("Reviewer");
    const source = f.artifacts.create(researcher, {
      kind: "source",
      content: "source",
      dependencies: [],
      sources: [],
    });
    const a = f.artifacts.create(researcher, {
      kind: "research",
      content: "report",
      dependencies: [source.id],
      sources: [],
    });
    f.artifacts.share(researcher, a.id, reviewer.session);
    f.workflow.submit(researcher, a.id);
    const review = f.workflow.review(reviewer, a.id, []);
    assert.equal(f.identity.session(f.root.session).stage, "research");
    assert.throws(
      () => f.workflow.approveStage(f.root.session, "wrong", review.id),
      /human_gate_stale/,
    );
    f.artifacts.invalidate(researcher, source.id);
    assert.throws(
      () => f.workflow.approveStage(f.root.session, a.id, review.id),
      /workflow_authority|review_stale/,
    );
    assert.equal(f.identity.session(f.root.session).status, "paused");
  } finally {
    f.close();
  }
});
test("change approvals require exact reviewed changes and cannot authorize unrelated actions", () => {
  const f = setup();
  try {
    const implementer = f.child("Implementer"),
      reviewer = f.child("Reviewer");
    const args = { path: "src/a", base: null, content: "approved" },
      a = f.artifacts.create(implementer, {
        kind: "change-set",
        content: canonical({ tool: "change", args }),
        dependencies: [],
        sources: [],
      });
    f.artifacts.share(implementer, a.id, reviewer.session);
    assert.throws(
      () =>
        f.workflow.approveAction(f.root.session, "change", args, [a.id], true),
      /review_required/,
    );
    f.workflow.reviewChange(reviewer, a.id, []);
    assert.throws(
      () =>
        f.workflow.approveAction(
          f.root.session,
          "change",
          { ...args, path: "src/b" },
          [a.id],
          true,
        ),
      /reviewed_change_mismatch/,
    );
    assert.ok(
      f.workflow.approveAction(f.root.session, "change", args, [a.id], true)
        .valid,
    );
  } finally {
    f.close();
  }
});
