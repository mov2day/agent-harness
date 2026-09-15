# agent-harness — Final Engine Specification

Repository name: `agent-harness`

Description: A policy-driven harness for coding agents, with specialized agents, review gates, controlled tools, and context management.

Naming: **agent-harness** is the project; **agent-harness engine** is the enforcement and orchestration service; **agent-harness web interface** is the controls interface. Runtime integrations are the **agent-harness OpenCode adapter** and the later **agent-harness Codex adapter**.

## 1. Product, registration, and authority lifecycle

Build agent-harness as a local harness engine governing independently started OpenCode sessions. The web interface manages controls, reviews, evidence, compaction, and learning; it does not launch root sessions.

**OpenCode ships first; Codex follows through an independently verified adapter.** Spending-budget enforcement remains deferred. Specialist concurrency, delegation depth, revision limits, execution timeouts, and context management remain in scope.

Use a TypeScript engine, React interface, SQLite state store, artifact storage, isolated command workers, and native filesystem helpers. Support Linux and macOS.

The trust boundary covers registered sessions and contained workers. It excludes an operating-system owner deliberately disabling controls or extracting credentials. Unsupported or unregistered sessions must never appear as enforced.

### Authenticated registration

- Bind registration to loopback and require a dedicated integration credential, separate from web credentials.
- Provision credentials through explicit local pairing. Keep them owner-readable, outside repositories, agent context, and worker mounts.
- A trusted integration bridge holds the credential; model-controlled code cannot access it.
- Authenticate a challenge-response binding integration identity, requested repository, session identifier, and a single-use nonce expiring after **60 seconds**.
- Independently verify repository enrollment. Registration grants only Conductor authority; specialist roles are assigned by the engine.
- Reject browser-originated registration, client-selected privileged roles, and credentials in URLs.

**Nonce redemption is atomic.** After validating the response, use one database transaction to conditionally consume the unexpired, unused nonce and create its registration record. Exactly one concurrent redemption may succeed. A failed transaction consumes neither. A lost successful response is recovered through an authenticated registration-status lookup, not nonce reuse.

### Capabilities and renewal

Issue opaque, server-tracked capabilities with a **five-minute TTL**, scoped to integration connection, session, repository, role, and authority generation.

The bridge requests renewal **60 seconds before expiry**. Renewal rechecks session status, current policy, loaded skill versions, role authority, and enforcement health. Failed renewal grants no grace period. Revoked or expired credentials cannot renew.

Each operation has a tracked authorization lease. Successful renewal may extend active leases only after revalidating those operations against current authority. It cannot broaden their approved actions. Expired credentials remain unusable for new requests.

### One authority-invalidation mechanism

Policy tightening, skill revocation, capability expiry, capability revocation, and session termination all use the same operation-control service:

1. Invalidate the affected authority generation or lease.
2. Block new operations and remaining steps of affected operations.
3. Cancel running commands and network activity where possible.
4. Record whether the operation was cancelled without effects, partially completed, completed before invalidation, or requires reconciliation.
5. Pause dependent workflow until evidence and approvals are reconciled.

Serialize final mutation admission with invalidation. A filesystem effect admitted before invalidation may complete; an effect not yet admitted must be rejected. Already committed or externally accepted effects cannot be retroactively cancelled.

Never report an invalidated operation as an ordinary success without recording the invalidation and observed outcome. Renewal failure and cancellation failure must be visible.

## 2. Policy, resource enforcement, and repository isolation

### Policy resolution

Global policy applies to the current user's enrolled repositories. Repository policy may tighten restrictions and replace permitted defaults.

