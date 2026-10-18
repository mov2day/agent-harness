import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import { canonical, digest, hash, id } from "../src/core.js";
import { taskViews } from "../src/task-view.js";
import { Artifacts } from "../src/workflow.js";

test("task overview: separates roots, keeps historical denials and does not turn failed execution into a success", () => {
  const f = fixture();
  try {
    const root = f.register().session;
    const child = {
      ...root,
      session: id(),
      parent: root.session,
      role: "Verifier" as const,
    };
    f.identity.saveSession(child);
    const other = { ...root, session: id(), root: "", repository: f.other.id };
    other.root = other.session;
    f.identity.saveSession(other);
    f.store.put(
      "authority",
      root.session,
      { goals: ["Fix invoice totals"] },
      root.repository,
      root.session,
    );
    f.store.put(
      "operation",
      "failed-command",
      {
        id: "failed-command",
        session: child.session,
        repository: root.repository,
        tool: "execute",
        status: "completed",
        args: { executable: "python3", args: ["test_invoice.py"] },
        result: { exitCode: 1, artifact: "test-output" },
      },
      root.repository,
      child.session,
    );
    f.store.put(
      "operation",
      "interrupted-command",
      {
        id: "interrupted-command",
        session: child.session,
        repository: root.repository,
        tool: "execute",
        status: "requires_reconciliation",
        args: { executable: "python3", args: ["test_invoice.py"] },
        invalidated: {
          reason: "policy_changed",
          time: f.clock.now(),
          outcome: "requires_reconciliation",
        },
      },
      root.repository,
      child.session,
    );
    f.store.audit(
      "authorization.denied",
      { rule: "deletion_disabled" },
      root.repository,
      child.session,
    );
    f.store.audit(
      "authorization.denied",
      { rule: "private_other_rule" },
      other.repository,
      other.session,
    );
    f.clock.tick(900_001);
    root.status = "paused";
    f.identity.saveSession(root);
    f.store.audit(
      "authority.invalidated",
      { reason: "policy_changed" },
      root.repository,
      root.session,
    );
    const tasks = taskViews(f.store),
      view = tasks.find((t) => t.id === root.session)!;
    assert.equal(tasks.length, 2);
    assert.equal(view.title, "Fix invoice totals");
    assert.equal(view.enforcement, "unverified");
    assert.equal(view.pauseReason, "policy_changed");
    assert.deepEqual(
      view.agents.map((a) => a.id),
      [child.session],
    );
    assert.equal(view.runs[0]!.exitCode, 1);
    assert.equal(view.runs[1]!.exitCode, undefined);
    assert.equal(view.runs[1]!.status, "requires_reconciliation");
    assert.deepEqual(
      view.blocked.map((d) => d.rule),
      ["deletion_disabled"],
    );
    assert.equal(tasks.find((t) => t.id === other.session)!.runs.length, 0);
  } finally {
    f.close();
  }
});

test("task overview: only exact current reviews are presented as ready and approval does not imply a file effect", () => {
  const f = fixture();
  try {
    const root = f.register().session,
      artifacts = new Artifacts(f.store, f.identity);
    const dependency = artifacts.create(root, {
      kind: "plan",
      content: "Keep tests",
      dependencies: [],
      sources: [],
    });
    const args = { path: "src/invoice.py", base: null, content: "invoice" };
    const proposal = artifacts.create(root, {
      kind: "change-set",
      content: canonical({ tool: "change", args }),
      dependencies: [dependency.id],
      sources: [],
    });
    const view = () => taskViews(f.store)[0]!.proposals[0]!;
    assert.equal(view().reviewed, false);
    const review = {
      id: id(),
      artifact: proposal.id,
      hash: proposal.hash,
      dependencies: { [dependency.id]: dependency.hash },
      policy: root.policy,
      reviewer: "reviewer",
      findings: [],
      created: f.clock.now(),
    };
    f.store.put("review", review.id, review, root.repository);
    assert.equal(view().reviewed, true);
    const approval = {
      id: id(),
      repository: root.repository,
      session: root.session,
      action: digest({ tool: "change", args }),
      policy: root.policy,
      human: true,
      valid: true,
      dependencies: [proposal.id],
    };
    f.store.put("action-approval", approval.id, approval, root.repository);
    assert.equal(view().approved, true);
    assert.equal(view().applied, false);
    f.store.put(
      "review",
      review.id,
      { ...review, findings: [{ message: "Wrong total", blocking: true }] },
      root.repository,
    );
    assert.equal(view().reviewed, false);
    f.store.put("review", review.id, review, root.repository);
    f.store.put(
      "artifact",
      dependency.id,
      { ...dependency, content: "Changed plan", hash: hash("Changed plan") },
      root.repository,
      root.session,
    );
    assert.equal(view().reviewed, false);
    f.store.put(
      "artifact",
      proposal.id,
      { ...proposal, valid: false },
      root.repository,
      root.session,
    );
    assert.equal(view().valid, false);
  } finally {
    f.close();
  }
});
