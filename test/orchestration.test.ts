import test from "node:test";
import assert from "node:assert/strict";
import { Artifacts, Workflow } from "../src/workflow.js";
import { Operations } from "../src/operations.js";
import { defaultPolicy, type Policy } from "../src/policy.js";
import { builtinAgents } from "../src/agents.js";
import { id, type Role } from "../src/core.js";
import { delegateSchema } from "../src/specialists.js";
import { fixture } from "./helpers.js";

export function setup(patch: Partial<Policy> = {}) {
  const f = fixture();
  f.policies.publish(
    "global",
    { ...defaultPolicy, humanGates: [], maxSpecialists: 6, ...patch },
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
    );
  const child = (role: Exclude<Role, "Conductor">) =>
    workflow.admit(f.identity.session(root.session), role).session;
  const stage = () => f.identity.session(root.session).stage;
  const attempt = (key = stage()) =>
    f.store.get<{ state: string; revision: number }>(
      "stage-attempt",
      `${root.session}:${key}`,
    )!;
  /** Submit as the stage's agent and share the artifact with the checker. */
  const submit = (
    worker: ReturnType<typeof child>,
    ...checkers: ReturnType<typeof child>[]
  ) => {
    const a = artifacts.create(worker, {
      kind: "work",
      content: id(),
      dependencies: [],
      sources: [],
    });
    for (const c of checkers) artifacts.share(worker, a.id, c.session);
    workflow.submit(worker, a.id);
    return a;
  };
  return { ...f, root, workflow, artifacts, child, stage, attempt, submit };
}

test("the Verifier checks every stage before the Reviewer and cannot be skipped", () => {
  const f = setup();
  try {
    const researcher = f.child("Researcher"),
      planner = f.child("Planner"),
      verifier = f.child("Verifier"),
      reviewer = f.child("Reviewer");
    const research = f.submit(researcher, verifier, reviewer);
    assert.equal(f.attempt().state, "verify");
    assert.throws(
      () => f.workflow.review(reviewer, research.id, []),
      /verifier_role/,
    );
    f.workflow.review(verifier, research.id, []);
    assert.equal(f.stage(), "plan", "research is verified but not reviewed");
    const plan = f.submit(planner, verifier, reviewer);
    assert.throws(
      () => f.workflow.review(reviewer, plan.id, []),
      /verifier_role/,
    );
    f.workflow.review(verifier, plan.id, []);
    assert.equal(f.attempt().state, "review");
    assert.throws(
      () => f.workflow.review(verifier, plan.id, []),
      /reviewer_role/,
    );
    f.workflow.review(reviewer, plan.id, []);
    assert.equal(f.stage(), "implementation");
  } finally {
    f.close();
  }
});

test("a blocking verification finding uses the shared revision limit", () => {
  for (const limit of [0, 1]) {
    const f = setup({ revisionLimit: limit });
    try {
      const researcher = f.child("Researcher"),
        verifier = f.child("Verifier");
      const first = f.submit(researcher, verifier);
      f.workflow.review(verifier, first.id, [
        { message: "off path", blocking: true },
      ]);
      if (limit === 0) {
        assert.equal(f.attempt().state, "needs_attention");
        assert.equal(
          f.identity.session(f.root.session).status,
          "needs_attention",
        );
      } else {
        assert.equal(f.attempt().state, "revision_required");
        const second = f.submit(researcher, verifier);
        f.workflow.review(verifier, second.id, []);
        assert.equal(f.stage(), "plan");
      }
    } finally {
      f.close();
    }
  }
});

test("configured checkpoints can be absent for a stage", () => {
  const f = setup({
    orchestration: { verifyStages: [], reviewStages: [] },
  });
  try {
    f.submit(f.child("Researcher"));
    assert.equal(f.stage(), "plan");
  } finally {
    f.close();
  }
});

test("the Orchestrator routes through a chosen subset of stages and closes the task", () => {
  const f = setup();
  try {
    const root = () => f.identity.session(f.root.session);
    const verifier = f.child("Verifier"),
      reviewer = f.child("Reviewer"),
      planner = f.child("Planner");
    const routed = f.workflow.setRoute(root(), ["plan"]);
    assert.deepEqual(routed.route, ["plan"]);
    assert.equal(f.stage(), "plan");
    assert.throws(
      () => f.workflow.setRoute(root(), ["plan"]),
      /route_already_set/,
    );
    const plan = f.submit(planner, verifier, reviewer);
    f.workflow.review(verifier, plan.id, []);
    f.workflow.review(reviewer, plan.id, []);
    assert.equal(f.stage(), "complete");
  } finally {
    f.close();
  }
});

test("invalid, unauthorized or late routes are rejected", () => {
  const f = setup();
  try {
    const root = () => f.identity.session(f.root.session);
    for (const stages of [
      [],
      ["plan", "research"],
      ["plan", "plan"],
      ["complete"],
    ])
      assert.throws(
        () => f.workflow.setRoute(root(), stages as never),
        /route_invalid/,
        JSON.stringify(stages),
      );
    assert.throws(
      () => f.workflow.setRoute(f.child("Planner"), ["plan"]),
      /route_authority/,
    );
    f.submit(f.child("Researcher"));
    assert.throws(
      () => f.workflow.setRoute(root(), ["plan"]),
      /route_after_work/,
    );
  } finally {
    f.close();
  }
});

