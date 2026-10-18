import type { MatrixReport } from "./matrix.js";

/** Release gate for the OpenCode first release (specification section 5).
 * Pure so every blocker rule is testable; scripts/release-check.ts gathers the
 * inputs. A missing input is a blocker, never a pass. */
export type StepResult = {
  name: string;
  status: "passed" | "failed" | "skipped";
  seconds: number;
};
export type Signoff = {
  author: string;
  reviewer: string;
  reviewedAt: string;
  /** `sourceFingerprint` the reviewer inspected. A change makes it stale. */
  fingerprint: string;
  /** Pointer to the evidence of a real provider run through the model channel. */
  liveProviderEvidence: string;
};
export type ReleaseInputs = {
  fingerprint: string;
  dirty: boolean;
  steps: StepResult[];
  matrix: MatrixReport;
  signoff: Signoff | null;
};

/** Every step must run and pass: scripted fixtures never stand in for these. */
export const requiredSteps = [
  "format",
  "verify",
  "matrix-strict",
  "linux-container",
  "live-workers",
  "live-opencode",
  "live-engine",
  "live-specialists",
  "benchmark",
] as const;

export function releaseBlockers(input: ReleaseInputs): string[] {
  const blockers: string[] = [];
  if (input.dirty) blockers.push("working tree has uncommitted changes");
  for (const name of requiredSteps) {
    const step = input.steps.find((s) => s.name === name);
    if (!step) blockers.push(`step ${name} did not run`);
    else if (step.status !== "passed")
      blockers.push(`step ${name} ${step.status}`);
  }
  for (const error of input.matrix.errors) blockers.push(`matrix: ${error}`);
  for (const key of input.matrix.unmapped)
    blockers.push(`matrix: ${key} has no test or approved N/A`);
  for (const key of input.matrix.needsReview)
    blockers.push(`matrix: ${key} awaits reviewer confirmation`);
  const s = input.signoff;
  if (!s) blockers.push("no independent release sign-off");
  else {
    for (const field of [
      "author",
      "reviewer",
      "reviewedAt",
      "fingerprint",
      "liveProviderEvidence",
    ] as const)
      if (!s[field]?.trim()) blockers.push(`sign-off lacks ${field}`);
    if (s.author?.trim().toLowerCase() === s.reviewer?.trim().toLowerCase())
      blockers.push("sign-off is self-approved");
    if (s.fingerprint !== input.fingerprint)
      blockers.push("sign-off is stale: source changed after review");
  }
  return blockers;
}
