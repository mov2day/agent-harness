import React, { useEffect, useState } from "react";
import type { Engine } from "../src/engine.js";
import type { AgentDef } from "../src/agents.js";
import type { Policy } from "../src/policy.js";

type State = ReturnType<Engine["state"]>;
type Action = (path: string, data: unknown, message: string) => Promise<void>;
interface Entry {
  name: string;
  scope: "global" | "repo";
  description?: string;
  transport?: string;
}
interface Catalog {
  skills: Entry[];
  mcps: Entry[];
  tools: string[];
}
type Rule = "default" | "allow" | "deny";
type Stage = Policy["orchestration"]["verifyStages"][number];
const pretty = (s: string) => s.replaceAll("_", " ");
const stageNames: Stage[] = [
  "research",
  "plan",
  "implementation",
  "execution",
  "verification",
];
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const toggle = <T,>(list: T[], item: T, on: boolean) =>
  on ? [...new Set([...list, item])] : list.filter((x) => x !== item);

export function Agents({
  state,
  busy,
  action,
  request,
  refresh,
}: {
  state: State;
  busy: boolean;
  action: Action;
  request: (path: string, data?: unknown) => Promise<any>;
  refresh: () => Promise<void>;
}) {
  const [scope, setScope] = useState("global"),
    [path, setPath] = useState(""),
    [suggested, setSuggested] = useState(""),
    [working, setWorking] = useState(false),
    [notice, setNotice] = useState(""),
    [catalog, setCatalog] = useState<Catalog>(),
    [failure, setFailure] = useState("");
  useEffect(() => {
    setCatalog(undefined);
    setFailure("");
    request("catalog", scope === "global" ? {} : { repository: scope })
      .then(setCatalog)
      .catch((e) => setFailure(e.message));
  }, [scope]);
  /** Enable the repository, then open its configuration straight away. */
  const enroll = async (target: string) => {
    setWorking(true);
    try {
      const repo = await request("repositories", { path: target });
      await refresh();
      setScope(repo.id);
      setPath("");
      setNotice(
        "Repository enabled. It starts with the global harness; change anything below and publish to give it its own.",
      );
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const global =
      "policy" in state.globalPolicy ? state.globalPolicy : undefined,
    entry = state.policies.find((p) => p.repository === scope),
    effective = entry && "effective" in entry ? entry.effective : undefined;
  const own: Policy | undefined =
    scope === "global"
      ? global?.policy
      : (effective?.repository?.policy ?? global?.policy);
  const agents =
    scope === "global" ? global?.policy.agents : effective?.policy.agents;
  return (
    <>
      <p className="intro">
        Choose which agents may work, what each may use, and how the
        Orchestrator may route a task. The Orchestrator, Verifier and Reviewer
        are always on. Only you can write agent instructions here; nothing an
        agent reads or produces can change them.
      </p>
      <section>
        <div className="section-heading">
          <h2>Harness scope</h2>
        </div>
        <div className="scope-select">
          <label htmlFor="agent-scope">Configure</label>
          <select
            id="agent-scope"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setNotice("");
            }}
          >
            <option value="global">Global harness — all repositories</option>
            {state.repositories.map((r) => (
              <option value={r.id} key={r.id}>
                Repository — {r.path}
              </option>
            ))}
          </select>
        </div>
        <form
          className="actions"
          onSubmit={(e) => {
            e.preventDefault();
            setSuggested("");
            setNotice("");
            setFailure("");
            // Enrollment needs the exact worktree root; offer it instead of failing.
            request("repositories/resolve", { path })
              .then((r) =>
                r.root === r.path ? enroll(r.path) : setSuggested(r.root),
              )
              .catch((err) => setFailure(err.message));
          }}
        >
          <input
            aria-label="Repository path"
            placeholder="/absolute/path/to/repository"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            required
          />
          <button className="secondary" disabled={busy || working}>
            Enable repository
          </button>
        </form>
        {suggested && (
          <div className="warning" role="note">
            That folder is inside a Git worktree. Enroll its root instead:{" "}
            <code>{suggested}</code>{" "}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setSuggested("");
                void enroll(suggested);
              }}
            >
              Enroll worktree root
            </button>
          </div>
        )}
        <p className="fine">
          A repository can enable only what the global harness enables, and can
          only narrow what each agent may use.
        </p>
      </section>
      {failure && (
        <p role="alert" className="error">
          {failure}
        </p>
      )}
      {notice && (
        <div role="status" className="notice banner">
          {notice}
        </div>
      )}
      {scope !== "global" && own && (
        <p className="fine">
          {effective?.repository
            ? "This repository has its own published harness."
            : "No repository harness is published yet: this repository inherits the global harness. Publish below to give it its own."}
        </p>
      )}
      {!own || !agents || !global ? (
        <div role="alert" className="error">
          <strong>The published policy for this scope cannot be read.</strong>
          {entry && "violations" in entry && entry.violations ? (
            <>
              <p>
                This repository&apos;s saved policy breaks a global limit (a
                denial or prohibition set on the global harness), so its
                protected operations are blocked until that is removed:
              </p>
              <ul>
                {Object.entries(entry.violations).map(([field, why]) => (
                  <li key={field}>
                    <code>{field}</code>: {why}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() =>
                  void action(
                    "policies/repair",
                    { repository: scope },
                    "Removed what broke the global limits.",
                  )
                }
              >
                Remove what breaks the global limits
              </button>
              <p className="fine">
                Removes only the denied or forbidden entries and keeps
                everything else this repository was granted. Recorded in the
                audit trail.
              </p>
            </>
          ) : (
            <p>
              Protected operations are blocked until a valid policy is active.
              {"error" in state.globalPolicy
                ? ` Global policy: ${String(state.globalPolicy.error)}`
                : entry && "error" in entry
                  ? ` ${String(entry.error)}`
                  : ""}{" "}
              If it was saved by an earlier version, restart the engine to
              upgrade it.
            </p>
          )}
        </div>
      ) : !catalog ? (
        <p className="quiet">Reading skills and MCP servers…</p>
      ) : (
        <AgentEditor
          key={`${scope}:${effective?.id ?? global.id}:${catalog.skills.length}`}
          scope={scope}
          base={own}
          agents={agents}
          globalPolicy={global.policy}
          catalog={catalog}
          roles={state.agentRoles}
          rules={state.agentRules}
          grants={
            entry && "grants" in entry && entry.grants
              ? (entry.grants as Record<string, string>)
              : {}
          }
          request={request}
          busy={busy}
          action={action}
        />
      )}
      {own && agents && global && (
        <>
          <PublishPanel scope={scope} request={request} />
          <TomlEditor
            scope={scope}
            request={request}
            action={action}
            busy={busy}
          />
        </>
      )}
    </>
  );
}