test("a route needs an enabled agent for every stage", () => {
  const f = setup({
    agents: builtinAgents.map((a) =>
      a.id === "planner" ? { ...a, enabled: false } : a,
    ),
  });
  try {
    assert.throws(
      () => f.workflow.setRoute(f.identity.session(f.root.session), ["plan"]),
      /No enabled agent can perform plan/,
    );
    f.workflow.setRoute(f.identity.session(f.root.session), [
      "research",
      "implementation",
    ]);
  } finally {
    f.close();
  }
});

test("delegation accepts agent, route and Executor assignments", () => {
  assert.ok(
    delegateSchema.safeParse({ role: "Executor", task: "run" }).success,
  );
  assert.ok(
    delegateSchema.safeParse({ agent: "auditor", task: "look" }).success,
  );
  assert.ok(
    delegateSchema.safeParse({ action: "route", stages: ["plan"] }).success,
  );
  assert.ok(!delegateSchema.safeParse({ task: "none" }).success);
  assert.ok(
    !delegateSchema.safeParse({ action: "route", stages: ["done"] }).success,
  );
});

import { Specialists } from "../src/specialists.js";
import type { StageStart } from "../src/workflow.js";

const gate = (f: ReturnType<typeof setup>, stage: string) =>
  f.store.get<StageStart>("stage-start", `${f.root.session}:${stage}`);

test("a start review holds the stage until the owner approves it", () => {
  const f = setup({
    humanReview: { ...defaultPolicy.humanReview, beforeStages: ["plan"] },
  });
  try {
    const verifier = f.child("Verifier"),
      planner = f.child("Planner"),
      researcher = f.child("Researcher");
    // Research has no start review; finishing it opens the plan review.
    const research = f.submit(researcher, verifier);
    f.workflow.review(verifier, research.id, []);
    assert.equal(f.stage(), "plan");
    assert.equal(gate(f, "plan")?.state, "pending");
    const artifact = f.artifacts.create(planner, {
      kind: "plan",
      content: id(),
      dependencies: [],
      sources: [],
    });
    assert.throws(
      () => f.workflow.submit(planner, artifact.id),
      /stage_start_pending/,
    );
    assert.throws(
      () =>
        f.workflow.approveStart(f.root.session, "implementation", "approve"),
      /stage_start_stale/,
    );
    f.workflow.approveStart(f.root.session, "plan", "approve", "go ahead");
    f.workflow.submit(planner, artifact.id);
    assert.equal(f.attempt().state, "verify");
    assert.throws(
      () => f.workflow.approveStart(f.root.session, "plan", "approve"),
      /stage_start_decided/,
    );
  } finally {
    f.close();
  }
});

test("rejecting a start review pauses the task and keeps the reason", () => {
  const f = setup({
    humanReview: { ...defaultPolicy.humanReview, beforeStages: ["research"] },
  });
  try {
    f.workflow.setRoute(f.identity.session(f.root.session), ["research"]);
    assert.equal(gate(f, "research")?.state, "pending");
    f.workflow.approveStart(f.root.session, "research", "reject", "wrong repo");
    assert.equal(gate(f, "research")?.comment, "wrong repo");
    assert.equal(f.identity.session(f.root.session).status, "needs_attention");
    assert.throws(() => f.submit(f.child("Researcher")));
  } finally {
    f.close();
  }
});

test("delegation waits for the start review and the review opens on first use", () => {
  const f = setup({
    humanReview: { ...defaultPolicy.humanReview, beforeStages: ["research"] },
  });
  try {
    const root = f.identity.session(f.root.session);
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
    assert.equal(gate(f, "research"), undefined);
    assert.throws(
      () =>
        specialists.execute(f.identity.session(root.session), {
          role: "Researcher",
          task: "look",
          artifacts: [],
        }),
      /stage_start_pending/,
    );
    assert.equal(
      gate(f, "research")?.state,
      "pending",
      "the review persists after the refusal",
    );
    // Planning the route is not blocked.
    specialists.execute(f.identity.session(root.session), {
      action: "route",
      stages: ["research"],
    });
    workflow.approveStart(root.session, "research", "approve");
    const result = specialists.execute(f.identity.session(root.session), {
      role: "Researcher",
      task: "look",
      artifacts: [],
    }) as { task: { status: string } };
    assert.equal(result.task.status, "queued");
  } finally {
    f.close();
  }
});

test("rejecting a human gate sends the stage back with the owner's feedback", () => {
  for (const limit of [1, 0]) {
    const f = setup({
      humanGates: ["plan"],
      revisionLimit: limit,
      orchestration: { verifyStages: [], reviewStages: ["plan"] },
    });
    try {
      f.workflow.setRoute(f.identity.session(f.root.session), ["plan"]);
      const planner = f.child("Planner"),
        reviewer = f.child("Reviewer");
      const a = f.submit(planner, reviewer);
      const review = f.workflow.review(reviewer, a.id, []);
      assert.equal(f.attempt().state, "human_gate");
      assert.throws(
        () => f.workflow.rejectStage(f.root.session, a.id, id(), "no"),
        /human_gate_stale/,
      );
      const attempt = f.workflow.rejectStage(
        f.root.session,
        a.id,
        review.id,
        "Cover the migration",
      );
      assert.equal(attempt.feedback, "Cover the migration");
      if (limit === 1) {
        assert.equal(attempt.state, "revision_required");
        f.submit(planner, reviewer);
        assert.equal(f.attempt().state, "review");
      } else {
        assert.equal(attempt.state, "needs_attention");
        assert.equal(
          f.identity.session(f.root.session).status,
          "needs_attention",
        );
      }
    } finally {
      f.close();
    }
  }
});
