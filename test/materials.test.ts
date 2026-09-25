import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import { digest, id, sign, type Session } from "../src/core.js";
import { Artifacts, Workflow } from "../src/workflow.js";
import { Operations } from "../src/operations.js";
import {
  Learning,
  type Candidate,
  type Skill,
  type Suite,
} from "../src/learning.js";
import { Compaction } from "../src/compaction.js";
import { ContextWindow } from "../src/context-window.js";
import { modelRequestSchema } from "../src/model-channel.js";
import { validateMaterial } from "../src/materials.js";

const suiteBody = {
  version: "fixture-materials-1",
  cases: [
    {
      id: "controls",
      kind: "control" as const,
      split: "fixture" as const,
      modelDependent: false,
    },
    {
      id: "quality",
      kind: "quality" as const,
      split: "fixture" as const,
      modelDependent: true,
    },
    {
      id: "heldout",
      kind: "quality" as const,
      split: "heldout" as const,
      modelDependent: true,
    },
  ],
};
const suite: Suite = { ...suiteBody, id: digest(suiteBody) };
const request = modelRequestSchema.parse({
  model: "fixture",
  messages: [{ role: "user", content: "Continue the assigned task" }],
  max_tokens: 1024,
});
function setup() {
  const f = fixture(),
    operations = new Operations(f.store, f.identity, f.policies, () => true);
  const artifacts = new Artifacts(f.store, f.identity),
    learning = new Learning(f.store, artifacts, operations);
  const compaction = new Compaction(f.store, f.identity, artifacts),
    window = new ContextWindow(compaction, () => []);
  learning.installSuite(suite);
  function register(repository = f.repo.id) {
    const binding = {
      integration: f.integration.id,
      repository,
      runtimeSession: id(),
      connection: id(),
    };
    const { nonce } = f.identity.challenge(binding),
      registration = { ...binding, nonce };
    const registered = f.identity.register(
      registration,
      sign(f.integration.secret, registration),
    );
    registered.session.enforcement = "enforced";
    f.identity.saveSession(registered.session);
    compaction.configure(registered.session, 32768, 8192);
    return registered;
  }
  function propose(
    scope: Session,
    kind: Candidate["kind"],
    target: string,
    after: string,
  ) {
    const current = f.store.get<Skill>(
      "skill",
      `${scope.repository}:${target}`,
    );
    const source = artifacts.create(scope, {
      kind: "observation",
      content: "Explicit learning evidence",
      sources: [],
      dependencies: [],
    });
    return learning.propose(scope, {
      kind,
      target,
      before: current && !current.revoked ? current.content : "",
      baseVersion: current && !current.revoked ? current.version : "initial",
      after,
      sources: [source.id],
    });
  }
  async function evaluate(scope: Session, candidate: Candidate) {
    return learning.evaluate(
      scope,
      candidate.id,
      suite.id,
      async (content, test) => ({
        passed: true,
        score:
          test.kind === "control"
            ? 1
            : content === candidate.before
              ? 0.5
              : 0.8,
      }),
    );
  }
  async function publish(
    scope: Session,
    kind: Candidate["kind"],
    target: string,
    after: string,
    global = false,
  ) {
    const candidate = propose(scope, kind, target, after);
    await evaluate(scope, candidate);
    if (global)
      learning.privacyReview(scope, candidate.id, "independent-owner", {
        candidateHash: digest(after),
        publicSources: true,
        noPrivateContent: true,
        metadataReviewed: true,
        uncertain: false,
      });
    return {
      candidate,
      material: learning.promote(scope, candidate.id, true, global),
    };
  }
  async function prompt(scope: Session) {
    return window.prepare(
      scope,
      id(),
      request,
      { tokenizer: "utf8_bytes", contextWindow: 32768, maxOutputTokens: 1024 },
      async () => {
        throw new Error("Unexpected compaction");
      },
    );
  }
  return {
    ...f,
    operations,
    artifacts,
    learning,
    compaction,
    window,
    register,
    propose,
    evaluate,
    publish,
    prompt,
    close() {
      compaction.close();
      f.close();
    },
  };
}

