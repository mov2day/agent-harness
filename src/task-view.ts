import { digest, hash, type Session } from "./core.js";
import type { Store } from "./store.js";
import type { ActionApproval, Operation } from "./operations.js";
import type { Artifact, Review, StageAttempt } from "./workflow.js";
import type { SpecialistTask } from "./specialists.js";

/** Owner-only presentation of existing evidence. This grants no authority. */
export function taskViews(store: Store) {
  const sessions = store.list<Session>("session");
  const artifacts = store.list<Artifact>("artifact");
  const reviews = store.list<Review>("review");
  const approvals = store.list<ActionApproval>("action-approval");
  const operations = store.list<Operation>("operation");
  const assignments = store.list<SpecialistTask>("specialist-task");
  const attempts = store.list<StageAttempt>("stage-attempt");
  const denials = store.db
    .prepare(
      "SELECT repository,session,json_extract(data,'$.rule') AS rule,COUNT(*) AS count,MAX(time) AS time FROM audit WHERE event='authorization.denied' GROUP BY repository,session,rule",
    )
    .all() as unknown as Array<{
    repository: string;
    session: string;
    rule: string;
    count: number;
    time: number;
  }>;
  return sessions
    .filter((s) => s.root === s.session && !s.parent)
    .sort((a, b) => b.created - a.created)
    .map((root) => {
      const members = sessions.filter(
        (s) => s.root === root.session && s.repository === root.repository,
      );
      const memberIds = new Set(members.map((s) => s.session));
      const effects = operations.filter(
        (op) => memberIds.has(op.session) && op.repository === root.repository,
      );
      const evidence = artifacts.filter(
        (a) => a.root === root.session && a.repository === root.repository,
      );
      const proposals = evidence
        .filter((a) => a.kind === "change-set")
        .flatMap((a) => {
          try {
            const value = JSON.parse(a.content);
            if (
              !value ||
              !["change", "delete", "rename", "execute"].includes(value.tool) ||
              !value.args ||
              typeof value.args !== "object"
            )
              return [];
            const matching = reviews.filter(
              (r) =>
                r.artifact === a.id &&
                r.hash === a.hash &&
                r.policy === root.policy,
            );
            const valid =
              a.valid &&
              a.policy === root.policy &&
              hash(a.content) === a.hash &&
              a.dependencies.every((key) =>
                evidence.some((dep) => dep.id === key && dep.valid),
              );
            const reviewed =
              valid &&
              matching.length > 0 &&
              matching.every(
                (r) =>
                  !r.findings.some((f) => f.blocking) &&
                  Object.entries(r.dependencies).every(([key, expected]) =>
                    evidence.some(
                      (dep) =>
                        dep.id === key && dep.valid && dep.hash === expected,
                    ),
                  ),
              );
            const action = digest({
              tool: value.tool,
              args: { ...value.args, approval: undefined },
            });
            const approved = approvals.some(
              (p) =>
                p.session === root.session &&
                p.repository === root.repository &&
                p.policy === root.policy &&
                p.valid &&
                p.action === action &&
                p.dependencies.includes(a.id) &&
                p.dependencies.every((key) =>
                  evidence.some((dep) => dep.id === key && dep.valid),
                ),
            );
            const applied = effects.some(
              (op) =>
                op.status === "completed" &&
                op.tool === value.tool &&
                op.args.approval &&
                approvals.some(
                  (p) =>
                    p.id === op.args.approval && p.dependencies.includes(a.id),
                ),
            );
            return [
              {
                id: a.id,
                tool: value.tool as string,
                label:
                  value.tool === "execute"
                    ? [
                        value.args.executable,
                        ...(Array.isArray(value.args.args)
                          ? value.args.args
                          : []),
                      ].join(" ")
                    : String(value.args.path ?? "Proposed change"),
                valid,
                reviewed,
                approved,
                applied,
              },
            ];
          } catch {
            return [];
          }
        });
      const authority = store.get<{ goals: string[] }>(
        "authority",
        root.session,
      );
      const lastPause = store.db
        .prepare(
          "SELECT data FROM audit WHERE event='authority.invalidated' AND repository=? AND session=? ORDER BY seq DESC LIMIT 1",
        )
        .get(root.repository, root.session) as { data: string } | undefined;
      return {
        id: root.session,
        repository: root.repository,
        title: authority?.goals[0] || "Coding task awaiting a goal",
        stage: root.stage,
        status: root.status,
        enforcement: root.enforcement,
        pauseReason:
          root.status === "paused" && lastPause
            ? String(JSON.parse(lastPause.data).reason)
            : undefined,
        stages: attempts.filter((a) => a.root === root.session),
        agents: members
          .filter((s) => s.parent)
          .map((s) => {
            const task = assignments
              .filter(
                (a) =>
                  a.session === s.session &&
                  a.root === root.session &&
                  a.repository === root.repository,
              )
              .sort((a, b) => b.created - a.created)[0];
            return {
              id: s.session,
              role: s.role,
              status: s.status,
              task: task
                ? { instructions: task.instructions, status: task.status }
                : undefined,
            };
          }),
        proposals,
        changes: effects
          .filter((op) => ["change", "delete", "rename"].includes(op.tool))
          .map((op) => ({
            id: op.id,
            tool: op.tool,
            path: String(op.args.path),
            to: op.args.to as string | undefined,
            status: op.status,
            error: op.error,
            invalidated: op.invalidated,
          })),
        runs: effects
          .filter((op) => op.tool === "execute")
          .map((op) => {
            const result = op.result as
              { exitCode?: unknown; artifact?: unknown } | undefined;
            return {
              id: op.id,
              command: [op.args.executable, ...op.args.args].join(" "),
              status: op.status,
              exitCode:
                typeof result?.exitCode === "number"
                  ? result.exitCode
                  : undefined,
              artifact:
                typeof result?.artifact === "string"
                  ? result.artifact
                  : undefined,
              error: op.error,
              invalidated: op.invalidated,
            };
          }),
        blocked: denials
          .filter(
            (d) => d.repository === root.repository && memberIds.has(d.session),
          )
          .sort((a, b) => b.time - a.time),
      };
    });
}
export type TaskView = ReturnType<typeof taskViews>[number];
