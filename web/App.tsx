import React, { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { Engine } from "../src/engine.js";
import type { Policy } from "../src/policy.js";
import "./app.css";
type State = ReturnType<Engine["state"]>;
type Page =
  "Overview" | "Policy" | "Reviews" | "Context" | "Learning" | "Audit";
const pages: Page[] = [
  "Overview",
  "Policy",
  "Reviews",
  "Context",
  "Learning",
  "Audit",
];
const short = (s: string) => s.slice(0, 8);
const pretty = (s: string) => s.replaceAll("_", " ").replaceAll(".", " · ");
function Badge({ value }: { value: string }) {
  return (
    <span
      className={`badge ${["enforced", "completed", "passed", "eligible", "active"].includes(value) ? "good" : ["unverified", "paused", "requires_reconciliation", "needs_attention", "rejected"].includes(value) ? "warn" : ""}`}
    >
      {pretty(value)}
    </span>
  );
}
function Empty({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-mark" aria-hidden="true">
        ◇
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function App() {
  const [token, setToken] = useState(""),
    [draftToken, setDraftToken] = useState(""),
    [state, setState] = useState<State>(),
    [page, setPage] = useState<Page>("Overview"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [artifact, setArtifact] = useState<any>(),
    [repoPath, setRepoPath] = useState("");
  const request = async (path: string, data?: unknown, key = token) => {
    const response = await fetch(`/v1/owner/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify(data ?? {}),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result.message +
          (result.details ? `\n${JSON.stringify(result.details)}` : ""),
      );
    return result;
  };
  const refresh = async (key = token) =>
    setState(await request("state", undefined, key));
  useEffect(() => {
    if (!token) return;
    void refresh().catch((e) => setError(e.message));
    const interval = setInterval(
      () => void refresh().catch((e) => setError(e.message)),
      10000,
    );
    return () => clearInterval(interval);
  }, [token]);
  const action = async (path: string, data: unknown, message: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(path, data);
      await refresh();
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const login = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await refresh(draftToken);
      setToken(draftToken);
      setDraftToken("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const inspect = async (id: string) => {
    try {
      setArtifact(await request("artifacts/get", { id }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!token || !state)
    return (
      <div className="login">
        <div className="login-story">
          <div className="brand">
            <span className="brand-mark">h</span> agent-harness
          </div>
          <div>
            <p className="eyebrow">LOCAL AUTHORITY / 01</p>
            <h1>
              A clear view.
              <br />A controlled agent.
            </h1>
            <p>
              Policy, reviews, and evidence for your coding sessions. One place
              to see what is allowed and what needs your attention.
            </p>
          </div>
          <span className="fine">
            Your repositories. Your machine. Your controls.
          </span>
        </div>
        <main className="login-form">
          <p className="eyebrow">ENGINE CONTROLS</p>
          <h2>Connect to your engine</h2>
          <p>
            Enter the web credential created during local setup. It is separate
            from your runtime pairing credential.
          </p>
          <form onSubmit={login}>
            <label htmlFor="credential">Web credential</label>
            <input
              id="credential"
              type="password"
              autoComplete="off"
              value={draftToken}
              onChange={(e) => setDraftToken(e.target.value)}
              required
            />
            <button disabled={busy} className="primary">
              {busy ? "Connecting…" : "Open controls"} <span>↗</span>
            </button>
          </form>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <details>
            <summary>Find your credential</summary>
            <p>
              The setup command reports the credential file location. Run{" "}
              <code>npm run harness -- credential-path</code> to show its path.
            </p>
          </details>
        </main>
      </div>
    );
  const active = state.sessions.filter((s) => s.status === "active"),
    attention = state.sessions.filter((s) =>
      ["paused", "needs_attention"].includes(s.status),
    ),
    unverified = active.filter((s) => s.enforcement !== "enforced"),
    gates = (state.stages as any[]).filter((s) => s.state === "human_gate");
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <span className="brand-mark">h</span>
          <span>
            agent-harness<small>ENGINE CONTROLS</small>
          </span>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {pages.map((p, i) => (
            <button
              key={p}
              className={page === p ? "selected" : ""}
              onClick={() => {
                setPage(p);
                setNotice("");
              }}
              aria-current={page === p ? "page" : undefined}
            >
              <span className="nav-number">0{i + 1}</span>
              {p}
              {p === "Reviews" && gates.length > 0 && (
                <span className="nav-count">{gates.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="online-dot" /> Local engine
          <small>
            v{state.version} · {state.platform}
          </small>
          <button
            className="text-button"
            onClick={() => {
              setToken("");
              setState(undefined);
            }}
          >
            Disconnect ↗
          </button>
        </div>
      </aside>
      <main className="main">
        <header>
          <span>
            Workspace <span className="separator">/</span> {page}
          </span>
          <span className="header-right">
            LOCAL ONLY <span className="online-dot" />
          </span>
        </header>
        <div className="page">
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {page === "Overview"
                  ? "YOUR ENGINE, AT A GLANCE"
                  : "ENGINE CONTROLS"}
              </p>
              <h1>
                {page === "Overview"
                  ? "Session overview"
                  : page === "Policy"
                    ? "Rules of engagement"
                    : page === "Reviews"
                      ? "Review queue"
                      : page === "Context"
                        ? "Context & continuity"
                        : page === "Learning"
                          ? "Learning & rollback"
                          : "Audit trail"}
              </h1>
            </div>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void refresh()
                  .then(() => setNotice("Updated"))
                  .catch((e) => setError(e.message))
              }
            >
              ↻ Refresh
            </button>
          </div>
          {error && (
            <div role="alert" className="error banner">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}
          {!state.storageHealth.healthy && (
            <div role="alert" className="error banner">
              Audit storage failed. Protected operations are paused. Restore
              storage, then restart the engine and reconcile interrupted work.
            </div>
          )}
          {notice && (
            <div role="status" className="notice banner">
              {notice}
            </div>
          )}
          {page === "Overview" && (
            <>
              <div className="metrics">
                <div>
                  <span>Registered sessions</span>
                  <strong>
                    {state.sessions.length.toString().padStart(2, "0")}
                  </strong>
                  <small>{active.length} active</small>
                </div>
                <div>
                  <span>Enforced sessions</span>
                  <strong>
                    {active
                      .filter((s) => s.enforcement === "enforced")
                      .length.toString()
                      .padStart(2, "0")}
                  </strong>
                  <small>Verified containment required</small>
                </div>
                <div>
                  <span>Needs attention</span>
                  <strong>
                    {(attention.length + gates.length)
                      .toString()
                      .padStart(2, "0")}
                  </strong>
                  <small>{gates.length} waiting for review</small>
                </div>
                <div>
                  <span>Enrolled repositories</span>
                  <strong>
                    {state.repositories.length.toString().padStart(2, "0")}
                  </strong>
                  <small>Individually scoped</small>
                </div>
              </div>
              {unverified.length > 0 && (
                <div className="warning">
                  <strong>
                    {unverified.length} active session
                    {unverified.length === 1 ? " is" : "s are"} unverified.
                  </strong>{" "}
                  Protected operations remain blocked until runtime containment
                  is verified.
                </div>
              )}
              <section>
                <div className="section-heading">
                  <h2>Sessions</h2>
                  <span className="fine">
                    Externally started · engine governed
                  </span>
                </div>
                {!state.sessions.length ? (
                  <Empty title="Ready for your first session">
                    Enroll a repository, pair a trusted bridge, then start your
                    coding runtime externally. Registered sessions will appear
                    here.
                  </Empty>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Session / role</th>
                          <th>Repository</th>
                          <th>Stage</th>
                          <th>Authority</th>
                          <th>Status</th>
                          <th>Control</th>
                        </tr>
                      </thead>
                      <tbody>
                        {state.sessions.map((s) => (
                          <tr key={s.session}>
                            <td>
                              <strong>{s.runtimeSession}</strong>
                              <small>
                                {s.role} · {short(s.session)}
                              </small>
                            </td>
                            <td>
                              {state.repositories
                                .find((r) => r.id === s.repository)
                                ?.path.split("/")
                                .pop() ?? short(s.repository)}
                            </td>
                            <td>{s.stage}</td>
                            <td>
                              <Badge value={s.enforcement} />
                            </td>
                            <td>
                              <Badge value={s.status} />
                            </td>
                            <td>
                              {s.status !== "terminated" && (
                                <button
                                  className="text-button danger"
                                  disabled={busy}
                                  onClick={() =>
                                    void action(
                                      "sessions/revoke",
                                      { session: s.session },
                                      "Authority revoked. The session is paused.",
                                    )
                                  }
                                >
                                  Revoke
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <div className="two-column">
                <section>
                  <div className="section-heading">
                    <h2>Repositories</h2>
                    <span className="fine">
                      {state.repositories.length} enrolled
                    </span>
                  </div>
                  <form
                    className="inline-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void action(
                        "repositories",
                        { path: repoPath },
                        "Repository enrolled.",
                      ).then(() => setRepoPath(""));
                    }}
                  >
                    <label className="sr-only" htmlFor="repo-path">
                      Absolute repository path
                    </label>
                    <input
                      id="repo-path"
                      placeholder="/absolute/path/to/repository"
                      value={repoPath}
                      onChange={(e) => setRepoPath(e.target.value)}
                      required
                    />
                    <button className="primary" disabled={busy}>
                      Enroll
                    </button>
                  </form>
                  {state.repositories.map((r) => (
                    <div key={r.id} className="list-row">
                      <div>
                        <strong>{r.path.split("/").pop()}</strong>
                        <small>{r.path}</small>
                      </div>
                      <span className="fine">
                        {r.caseSensitive
                          ? "Case sensitive"
                          : "Case insensitive"}
                      </span>
                    </div>
                  ))}
                </section>
                <section>
                  <div className="section-heading">
                    <h2>Enforcement readiness</h2>
                  </div>
                  <div className="list-row">
                    <span>Runtime certificates</span>
                    <Badge
                      value={
                        state.certificates.length ? "available" : "unverified"
                      }
                    />
                  </div>
                  <div className="list-row">
                    <span>Command workers</span>
                    <Badge
                      value={
                        state.workerConfigured ? "configured" : "unconfigured"
                      }
                    />
                  </div>
                  <div className="list-row">
                    <span>Root session control</span>
                    <span className="fine">External runtime</span>
                  </div>
                  <p className="fine readiness-note">
                    Enforcement status is granted after verified runtime
                    attachment. The controls interface never launches root
                    sessions.
                  </p>
                </section>
              </div>
            </>
          )}
          {page === "Policy" && (
            <PolicyEditor state={state} busy={busy} action={action} />
          )}
          {page === "Reviews" && (
            <>
              <p className="intro">
                Inspect the exact artifact before approving. Changed
                dependencies invalidate earlier approvals.
              </p>
              {!(state.stages as any[]).length ? (
                <Empty title="No reviews waiting">
                  Stage artifacts and their review decisions will appear here.
                </Empty>
              ) : (
                <section>
                  {(state.stages as any[]).map((a) => (
                    <div className="list-row" key={`${a.root}:${a.stage}`}>
                      <div>
                        <strong>
                          {a.stage} · revision {a.revision}
                        </strong>
                        <small>
                          Root {short(a.root)} · artifact {short(a.artifact)}
                        </small>
                      </div>
                      <Badge value={a.state} />
                      <button
                        className="secondary"
                        onClick={() => void inspect(a.artifact)}
                      >
                        Inspect artifact
                      </button>
                      {a.state === "human_gate" && (
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() =>
                            void action(
                              "reviews/approve",
                              {
                                root: a.root,
                                artifact: a.artifact,
                                review: a.review,
                              },
                              "Stage approved.",
                            )
                          }
                        >
                          Approve stage
                        </button>
                      )}
                    </div>
                  ))}
                </section>
              )}
              <section>
                <div className="section-heading">
                  <h2>Review findings</h2>
                </div>
                {(state.reviews as any[]).map((r) => (
                  <div className="list-row" key={r.id}>
                    <div>
                      <strong>
                        {r.findings.length
                          ? `${r.findings.length} finding(s)`
                          : "Review passed"}
                      </strong>
                      {r.findings.map((f: any, i: number) => (
                        <small key={i}>
                          {f.blocking ? "Blocking: " : ""}
                          {f.message}
                        </small>
                      ))}
                    </div>
                    <button
                      className="secondary"
                      onClick={() => void inspect(r.artifact)}
                    >
                      Inspect change
                    </button>
                  </div>
                ))}
              </section>
            </>
          )}
          {page === "Context" && (
            <>
              <p className="intro">
                Authoritative state stays outside narrative summaries.
                Compaction starts near 70%; optional context stops at 90%.
              </p>
              {!(state.contexts as any[]).length ? (
                <Empty title="No context checkpoints yet">
                  Context usage, pending tool exchanges, and checkpoint fidelity
                  appear when a session is configured.
                </Empty>
              ) : (
                <section>
                  {(state.contexts as any[]).map((c) => (
                    <div className="context-row" key={c.session}>
                      <div>
                        <strong>Session {short(c.session)}</strong>
                        <small>
                          {c.checkpoint
                            ? `Checkpoint ${short(c.checkpoint)}`
                            : "Awaiting first checkpoint"}
                        </small>
                      </div>
                      <div className="context-meter">
                        <meter
                          value={c.used}
                          min={0}
                          max={c.capacity - c.reserved}
                          low={(c.capacity - c.reserved) * 0.7}
                          high={(c.capacity - c.reserved) * 0.9}
                          optimum={0}
                        />
                        <span>
                          {Math.round(
                            (c.used / (c.capacity - c.reserved)) * 100,
                          )}
                          % used · {c.reserved.toLocaleString()} reserved
                        </span>
                      </div>
                      <Badge
                        value={
                          c.paused
                            ? "paused"
                            : c.exchange
                              ? "tool_exchange"
                              : "active"
                        }
                      />
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
          {page === "Learning" && (
            <>
              <p className="intro">
                Promote exact, evaluated changes with human approval. Every
                mandatory control must pass and quality must improve without
                regression.
              </p>
              {!(state.candidates as any[]).length ? (
                <Empty title="Learning starts with evidence">
                  Repository-scoped candidates, evaluation results, and approved
                  skills will appear here.
                </Empty>
              ) : (
                <section>
                  {(state.candidates as any[]).map((c) => (
                    <div className="learning-entry" key={c.id}>
                      <div className="list-row">
                        <div>
                          <strong>{c.target}</strong>
                          <small>
                            {c.kind} · repository {short(c.repository)}
                          </small>
                        </div>
                        <Badge value={c.status} />
                      </div>
                      <div className="diff">
                        <pre>
                          <span>BASELINE</span>
                          {c.before || "(empty)"}
                        </pre>
                        <pre>
                          <span>PROPOSED</span>
                          {c.after}
                        </pre>
                      </div>
                      <div className="actions">
                        {c.status === "eligible" && (
                          <button
                            className="primary"
                            disabled={busy}
                            onClick={() =>
                              void action(
                                "learning/promote",
                                { session: c.session, candidate: c.id },
                                "Candidate promoted. Affected sessions require a clean restart.",
                              )
                            }
                          >
                            Approve repository promotion
                          </button>
                        )}
                        {c.status === "promoted" && (
                          <button
                            className="secondary danger"
                            disabled={busy}
                            onClick={() =>
                              void action(
                                "learning/rollback",
                                { session: c.session, candidate: c.id },
                                "Promotion revoked. Affected sessions require a clean restart.",
                              )
                            }
                          >
                            Roll back
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
          {page === "Audit" && (
            <>
              <section>
                <div className="section-heading">
                  <h2>Persistent alerts</h2>
                  <span className="fine">Exact sliding windows</span>
                </div>
                {!(state.alerts as any[]).length ? (
                  <p className="quiet">
                    No denial thresholds have been reached.
                  </p>
                ) : (
                  (state.alerts as any[]).map((a) => (
                    <div className="list-row" key={a.id}>
                      <div>
                        <strong>
                          {a.count} denials in {a.window / 60000} minute(s)
                        </strong>
                        <small>
                          {a.scope} · {a.sessions.length} contributing sessions
                        </small>
                        <small>{a.rules.join(", ")}</small>
                      </div>
                      <button
                        className="secondary"
                        disabled={busy || a.acknowledged}
                        onClick={() =>
                          void action(
                            "alerts/acknowledge",
                            { id: a.id },
                            "Alert acknowledged.",
                          )
                        }
                      >
                        {a.acknowledged ? "Acknowledged" : "Acknowledge"}
                      </button>
                    </div>
                  ))
                )}
              </section>
              <section>
                <div className="section-heading">
                  <h2>Durable events</h2>
                  <span className="fine">Most recent 100</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Event</th>
                        <th>Session</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.audit.map((a: any) => (
                        <tr key={a.seq}>
                          <td className="mono">
                            {new Date(a.time).toLocaleTimeString()}
                          </td>
                          <td>{pretty(a.event)}</td>
                          <td className="mono">
                            {a.session ? short(a.session) : "Engine"}
                          </td>
                          <td>
                            <details>
                              <summary>Inspect</summary>
                              <pre>
                                {JSON.stringify(JSON.parse(a.data), null, 2)}
                              </pre>
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <section>
                <div className="section-heading">
                  <h2>Interrupted operations</h2>
                </div>
                {state.operations
                  .filter((o) => o.status === "requires_reconciliation")
                  .map((o) => (
                    <Reconcile
                      key={o.id}
                      operation={o}
                      action={action}
                      busy={busy}
                    />
                  ))}
              </section>
              <section>
                <div className="section-heading">
                  <h2>Runtime cleanup</h2>
                </div>
                {!state.runtimes.length ? (
                  <p className="fine">
                    No runtime processes have been registered.
                  </p>
                ) : (
                  state.runtimes.map((runtime) => (
                    <div className="list-row" key={runtime.session}>
                      <div>
                        <strong>Session {short(runtime.session)}</strong>
                        <small>
                          <Badge value={runtime.status} />
                        </small>
                        {runtime.error && <small>{runtime.error}</small>}
                      </div>
                      {runtime.status === "requires_reconciliation" && (
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            void action(
                              "runtime/cleanup",
                              { session: runtime.session },
                              "Cleanup checked. The recorded outcome is shown below.",
                            )
                          }
                        >
                          Retry cleanup
                        </button>
                      )}
                    </div>
                  ))
                )}
              </section>
            </>
          )}
          <footer>
            <span>agent-harness engine</span>
            <span>Policy decisions leave evidence.</span>
          </footer>
        </div>
      </main>
      {artifact && (
        <div className="modal-backdrop" onClick={() => setArtifact(undefined)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Artifact inspection"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="section-heading">
              <h2>{artifact.kind}</h2>
              <button
                autoFocus
                className="secondary"
                onClick={() => setArtifact(undefined)}
              >
                Close
              </button>
            </div>
            <p className="mono">{artifact.hash}</p>
            <Badge value={artifact.trust} />
            <pre>{artifact.content}</pre>
            <p className="fine">
              {artifact.dependencies.length} dependencies ·{" "}
              {artifact.sources.length} sources
            </p>
            {artifact.kind === "change-set" && (
              <button
                className="primary"
                disabled={busy || !artifact.valid}
                onClick={() => {
                  try {
                    const proposed = JSON.parse(artifact.content);
                    void action(
                      "actions/approve",
                      {
                        root: artifact.root,
                        tool: proposed.tool,
                        args: proposed.args,
                        dependencies: [artifact.id],
                      },
                      "Exact change approved.",
                    ).then(() => setArtifact(undefined));
                  } catch {
                    setError("This artifact does not contain a valid change.");
                  }
                }}
              >
                Approve exact change
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function Reconcile({
  operation,
  action,
  busy,
}: {
  operation: any;
  action: (path: string, data: unknown, message: string) => Promise<void>;
  busy: boolean;
}) {
  const [outcome, setOutcome] = useState(""),
    [evidence, setEvidence] = useState("");
  return (
    <form
      className="reconcile"
      onSubmit={(e) => {
        e.preventDefault();
        void action(
          "operations/reconcile",
          { key: operation.key, outcome, evidence },
          "Reconciliation recorded.",
        );
      }}
    >
      <strong>
        {operation.tool} · {short(operation.id)}
      </strong>
      <label>
        Observed outcome
        <input
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          required
        />
      </label>
      <label>
        Evidence reference
        <input
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          required
        />
      </label>
      <button className="secondary" disabled={busy}>
        Record reconciliation
      </button>
    </form>
  );
}
function PolicyEditor({
  state,
  busy,
  action,
}: {
  state: State;
  busy: boolean;
  action: (path: string, data: unknown, message: string) => Promise<void>;
}) {
  const [scope, setScope] = useState("global");
  const record =
    scope === "global"
      ? state.globalPolicy
      : (state.policies.find((p) => p.repository === scope)?.effective
          ?.repository ??
        state.policies.find((p) => p.repository === scope)?.effective?.global);
  if (!record || !("policy" in record))
    return (
      <Empty title="Published policy unavailable">
        Protected operations are blocked. Restore a valid policy through local
        recovery.
      </Empty>
    );
  return (
    <>
      <div className="scope-select">
        <label htmlFor="policy-scope">Policy scope</label>
        <select
          id="policy-scope"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          <option value="global">Global — all enrolled repositories</option>
          {state.repositories.map((r) => (
            <option value={r.id} key={r.id}>
              {r.path}
            </option>
          ))}
        </select>
      </div>
      <PolicyForm
        key={`${scope}:${record.id}`}
        scope={scope}
        policy={record.policy}
        version={record.id}
        busy={busy}
        action={action}
      />
    </>
  );
}
function PolicyForm({
  scope,
  policy,
  version,
  busy,
  action,
}: {
  scope: string;
  policy: Policy;
  version: string;
  busy: boolean;
  action: (path: string, data: unknown, message: string) => Promise<void>;
}) {
  const [p, setP] = useState(policy),
    [commands, setCommands] = useState(
      JSON.stringify(policy.commands, null, 2),
    ),
    [models, setModels] = useState(JSON.stringify(policy.models, null, 2)),
    [formError, setFormError] = useState("");
  const save = (activate: boolean) => {
    try {
      const candidate = {
        ...p,
        commands: JSON.parse(commands),
        models: JSON.parse(models),
      };
      setFormError("");
      void action(
        "policies",
        { scope, policy: candidate, activate },
        activate
          ? "Policy activated. Existing session authority was invalidated."
          : "Policy candidate saved. It has not been activated.",
      );
    } catch {
      setFormError("Commands and role settings must contain valid JSON.");
    }
  };
  const change = <K extends keyof Policy>(key: K, value: Policy[K]) =>
    setP({ ...p, [key]: value });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(true);
      }}
    >
      <section>
        <div className="section-heading">
          <h2>Execution limits</h2>
          <span className="fine mono">Published {short(version)}</span>
        </div>
        <div className="form-grid">
          {(
            [
              ["maxSpecialists", "Concurrent specialists"],
              ["maxDepth", "Delegation depth"],
              ["revisionLimit", "Corrective revisions"],
              ["timeoutMs", "Execution timeout (ms)"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                min={key === "timeoutMs" ? 10 : 0}
                value={p[key]}
                onChange={(e) => change(key, Number(e.target.value))}
                required
              />
            </label>
          ))}
        </div>
      </section>
      <section>
        <div className="section-heading">
          <h2>Protected tools</h2>
          <span className="fine">Unlisted tools are denied</span>
        </div>
        <div className="checkbox-grid">
          {(
            [
              "read",
              "change",
              "delete",
              "rename",
              "research",
              "execute",
              "delegate",
              "artifact",
              "review",
              "compact",
              "learn",
            ] as const
          ).map((tool) => (
            <label className="check" key={tool}>
              <input
                type="checkbox"
                checked={p.tools.includes(tool)}
                onChange={(e) =>
                  change(
                    "tools",
                    e.target.checked
                      ? [...p.tools, tool]
                      : p.tools.filter((t) => t !== tool),
                  )
                }
              />
              {pretty(tool)}
            </label>
          ))}
        </div>
        <label className="check destructive">
          <input
            type="checkbox"
            checked={p.deletion}
            onChange={(e) => change("deletion", e.target.checked)}
          />
          Enable reviewed deletion{" "}
          <small>Exact paths still require human approval</small>
        </label>
      </section>
      <section>
        <div className="section-heading">
          <h2>Resource rules</h2>
        </div>
        <div className="form-grid">
          {(
            [
              ["allowPaths", "Allowed paths"],
              ["denyPaths", "Denied paths"],
              ["domains", "Research domains"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <textarea
                rows={4}
                value={p[key].join("\n")}
                onChange={(e) =>
                  change(key, e.target.value.split("\n").filter(Boolean))
                }
              />
              <small>One rule per line</small>
            </label>
          ))}
        </div>
      </section>
      <section>
        <div className="section-heading">
          <h2>Human review gates</h2>
        </div>
        <div className="checkbox-grid">
          {(
            [
              "research",
              "plan",
              "implementation",
              "execution",
              "verification",
            ] as const
          ).map((stage) => (
            <label className="check" key={stage}>
              <input
                type="checkbox"
                checked={p.humanGates.includes(stage)}
                onChange={(e) =>
                  change(
                    "humanGates",
                    e.target.checked
                      ? [...p.humanGates, stage]
                      : p.humanGates.filter((s) => s !== stage),
                  )
                }
              />
              {stage}
            </label>
          ))}
        </div>
        <details className="advanced">
          <summary>Commands and role settings</summary>
          <p className="fine">
            Exact command definitions include executable, arguments,
            environment, and working directory. Model settings must match
            verified runtime capabilities.
          </p>
          <label>
            Approved command definitions
            <textarea
              rows={8}
              value={commands}
              onChange={(e) => setCommands(e.target.value)}
            />
          </label>
          <label>
            Role model and reasoning settings
            <textarea
              rows={8}
              value={models}
              onChange={(e) => setModels(e.target.value)}
            />
          </label>
        </details>
      </section>
      {formError && (
        <p className="error" role="alert">
          {formError}
        </p>
      )}
      <div className="save-bar">
        <p>
          Activation invalidates affected session authority.
          <br />
          <span className="fine">
            Saved candidates leave the published policy in place.
          </span>
        </p>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => save(false)}
        >
          Save candidate
        </button>
        <button className="primary" disabled={busy}>
          Activate policy ↗
        </button>
      </div>
    </form>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
