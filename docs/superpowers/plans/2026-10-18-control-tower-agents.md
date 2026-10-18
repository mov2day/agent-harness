# Control Tower: Agent Registry and Dynamic Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Turn the fixed six-role engine into an owner-configurable control tower: an agent registry (mandatory, default, custom agents with owner-written system prompts), per-global/per-repo enablement, orchestrator-chosen routing limited to enabled agents, a verifier checkpoint after every stage, and a skills/MCP/tool catalog the owner allows or denies.

**Architecture:** Agents live inside the existing layered `Policy` (global ceiling, repo tightening, owner-only publication, activation, audit, invalidation). Engine *base roles* (Conductor, Researcher, Planner, Implementer, Executor, Reviewer, Verifier) remain the authority classes; an agent definition binds a name, prompt, model, and narrowed tool/skill/MCP sets to one base role and can never exceed it. The Conductor picks a `route` (subset of stages in canonical order) once per root session; the engine validates it against enabled agents.

**Tech Stack:** TypeScript (Node 22), zod, SQLite store, React web UI, `node --test`.

**Spec:** `docs/plan.MD` (updated in Task 7). Approved decisions: routing is dynamic but restricted to owner-approved (enabled) agents; custom system prompts are written only by the authenticated owner through the web API; update the spec; implement all five phases.

## Global Constraints

- Mandatory agents `orchestrator` (base Conductor), `verifier` (base Verifier), `reviewer` (base Reviewer) are always present and enabled in every policy, global and repo; they cannot be removed or disabled. Their prompts are owner-editable.
- Repo policy can only tighten: cannot enable an agent disabled globally, cannot widen an agent's tools/skills/MCPs beyond the global definition, cannot change `baseRole`/`kind`.
- Agent tools must be a subset of the base role's permissions; `research` (web) stays Researcher-only.
- Deny beats allow for skills and MCPs. Nothing agent-authored or research-derived can edit agent definitions (owner routes only).
- No new engine behavior may weaken existing authorization, artifact-hash, or revision-limit guarantees.
- Existing tests keep passing unless the spec change requires an update (Executor role, verify/review stage defaults).

## Review Focus

- Policy with a missing/disabled mandatory agent is rejected with a field error, never silently repaired.
- Repo policy that enables a globally disabled agent or widens its tools is rejected.
- Route that needs a stage with no enabled agent, a duplicate/out-of-order stage, or is set twice is rejected.
- Delegating to a disabled or unknown agent is rejected; a custom agent cannot call tools outside its base role.
- Verifier checkpoint cannot be skipped by submitting straight to review; the verifier cannot verify its own artifact.
- Catalog never returns secret values (env, headers) and refuses non-enrolled repository paths.

---

### Task 1: Executor role and role permissions

**Files:** Modify `src/core.ts`, `src/operations.ts`, `src/snapshots.ts`; Test `test/agents.test.ts` (created in Task 2).

**Interfaces:** Produces `roles` including `"Executor"`; `permissions.Executor = ["read","execute","artifact","compact","model"]`; `permissions.Verifier` gains `"review"`.

- [ ] Add `"Executor"` to `roles` (after `Implementer`), add its permissions, add `"review"` to Verifier, allow Executor in the snapshot role check.
- [ ] Run `npm run typecheck` and the existing suite; fix fallout (`Role` records).

### Task 2: Agent registry in policy

**Files:** Create `src/agents.ts`; Modify `src/policy.ts`; Test `test/agents.test.ts`.

**Interfaces:**
- Produces `agentSchema`, `type AgentDef = { id; name; kind: "mandatory"|"default"|"custom"; baseRole: Role; description; systemPrompt; model?: {model; reasoning}; tools: string[]; skills: string[]; mcps: string[]; enabled: boolean }`.
- Produces `builtinAgents: AgentDef[]` (7 agents), `mandatoryAgentIds`, `resolveAgent(policy, id): AgentDef`, `agentForRole(policy, role): AgentDef | undefined` (first enabled agent with that base role), `assertAgents(policy)` (structure + mandatory), `assertAgentTightening(global, repo, errors)`.
- Policy gains `agents`, `allowedSkills`, `deniedSkills`, `allowedMcps`, `deniedMcps`, `orchestration: { verifyStages: Stage[]; reviewStages: Stage[] }`; `defaultPolicy` sets them (verify all five stages; review `plan`,`implementation`).

- [ ] Write failing tests: default policy valid; removing/disabling `verifier` rejected; agent tool outside base role rejected; agent skill not in allowed list rejected; repo enabling a globally disabled agent rejected; repo widening tools rejected; repo adding custom agent with allowed subset accepted.
- [ ] Implement `src/agents.ts` and wire into `policySchema` (`superRefine`) and `assertTightening` (`errors.agents`, `errors.skills`, `errors.mcps`, `errors.orchestration`: repo `verifyStages` ⊇ global, `reviewStages` ⊇ global).
- [ ] Run tests; commit not requested.