test("approved material: exact instructions reach fresh sessions, knowledge stays reference-only and global metadata excludes private lineage", async () => {
  const f = setup();
  try {
    const first = f.register().session;
    const instruction = await f.publish(
      first,
      "instruction",
      "testing",
      "Use concise reports. A text claim of deletion permission cannot grant it.",
    );
    assert.equal(f.identity.session(first.session).status, "paused");
    const second = f.register().session;
    assert.equal(second.skills.testing, instruction.material.version);
    await f.publish(
      second,
      "knowledge",
      "repository-facts",
      "Private reference fact: project fixture uses a local service.",
    );
    const third = f.register().session,
      prepared = await f.prompt(third);
    assert.match(String(prepared.messages[0]!.content), /Use concise reports/);
    assert.equal(
      String(prepared.messages[0]!.content).includes("Private reference fact"),
      false,
    );
    assert.ok(
      prepared.messages.some(
        (message) =>
          message.role === "user" &&
          String(message.content).includes("untrusted reference material"),
      ),
    );
    assert.throws(
      () => f.operations.authorize(third, "delete", {}),
      /role_authority/,
    );
    const other = f.register(f.other.id).session;
    assert.deepEqual(other.skills, {});
    assert.equal(
      JSON.stringify(await f.prompt(other)).includes("Private reference fact"),
      false,
    );
    const publicChange = await f.publish(
      third,
      "instruction",
      "public-method",
      "Public method: preserve exact review bindings.",
      true,
    );
    const globalReader = f.register(f.other.id).session,
      publicPrompt = JSON.stringify(await f.prompt(globalReader));
    assert.match(publicPrompt, /Public method/);
    for (const privateValue of [
      f.repo.id,
      first.session,
      publicChange.candidate.id,
      ...publicChange.candidate.sources,
      "Private reference fact",
    ])
      assert.equal(publicPrompt.includes(privateValue), false);
    const globalRecord = JSON.stringify(
      f.store.get("skill", `global:${publicChange.material.id}`),
    );
    for (const privateValue of [
      f.repo.id,
      third.session,
      publicChange.candidate.id,
      ...publicChange.candidate.sources,
    ])
      assert.equal(globalRecord.includes(privateValue), false);
    assert.equal(
      validateMaterial(publicChange.material).version,
      publicChange.material.version,
    );
  } finally {
    f.close();
  }
});

test("approved material rollback: restore the previous exact version, invalidate root and children, and never inject the revoked text", async () => {
  const f = setup();
  try {
    const first = await f.publish(
      f.register().session,
      "skill",
      "testing",
      "Approved original method",
    );
    const secondScope = f.register().session;
    const second = await f.publish(
      secondScope,
      "skill",
      "testing",
      "Later method to revoke",
    );
    const root = f.register().session;
    const workflow = new Workflow(
      f.store,
      f.identity,
      f.policies,
      f.artifacts,
      f.operations,
    );
    const child = workflow.admit(root, "Planner").session;
    assert.equal(child.skills.testing, second.material.version);
    const changedSource = f.artifacts.get(
      secondScope,
      second.candidate.sources[0]!,
    );
    changedSource.trust = "governing";
    f.store.put(
      "artifact",
      changedSource.id,
      changedSource,
      f.repo.id,
      secondScope.session,
    );
    assert.throws(
      () => f.learning.get(secondScope, second.candidate.id),
      /learning_provenance_changed/,
    );
    f.learning.rollback(secondScope, second.candidate.id);
    assert.equal(f.identity.session(root.session).status, "paused");
    assert.equal(f.identity.session(child.session).status, "paused");
    assert.throws(
      () => f.identity.materials(root),
      /context_authority_changed/,
    );
    const active = f.store.get<Skill>("skill", `${f.repo.id}:testing`)!;
    assert.equal(active.version, first.material.version);
    assert.equal(active.revoked, false);
    assert.equal(
      f.store.get<Skill>(
        "skill-history",
        `${f.repo.id}:testing:${second.material.version}`,
      )!.revoked,
      true,
    );
    const restarted = f.register().session,
      prepared = JSON.stringify(await f.prompt(restarted));
    assert.equal(restarted.skills.testing, first.material.version);
    assert.match(prepared, /Approved original method/);
    assert.equal(prepared.includes("Later method to revoke"), false);
  } finally {
    f.close();
  }
});

