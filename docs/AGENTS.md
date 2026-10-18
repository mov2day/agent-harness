# Control tower: agents, routing and catalog

The control tower is the **Agents** page of the web interface. It configures the harness at two levels:

- **Global harness** — the catalogue of agents, skills, MCP servers and limits for every enrolled repository.
- **Repository harness** — enable a repository (enter its path), then choose which agents run there and what each may use. A repository can be **granted** more than the global defaults (for example web research and some domains) without changing the global harness or any other repository. You confirm each new grant once. The only limits no repository can pass are the global denials (skills, MCP servers) and the global **Forbidden everywhere** tools and domains.

## Agents

| Agent        | Kind      | Role        | Default               |
| ------------ | --------- | ----------- | --------------------- |
| Orchestrator | mandatory | Conductor   | on, cannot be removed |
| Verifier     | mandatory | Verifier    | on, cannot be removed |
| Reviewer     | mandatory | Reviewer    | on, cannot be removed |
| Researcher   | default   | Researcher  | on                    |
| Planner      | default   | Planner     | on                    |
| Implementer  | default   | Implementer | on                    |
| Executor     | default   | Executor    | on                    |

Each agent has a system prompt, an optional model and reasoning level, and its own tools, skills and MCP servers. Tools are capped by the agent's role (`src/agents.ts`, `rolePermissions`). Web research stays with Researcher-role agents because only that role holds the `research` tool; all retrieved content stays `untrusted` and is bounded by the gateway.

**Tools and permissions.** An agent's tools are capped by its role and always include the plumbing every agent needs (`model`, `compact`, `artifact`: shown locked). The mandatory agents cannot lose the tool that is their job: the Orchestrator needs `delegate`, the Verifier and Reviewer need `review`. Publishing is refused otherwise, and the **Verify** check also fails if the policy's own tool list leaves those out. Defaults follow least privilege, and the agent card offers **Use recommended tools**:

- **Researcher: web only** (`research`, no repository `read`). The agent that handles untrusted outside content does not also see private files.
- **Verifier: judges, does not run commands** (`read`, `review`). The **Executor** runs approved commands and may perform the execution and verification stages; the Verifier checks the results.
- Verify also warns when `execute` is enabled with no approved command, `research` with no allowed domain, or delegation with a depth or agent limit of 0.

**Models.** Each agent's model is a dropdown of the models from the providers connected in OpenCode (`opencode models`, loaded on demand, cached for five minutes, **Refresh models** asks again), with the reasoning levels that model offers. Models a runtime certificate lists are marked ✓ enforced; others work in native OpenCode but enforced sessions refuse them until a certificate lists the model (Verify reports this). If OpenCode cannot be asked the fields fall back to text.

**Custom agents** are added on the same page: id, name, role, description and system prompt. They start with their role's full tool set and cannot exceed it. Only the authenticated owner can create or edit agents and prompts (`POST /v1/owner/policies`); agent sessions have no route to them.

## How a task runs

1. The Orchestrator reads its authoritative context (`compact` → `context`), which lists the enabled agents and its own owner-written prompt.
2. It chooses the stages the task needs with `delegate {"action":"route","stages":[…]}`, once and before any work. Each stage must have an enabled agent.
3. It delegates each stage to an enabled agent, by `role` or by `agent` id. Disabled or unknown agents are refused.
4. After a stage's artifact is submitted the **Verifier** checks it (default: every stage), then the **Reviewer** (default: plan and implementation), then any human gate. A blocking finding triggers a corrective revision up to the revision limit.
5. When the last routed stage passes the task is complete.

Delegation depth, concurrent agents and revision limits are set under **Orchestration**.

## Web research: why an agent may be unable to fetch

Out of the box the Researcher cannot reach any outside source, on purpose (deny by default). Four things must all be true, and **Verify → "Web research is ready"** names the ones that are not:

