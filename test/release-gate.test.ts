import test from "node:test";
import assert from "node:assert/strict";
import {
  releaseBlockers,
  requiredSteps,
  type ReleaseInputs,
} from "../conformance/release.js";

const ready = (): ReleaseInputs => ({
  fingerprint: "abc",
  dirty: false,
  steps: requiredSteps.map((name) => ({ name, status: "passed", seconds: 1 })),
  matrix: { errors: [], unmapped: [], needsReview: [], total: 90, covered: 90 },
  signoff: {
    author: "alice",
    reviewer: "bob",
    reviewedAt: "2026-10-18",
    fingerprint: "abc",
    liveProviderEvidence: "conformance/results/provider-run.json",
  },
});

test("release gate: a complete, independently signed record has no blockers", () => {
  assert.deepEqual(releaseBlockers(ready()), []);
});

test("release gate: skipped or missing steps, matrix gaps and a dirty tree block release", () => {
  const input = ready();
  input.dirty = true;
  input.steps = input.steps.filter((s) => s.name !== "live-engine");
  input.steps.find((s) => s.name === "linux-container")!.status = "skipped";
  input.steps.find((s) => s.name === "verify")!.status = "failed";
  input.matrix = {
    errors: ["x/y: missing cell"],
    unmapped: ["a/b"],
    needsReview: ["c/d"],
    total: 90,
    covered: 87,
  };
  const blockers = releaseBlockers(input).join("\n");
  for (const expected of [
    "uncommitted",
    "step live-engine did not run",
    "step linux-container skipped",
    "step verify failed",
    "x/y: missing cell",
    "a/b has no test",
    "c/d awaits reviewer",
  ])
    assert.match(blockers, new RegExp(expected));
});

test("release gate: sign-off must be present, independent, current and cite a live provider run", () => {
  const missing = ready();
  missing.signoff = null;
  assert.match(
    releaseBlockers(missing).join(),
    /no independent release sign-off/,
  );
  const own = ready();
  own.signoff!.reviewer = " Alice";
  assert.match(releaseBlockers(own).join(), /self-approved/);
  const stale = ready();
  stale.signoff!.fingerprint = "old";
  assert.match(releaseBlockers(stale).join(), /stale/);
  const fixtureOnly = ready();
  fixtureOnly.signoff!.liveProviderEvidence = "";
  assert.match(
    releaseBlockers(fixtureOnly).join(),
    /lacks liveProviderEvidence/,
  );
});
