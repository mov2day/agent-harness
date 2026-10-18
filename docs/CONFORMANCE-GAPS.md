# Conformance matrix status

Status 2026-10-18: `conformance/matrix.json` covers **90 of 90** cells with passing tests and uses no N/A entries, so no independent N/A approval is needed. `npm run conformance:matrix -- --strict` exits 0.

Tests added to close the matrix:

| File | Closes |
|---|---|
| `test/conformance-gaps.test.ts` | forged/revoked credentials; path, URL-host and command spelling attacks |
| `test/conformance-lifecycle.test.ts` | compaction and learning carry no authority |
| `test/conformance-delegation.test.ts` | children inherit tools, commands, domains and material; policy tightening; registration authority |
| `test/conformance-research.test.ts` | hostile research evidence; credentials an agent can hold never reach owner routes |
| `test/conformance-overrides.test.ts` | launcher arguments, fixed runtime config, plugin definitions, tool-name aliases |
| `test/case-volumes.test.ts` | real case-sensitive and case-insensitive APFS volumes (macOS only) |

Behavior learned while writing them:

- Publishing a policy voids existing sessions and capabilities outright, which is stronger than the `policy_changed` check alone.
- The launcher used to ignore unknown options. `src/runtime-args.ts` now rejects them (and repeated or valueless options), so an override fails closed instead of being silently dropped.

A cell mapped to a test is evidence the behavior holds, not proof the cell has no other attack path. Add `needsReview` to a cell (see `conformance/matrix.ts`) when a mapping is indirect, and a reviewer-approved N/A only with evidence.