| Condition | Required behavior |
|---|---|
| Repository raises a global ceiling or enables a forbidden capability | Reject publication with field-specific errors; never clamp silently. |
| Invalid UI candidate | Preserve the valid published policy. |
| Active global policy becomes invalid or unexpectedly missing | Block affected protected operations globally. |
| Active repository policy becomes invalid or unexpectedly missing | Block that repository's protected operations. |
| Optional repository policy has never been activated | Apply global policy. |
| Allow/deny overlap | Evaluate the concrete resource; any applicable denial wins. |
| Policy becomes more permissive | Require explicit activation; existing approvals do not expand. |

For example, `src/**` remains usable where allowed while `src/secrets/**` is denied. Record effective policy versions and contributing rules for every decision.

Enroll repositories through canonical filesystem identity and verified Git metadata. Worktrees require verified membership and explicit enrollment; repository names, remote URLs, and client-supplied identifiers are insufficient.

### Roles and broker

Implement authenticated role identity before resource enforcement.

| Role | Authority |
|---|---|
| Conductor | Coordinate stages and request specialists. |
| Researcher | Obtain external information through the gateway. |
| Planner | Read approved context and propose plans. |
| Implementer | Submit and apply reviewed changes through the file broker. |
| Reviewer | Inspect artifacts and issue findings. |
| Verifier | Request approved execution and assess results. |

Admission and delegation checks are atomic. Children inherit restrictions. Skills supply instructions, never permissions.

Every protected operation checks identity, final arguments, stage, policy, and artifact versions. Default-deny unlisted tools and commands. Constrain executable, arguments, environment, working directory, filesystem scope, and network access.

Bind mutations to reviewed changes and expected base versions. Default-deny deletion; enabled deletion still requires approval of exact paths. Keep engine evidence writing separate from agent authority.

### Filesystem mechanism

Protect creation, modification, deletion, rename, and replacement—not just writes.