1. The **Researcher** agent is enabled and holds the `research` tool (it is the only role that can). Ticking `research` on the agent is not enough: the policy's own tool list for that scope decides, and a tool the policy does not allow does nothing. The agent card says "not allowed by the policy" and offers **Turn on in policy**; the Researcher card also shows a banner with the missing pieces and a one-click fix.
2. **Allow web research** is on (the policy's `research` tool). Agents page → Web research.
3. The host is in **Allowed domains**: exact host names, HTTPS only (`github.com` does not cover `api.github.com` or `www.`). With none listed, every address is refused.
4. The task is in the **research stage** and the Researcher has been delegated to.

Then the review mode applies: by default fetched text is held until you approve it under **Reviews**, and the agent is told plainly that this is a wait (not a network failure) and that it should request the same URL again after approval. **Native OpenCode has no research gateway.** The gateway (enforced domains, review, cleaning) exists only in sessions registered with the engine. In your own OpenCode the exported `harness-researcher` uses OpenCode's `websearch` to find pages and `webfetch` to read them (both ask before each call unless external-content review is off, and both are denied when no domain is allowed). OpenCode registers `websearch` only for its own `opencode` provider (and `opencode-go` from 1.19) or when started with `OPENCODE_ENABLE_EXA=1` (or `OPENCODE_ENABLE_PARALLEL=1`), for example `OPENCODE_ENABLE_EXA=1 opencode`; a `websearch` permission alone does not add the tool, and **Publish & verify** warns when the flag is missing. Its exported prompt says so, lists the allowed hosts as instructions it must follow (OpenCode does not enforce them) and tells it to report a denied or pending fetch instead of saying the information is unavailable. Re-run **Write selected** after changing research settings so the file carries this, and start a new OpenCode session. Invoke it with `@harness-researcher` or through `harness-orchestrator` (it is a subagent, so `opencode run --agent` cannot select it).

The Researcher also has no repository `read` by default (least privilege), so it will report no local file access; the Orchestrator should pass it the context it needs as artifacts.

## Manual review points

Under **Agents → Manual review points** (global defaults, or per repository):

- **Approve before a stage starts.** The task waits at the start of each chosen stage. No agent is delegated and no artifact is accepted for that stage until you approve under **Reviews**. Rejecting pauses the task (needs attention).
- **Approve after a stage finishes.** The existing human gate, now also on this page. **Send back** returns the stage for revision with your reason, which the Orchestrator receives as feedback (it counts against the revision limit; at the limit the task needs attention).
- **External content.** Choose how web fetches are handled, per policy:
  - `approve-content` (default): the page is fetched and held back. You read the cleaned text and any flags, and the agent receives exactly that text only after you approve. A rejection is final for that URL in that task.
  - `approve-url`: you approve each address before it is fetched.
  - `off`: no review.
  - **Trusted domains** skip review. They must also be allowed research domains.

All fetched text is cleaned first (`src/sanitize.ts`): HTML reduced to visible text, comments, scripts and hidden markup removed, hidden characters stripped, size bounded. Text that looks addressed to the model (override instructions, role markers, requests to delete or send files, claimed approvals, large encoded blobs) is **flagged for you**. Flags are hints, not a security boundary; fetched content stays untrusted and cannot grant authority.

An approval binds the exact URL for that task and, for content review, the exact stored evidence you read. Pending items and the Orchestrator's context list what is waiting, so agents wait instead of working around it. The Reviews page shows a pending count and every decision is audited.

## Publishing: one flow

The harness you publish on the Agents page is the single source of truth: it is what the engine enforces and what a new session loads. Everything else is derived from it, in one place, **Publish &amp; verify**:

1. **Publish** the harness (the button under the editors). Running sessions end; start a new one to load it.
2. **Preview** and **Write selected** write the outputs you tick, from what is published (never from unsaved edits). Publishing a policy never writes files.
   - **harness.toml**: the readable source to keep in git. `<repo>/.agent-harness/harness.toml`, or `~/.config/agent-harness/harness.toml` (`$XDG_CONFIG_HOME/agent-harness/`) for global. A file the harness wrote (it starts with `# agent-harness policy (format 1)`) is updated; a file you wrote is kept and replaced only if you tick "Replace my harness.toml".
   - **OpenCode agents**: native `harness-<id>.md` files in `<repo>/.opencode/agent/` or `~/.config/opencode/agent/`. Files you wrote are never overwritten. Files the harness wrote are updated, and removed when their agent is turned off.
   - One target failing (for example a conflicting file) does not stop the other; each result is reported. Symlinked folders and files are never followed.
3. **Verify** (runs automatically on opening and after a write) checks, per scope:
   - the published policy loads, and the Orchestrator, Verifier and Reviewer are enabled
   - every skill and MCP server an agent uses exists in your configuration
   - harness.toml: matches, missing, out of sync, or edited so that it no longer loads
   - OpenCode files: in sync, not written, out of date, left from a disabled agent, or kept because you wrote them
   - **Verify in OpenCode** also starts the installed OpenCode briefly and checks it resolves every in-sync `harness-…` agent with the right mode.

**Edit as TOML** is the reverse direction and only edits policy: start from the published harness or a harness.toml file, validate, and import under exactly the rules of the form. It writes no files. A file on disk never applies on its own.

Each OpenCode file carries the agent's prompt and a `permission` block: read tools allowed only if granted, with the policy's protected paths (`denyPaths`, e.g. `.env`, `.git/**`) kept as `deny` rules under `read` and `edit` (OpenCode matches only `*` and `?`, so each glob is widened, never narrowed); `edit`, `bash` and web access set to `ask` where you require manual review (implementation gate or start review, executing commands, external content review); `task` limited to the enabled `harness-*` agents; `skill` limited to the agent's allowed skills; `external_directory` denied. `edit` covers OpenCode's `edit`, `write` and `apply_patch` tools; `webfetch` and `websearch` take a single action, because OpenCode rejects the whole file if they are given URL patterns. MCP servers are switched with `"<mcp>_*": allow|deny` rules in the same `permission` block (OpenCode deprecated the per-agent `tools` map in 1.1.1); server definitions and credentials are never copied. The orchestrator also carries a "Harness protocol" section built from the policy. Verified to load in the OpenCode 1.17.13 and 1.19.3 CLIs, which resolve the generated permissions as written. `glob` and `grep` cannot be limited by path in OpenCode, and `bash` (always `ask`) can read any file, so protected paths are enforced only for `read` and `edit`. In 1.19.3 the experimental code-mode `execute` tool (`OPENCODE_EXPERIMENTAL_CODE_MODE`, also turned on by `OPENCODE_EXPERIMENTAL`) still applies these `<mcp>_*` rules to every MCP call; use `OPENCODE_ENABLE_EXA=1` rather than `OPENCODE_EXPERIMENTAL=1` to enable search.

Native OpenCode files and harness.toml are conveniences: only sessions registered with the engine are enforced. The API behind the panel is `POST /v1/owner/sync/preview|write|verify` (owner only); the earlier `opencode/*` and `toml/write*` routes remain for scripts.

## Skills and MCP servers

`POST /v1/owner/catalog` lists skills and MCP servers from global (`~/.claude`, `~/.claude.json`, installed plugins) and, for an enrolled repository, `.claude/skills` and `.mcp.json`. Only names, scope and transport are read; environments, arguments, headers and URLs are never returned. Allow or deny each entry; unlisted is denied and denial wins. A repository cannot allow a globally denied entry.

Limit: these lists and each agent's allowed subset are policy and authoritative agent context. The engine does not proxy MCP calls, so an MCP server is reachable only if the runtime is configured with one.

## Defaults, grants and limits

- **Global harness = defaults + prohibitions.** It is what a repository gets until it has its own policy, plus an optional **Forbidden everywhere** list (tools and domains) and the global skill/MCP denials. Enabling something globally makes it the default for every repository without its own policy, so prefer granting to just the repository that needs it.
- **Grants.** In a repository, turn something on (web research, a tool, more domains or commands, higher limits, fewer review points, an enabled agent) and publish. The page lists what is new and asks you to confirm it for this repository only (**Grant to this repository and publish**). Confirmed grants are listed under **Granted to this repository**, recorded in the audit trail (`policy.granted`), and not asked about again; removing a grant needs no confirmation, and asking for it again later does. Other repositories and the global defaults never change. API: `POST /v1/owner/policies` with `acknowledgeGrants: true` (preview with `/v1/owner/policies/preview`); importing a harness.toml has the same checkbox.
- **Hard limits** (confirmation cannot override them): a repository cannot allow a globally denied skill or MCP server, drop a global denial or prohibition, use a forbidden tool or domain, or allow file paths outside the global ones.
- **If a limit is added later** (a new denial or prohibition) a repository that already used that thing stops loading and its protected operations are blocked (fail closed). The Agents page lists the exact fields and offers **Remove what breaks the global limits**, which removes only that and keeps the repository's other grants (`policy.repaired` in the audit trail). A global publish that would do this is refused with the list; tick **Also fix repositories this change would block** (`repair: true`) to fix them in the same step. Ordinary changes to the global defaults never block a repository.

## Compatibility

Policies published before this change lack the agent fields and fail validation, so the engine blocks protected operations until a new policy is published (a fresh `init` publishes the default). This is a pre-release change; earlier policies are not migrated.