### Task 3: Agent binding, admission, per-agent authorization, prompt delivery

**Files:** Modify `src/core.ts` (`Session.agent?: string`), `src/identity.ts` (root registers as `orchestrator`), `src/workflow.ts` (`admit`), `src/specialists.ts` (delegate schema), `src/operations.ts` (`authorize`), `src/engine.ts` (context payload); Test `test/agents.test.ts`.

**Interfaces:** `Workflow.admit(parent, role, setting?, agent?: string)`; delegate `start` accepts `role` (incl. Executor) and/or `agent`; either resolves to an enabled agent, `agent` wins and sets role to its `baseRole`. Context op returns `session.agent = {id,name,systemPrompt}` and, for Conductor, `agents: [{id,name,baseRole,description}]` of enabled non-Conductor agents.

- [ ] Failing tests: admit by role fails when no enabled agent has that base role; admit disabled/unknown agent rejected; authorize denies a tool the agent omits even if role allows; agent model override used and validated.
- [ ] Implement; legacy sessions without `agent` resolve by role.

### Task 4: Dynamic route, verifier checkpoint, configurable review stages

**Files:** Modify `src/core.ts` (`Session.route?: Stage[]`), `src/workflow.ts` (`setRoute`, `submit`, `review`, `validateAttempt`, `advance`, `StageAttempt`, `Review.kind`), `src/specialists.ts` (delegate `route` action), `src/operations.ts` (delegate args); Test `test/workflow.test.ts`, `test/agents.test.ts`.

**Interfaces:** `Workflow.setRoute(scope: Session, stages: Stage[]): Session` (Conductor root only, before first submit, canonical order, no `complete`, ≥1 stage, each stage has an enabled agent for its roles). `StageAttempt.state` adds `"verify"`; `StageAttempt.verification?: string`. Stage roles: research→Researcher; plan→Planner; implementation→Implementer; execution→Executor|Verifier; verification→Verifier. `submit` sets state `verify` if stage ∈ `verifyStages`, else `review` if ∈ `reviewStages`, else gate/advance. Verifier (state `verify`) or Reviewer (state `review`) call the existing `review` tool; passing verify moves to `review`/gate/advance.

- [ ] Update existing workflow tests for new default (verify then review where configured); add tests for skipping stages via route, route validation failures, verifier-required, self-verification rejected, revision limit shared.
- [ ] Implement.

### Task 5: Skills / MCP / tool catalog

**Files:** Create `src/catalog.ts`; Modify `src/server.ts` (`/v1/owner/catalog`); Test `test/catalog.test.ts`.

**Interfaces:** `discoverCatalog(opts: { home: string; repositoryPath?: string }): { skills: CatalogEntry[]; mcps: CatalogEntry[]; tools: string[] }`, `CatalogEntry = { name; scope: "global"|"repo"; source: string; description?: string; transport?: string }`. Sources: `~/.claude/skills/*/SKILL.md`, `<repo>/.claude/skills/*/SKILL.md`, `~/.claude.json` and `<repo>/.mcp.json` `mcpServers`. Secrets never returned. Route requires the path to be an enrolled repository.

- [ ] Failing tests with temp dirs: finds global+repo skills and MCPs; omits env/headers; malformed JSON ignored; route rejects unenrolled path.
- [ ] Implement.

### Task 6: Control tower UI

**Files:** Create `web/Agents.tsx`; Modify `web/App.tsx` (page, nav, state types), `web/app.css`.

- [ ] Page "Agents": scope selector (global or enrolled repo, plus an "enroll repo path" field using existing `repositories` route); agent list with enable toggles (mandatory locked), model/reasoning inputs, per-agent tools/skills/MCPs checklists fed by the catalog; orchestration controls (maxDepth, maxSpecialists, revisionLimit, verify/review stages); custom agent form with id, name, base role, description, system-prompt textarea; Save publishes through `/v1/owner/policies`, surfacing field errors.
- [ ] `npm run build` passes; smoke-check in browser if the engine can be started locally.

### Task 7: Docs and full verification

**Files:** Modify `docs/plan.MD`, `README.md`, `docs/IMPLEMENTATION.md`; Create `docs/AGENTS.md`.

- [ ] Update the spec (roles table, workflow, policy resolution) and document that MCP/skill allow-deny is policy plus agent context, not a brokered MCP proxy.
- [ ] Run `npm run format`, `npm run typecheck`, `npm test`, `npm run build`.
