# OpenCode release readiness

Scope: first release, OpenCode only. Codex (phase 7) and spending-budget enforcement are later work per [plan.MD](plan.MD). CI is out of scope for now; the gate runs locally.

## Run the gate

Select the dedicated Docker daemon, then run:

```sh
export DOCKER_CONTEXT=colima-agent-harness
npm run release:check
```

`scripts/release-check.ts` runs, in order: format check, `npm run verify` (types, unit/integration tests, build, matrix), the strict matrix, the Linux container suite, the four live OpenCode/worker suites and the authorization benchmark. It writes `conformance/results/release.json` and exits 0 only with **no blockers**. A step that did not run counts as a blocker, never a pass. Without `DOCKER_CONTEXT` the Docker steps are skipped and the gate cannot pass.

Blocker rules are in [`conformance/release.ts`](../conformance/release.ts) and tested in `test/release-gate.test.ts`.

## What only people can supply

These stay blockers until a person provides them. They cannot be generated or self-approved.

1. **Matrix review (optional).** All 90 cells map to passing tests with no N/A, so none is required. An independent reviewer can still spot-check the mappings listed in [CONFORMANCE-GAPS.md](CONFORMANCE-GAPS.md).
2. **Live provider run.** Provider replies in every live suite are scripted. The owner must run the restricted model channel against a real provider, using a credential kept in an owner-readable file outside the repository, and record the evidence path.
3. **Release sign-off.** Create `conformance/release-signoff.json` after item 2:

   ```json
   {
     "author": "who prepared the release",
     "reviewer": "someone else",
     "reviewedAt": "YYYY-MM-DD",
     "fingerprint": "value of sourceFingerprint at review time",
     "liveProviderEvidence": "path or id of the provider run record"
   }
   ```

   `release.json` includes the current `fingerprint`. Any later change to engine, native, worker, runtime, script or web sources makes the sign-off stale.

## Known limits that the gate cannot remove

- **Linux host orchestration.** The Linux container suite runs the engine tests on Linux. The live OpenCode suites drive containers from the macOS host through a Linux VM. A run with the engine and launcher on a Linux host is still needed to meet "supported Linux and macOS environments" for OpenCode.
- **Runtime certificates** in the live suites are disposable fixtures. Production certificates are an owner action.
- **Case-volume tests** use macOS disk images and are skipped on Linux.