**Linux:** use `openat2` beneath the enrolled root descriptor with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV`. Reject unsupported primitives rather than downgrade silently. These resolution restrictions apply across path components, unlike leaf-only `O_NOFOLLOW`. [Linux openat2 documentation](https://man7.org/linux/man-pages/man2/openat2.2.html)

**macOS:** use a native helper that opens every intermediate component relative to its pinned parent descriptor with directory/no-follow flags. At every hop, compare the opened descriptor's identity with the parent-relative entry. Retain the descriptor chain and revalidate its root-to-parent relationships immediately before mutation. Reject changes, symlinks, and unapproved volume crossings.

On both platforms:

- Resolve and pin the parent before `unlinkat`-relative deletion or relative rename.
- Check target identity, type, hard-link safety, and expected content before effect.
- Serialize conflicting namespace mutations under broker control.
- Deny untrusted workers direct mutation access to protected roots and their parent namespace.
- Treat trusted external edits as conflicts requiring renewed review.

Intermediate revalidation is not a substitute for excluding uncontrolled hostile writers. If containment cannot prevent concurrent untrusted namespace changes, refuse enforced mutation mode.

Detect actual filesystem case behavior; test case-sensitive and case-insensitive volumes without globally lowercasing paths.

### Research and execution

All agent-requested external information goes through the Researcher and gateway. Model-provider traffic uses a separate restricted engine channel.

Validate every redirect, allow at most five, reject prohibited addresses, pin validated destinations at connection time, and verify TLS hostname identity. Return bounded evidence with immutable provenance and trust labels.

Research content cannot create task authority, approve changes, or modify policy. Test harmful instructions that target otherwise allowed operations, including deleting source files and weakening tests.

Workers receive no general network, host mounts, privileged mode, host networking, devices, Docker/containerd sockets, or equivalent host-control endpoints. Approved plugins and hooks still require independent containment of alternate execution paths.

### Repository isolation

Repository isolation applies to **all session and storage paths**, independently of learning promotion.

- Partition sessions, conversations, gateway caches, artifacts, retrieval indexes, checkpoints, and learned knowledge by enrolled repository identity.
- Authorize every read and lookup using the session's repository scope. Knowing an artifact identifier or content hash grants no access.
- Disable cross-repository gateway-cache sharing in the first release, including results fetched from public URLs.
- Reuse specialists only within the same root session and repository. Never transfer retained conversation context between repositories.
- Reused worker processes must receive fresh credentials and cleared temporary state; otherwise create a fresh process.
- Worktrees share only explicitly repository-scoped knowledge. Session artifacts retain session/worktree ownership and require explicit sharing within that repository.
- Global skills are shared only through the approved global-promotion path.

## 3. Quality workflow, compaction, and learning

### Reviews

Persist:

`research → plan → implementation → execution → verification → complete`

Each stage produces versioned artifacts and passes its configured review. Support automatic reviews and configurable human gates; require human approval for destructive changes by default.

Blocking findings prevent advancement. Approvals bind artifact hashes, upstream dependencies, and policy versions. Invalidate dependencies transitively, including diamond graphs, without invalidating unrelated artifacts. Reject cycles.

Revision limit `0` permits the initial review only; `1` permits one corrective revision and re-review. Passing the last permitted revision advances; failing it enters `needs_attention`.

Validate role-specific model and reasoning settings against runtime capabilities; reject unsupported combinations.

### Compaction

Keep authoritative goals, constraints, decisions, findings, artifacts, approvals, pending operations, and policy references outside narrative summaries.

Request compaction near **70% usable context** and stop admitting optional context at **90%**. Reserve space for bounded tool results. Store large outputs as artifacts. Never compact across an incomplete tool exchange; pause when safe continuation cannot fit.

Preserve evidence provenance independently of narrative text:

- Derived segments retain source references and inherited trust labels.
- Mixed or ambiguous provenance remains untrusted.
- Summaries cannot upgrade research into governing instructions.
- Approval authorizes a particular action or artifact, not the entire source.

Checkpoint acceptance requires complete authoritative-state coverage, zero conflicting values, correct artifact references, preserved pending work, and complete evidence lineage without trust upgrades.

On failure, retain the previous checkpoint, retry once, then pause. Test behavioral continuation and repeated-compaction injection alongside structural fidelity.

### Learning

Candidates may change skills, instructions, and repository knowledge. They cannot alter enforcement policy, evaluation criteria, or approval records.

Require exact diffs, baseline versions, complete lineage, trust labels, and evaluation evidence. Use versioned fixture and held-out suites with three runs per model-dependent case.

Promotion rules:

- Any mandatory-control failure rejects the candidate.
- Compare each quality case's median and lowest score against the baseline.
- A decrease in either statistic on any case is a regression and rejects promotion.
- Require improvement in at least one predefined median quality score.
- Ties are ineligible; human approval cannot override failed eligibility gates.

Promotion requires human approval and defaults to repository scope.

Global promotion requires a separate privacy review and must exclude repository-private information from both the candidate and globally visible metadata. Keep private lineage access-controlled in its originating repository. Missing provenance or uncertain private content blocks promotion.

Rollback uses the shared authority-invalidation mechanism. Restart affected specialists from clean checkpoints with approved instructions; require root-session restart where safe reload is unavailable. Retain revoked material for audit without reinjecting it.

## 4. Interfaces, monitoring, and reliability

Provide versioned interfaces for policy management, pairing and registration, capability renewal, specialist admission, broker operations, artifacts, reviews, compaction, and learning.

Use idempotency keys and durable operation intents followed by outcomes. Reconcile interrupted effects after crashes before dependent work proceeds.

The agent-harness web interface uses loopback binding, authentication, and origin protection, with credentials separate from runtime integration. It exposes effective policy, role settings, enforcement health, reviews, context fidelity, provenance, rollback, and audit alerts.

Use SQLite WAL, a single writer queue, a five-second busy timeout, and bounded transaction retries. Storage contention must never repeat an external effect.

Target warm authorization latency of p95 ≤20 ms and p99 ≤50 ms at 50 requests/second across eight sessions, excluding execution and human waits. Measure durable audit latency separately. Required audit failure blocks new protected operations.

### Exact sliding denial windows

Use **sliding windows**, evaluated on every denial—not fixed time buckets.

| Scope | Threshold |
|---|---|
| Session | 10 in 60 seconds |
| Root and descendants | 20 in 60 seconds |
| Repository | 30 in 60 seconds |
| User-wide | 50 in 60 seconds |
| Repository or user-wide sustained activity | 100 in 15 minutes |

Count events in `(now − window, now]`, including the incoming event. Trigger when the count reaches the threshold. Use engine-assigned timestamps and unique event IDs; aggregate each event once per applicable scope.

Serialize concurrent updates so threshold crossings cannot be missed. Retain child attribution after termination. Persist recent events across engine restarts; use monotonic elapsed time during a process lifetime and conservative recovery when wall-clock changes are detected.

Show persistent, coalesced alerts with contributing sessions and rules. Thresholds produce alerts, not automatic declarations of malicious activity.

## 5. Delivery and release tests

| Phase | Deliverable | Exit gate |
|---|---|---|
| 1 | Policy, enrollment, registration, capabilities, role identity | Authentication, atomic nonce redemption, renewal, isolation bindings, and spoofing tests pass. |
| 2 | agent-harness OpenCode adapter and containment | Externally started sessions register; native tools, overrides, and plugins cannot bypass controls. |
| 3 | Resource enforcement and shared invalidation | File, deletion, network, command, and mid-operation authority-loss tests pass. |
| 4 | Coordination and reviews | Atomic admission, revision boundaries, and dependency invalidation pass. |
| 5 | Compaction and learning | Fidelity, trust preservation, repository privacy, evaluation, and rollback pass. |
| 6 | agent-harness web interface and first release | Controls, monitoring, recovery, and end-to-end conformance pass without launching root sessions. |
| 7 | agent-harness Codex adapter | Independently verify runtime identity, interception, containment, lifecycle, and compaction. |

Maintain a conformance matrix crossing identity, roles, tools, paths, commands, network, admission, reviews, skills, and policy with registration, configuration, CLI overrides, plugins, aliases, delegation, research, compaction, and learning.

Every cell requires a passing test or an evidence-backed N/A approved by a reviewer independent of its author. Relevant implementation changes invalidate N/A approval; CI rejects missing, stale, or self-approved records.

Required dedicated scenarios include:

- **Live nonce race:** concurrent valid redemptions produce exactly one registration; also test expiry, replay, transaction failure, and lost-response recovery.
- **Capability lifecycle:** exact expiry boundaries, successful and failed renewal, revocation, and renewal racing invalidation.
- **Shared cancellation:** policy tightening, rollback, expiry, and explicit revocation before admission, during execution, and across commit admission.
- **Filesystem races:** separate leaf-symlink swaps, intermediate-directory swaps, ancestor renames, deletion races, hard links, and case/volume behavior.
- **Cross-repository leakage:** cached research, reused specialist context, artifact-ID guessing, retrieval indexes, checkpoints, logs exposed to agents, and worker temporary files.
- **Sliding-window boundaries:** bursts straddling fixed-minute boundaries at every scope, exact window expiry, concurrent events, terminated children, sustained windows, and restart recovery.
- **Other enforcement:** malformed policies, partial overlaps, worktree spoofing, DNS rebinding, redirect chains, host-control sockets, and harmful research-directed actions.
- **Quality and state:** diamond invalidation, revision limits zero/one, large tool outputs, repeated compaction, evaluation regressions, private global candidates, storage contention, and crash reconciliation.

Release requires passing applicable OpenCode conformance tests on supported Linux and macOS environments, valid independent N/A approvals, no protected effects from denied-operation fixtures, no cross-repository information leakage, and observable outcomes for every interrupted operation.

The QA demonstration exercises these production controls. Codex support and spending-budget enforcement remain later work.
