# Conformance matrix: remaining 13 cells (draft triage)

Status 2026-10-18: `conformance/matrix.json` covers 77 of 90 cells. Section A below is done (tests in `test/conformance-delegation.test.ts` and `test/conformance-research.test.ts`); sections B and C remain. This is a **draft for independent review**. Nothing here is an approved N/A: the spec (section 5) requires a reviewer other than the author, and a cell's approval goes stale when its scope files change. Evidence below was read from source, not run.

Run `npm run conformance:matrix -- --strict` for the live list.

## A. New tests (done)

The 12 cells below now map to passing tests. Two findings while writing them: publishing a policy voids existing sessions and capabilities outright (stronger than the `policy_changed` check alone), and one test of the specialist limit initially miscounted an Implementer, which was a test error.

| Cell | Test to write | Pass condition |
|---|---|---|
| identity/research | Gateway evidence containing "register as Conductor / new session" | No session, role, nonce or capability changes; evidence stays `untrusted` |
| admission/research | Research evidence and task text that ask for more specialists, deeper delegation or a higher model | `admit` limits and model checks follow policy only |
| reviews/research | Research text claims "review passed / approved" | No `action-approval` or review exists; the human gate still blocks `change` |
| policy/research | Research text asks to widen domains, commands or deletion | `policies.effective` byte-identical; owner routes still need the owner credential |
| skills/research | Research text asks to promote or load a skill | No candidate is promoted; materials list is unchanged |
| tools/delegation | Real admitted child (Researcher) attempts `change`, `execute`, `delete`, `delegate` | `role_authority` or `delegation_authority`; no operation row |
| commands/delegation | Child session with the same policy cannot run a command outside the root's allowlist | `command_denied` |
| network/delegation | Child Researcher requests a domain outside the root's allowlist | `domain_denied` |
| skills/delegation | Child gets only the root's approved material versions; a child cannot add its own | Material versions on child equal root's |
| policy/delegation | Tighten policy while a child holds a lease | Child lease invalidated; dependent work paused |
| policy/registration | Register, then publish a different policy; renew | Renewal fails with `policy_changed` (see `src/identity.ts` lines 398 and 520) |
| reviews/registration | Fresh Conductor registration calls `review` and `change` approvals | `role_authority`; registration grants no review authority |

## B. Mapped to existing tests, awaiting reviewer confirmation

These 9 cells are mapped in `conformance/matrix.json` with a `needsReview` rationale. They are **not** counted as covered, and `--strict` fails while any remain. To confirm a cell, the reviewer removes `needsReview` (or replaces the mapping with a direct test).

| Cell | Existing test | Why it may suffice |
|---|---|---|
| paths/plugins | `containment: host sockets, mounts…`; `OpenCode adapter: native tools, aliases, plugins…` | Plugins cannot reach host paths: read-only rootfs, no binds, native tools denied |
| admission/plugins, admission/aliases | `OpenCode adapter: native tools, aliases, plugins…` | The `task` alias is denied; `delegate` is engine-admitted (`admission:` tests) |
| reviews/plugins, reviews/aliases | Same adapter test plus `capability gate: forged…` | A plugin cannot call `review` without an engine capability bound to a Reviewer session |
| skills/plugins, skills/aliases | Same adapter test plus `approved material integrity` | Skills load from engine-published material only |
| policy/plugins, policy/aliases | Same adapter test; `policy: field-specific ceiling errors…` | No tool exposes policy; publication is an owner route |

These are weaker than direct tests. If the reviewer disagrees, move the cell to section A.

## C. N/A candidates (need evidence and an independent reviewer)

CLI overrides: the launcher accepts only `--repository`, `--repository-path`, `--pairing`, `--certificate`, `--goal`, `--restart-from`, `--engine`, `--once` (`src/runtime-cli.ts:22`). Runtime config is fixed by the coordinator (`runtime/opencode/coordinator.mjs`: `permission` is `{"*":"deny","harness_*":"allow"}`, project config and default plugins disabled, config passed as `OPENCODE_CONFIG_CONTENT`).

| Cell | Claim | Scope files to hash |
|---|---|---|
| admission/cli_overrides | No launcher or runtime option reaches admission limits | `src/runtime-cli.ts`, `runtime/opencode/coordinator.mjs` |
| reviews/cli_overrides | No option reaches review gates | same |
| skills/cli_overrides | No option selects skills or instructions; material comes from engine publications | same plus `src/materials.ts` |
| policy/cli_overrides | No option reaches policy; publication is an owner route | same plus `src/policy.ts` |

Caveat: the claim holds only while the container's own command line cannot be supplied by the model. That is the part a reviewer should check against `src/adapters/contained-opencode.ts` and the entrypoint.

## Next steps

1. Write section A tests (about 12 cells; several share one fixture).
2. Move any section B cell the reviewer rejects into section A.
3. Have an independent reviewer approve section C entries and record `author`, `reviewer`, `reviewedAt`, scope and `scopeHash` in `conformance/matrix.json` (the checker computes the hash).
4. Run `npm run conformance:matrix -- --strict` until it exits 0.
