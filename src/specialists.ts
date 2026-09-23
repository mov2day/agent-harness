import { z } from "zod";
import { check, hash, id, type Session } from "./core.js";
import type { Store } from "./store.js";
import type { Identity } from "./identity.js";
import type { Operations, Operation } from "./operations.js";
import type { Artifacts, Workflow } from "./workflow.js";

const assignment = {
  task: z.string().trim().min(1).max(16_000),
  artifacts: z.array(z.string().uuid()).max(32).default([]),
};
export const delegateSchema = z.union([
  z
    .object({
      action: z.literal("start").optional(),
      role: z.enum([
        "Researcher",
        "Planner",
        "Implementer",
        "Reviewer",
        "Verifier",
      ]),
      ...assignment,
      model: z.string().min(1).optional(),
      reasoning: z.string().min(1).optional(),
    })
    .strict()
    .refine(
      (v) => !!v.model === !!v.reasoning,
      "Model and reasoning must be assigned together",
    ),
  z
    .object({
      action: z.literal("message"),
      session: z.string().uuid(),
      ...assignment,
    })
    .strict(),
  z
    .object({ action: z.literal("finish"), session: z.string().uuid() })
    .strict(),
  z.object({ action: z.literal("status"), task: z.string().uuid() }).strict(),
]);
export type Delegation = z.infer<typeof delegateSchema>;
export interface SpecialistTask {
  id: string;
  repository: string;
  root: string;
  parent: string;
  session: string;
  parentGeneration: number;
  generation: number;
  policy: string;
  instructions: string;
  artifacts: Record<string, string>;
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "requires_reconciliation";
  claimHash?: string;
  result?: { artifact: string; hash: string; trust: "untrusted" };
  error?: string;
  created: number;
  completed?: number;
}
export type TaskView = Omit<SpecialistTask, "claimHash">;
const pending = (task: SpecialistTask) =>
  task.status === "queued" || task.status === "running";

/** Durable assignments belong to the engine. Only the credential-holding host
 * bridge may claim a task; model-facing delegation never returns a claim. */
