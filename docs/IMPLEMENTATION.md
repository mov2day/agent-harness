# Delivery ledger

The normative specification is [plan.MD](plan.MD). This ledger distinguishes code completion, locally verified behavior, and release evidence. No runtime may claim enforcement from configuration or plugin hooks alone.

| Phase | Work | Status |
| --- | --- | --- |
| 1 | Policy, filesystem enrollment, pairing, atomic registration, scoped capabilities | Implemented; targeted tests pass |
| 2 | OpenCode bridge, runtime profiles, containment and alternate-path rejection | Contracts implemented; dedicated container VM available; full OpenCode runtime transport and certification pending |
| 3 | Operation leases, native file broker, gateway, isolated execution, cancellation | Native broker/races and TLS gateway scenarios pass on macOS and Linux; real worker isolation/cancellation pass; restricted model channel and full runtime integration pending |
| 4 | Specialist admission, artifacts, review workflow and dependency graph | Services and adversarial tests pass, including revision boundaries, diamond invalidation and runtime model validation; full runtime-driven workflow pending |
| 5 | Authoritative checkpoints, provenance, evaluated learning and rollback | Core services and tests pass; production evaluator runner and clean restart/reload integration pending |
| 6 | Authenticated React controls, alerts, durable recovery, conformance and release tooling | Controls and API implemented; browser sign-in verified; 63 tests and builds pass on macOS/Linux; measured authorization target passes; full conformance/release tooling and QA pending |
| 7 | Separate Codex adapter and compatibility verification | Protocol adapter implemented; three independent adapter tests pass against locally generated schema; live containment certification remains pending |

## Implementation choices

- TypeScript, Node 22.17+, React, SQLite through Node's built-in SQLite module, and an independently compiled native filesystem helper.
- The engine is the sole authority; runtime adapters and research data cannot issue roles or approvals.
- Synchronous database transactions serialize admission; asynchronous effects have durable intents and are never retried as part of a storage retry.
- Unsupported containment and unverified runtime versions fail closed. Release certification requires actual Linux and macOS runtime evidence. Test doubles cannot certify production containment.
- Spending budgets remain deferred by the specification.

## Validation and commits

Each phase adds targeted adversarial tests and a local commit. The final checks include type checking, production build, integration tests, conformance validation, and a measured authorization benchmark. Platform or independent-review evidence unavailable on this host will remain explicit release blockers.

Latest verification: 2026-09-16, 63/63 tests, type checks and production builds passed on macOS arm64 and Linux arm64. The Linux test image was `4cd54277674c`. See [conformance evidence](../conformance/README.md) for scope and benchmark limitations. The overall goal remains incomplete; unit/mechanism results do not establish end-to-end runtime enforcement.
