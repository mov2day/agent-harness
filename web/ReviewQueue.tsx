import React, { useState } from "react";
import type { Engine } from "../src/engine.js";

type State = ReturnType<Engine["state"]>;
type Action = (path: string, data: unknown, message: string) => Promise<void>;
const short = (s: string) => s.slice(0, 8);
const pretty = (s: string) => s.replaceAll("_", " ").replaceAll("-", " ");

/** Approve or reject with an optional reason the agent will see. */
function Decide({
  busy,
  approve,
  reject,
  approveLabel = "Approve",
  rejectLabel = "Reject",
  requireReason = false,
}: {
  busy: boolean;
  approve: (comment: string) => void;
  reject: (comment: string) => void;
  approveLabel?: string;
  rejectLabel?: string;
  requireReason?: boolean;
}) {
  const [comment, setComment] = useState("");
  return (
    <div className="decide">
      <label>
        Reason (optional, shown to the agent)
        <textarea
          rows={2}
          maxLength={2000}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </label>
      <div className="actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() => approve(comment)}
        >
          {approveLabel}
        </button>
        <button
          className="secondary"
          disabled={busy || (requireReason && !comment.trim())}
          onClick={() => reject(comment)}
        >
          {rejectLabel}
        </button>
      </div>
      {requireReason && !comment.trim() && (
        <p className="fine">Say what should change before sending it back.</p>
      )}
    </div>
  );
}

/** Everything waiting for the owner: external content, stage starts and
 * finished stages held at a gate. */
export function ReviewQueue({
  state,
  busy,
  action,
  inspect,
}: {
  state: State;
  busy: boolean;
  action: Action;
  inspect: (id: string) => void;
}) {
  const external = state.externalReviews.filter((r) => r.state === "pending"),
    // A start review only matters while its task is still at that stage.
    starts = (state.stageStarts as any[]).filter(
      (g) =>
        g.state === "pending" &&
        state.sessions.some(
          (s) =>
            s.session === g.root &&
            s.status === "active" &&
            s.stage === g.stage,
        ),
    ),
    gates = (state.stages as any[]).filter((s) => s.state === "human_gate");
  if (!external.length && !starts.length && !gates.length)
    return (
      <p className="quiet">
        Nothing is waiting for you. External content, stage starts and gated
        stages appear here when you configure them under Agents.
      </p>
    );
  return (
    <section>
      <div className="section-heading">
        <h2>Waiting for you</h2>
        <span className="fine">
          {external.length + starts.length + gates.length} pending
        </span>
      </div>
      {external.map((r) => (
        <div className="list-row review-card" key={r.id}>
          <div>
            <strong>External content · {pretty(r.mode)}</strong>
            <small className="mono">{r.url}</small>
            <small>
              Root {short(r.root)} ·{" "}
              {r.mode === "approve-url"
                ? "Not fetched yet. Approving lets the agent fetch this address."
                : "Fetched and held back. The agent sees only the text below, once you approve."}
            </small>
            {r.flags?.length ? (
              <div className="flags">
                {r.flags.map((f: { rule: string; count: number }) => (
                  <span className="badge warn" key={f.rule}>
                    {pretty(f.rule)} × {f.count}
                  </span>
                ))}
              </div>
            ) : null}
            {r.text !== undefined && (
              <pre className="external-text">{r.text || "(empty page)"}</pre>
            )}
            <p className="fine">
              Flags are hints, not proof. Approved content is still untrusted
              and cannot grant permissions or approvals.
            </p>
          </div>
          <Decide
            busy={busy}
            approveLabel={
              r.mode === "approve-url" ? "Allow fetch" : "Approve content"
            }
            approve={(comment) =>
              void action(
                "external/decide",
                { review: r.id, decision: "approve", comment },
                "External content approved.",
              )
            }
            reject={(comment) =>
              void action(
                "external/decide",
                { review: r.id, decision: "reject", comment },
                "External content rejected.",
              )
            }
          />
        </div>
      ))}
      {starts.map((g) => (
        <div className="list-row review-card" key={g.key}>
          <div>
            <strong>Start review · {g.stage}</strong>
            <small>
              Root {short(g.root)} · no agent starts {g.stage} work until you
              approve.
            </small>
          </div>
          <Decide
            busy={busy}
            approveLabel="Start stage"
            rejectLabel="Stop task"
            approve={(comment) =>
              void action(
                "stages/start",
                { root: g.root, stage: g.stage, decision: "approve", comment },
                "Stage approved to start.",
              )
            }
            reject={(comment) =>
              void action(
                "stages/start",
                { root: g.root, stage: g.stage, decision: "reject", comment },
                "Task paused.",
              )
            }
          />
        </div>
      ))}
      {gates.map((a) => (
        <div className="list-row review-card" key={`${a.root}:${a.stage}`}>
          <div>
            <strong>
              Finished stage · {a.stage} · revision {a.revision}
            </strong>
            <small>
              Root {short(a.root)} · artifact {short(a.artifact)}
            </small>
            <button className="secondary" onClick={() => inspect(a.artifact)}>
              Inspect artifact
            </button>
          </div>
          <Decide
            busy={busy}
            approveLabel="Approve stage"
            rejectLabel="Send back"
            requireReason
            approve={() =>
              void action(
                "reviews/approve",
                { root: a.root, artifact: a.artifact, review: a.review },
                "Stage approved.",
              )
            }
            reject={(comment) =>
              void action(
                "reviews/reject",
                {
                  root: a.root,
                  artifact: a.artifact,
                  review: a.review,
                  comment,
                },
                "Sent back with your feedback.",
              )
            }
          />
        </div>
      ))}
    </section>
  );
}
