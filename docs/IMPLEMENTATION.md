# Delivery ledger

The normative specification is [plan.MD](plan.MD). This ledger distinguishes code completion, locally verified behavior, and release evidence. No runtime may claim enforcement from configuration or plugin hooks alone.

| Phase | Work | Status |
| --- | --- | --- |
| 1 | Policy, filesystem enrollment, pairing, atomic registration, scoped capabilities | Implemented; targeted tests pass |
| 2 | OpenCode bridge, runtime profiles, containment and alternate-path rejection | Pinned OpenCode 1.18.31 image, plugin, external launcher and durable lifecycle are wired to the production engine; real conversation, denial, artifact and cleanup tests pass on macOS; full certification pending |
| 3 | Operation leases, native file broker, gateway, isolated execution, cancellation | Native broker/races and TLS gateway scenarios pass on macOS and Linux; real worker isolation/cancellation pass; restricted model channel implemented and tested; full runtime integration pending |
| 4 | Specialist admission, artifacts, review workflow and dependency graph | Services and adversarial tests pass, including revision boundaries, diamond invalidation and runtime model validation; full runtime-driven workflow pending |
| 5 | Authoritative checkpoints, provenance, evaluated learning and rollback | Core services and tests pass; production evaluator runner and clean restart/reload integration pending |
| 6 | Authenticated React controls, alerts, durable recovery, conformance and release tooling | Controls and API implemented; browser sign-in verified; 73 tests and builds pass on macOS/Linux; measured authorization target passes; full conformance/release tooling and QA pending |
| 7 | Separate Codex adapter and compatibility verification | Protocol adapter implemented; three independent adapter tests pass against locally generated schema; live containment certification remains pending |

## Implementation choices

- TypeScript, Node 22.17+, React, SQLite through Node's built-in SQLite module, and an independently compiled native filesystem helper.
- The engine is the sole authority; runtime adapters and research data cannot issue roles or approvals.
- Synchronous database transactions serialize admission; asynchronous effects have durable intents and are never retried as part of a storage retry.
- Unsupported containment and unverified runtime versions fail closed. Release certification requires actual Linux and macOS runtime evidence. Test doubles cannot certify production containment.
- Spending budgets remain deferred by the specification.

## Validation and commits

Each phase adds targeted adversarial tests and a local commit. The final checks include type checking, production build, integration tests, conformance validation, and a measured authorization benchmark. Platform or independent-review evidence unavailable on this host will remain explicit release blockers.

Latest verification: 2026-09-23, 73/73 tests, type checks and production builds passed on macOS arm64 and Linux arm64. The Linux image was `c961779faf07`. The real OpenCode transport and engine integration tests also passed on the macOS host using runtime image `1072896ffc45`. See [conformance evidence](../conformance/README.md) for scope and benchmark limitations. The overall goal remains incomplete; these results do not establish full release conformance.

The restricted model channel keeps provider credentials in owner-readable host files outside enrolled repositories. It enforces the assigned model/reasoning, validates and pins public HTTPS destinations, prohibits redirects and remote tool/image fetches, bounds responses, and shares operation cancellation/audit. Tests use an injected provider transport; live paid-provider inference is not yet verified.

The live OpenCode transport test passes with the actual 1.18.31 binary and plugin in a no-network, read-only container. It covers authoritative-context retrieval, streamed model responses, a scoped artifact call, raw-session spoof rejection, native-shell rejection without an effect, absence of host paths/sockets, and cleanup. Engine/provider responses are deterministic fixtures; this result does not replace production engine-backed certification. See [runtime notes](../runtime/opencode/README.md).

Runtime certificates now fingerprint runtime scripts/images/lockfiles, worker code/images, build scripts, web controls, and root dependency inputs in addition to engine/native sources. Generated binaries and dependency caches are excluded.

2026-09-23 runtime integration milestone: the external host launcher uses real registration, scoped capabilities, durable launch preparation, verified attachment and termination. Lifecycle tests cover replay, revocation during inspection, interrupted creation, mismatched identities, failed cleanup and termination before any launch intent. Runtime cleanup outcomes and a checked retry are visible in the owner controls. The engine-backed OpenCode test passes using image `1072896ffc45`, with a scripted provider and disposable test certificate; the production engine denies a Conductor file read, accepts a scoped artifact, and verifies shutdown. All 73 tests and the build pass on both host platforms.
