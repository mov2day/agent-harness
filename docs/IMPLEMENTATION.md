# Delivery ledger

The normative specification is [plan.MD](plan.MD). This ledger distinguishes code completion, locally verified behavior, and release evidence. No runtime may claim enforcement from configuration or plugin hooks alone.

| Phase | Work | Status |
| --- | --- | --- |
| 1 | Policy, filesystem enrollment, pairing, atomic registration, scoped capabilities | Implemented; targeted tests pass |
| 2 | OpenCode bridge, runtime profiles, containment and alternate-path rejection | Pinned OpenCode 1.18.31 image, plugin, external launcher and durable lifecycle are wired to the production engine; real conversation, denial, artifact and cleanup tests pass on macOS; full certification pending |
| 3 | Operation leases, native file broker, gateway, isolated execution, cancellation | Native broker/races and TLS gateway scenarios pass on macOS and Linux; real worker isolation/cancellation pass; restricted model channel implemented and tested; full runtime integration pending |
| 4 | Specialist admission, artifacts, review workflow and dependency graph | Implemented; atomic admission, revision boundaries, dependency invalidation and host orchestration tests pass. Live OpenCode completed ten assignments across all five reviewed stages with retained Reviewer context and durable cleanup on macOS; provider decisions were scripted |
| 5 | Authoritative checkpoints, provenance, evaluated learning and rollback | Live model/tool context accounting and exchange barriers verified; core checkpoint/learning tests pass. Automatic runtime compaction, production evaluator runner and clean restart/reload integration pending |
| 6 | Authenticated React controls, alerts, durable recovery, conformance and release tooling | Controls and API implemented; browser sign-in verified; 95 tests and builds pass on macOS/Linux; measured authorization target passes; full conformance/release tooling and QA pending |
| 7 | Separate Codex adapter and compatibility verification | Protocol adapter implemented; three independent adapter tests pass against locally generated schema; live containment certification remains pending |

## Implementation choices

- TypeScript, Node 22.17+, React, SQLite through Node's built-in SQLite module, and an independently compiled native filesystem helper.
- The engine is the sole authority; runtime adapters and research data cannot issue roles or approvals.
- Synchronous database transactions serialize admission; asynchronous effects have durable intents and are never retried as part of a storage retry.
- Unsupported containment and unverified runtime versions fail closed. Release certification requires actual Linux and macOS runtime evidence. Test doubles cannot certify production containment.
- Spending budgets remain deferred by the specification.

## Validation and commits

Each phase adds targeted adversarial tests and a local commit. The final checks include type checking, production build, integration tests, conformance validation, and a measured authorization benchmark. Platform or independent-review evidence unavailable on this host will remain explicit release blockers.

Latest verification: 2026-09-24, **95/95 tests**, type checks and production builds passed on macOS arm64 and Linux arm64. The Linux image was `462e8161047b`. The real OpenCode engine integration and complete specialist workflow tests passed on the macOS host using runtime image `411216a2fdc7`; the unchanged transport test last passed on 2026-09-23. See [conformance evidence](../conformance/README.md) for scope and benchmark limitations. The overall goal remains incomplete; these results do not establish full release conformance.

The restricted model channel keeps provider credentials in owner-readable host files outside enrolled repositories. It enforces the assigned model/reasoning, validates and pins public HTTPS destinations, prohibits redirects and remote tool/image fetches, bounds responses, and shares operation cancellation/audit. Tests use an injected provider transport; live paid-provider inference is not yet verified.

The live OpenCode transport test passes with the actual 1.18.31 binary and plugin in a no-network, read-only container. It covers authoritative-context retrieval, streamed model responses, a scoped artifact call, raw-session spoof rejection, native-shell rejection without an effect, absence of host paths/sockets, and cleanup. Engine/provider responses are deterministic fixtures; this result does not replace production engine-backed certification. See [runtime notes](../runtime/opencode/README.md).

Runtime certificates now fingerprint runtime scripts/images/lockfiles, worker code/images, build scripts, web controls, and root dependency inputs in addition to engine/native sources. Generated binaries and dependency caches are excluded.

2026-09-23 runtime integration milestone: the external host launcher uses real registration, scoped capabilities, durable launch preparation, verified attachment and termination. Lifecycle tests cover replay, revocation during inspection, interrupted creation, mismatched identities, failed cleanup and termination before any launch intent. Runtime cleanup outcomes and a checked retry are visible in the owner controls. The engine-backed OpenCode test passes using image `1072896ffc45`, with a scripted provider and disposable test certificate; the production engine denies a Conductor file read, accepts a scoped artifact, and verifies shutdown. All 73 tests and the build pass on both host platforms.

2026-09-23 specialist task milestone: assignments and explicit artifact sharing commit atomically with admission. Trusted host bridges claim tasks exactly once, preserve result ownership and input lineage, and can reuse only idle specialists in the same root and repository. Child authority loss, engine restart and invalidated evidence preserve interrupted task outcomes and pause dependent work. Task claim material is excluded from model-facing results and owner state. This milestone passed **81/81** tests, type checks and production build on macOS.

2026-09-23 live specialist milestone: the external launcher now drives admitted tasks through fresh contained processes and reuses idle specialists only within the original root/repository. Duplicate delivery does not repeat execution; an orphaned claim pauses the root for reconciliation. Completion uses a fresh authority check, and release waits for recorded container cleanup. The live test completed 42 model turns, ten assignments, five reviewed stages, one retained Reviewer and cleanup of all seven containers with runtime image `411216a2fdc7`. It also caught and fixed an OpenCode hook issue: authoritative context must replace the contents of the existing system array, rather than assign a new array. Provider payloads now prove the assigned context reaches the model. This is scripted-provider integration evidence, not runtime release certification or a model quality evaluation.

The final cleanup regression test verifies that failed specialist removal remains visible and pauses the Conductor, preventing continued admission while cleanup requires reconciliation. Both platform suites now pass 87 tests.

2026-09-24 context accounting milestone: actual model requests now consume the configured context budget. Locally bundled encodings and conservative framing allowances run in a bounded background worker, so adversarial text does not block the authority event loop. Provider usage can increase the recorded total; shortened histories cannot lower it. The model channel enforces the remaining response allowance. Pending inference and exact tool calls block new inference and checkpoint acceptance until the trusted host records every result, including denials. Large results become untrusted artifact references that preserve an existing artifact's ID, hash and source/dependency links. Replays count once, and authority/configuration changes during counting reject stale results. Both live engine and 42-turn specialist checks passed with scripted providers and disposable certificates. Automatic compaction and bounded artifact paging remain unfinished; this milestone does not close Phase 5.
