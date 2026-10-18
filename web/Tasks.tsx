import React from "react";
import type { TaskView } from "../src/task-view.js";

const stages = [
  "research",
  "plan",
  "implementation",
  "execution",
  "verification",
  "complete",
];
const labels: Record<string, string> = {
  research: "Research",
  plan: "Plan",
  implementation: "Code",
  execution: "Test",
  verification: "Verify",
  complete: "Done",
};
const readable = (value: string) => value.replaceAll("_", " ");
const outcome = (value: { outcome: string; reason: string }) =>
  value.outcome === "completed_before_invalidation"
    ? value.reason === "session_terminated"
      ? "Completed before the session ended"
      : "Completed before controls changed"
    : readable(value.outcome);
export function Tasks({
  tasks,
  repositories,
  inspect,
  review,
  diagnostics,
}: {
  tasks: TaskView[];
  repositories: Array<{ id: string; path: string }>;
  inspect: (id: string) => void;
  review: () => void;
  diagnostics: () => void;
}) {
  if (!tasks.length)
    return (
      <section className="task-empty">
        <h2>Your next coding task starts in OpenCode</h2>
        <p>
          Enroll your repository below, pair the runtime, then start OpenCode
          from your terminal. Its goal, agents, review decisions and results
          will appear here.
        </p>
      </section>
    );
  return (
    <div className="task-list">
      {tasks.map((task) => {
        const complete = task.stage === "complete";
        const gate = task.stages.find(
          (s) => s.stage === task.stage && s.state === "human_gate",
        );
        const decisions = task.proposals.filter(
          (p) => p.valid && !p.approved && !p.applied,
        );
        const working = task.agents.filter(
          (a) => a.task?.status === "running" || a.task?.status === "queued",
        );
        const blockedCount = task.blocked.reduce((n, d) => n + d.count, 0);
        return (
          <section className="task-card" key={task.id} aria-label={task.title}>
            <div className="task-heading">
              <p className="eyebrow">
                {repositories
                  .find((r) => r.id === task.repository)
                  ?.path.split("/")
                  .pop() || "Repository"}
              </p>
              <h2>{task.title}</h2>
              <div className="task-badges">
                <span
                  className={`badge ${complete ? "good" : task.status === "active" ? "" : "warn"}`}
                >
                  {complete
                    ? "Workflow complete"
                    : task.status === "active"
                      ? "In progress"
                      : readable(task.status)}
                </span>
                <span
                  className={`badge ${task.status === "active" && task.enforcement === "enforced" ? "good" : ""}`}
                >
                  {task.status !== "active"
                    ? "Session inactive"
                    : task.enforcement === "enforced"
                      ? "Controls enforced"
                      : "Controls unverified · protected actions blocked"}
                </span>
              </div>
            </div>
            <ol className="task-stages" aria-label="Task progress">
              {stages.map((stage) => {
                const passed =
                  task.stages.some(
                    (s) => s.stage === stage && s.state === "passed",
                  ) ||
                  (stage === "complete" && complete);
                const skipped =
                  !passed &&
                  stage !== "complete" &&
                  !!task.route &&
                  !task.route.includes(stage as never);
                return (
                  <li
                    key={stage}
                    className={
                      passed
                        ? "passed"
                        : skipped
                          ? "skipped"
                          : stage === task.stage
                            ? "current"
                            : ""
                    }
                    aria-current={stage === task.stage ? "step" : undefined}
                  >
                    <span>{labels[stage]}</span>
                    <small>
                      {passed
                        ? "Complete"
                        : skipped
                          ? "Not needed"
                          : stage === task.stage
                            ? "Current"
                            : "Upcoming"}
                    </small>
                  </li>
                );
              })}
            </ol>
            {!complete && task.status !== "active" && (
              <div className="task-attention">
                <strong>
                  {task.status === "terminated"
                    ? "Session ended"
                    : "Task needs attention"}
                </strong>
                <p>
                  {task.pauseReason
                    ? `Paused: ${readable(task.pauseReason)}.`
                    : "Inspect the recorded outcome before continuing from your terminal."}
                </p>
                <button className="secondary" onClick={diagnostics}>
                  Inspect recovery details
                </button>
              </div>
            )}
            {gate && (
              <div className="task-attention">
                <strong>Your approval is needed</strong>
                <p>
                  The {labels[task.stage]?.toLowerCase()} stage has been
                  reviewed. Inspect the result before allowing the next stage.
                </p>
                <button className="primary" onClick={review}>
                  Review stage
                </button>
              </div>
            )}
            {decisions.length > 0 && (
              <div className="task-decisions">
                <h3>Proposed actions</h3>
                {decisions.map((p) => (
                  <div className="task-line" key={p.id}>
                    <div>
                      <strong>
                        {p.tool === "execute"
                          ? "Run tests or a command"
                          : "Change a file"}
                      </strong>
                      <p className="task-path">{p.label}</p>
                      <small>
                        {p.reviewed
                          ? "Reviewed · ready for your decision"
                          : "Awaiting a passing review"}
                      </small>
                    </div>
                    <button className="secondary" onClick={() => inspect(p.id)}>
                      Inspect proposal
                    </button>
                  </div>
                ))}
              </div>
            )}
            {!complete && working.length > 0 && (
              <div className="task-work">
                <h3>Working now</h3>
                {working.map((a) => (
                  <p key={a.id}>
                    <strong>{a.role}</strong> · {a.task!.instructions}
                  </p>
                ))}
              </div>
            )}
            {!complete &&
              !gate &&
              !working.length &&
              !decisions.length &&
              task.status === "active" && (
                <p className="task-work">
                  Waiting for the next instruction in your external coding
                  session.
                </p>
              )}
            {(task.changes.length > 0 ||
              task.runs.length > 0 ||
              blockedCount > 0) && (
              <div className="task-results">
                <h3>Results & protection</h3>
                {task.changes.map((change) => (
                  <div className="task-line" key={change.id}>
                    <div>
                      <strong>
                        {change.status === "completed"
                          ? "Recorded file change"
                          : "File operation"}
                      </strong>
                      <p className="task-path">
                        {change.path}
                        {change.to ? ` → ${change.to}` : ""}
                      </p>
                      <small>
                        {readable(change.tool)} · {readable(change.status)}
                        {change.invalidated
                          ? ` · ${outcome(change.invalidated)}`
                          : ""}
                      </small>
                      {change.error && <p>{change.error}</p>}
                    </div>
                  </div>
                ))}
                {task.runs.map((run) => (
                  <div className="task-line" key={run.id}>
                    <div>
                      <strong>
                        {run.status === "completed"
                          ? run.exitCode === 0
                            ? "Command passed"
                            : typeof run.exitCode === "number"
                              ? `Command failed · exit ${run.exitCode}`
                              : "Command outcome unavailable"
                          : `Command ${readable(run.status)}`}
                      </strong>
                      <p className="task-path">{run.command}</p>
                      {run.invalidated && (
                        <small>{outcome(run.invalidated)}</small>
                      )}
                      {run.error && <p>{run.error}</p>}
                    </div>
                    {run.artifact && (
                      <button
                        className="secondary"
                        onClick={() => inspect(run.artifact!)}
                      >
                        View output
                      </button>
                    )}
                  </div>
                ))}
                {blockedCount > 0 && (
                  <details className="task-protection">
                    <summary>
                      {blockedCount} blocked action
                      {blockedCount === 1 ? "" : "s"}
                    </summary>
                    <p>These requests were rejected at admission.</p>
                    <ul>
                      {task.blocked.map((d) => (
                        <li key={`${d.session}:${d.rule}`}>
                          {readable(d.rule)} · {d.count} request
                          {d.count === 1 ? "" : "s"}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
            <details className="task-agent-details">
              <summary>Agents & task details</summary>
              <ul>
                {task.agents.map((a) => (
                  <li key={a.id}>
                    {a.role} ·{" "}
                    {a.task ? readable(a.task.status) : readable(a.status)}
                  </li>
                ))}
              </ul>
              <p className="fine">Task {task.id}</p>
              <p className="fine">
                {task.enforcement === "enforced"
                  ? "Runtime containment was verified for this session."
                  : "Runtime containment has not been verified."}
              </p>
            </details>
          </section>
        );
      })}
    </div>
  );
}