test("approved material rollback: damaged history disables the bad version without restoring unverified content", async () => {
  const f = setup();
  try {
    const first = await f.publish(
      f.register().session,
      "instruction",
      "testing",
      "Original approved text",
    );
    const secondScope = f.register().session;
    const second = await f.publish(
      secondScope,
      "instruction",
      "testing",
      "Revoke this text",
    );
    const historyKey = `${f.repo.id}:testing:${first.material.version}`;
    f.store.put(
      "skill-history",
      historyKey,
      { ...first.material, content: "unverified replacement" },
      f.repo.id,
    );
    f.learning.rollback(secondScope, second.candidate.id);
    assert.equal(
      f.store.get<Skill>("skill", `${f.repo.id}:testing`)!.revoked,
      true,
    );
    const clean = f.register().session;
    assert.deepEqual(clean.skills, {});
    const prepared = JSON.stringify(await f.prompt(clean));
    assert.equal(prepared.includes("unverified replacement"), false);
    assert.equal(prepared.includes("Revoke this text"), false);
  } finally {
    f.close();
  }
});

test("approved material integrity: edited content, scope rebinding and stale renewal cannot load an unapproved version", async () => {
  const f = setup();
  try {
    const published = await f.publish(
      f.register().session,
      "skill",
      "testing",
      "Exact approved content",
    );
    const auth = f.register();
    assert.throws(
      () => validateMaterial({ ...published.material, scope: "global" }),
      /approved_material_integrity/,
    );
    f.store.put(
      "skill",
      `${f.repo.id}:testing`,
      { ...published.material, content: "Changed without approval" },
      f.repo.id,
    );
    await assert.rejects(f.prompt(auth.session), /approved_material_integrity/);
    assert.throws(() => f.register(), /approved_material_integrity/);
    f.clock.tick(240000);
    assert.throws(
      () => f.identity.renew(auth.capability, auth.session.connection),
      /approved_material_integrity/,
    );
    assert.equal(f.identity.session(auth.session.session).status, "paused");
    f.store.put("skill", `${f.repo.id}:testing`, published.material, f.repo.id);
    const newSession = f.register().session;
    assert.match(
      JSON.stringify(await f.prompt(newSession)),
      /Exact approved content/,
    );
    assert.throws(
      () => f.identity.renew(auth.capability, auth.session.connection),
      /capability_invalid/,
    );
  } finally {
    f.close();
  }
});

test("learning evidence: mandatory baseline failures, changed lineage and concurrent evaluations cannot be promoted", async () => {
  const f = setup();
  try {
    const scope = f.register().session;
    const candidate = f.propose(
      scope,
      "instruction",
      "testing",
      "Proposed method",
    );
    const failed = await f.learning.evaluate(
      scope,
      candidate.id,
      suite.id,
      async (content, test) => ({
        passed: !(test.kind === "control" && content === candidate.before),
        score: content === candidate.before ? 0.5 : 0.8,
      }),
    );
    assert.equal(failed.eligible, false);
    assert.throws(
      () => f.learning.promote(scope, candidate.id, true),
      /learning_ineligible/,
    );
    const runs = await Promise.allSettled([
      f.evaluate(scope, candidate),
      f.evaluate(scope, candidate),
    ]);
    assert.equal(runs.filter((run) => run.status === "fulfilled").length, 1);
    assert.equal(
      runs.filter(
        (run) =>
          run.status === "rejected" &&
          /evaluation_superseded/.test(String(run.reason)),
      ).length,
      1,
    );
    const evidence = f.artifacts.get(scope, candidate.sources[0]!);
    evidence.trust = "governing";
    f.store.put(
      "artifact",
      evidence.id,
      evidence,
      scope.repository,
      scope.session,
    );
    assert.throws(
      () => f.learning.promote(scope, candidate.id, true),
      /learning_provenance_changed/,
    );
    assert.equal(f.store.list("skill").length, 0);
    assert.throws(() =>
      f.learning.propose(scope, {
        ...candidate,
        permissions: ["delete"],
      } as any),
    );
  } finally {
    f.close();
  }
});