interface ExportFile {
  name: string;
  action: "create" | "update" | "unchanged" | "conflict" | "remove";
  reason?: string;
}
interface TomlPlan {
  path: string;
  action: "create" | "update" | "unchanged" | "conflict";
  reason?: string;
  replaceable?: boolean;
}
interface Check {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}
const actionWord = (a: string) =>
  a === "conflict" ? "kept" : a === "remove" ? "remove" : a;
const actionBadge = (a: string) =>
  a === "conflict" ? "warn" : a === "unchanged" ? "good" : "";

/** The one place the published harness leaves the engine: harness.toml (the
 * readable source you can commit) and the native OpenCode agents. Both are
 * written from what is published, previewed first, then checked. */
function PublishPanel({
  scope,
  request,
}: {
  scope: string;
  request: (path: string, data?: unknown) => Promise<any>;
}) {
  const [targets, setTargets] = useState({ toml: true, opencode: true }),
    [plan, setPlan] = useState<{
      toml?: TomlPlan;
      opencode?: { directory: string; files: ExportFile[] };
    }>(),
    [replace, setReplace] = useState(false),
    [checks, setChecks] = useState<Check[]>(),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [working, setWorking] = useState(""),
    scopeBody = scope === "global" ? {} : { repository: scope };
  const verify = async (load: boolean) => {
    setWorking(load ? "Asking OpenCode…" : "Checking…");
    try {
      setChecks((await request("sync/verify", { ...scopeBody, load })).checks);
    } finally {
      setWorking("");
    }
  };
  const run = async (label: string, work: () => Promise<void>) => {
    setError("");
    setMessage("");
    setWorking(label);
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking("");
    }
  };
  useEffect(() => {
    setPlan(undefined);
    setReplace(false);
    setMessage("");
    setError("");
    setChecks(undefined);
    void run("Checking…", () => verify(false));
  }, [scope]);
  const preview = () =>
    run("Previewing…", async () => {
      setReplace(false);
      setPlan(await request("sync/preview", { ...scopeBody, targets }));
    });
  const changes =
    (plan?.toml && ["create", "update"].includes(plan.toml.action) ? 1 : 0) +
    (plan?.toml?.action === "conflict" && replace ? 1 : 0) +
    (plan?.opencode?.files.filter((f) =>
      ["create", "update", "remove"].includes(f.action),
    ).length ?? 0);
  const write = () =>
    run("Writing…", async () => {
      const out = await request("sync/write", {
        ...scopeBody,
        targets,
        replaceToml: replace,
      });
      const lines = [
        out.toml &&
          (out.toml.ok
            ? `harness.toml written`
            : `harness.toml not written: ${out.toml.error}`),
        out.opencode &&
          (out.opencode.ok
            ? `OpenCode: ${out.opencode.result.written.length} file(s) written`
            : `OpenCode not written: ${out.opencode.error}`),
      ].filter(Boolean) as string[];
      setMessage(lines.join(" · "));
      setChecks(out.checks);
      setReplace(false);
      setPlan(await request("sync/preview", { ...scopeBody, targets }));
    });
  return (
    <section>
      <div className="section-heading">
        <h2>Publish &amp; verify</h2>
        <span className="fine">From the published harness</span>
      </div>
      <p className="fine">
        1. Publish the harness above: that is what the engine enforces and what
        new sessions load. 2. Write the files below from it. 3. Verify that
        everything matches. Files are written only from here, never when you
        publish. Unsaved edits above are not included.
      </p>
      <div className="checkbox-grid">
        <label className="check">
          <input
            type="checkbox"
            checked={targets.toml}
            onChange={(e) => setTargets({ ...targets, toml: e.target.checked })}
          />
          harness.toml{" "}
          <small>
            the readable source to keep in git ·{" "}
            {scope === "global"
              ? "~/.config/agent-harness/"
              : "<repo>/.agent-harness/"}
          </small>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={targets.opencode}
            onChange={(e) =>
              setTargets({ ...targets, opencode: e.target.checked })
            }
          />
          OpenCode agents{" "}
          <small>
            native <code>harness-…</code> agents ·{" "}
            {scope === "global"
              ? "~/.config/opencode/agent/"
              : "<repo>/.opencode/agent/"}
          </small>
        </label>
      </div>
      <div className="actions">
        <button
          type="button"
          className="secondary"
          disabled={!!working || (!targets.toml && !targets.opencode)}
          onClick={() => void preview()}
        >
          Preview
        </button>
        <button
          type="button"
          className="primary"
          disabled={!!working || !plan || changes === 0}
          onClick={() => void write()}
        >
          Write selected
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!!working}
          onClick={() => void run("Checking…", () => verify(false))}
        >
          Verify
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!!working}
          title="Starts the installed OpenCode briefly and lists the agents it loads"
          onClick={() => void run("Asking OpenCode…", () => verify(true))}
        >
          Verify in OpenCode
        </button>
        {working && <span className="fine">{working}</span>}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && (
        <div role="status" className="notice banner">
          {message}
        </div>
      )}
      {plan?.toml && (
        <div className="list-row">
          <div>
            <strong>harness.toml</strong>
            <small className="mono">{plan.toml.path}</small>
            <small>
              {plan.toml.action === "create" && "Will be created."}
              {plan.toml.action === "update" && "Will be updated."}
              {plan.toml.action === "unchanged" && "Already matches."}
              {plan.toml.action === "conflict" &&
                `${plan.toml.reason}. Kept unless you replace it.`}
            </small>
            {plan.toml.action === "conflict" && plan.toml.replaceable && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={replace}
                  onChange={(e) => setReplace(e.target.checked)}
                />
                Replace my harness.toml
              </label>
            )}
          </div>
          <span className={`badge ${actionBadge(plan.toml.action)}`}>
            {actionWord(plan.toml.action)}
          </span>
        </div>
      )}
      {plan?.opencode && (
        <div>
          <p className="fine mono">{plan.opencode.directory}</p>
          {plan.opencode.files.map((f) => (
            <div className="list-row" key={f.name}>
              <div>
                <strong>{f.name}</strong>
                {f.reason && <small>{f.reason}</small>}
              </div>
              <span className={`badge ${actionBadge(f.action)}`}>
                {actionWord(f.action)}
              </span>
            </div>
          ))}
        </div>
      )}
      {checks && (
        <div>
          <h3>Checks</h3>
          {checks.map((c) => (
            <div className="list-row" key={c.id}>
              <div>
                <strong>{c.label}</strong>
                <small>{c.detail}</small>
              </div>
              <span
                className={`badge ${c.status === "ok" ? "good" : c.status === "warn" ? "warn" : "bad"}`}
              >
                {c.status === "ok"
                  ? "ok"
                  : c.status === "warn"
                    ? "check"
                    : "failed"}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="fine">
        Publishing a policy ends running sessions; start a new one to load it.
        Native OpenCode files are a convenience and are not enforcement: only
        sessions registered with the engine are enforced.
      </p>
    </section>
  );
}

/** Edit the published harness as text, then validate and import it under the
 * same rules as the form. Nothing here writes files; Publish &amp; verify does. */
function TomlEditor({
  scope,
  request,
  action,
  busy,
}: {
  scope: string;
  request: (path: string, data?: unknown) => Promise<any>;
  action: Action;
  busy: boolean;
}) {
  const [text, setText] = useState(""),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [grant, setGrant] = useState(false);
  const body = scope === "global" ? {} : { repository: scope };
  useEffect(() => {
    setText("");
    setMessage("");
    setError("");
    setGrant(false);
  }, [scope]);
  const run = async (work: () => Promise<void>) => {
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section>
      <div className="section-heading">
        <h2>Edit as TOML</h2>
        <span className="fine">Advanced</span>
      </div>
      <p className="fine">
        Start from the published harness or a harness.toml file, edit, validate,
        then import to publish. A file on disk never applies on its own.
      </p>
      <div className="actions">
        <button
          type="button"
          className="secondary"
          onClick={() =>
            void run(async () =>
              setText((await request("toml/export", body)).toml),
            )
          }
        >
          Start from published
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() =>
            void run(async () => {
              const file = await request("toml/file", body);
              if (file.text === null)
                setMessage(file.reason ?? `No file at ${file.path}`);
              else {
                setText(file.text);
                setMessage(`Loaded ${file.path}. Review it, then validate.`);
              }
            })
          }
        >
          Load harness.toml file
        </button>
      </div>
      <textarea
        aria-label="harness.toml"
        className="mono"
        rows={14}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="actions">
        <button
          type="button"
          className="secondary"
          disabled={!text.trim()}
          onClick={() =>
            void run(async () => {
              await request("toml/validate", { ...body, toml: text });
              setMessage("Valid. Nothing has been published.");
            })
          }
        >
          Validate
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !text.trim()}
          onClick={() =>
            void run(() =>
              action(
                "toml/import",
                {
                  ...body,
                  toml: text,
                  ...(scope !== "global" && grant
                    ? { acknowledgeGrants: true }
                    : {}),
                },
                "Imported and published. Write the files from Publish & verify.",
              ),
            )
          }
        >
          Import and publish
        </button>
        {scope !== "global" && (
          <label className="check">
            <input
              type="checkbox"
              checked={grant}
              onChange={(e) => setGrant(e.target.checked)}
            />
            Grant this repository any extra permissions in this file
            <small> (only this repository)</small>
          </label>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && (
        <div role="status" className="notice banner">
          {message}
        </div>
      )}
    </section>
  );
}

interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  status: string;
  variants: string[];
  reasoning: boolean;
}
type ModelList =
  | {
      available: true;
      models: ModelInfo[];
      certified: Record<string, Record<string, string[]>>;
    }
  | {
      available: false;
      reason: string;
      certified?: Record<string, Record<string, string[]>>;
    };

/** Picks an agent's model from the providers connected in OpenCode, with the
 * reasoning levels that model offers. Falls back to text when OpenCode cannot
 * be asked. */
function ModelPicker({
  agent,
  models,
  certified,
  onChange,
}: {
  agent: AgentDef;
  models?: ModelList;
  certified: Record<string, string[]>;
  onChange: (model: AgentDef["model"]) => void;
}) {
  const current = agent.model?.model ?? "";
  const known = models?.available
    ? models.models.find((m) => m.id === current)
    : undefined;
  const isCertified = (id: string) =>
    !!certified[id] || !!certified[id.split("/").slice(1).join("/")];
  if (!models || !models.available)
    return (
      <div className="form-grid">
        <label>
          Model
          <input
            value={current}
            placeholder="Role default"
            onChange={(e) =>
              onChange(
                e.target.value || agent.model?.reasoning
                  ? {
                      model: e.target.value,
                      reasoning: agent.model?.reasoning ?? "default",
                    }
                  : undefined,
              )
            }
          />
        </label>
        <label>
          Reasoning
          <input
            value={agent.model?.reasoning ?? ""}
            placeholder="Role default"
            onChange={(e) =>
              onChange(
                e.target.value || current
                  ? { model: current, reasoning: e.target.value }
                  : undefined,
              )
            }
          />
        </label>
        <p className="fine">
          {models ? models.reason : "Loading OpenCode models…"} You can type a
          model id meanwhile.
        </p>
      </div>
    );
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of models.models)
    byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
  const levels = known
    ? known.variants.length
      ? known.variants
      : ["default"]
    : [];
  return (
    <div className="form-grid">
      <label>
        Model
        <select
          value={current}
          onChange={(e) => {
            const id = e.target.value;
            if (!id) return onChange(undefined);
            const info = models.models.find((m) => m.id === id);
            const options = info?.variants.length ? info.variants : ["default"];
            onChange({
              model: id,
              reasoning: options.includes(agent.model?.reasoning ?? "")
                ? agent.model!.reasoning
                : options.includes("medium")
                  ? "medium"
                  : options[0]!,
            });
          }}
        >
          <option value="">Role default</option>
          {current && !known && (
            <option value={current}>{current} (not connected)</option>
          )}
          {[...byProvider].map(([provider, list]) => (
            <optgroup label={provider} key={provider}>
              {list.map((m) => (
                <option value={m.id} key={m.id}>
                  {m.name}
                  {m.status !== "active" ? ` (${m.status})` : ""}
                  {isCertified(m.id) ? " ✓ enforced" : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label>
        Reasoning
        <select
          value={agent.model?.reasoning ?? ""}
          disabled={!agent.model}
          onChange={(e) =>
            onChange(
              agent.model
                ? { model: agent.model.model, reasoning: e.target.value }
                : undefined,
            )
          }
        >
          {!agent.model && <option value="">Role default</option>}
          {(known ? levels : [agent.model?.reasoning ?? "default"]).map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </label>
      {agent.model && !isCertified(agent.model.model) && (
        <p className="fine">
          Works in OpenCode. Enforced sessions refuse this agent until a runtime
          certificate lists this model for the {agent.baseRole} role (✓
          enforced).
        </p>
      )}
    </div>
  );
}

function AgentEditor({
  scope,
  base,
  agents: initial,
  globalPolicy,
  catalog,
  roles,
  rules,
  grants,
  request,
  busy,
  action,
}: {
  scope: string;
  grants: Record<string, string>;
  base: Policy;
  agents: AgentDef[];
  globalPolicy: Policy;
  catalog: Catalog;
  roles: State["agentRoles"];
  rules: State["agentRules"];
  request: (path: string, data?: unknown) => Promise<any>;
  busy: boolean;
  action: Action;
}) {
  const repo = scope !== "global";
  const [models, setModels] = useState<ModelList>(),
    [loadingModels, setLoadingModels] = useState(false);
  const loadModels = (refresh: boolean) => {
    setLoadingModels(true);
    request("opencode/models", {
      ...(repo ? { repository: scope } : {}),
      refresh,
    })
      .then(setModels)
      .catch((e) => setModels({ available: false, reason: e.message }))
      .finally(() => setLoadingModels(false));
  };
  useEffect(() => loadModels(false), [scope]);
  const [agents, setAgents] = useState(initial),
    [lists, setLists] = useState({
      allowedSkills: base.allowedSkills,
      deniedSkills: base.deniedSkills,
      allowedMcps: base.allowedMcps,
      deniedMcps: base.deniedMcps,
    }),
    [orchestration, setOrchestration] = useState(base.orchestration),
    [alsoRepairRepositories, setAlsoRepairRepositories] = useState(false),
    [pending, setPending] = useState<{
      grants: Record<string, string>;
      payload: unknown;
      message: string;
    }>(),
    [policyTools, setPolicyTools] = useState(base.tools),
    [forbiddenTools, setForbiddenTools] = useState(base.forbiddenTools),
    [forbiddenDomains, setForbiddenDomains] = useState(
      base.forbiddenDomains.join("\n"),
    ),
    [domains, setDomains] = useState(base.domains.join("\n")),
    [humanGates, setHumanGates] = useState(base.humanGates),
    [humanReview, setHumanReview] = useState(base.humanReview),
    [trusted, setTrusted] = useState(
      base.humanReview.trustedDomains.join("\n"),
    ),
    [limits, setLimits] = useState({
      maxDepth: base.maxDepth,
      maxSpecialists: base.maxSpecialists,
      revisionLimit: base.revisionLimit,
    }),
    [draft, setDraft] = useState({
      id: "",
      name: "",
      baseRole: "Planner" as AgentDef["baseRole"],
      description: "",
      systemPrompt: "",
    }),
    [formError, setFormError] = useState("");
  type PolicyTool = (typeof base.tools)[number];
  const webResearch = policyTools.includes("research" as PolicyTool),
    setWebResearch = (on: boolean) =>
      setPolicyTools(toggle(policyTools, "research" as PolicyTool, on)),
    // The policy's tool list is the ceiling. A tool ticked on an agent does
    // nothing until the policy allows it, so say so and offer the fix.
    // Any scope can turn a tool on for itself; a repository's choice does not
    // change the global defaults or any other repository.
    canEnableInPolicy = (_tool: string) => true,
    enableInPolicy = (tool: string) =>
      setPolicyTools(toggle(policyTools, tool as PolicyTool, true)),
    domainList = domains
      .split(/[\s,]+/)
      .map((d) => d.trim())
      .filter(Boolean);
  const globalAgent = (id: string) =>
    globalPolicy.agents.find((a) => a.id === id);
  const edit = (id: string, patch: Partial<AgentDef>) =>
    setAgents(agents.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const rule = (kind: "Skills" | "Mcps", name: string): Rule =>
    lists[`denied${kind}`].includes(name)
      ? "deny"
      : lists[`allowed${kind}`].includes(name)
        ? "allow"
        : "default";
  const setRule = (kind: "Skills" | "Mcps", name: string, value: Rule) => {
    setLists({
      ...lists,
      [`allowed${kind}`]: toggle(
        lists[`allowed${kind}`],
        name,
        value === "allow",
      ),
      [`denied${kind}`]: toggle(lists[`denied${kind}`], name, value === "deny"),
    });
    if (value !== "allow") {
      const field = kind === "Skills" ? "skills" : "mcps";
      setAgents(
        agents.map((a) => ({
          ...a,
          [field]: a[field].filter((x) => x !== name),
        })),
      );
    }
  };
  const names = (kind: "Skills" | "Mcps", entries: Entry[]) => [
    ...new Set([
      ...entries.map((e) => e.name),
      ...lists[`allowed${kind}`],
      ...lists[`denied${kind}`],
    ]),
  ];
  const add = () => {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(draft.id))
      return setFormError(
        "Use 2–40 lowercase letters, numbers or dashes, starting with a letter.",
      );
    if (agents.some((a) => a.id === draft.id) || globalAgent(draft.id))
      return setFormError("That agent id is already in use.");
    if (!draft.name.trim()) return setFormError("Give the agent a name.");
    if (!draft.systemPrompt.trim())
      return setFormError("Write the instructions this agent will follow.");
    setFormError("");
    setAgents([
      ...agents,
      {
        id: draft.id,
        name: draft.name.trim(),
        kind: "custom",
        baseRole: draft.baseRole,
        description: draft.description,
        systemPrompt: draft.systemPrompt,
        tools: [...roles[draft.baseRole]] as AgentDef["tools"],
        skills: [],
        mcps: [],
        enabled: true,
      },
    ]);
    setDraft({ ...draft, id: "", name: "", description: "", systemPrompt: "" });
  };
  const save = () => {
    const bad = agents.find(
      (a) => a.model && (!a.model.model || !a.model.reasoning),
    );
    if (bad)
      return setFormError(
        `${bad.name}: set both a model and its reasoning level.`,
      );
    setFormError("");
    // A repository stores only what differs from the global agents.
    const own = repo
      ? agents.filter((a) => !same(a, globalAgent(a.id)))
      : agents;
    const message = repo
      ? "Repository harness published."
      : "Global harness published for every repository.";
    const payload = {
      scope,
      activate: true,
      ...(!repo && alsoRepairRepositories ? { repair: true } : {}),
      policy: {
        ...base,
        ...lists,
        ...limits,
        // Plumbing and the tools the mandatory agents need always stay on.
        tools: [
          ...new Set([
            ...policyTools,
            ...(rules.core as PolicyTool[]),
            ...(Object.values(rules.required).flat() as PolicyTool[]),
          ]),
        ],
        domains: domains
          .split(/[\s,]+/)
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
        // A repository can never drop what the global harness forbids.
        forbiddenTools: repo
          ? [...new Set([...forbiddenTools, ...globalPolicy.forbiddenTools])]
          : forbiddenTools,
        forbiddenDomains: [
          ...new Set([
            ...forbiddenDomains
              .split(/[\s,]+/)
              .map((d) => d.trim().toLowerCase())
              .filter(Boolean),
            ...(repo ? globalPolicy.forbiddenDomains : []),
          ]),
        ],
        orchestration,
        humanGates,
        humanReview: {
          ...humanReview,
          trustedDomains: trusted
            .split(/[\s,]+/)
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean),
        },
        agents: own,
      },
    };
    if (!repo) return void action("policies", payload, message);
    // Granting one repository more than the defaults is deliberate: show what
    // is new and let the owner confirm it for this repository only.
    request("policies/preview", {
      repository: scope,
      policy: payload.policy,
    })
      .then((r: { fresh: Record<string, string> }) =>
        Object.keys(r.fresh).length
          ? setPending({ grants: r.fresh, payload, message })
          : void action("policies", payload, message),
      )
      .catch((e: Error) => setFormError(e.message));
  };
  const roleNames = Object.keys(roles).filter((r) => r !== "Conductor");
  return (
    <>
      <section>
        <div className="section-heading">
          <h2>Agents</h2>
          <span className="fine">
            {agents.filter((a) => a.enabled).length} of {agents.length} enabled
            {" · "}
            {loadingModels
              ? "loading OpenCode models…"
              : models?.available
                ? `${models.models.length} OpenCode models`
                : "OpenCode models unavailable"}{" "}
            <button
              type="button"
              className="text-button"
              disabled={loadingModels}
              onClick={() => loadModels(true)}
            >
              Refresh models
            </button>
          </span>
        </div>
        {agents.map((a) => {
          const locked = a.kind === "mandatory",
            blocked = false,
            ceiling = roles[a.baseRole] as string[],
            skills = lists.allowedSkills.filter(
              (x) => !lists.deniedSkills.includes(x),
            ),
            mcps = lists.allowedMcps.filter(
              (x) => !lists.deniedMcps.includes(x),
            );
          return (
            <details className="list-row agent-card" key={a.id}>
              <summary>
                <strong>{a.name}</strong>
                <span className="badge">{a.kind}</span>
                <span className="badge">{a.baseRole}</span>
                <span className={`badge ${a.enabled ? "good" : "warn"}`}>
                  {a.enabled ? "enabled" : "off"}
                </span>
              </summary>
              <p className="fine">{a.description}</p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={a.enabled}
                  disabled={locked || blocked}
                  onChange={(e) => edit(a.id, { enabled: e.target.checked })}
                />
                Enabled
                {locked && <small> Always on; cannot be removed</small>}
                {blocked && <small> Disabled by the global harness</small>}
              </label>
              <ModelPicker
                agent={a}
                models={models}
                certified={models?.certified?.[a.baseRole] ?? {}}
                onChange={(model) => edit(a.id, { model })}
              />
              {a.enabled &&
                a.baseRole === "Researcher" &&
                a.tools.includes("research" as never) &&
                (!webResearch || domainList.length === 0) && (
                  <div className="warning" role="note">
                    <strong>This agent cannot fetch anything yet.</strong>
                    <ul>
                      {!webResearch && (
                        <li>
                          Web research is off in the policy.{" "}
                          {canEnableInPolicy("research") ? (
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => setWebResearch(true)}
                            >
                              Turn on web research
                            </button>
                          ) : (
                            "Turn it on in the global harness first."
                          )}
                        </li>
                      )}
                      {domainList.length === 0 && (
                        <li>
                          No domain is allowed, so every address is refused.
                          <label htmlFor={`domains-${a.id}`}>
                            Allowed domains (one per line, exact host names)
                          </label>
                          <textarea
                            id={`domains-${a.id}`}
                            rows={3}
                            value={domains}
                            placeholder={"github.com\napi.github.com"}
                            onChange={(e) => setDomains(e.target.value)}
                          />
                        </li>
                      )}
                    </ul>
                    <p className="fine">
                      Then publish and write the files again from Publish &amp;
                      verify.
                    </p>
                  </div>
                )}
              <h3>Tools</h3>
              <p className="fine">
                Model, compact and artifact are plumbing every agent needs.
                {(rules.required[a.baseRole] ?? []).length > 0 &&
                  ` A ${a.baseRole} also needs ${(rules.required[a.baseRole] ?? []).join(", ")}.`}
              </p>
              <div className="checkbox-grid">
                {ceiling.map((tool) => {
                  const fixed =
                    (rules.core as string[]).includes(tool) ||
                    (rules.required[a.baseRole] ?? []).includes(tool as never);
                  return (
                    <label className="check" key={tool}>
                      <input
                        type="checkbox"
                        checked={fixed || a.tools.includes(tool as never)}
                        disabled={fixed}
                        onChange={(e) =>
                          edit(a.id, {
                            tools: toggle(
                              a.tools,
                              tool as never,
                              e.target.checked,
                            ),
                          })
                        }
                      />
                      {pretty(tool)}
                      {fixed && <small> always on</small>}
                      {!fixed &&
                        !policyTools.includes(tool as PolicyTool) &&
                        (a.tools.includes(tool as never) ? (
                          <>
                            <small className="warn-text">
                              {" "}
                              not allowed by the policy, so this does nothing
                            </small>{" "}
                            {canEnableInPolicy(tool) ? (
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => enableInPolicy(tool)}
                              >
                                Turn on in policy
                              </button>
                            ) : (
                              <small>
                                {" "}
                                Turn it on in the global harness first
                              </small>
                            )}
                          </>
                        ) : (
                          <small> off in policy</small>
                        ))}
                    </label>
                  );
                })}
              </div>
              {rules.recommended[a.id] &&
                !same(
                  [...a.tools].sort(),
                  [...rules.recommended[a.id]!].sort(),
                ) && (
                  <p className="fine">
                    Recommended for {a.name}:{" "}
                    {rules.recommended[a.id]!.join(", ")}.{" "}
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        edit(a.id, {
                          tools: rules.recommended[a.id]!.filter((t) =>
                            ceiling.includes(t),
                          ) as AgentDef["tools"],
                        })
                      }
                    >
                      Use recommended tools
                    </button>
                  </p>
                )}
              {[
                ["Skills", "skills", skills],
                ["MCP servers", "mcps", mcps],
              ].map(([label, field, choices]) => (
                <React.Fragment key={field as string}>
                  <h3>{label as string}</h3>
                  {(choices as string[]).length ? (
                    <div className="checkbox-grid">
                      {(choices as string[]).map((name) => (
                        <label className="check" key={name}>
                          <input
                            type="checkbox"
                            checked={a[field as "skills" | "mcps"].includes(
                              name,
                            )}
                            onChange={(e) =>
                              edit(a.id, {
                                [field as string]: toggle(
                                  a[field as "skills" | "mcps"],
                                  name,
                                  e.target.checked,
                                ),
                              })
                            }
                          />
                          {name}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="fine">Allow some below to offer them here.</p>
                  )}
                </React.Fragment>
              ))}
              <label htmlFor={`prompt-${a.id}`}>System prompt</label>
              <textarea
                id={`prompt-${a.id}`}
                rows={5}
                value={a.systemPrompt}
                maxLength={20000}
                onChange={(e) => edit(a.id, { systemPrompt: e.target.value })}
              />
              {a.kind === "custom" && !globalAgent(a.id) && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setAgents(agents.filter((x) => x.id !== a.id))}
                >
                  Remove agent
                </button>
              )}
            </details>
          );
        })}
      </section>
      <section>
        <div className="section-heading">
          <h2>Add a custom agent</h2>
          <span className="fine">
            Its authority is capped by the role you pick
          </span>
        </div>
        <div className="form-grid">
          <label>
            Id
            <input
              value={draft.id}
              placeholder="doc-writer"
              onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            />
          </label>
          <label>
            Name
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            Works as
            <select
              value={draft.baseRole}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  baseRole: e.target.value as AgentDef["baseRole"],
                })
              }
            >
              {roleNames.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label>
            Description
            <input
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
          </label>
        </div>
        <label htmlFor="new-prompt">System prompt</label>
        <textarea
          id="new-prompt"
          rows={5}
          maxLength={20000}
          value={draft.systemPrompt}
          onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
        />
        <button type="button" className="secondary" onClick={add}>
          Add agent
        </button>
      </section>
      {(
        [
          ["Skills", "Skills", catalog.skills],
          ["MCP servers", "Mcps", catalog.mcps],
        ] as const
      ).map(([label, kind, entries]) => (
        <section key={kind}>
          <div className="section-heading">
            <h2>{label}</h2>
            <span className="fine">Unlisted is denied · Deny wins</span>
          </div>
          {names(kind, entries).length === 0 && (
            <p className="fine">
              None found in your global or repository configuration.
            </p>
          )}
          {names(kind, entries).map((name) => {
            const found = entries.find((e) => e.name === name),
              locked = repo && globalPolicy[`denied${kind}`].includes(name);
            return (
              <div className="list-row" key={name}>
                <div>
                  <strong>{name}</strong>
                  <small>
                    {found
                      ? `${found.scope === "repo" ? "Repository" : "Global"}${found.transport ? ` · ${found.transport}` : ""}${found.description ? ` · ${found.description}` : ""}`
                      : "Not found in current configuration"}
                  </small>
                </div>
                <select
                  aria-label={`${name} access`}
                  value={locked ? "deny" : rule(kind, name)}
                  disabled={locked}
                  onChange={(e) => setRule(kind, name, e.target.value as Rule)}
                >
                  <option value="default">Not allowed</option>
                  <option value="allow">Allow</option>
                  <option value="deny">Deny</option>
                </select>
              </div>
            );
          })}
        </section>
      ))}
      <section>
        <div className="section-heading">
          <h2>Orchestration</h2>
          <span className="fine">How far the Orchestrator may fan out</span>
        </div>
        <div className="form-grid">
          {(
            [
              ["maxDepth", "Sub-agent depth"],
              ["maxSpecialists", "Concurrent agents"],
              ["revisionLimit", "Corrective revisions"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                min={0}
                value={limits[key]}
                onChange={(e) =>
                  setLimits({ ...limits, [key]: Number(e.target.value) })
                }
              />
            </label>
          ))}
        </div>
        {(
          [
            ["verifyStages", "Verifier checks after"],
            ["reviewStages", "Reviewer reviews after"],
          ] as const
        ).map(([key, label]) => (
          <fieldset key={key}>
            <legend>{label}</legend>
            <div className="checkbox-grid">
              {stageNames.map((stage) => (
                <label className="check" key={stage}>
                  <input
                    type="checkbox"
                    checked={orchestration[key].includes(stage)}
                    onChange={(e) =>
                      setOrchestration({
                        ...orchestration,
                        [key]: toggle(
                          orchestration[key],
                          stage,
                          e.target.checked,
                        ),
                      })
                    }
                  />
                  {pretty(stage)}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </section>
      {repo ? (
        <section>
          <div className="section-heading">
            <h2>Granted to this repository</h2>
            <span className="fine">Beyond the global defaults</span>
          </div>
          {Object.keys(grants).length ? (
            <ul>
              {Object.entries(grants).map(([key, why]) => (
                <li key={key}>{why}</li>
              ))}
            </ul>
          ) : (
            <p className="fine">
              Nothing yet: this repository follows the global defaults. Turn
              something on below (web research, more tools, fewer review points)
              and publish to grant it here, for this repository only.
            </p>
          )}
        </section>
      ) : (
        <section>
          <div className="section-heading">
            <h2>Forbidden everywhere</h2>
            <span className="fine">No repository can be granted these</span>
          </div>
          <p className="fine">
            The global harness holds only defaults and these prohibitions.
            Anything else can be granted to a single repository. Leave empty to
            allow any grant.
          </p>
          <div className="checkbox-grid">
            {(
              ["research", "execute", "change", "delete", "rename"] as const
            ).map((tool) => (
              <label className="check" key={tool}>
                <input
                  type="checkbox"
                  checked={forbiddenTools.includes(tool as never)}
                  onChange={(e) =>
                    setForbiddenTools(
                      toggle(forbiddenTools, tool as never, e.target.checked),
                    )
                  }
                />
                Forbid {pretty(tool)}
              </label>
            ))}
          </div>
          <label htmlFor="forbidden-domains">
            Forbidden domains (one per line)
          </label>
          <textarea
            id="forbidden-domains"
            rows={2}
            value={forbiddenDomains}
            onChange={(e) => setForbiddenDomains(e.target.value)}
          />
        </section>
      )}
      <section>
        <div className="section-heading">
          <h2>Web research</h2>
          <span className="fine">
            {webResearch && domains.trim()
              ? "On"
              : "Off: agents cannot fetch anything"}
          </span>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={webResearch}
            disabled={forbiddenTools.includes("research" as never)}
            onChange={(e) => setWebResearch(e.target.checked)}
          />
          {repo
            ? "Allow web research for this repository only"
            : "Allow web research by default for every repository"}
          {forbiddenTools.includes("research" as never) && (
            <small> Forbidden everywhere</small>
          )}
        </label>
        <label htmlFor="research-domains">
          Allowed domains (one per line, exact host names)
        </label>
        <textarea
          id="research-domains"
          rows={3}
          value={domains}
          placeholder={"github.com\napi.github.com\nkaratelabs.io"}
          onChange={(e) => setDomains(e.target.value)}
        />
        <p className="fine">
          Both must be set: without any allowed domain every address is refused.
          Host names match exactly (<code>github.com</code> does not include{" "}
          <code>api.github.com</code> or <code>www.</code>), over HTTPS only.
          Only the Researcher can fetch, and only during the research stage.
          What happens to fetched text is set under Manual review points; by
          default it waits for your approval under Reviews.
        </p>
        <p className="fine">
          {repo
            ? "This is granted to this repository only. Other repositories keep the global defaults."
            : "On the global harness this is the default for repositories that have no policy of their own. To give just one repository web access, choose that repository above instead."}
        </p>
        <p className="fine">
          <strong>Two places agents run.</strong> In sessions registered with
          the engine, the Researcher uses the research gateway: domains are
          enforced, fetched text is cleaned and reviewed. In your own OpenCode
          there is no gateway; the exported Researcher uses OpenCode&apos;s
          <code> websearch</code> and <code>webfetch</code>, which ask you
          before each search and fetch, and the domains above are instructions
          it is told to follow, not a block. OpenCode offers
          <code> websearch</code> only with its own Zen or Go provider or when
          started as <code>OPENCODE_ENABLE_EXA=1 opencode</code>. Write the
          files again from Publish &amp; verify after changing this.
        </p>
      </section>
      <section>
        <div className="section-heading">
          <h2>Manual review points</h2>
          <span className="fine">Work waits for you at these points</span>
        </div>
        {(
          [
            ["before", "Approve before the stage starts"],
            ["after", "Approve after the stage finishes"],
          ] as const
        ).map(([when, label]) => (
          <fieldset key={when}>
            <legend>{label}</legend>
            <div className="checkbox-grid">
              {stageNames.map((stage) => {
                const list =
                  when === "before" ? humanReview.beforeStages : humanGates;
                const inherited = (
                  when === "before"
                    ? globalPolicy.humanReview.beforeStages
                    : globalPolicy.humanGates
                ).includes(stage as never);
                return (
                  <label className="check" key={stage}>
                    <input
                      type="checkbox"
                      checked={list.includes(stage as never)}
                      onChange={(e) =>
                        when === "before"
                          ? setHumanReview({
                              ...humanReview,
                              beforeStages: toggle(
                                humanReview.beforeStages,
                                stage,
                                e.target.checked,
                              ),
                            })
                          : setHumanGates(
                              toggle(
                                humanGates,
                                stage as (typeof humanGates)[number],
                                e.target.checked,
                              ),
                            )
                      }
                    />
                    {pretty(stage)}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
        <label htmlFor="external-mode">External content (web fetches)</label>
        <select
          id="external-mode"
          value={humanReview.externalContent}
          onChange={(e) =>
            setHumanReview({
              ...humanReview,
              externalContent: e.target
                .value as typeof humanReview.externalContent,
            })
          }
        >
          {(
            [
              [
                "approve-content",
                "Review the fetched text before the agent sees it",
              ],
              ["approve-url", "Approve each address before it is fetched"],
              [
                "off",
                "No review (content is still cleaned and marked untrusted)",
              ],
            ] as const
          ).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <label htmlFor="trusted-domains">
          Trusted domains (skip review, one per line)
        </label>
        <textarea
          id="trusted-domains"
          rows={3}
          value={trusted}
          placeholder="docs.example.com"
          onChange={(e) => setTrusted(e.target.value)}
        />
        <p className="fine">
          A trusted domain must also be an allowed research domain (Policy →
          Resource rules). Trusted content is still cleaned and untrusted.
          Reviews wait under Reviews.
        </p>
      </section>
      {formError && (
        <p role="alert" className="error">
          {formError}
        </p>
      )}
      {pending && (
        <div className="warning" role="alertdialog" aria-label="Confirm grants">
          <strong>Grant this repository more than the global defaults?</strong>
          <ul>
            {Object.entries(pending.grants).map(([key, why]) => (
              <li key={key}>{why}</li>
            ))}
          </ul>
          <p className="fine">
            Only this repository gets these. The global defaults and every other
            repository stay as they are. You confirm each new grant once; they
            are listed above and recorded in the audit trail.
          </p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => {
                const confirmed = pending;
                setPending(undefined);
                void action(
                  "policies",
                  { ...(confirmed.payload as object), acknowledgeGrants: true },
                  confirmed.message,
                );
              }}
            >
              Grant to this repository and publish
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setPending(undefined)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="actions">
        <button className="primary" disabled={busy} onClick={save}>
          {repo ? "Publish repository harness" : "Publish global harness"}
        </button>
        <span className="fine">
          Publishing replaces the active policy for this scope and ends running
          sessions; start a new one to load it.
        </span>
        {!repo && (
          <label className="check">
            <input
              type="checkbox"
              checked={alsoRepairRepositories}
              onChange={(e) => setAlsoRepairRepositories(e.target.checked)}
            />
            Also fix repositories this change would block
            <small>
              {" "}
              A new denial or prohibition can break a repository that already
              uses it. The publish is refused and lists them; tick this to
              remove just that from those repositories in the same step.
            </small>
          </label>
        )}
      </div>
    </>
  );
}