export class Specialists {
  constructor(
    readonly store: Store,
    readonly identity: Identity,
    readonly operations: Operations,
    readonly workflow: Workflow,
    readonly artifacts: Artifacts,
  ) {
    operations.onInvalidation((sessions, reason) => {
      for (const task of store.list<SpecialistTask>("specialist-task")) {
        if (
          !pending(task) ||
          (!sessions.has(task.parent) && !sessions.has(task.session))
        )
          continue;
        task.status =
          task.status === "queued" ? "cancelled" : "requires_reconciliation";
        task.error = reason;
        task.completed = store.clock.now();
        this.save(task, "specialist.interrupted");
        // A failed child cannot leave dependent work authorized at its root.
        if (
          !sessions.has(task.parent) &&
          identity.session(task.parent).status === "active"
        )
          operations.invalidate(task.parent, "specialist_authority_lost");
      }
    });
    artifacts.onInvalidation((invalid) => {
      for (const task of store.list<SpecialistTask>("specialist-task")) {
        if (
          !["queued", "running", "completed"].includes(task.status) ||
          !(
            Object.keys(task.artifacts).some((key) => invalid.has(key)) ||
            (task.result && invalid.has(task.result.artifact))
          )
        )
          continue;
        task.status =
          task.status === "queued" ? "cancelled" : "requires_reconciliation";
        task.error = "specialist_evidence_invalidated";
        task.completed = store.clock.now();
        this.save(task, "specialist.interrupted");
        if (identity.session(task.parent).status === "active")
          operations.invalidate(task.parent, "specialist_evidence_invalidated");
      }
    });
  }
  view(task: SpecialistTask): TaskView {
    const { claimHash: _claim, ...view } = task;
    return view;
  }
  private save(task: SpecialistTask, event: string) {
    this.store.put(
      "specialist-task",
      task.id,
      task,
      task.repository,
      task.session,
    );
    this.store.audit(
      event,
      {
        id: task.id,
        parent: task.parent,
        session: task.session,
        status: task.status,
        artifacts: task.artifacts,
        result: task.result,
        error: task.error,
      },
      task.repository,
      task.parent,
    );
  }
  private parent(scope: Session) {
    const parent = this.identity.session(scope.session);
    check(
      parent.generation === scope.generation &&
        parent.repository === scope.repository &&
        parent.root === scope.root,
      "delegation_authority_lost",
    );
    this.operations.authorize(parent, "delegate", {});
    return parent;
  }
  private child(parent: Session, session: string) {
    const child = this.identity.session(session);
    check(
      child.parent === parent.session &&
        child.root === parent.root &&
        child.repository === parent.repository &&
        child.integration === parent.integration,
      "delegation_scope",
    );
    check(
      child.status === "active" && child.policy === parent.policy,
      "specialist_inactive",
    );
    return child;
  }
  private get(parent: Session, key: string) {
    const task = this.store.get<SpecialistTask>("specialist-task", key);
    check(
      task &&
        task.parent === parent.session &&
        task.root === parent.root &&
        task.repository === parent.repository,
      "specialist_task_not_found",
      "Specialist task not found",
      404,
    );
    return task;
  }
  private current(parent: Session, task: SpecialistTask) {
    const child = this.child(parent, task.session);
    check(
      task.parentGeneration === parent.generation &&
        task.generation === child.generation &&
        task.policy === parent.policy,
      "specialist_task_stale",
    );
    for (const [key, expected] of Object.entries(task.artifacts)) {
      const artifact = this.artifacts.get(child, key);
      check(
        artifact.valid && artifact.hash === expected,
        "specialist_input_stale",
      );
    }
    return child;
  }
  private idle(child: Session) {
    check(
      !this.store
        .list<SpecialistTask>(
          "specialist-task",
          child.repository,
          child.session,
        )
        .some((t) => pending(t) || t.status === "requires_reconciliation"),
      "specialist_busy",
    );
    this.noPendingOperations(child);
  }
  private noPendingOperations(child: Session) {
    check(
      !this.store
        .list<Operation>("operation", child.repository, child.session)
        .some(
          (op) => !["completed", "failed", "cancelled"].includes(op.status),
        ),
      "specialist_operation_pending",
    );
  }
  execute(scope: Session, input: Delegation) {
    return this.store.transaction(() => {
      const parent = this.parent(scope);
      if (input.action === "status") {
        const task = this.get(parent, input.task);
        if (task.result) {
          const artifact = this.artifacts.get(parent, task.result.artifact);
          check(
            artifact.valid && artifact.hash === task.result.hash,
            "specialist_result_stale",
          );
        }
        return { task: this.view(task) };
      }
      if (input.action === "finish") {
        const child = this.child(parent, input.session);
        this.idle(child);
        this.workflow.terminate(parent, child.session);
        return { session: child.session, status: "terminated" as const };
      }
      const child =
        input.action === "message"
          ? this.child(parent, input.session)
          : this.workflow.admit(
              parent,
              input.role,
              input.model
                ? { model: input.model, reasoning: input.reasoning! }
                : undefined,
            ).session;
      this.idle(child);
      const inputs: Record<string, string> = {};
      for (const key of new Set(input.artifacts)) {
        const artifact = this.artifacts.get(parent, key);
        check(
          artifact.valid && artifact.root === parent.root,
          "specialist_input_scope",
        );
        this.artifacts.shareForDelegation(parent, key, child);
        inputs[key] = artifact.hash;
      }
      const task: SpecialistTask = {
        id: id(),
        repository: parent.repository,
        root: parent.root,
        parent: parent.session,
        session: child.session,
        parentGeneration: parent.generation,
        generation: child.generation,
        policy: parent.policy,
        instructions: input.task,
        artifacts: inputs,
        status: "queued",
        created: this.store.clock.now(),
      };
      this.save(task, "specialist.assigned");
      return { session: child, task: this.view(task) };
    });
  }
  claim(token: string, connection: string, key: string, claim: string) {
    // Authenticate outside the transaction so expiry invalidation is durable.
    const scope = this.identity.authenticate(token, connection);
    return this.store.transaction(() => {
      const parent = this.parent(scope),
        task = this.get(parent, key),
        child = this.current(parent, task);
      check(
        task.status === "queued" ||
          (task.status === "running" && task.claimHash === hash(claim)),
        "specialist_task_claimed",
      );
      if (task.status === "queued") {
        task.claimHash = hash(claim);
        task.status = "running";
        this.save(task, "specialist.claimed");
      }
      return { task: this.view(task), session: child };
    });
  }
  complete(
    token: string,
    connection: string,
    key: string,
    claim: string,
    result: string,
  ) {
    const scope = this.identity.authenticate(token, connection);
    return this.store.transaction(() => {
      const parent = this.parent(scope),
        task = this.get(parent, key);
      check(task.claimHash === hash(claim), "specialist_claim_mismatch");
      // A response lost after completion can be recovered, even after finish.
      if (task.status === "completed") {
        check(task.result?.artifact === result, "specialist_result_conflict");
        const artifact = this.artifacts.get(parent, result);
        check(
          artifact.valid && artifact.hash === task.result.hash,
          "specialist_result_stale",
        );
        return this.view(task);
      }
      check(task.status === "running", "specialist_task_terminal");
      const child = this.current(parent, task);
      this.operations.authorize(child, "artifact", {});
      this.noPendingOperations(child);
      const artifact = this.artifacts.get(parent, result);
      check(
        artifact.valid &&
          artifact.session === child.session &&
          artifact.root === parent.root &&
          artifact.policy === parent.policy &&
          artifact.trust === "untrusted",
        "specialist_result_scope",
      );
      check(
        Object.keys(task.artifacts).every((key) =>
          artifact.dependencies.includes(key),
        ),
        "specialist_result_lineage",
      );
      task.status = "completed";
      task.result = {
        artifact: artifact.id,
        hash: artifact.hash,
        trust: "untrusted",
      };
      task.completed = this.store.clock.now();
      this.save(task, "specialist.completed");
      return this.view(task);
    });
  }
  fail(token: string, connection: string, key: string, claim: string) {
    const scope = this.identity.authenticate(token, connection);
    return this.store.transaction(() => {
      const parent = this.parent(scope),
        task = this.get(parent, key);
      check(
        task.status === "running" && task.claimHash === hash(claim),
        "specialist_claim_mismatch",
      );
      task.status = "failed";
      task.error = "specialist_runtime_failed";
      task.completed = this.store.clock.now();
      this.save(task, "specialist.failed");
      this.operations.invalidate(parent.session, "specialist_failed");
      return this.view(task);
    });
  }
  release(token: string, connection: string, session: string) {
    const parent = this.parent(this.identity.authenticate(token, connection));
    const child = this.identity.session(session);
    check(
      child.parent === parent.session &&
        child.root === parent.root &&
        child.repository === parent.repository &&
        child.status === "terminated",
      "specialist_release_scope",
    );
    this.idle(child);
    return child;
  }
  abandon(token: string, connection: string, key: string) {
    const scope = this.identity.authenticate(token, connection);
    return this.store.transaction(() => {
      const parent = this.parent(scope),
        task = this.get(parent, key);
      check(task.status === "running", "specialist_task_terminal");
      task.status = "requires_reconciliation";
      task.error = "specialist_host_state_lost";
      task.completed = this.store.clock.now();
      this.save(task, "specialist.interrupted");
      this.operations.invalidate(parent.session, "specialist_host_state_lost");
      return this.view(task);
    });
  }
  context(scope: Session) {
    const tasks = this.store
      .list<SpecialistTask>("specialist-task", scope.repository)
      .filter(
        (task) =>
          task.root === scope.root &&
          (task.session === scope.session || task.parent === scope.session),
      )
      .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
    // Include all current assignments and a bounded recent history. Task text is
    // explicitly separate from the engine's authoritative role and permissions.
    return tasks
      .filter(pending)
      .concat(tasks.filter((task) => !pending(task)).slice(-8))
      .map((task) => this.view(task));
  }
}
