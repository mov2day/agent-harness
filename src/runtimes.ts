import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { check, digest, type Session } from "./core.js";
import type { Store } from "./store.js";
import type { Identity } from "./identity.js";
import type { Operations } from "./operations.js";
import type { Compaction } from "./compaction.js";
import type { Containment, ContainerInspection } from "./containment.js";

const exec = promisify(execFile);
export interface RuntimeControl {
  inspect(reference: string): Promise<ContainerInspection | undefined>;
  remove(container: string): Promise<void>;
}
export const dockerRuntimeControl: RuntimeControl = {
  async inspect(reference) {
    check(
      /^(?:[a-f0-9]{64}|agent-harness-runtime-[a-f0-9-]{36})$/.test(reference),
      "runtime_reference",
    );
    try {
      const { stdout } = await exec(
        "docker",
        ["inspect", "--type", "container", reference],
        { timeout: 5000, maxBuffer: 1024 * 1024 },
      );
      const values = JSON.parse(stdout);
      check(
        Array.isArray(values) && values.length === 1,
        "container_inspection",
      );
      return values[0];
    } catch (error) {
      const failure = error as { code?: unknown; stderr?: string };
      if (
        failure.code === 1 &&
        /(?:No such object|No such container):/.test(failure.stderr ?? "")
      )
        return undefined;
      throw error;
    }
  },
  async remove(container) {
    check(/^[a-f0-9]{64}$/.test(container), "container_id");
    await exec("docker", ["rm", "--force", container], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
  },
};
export interface RuntimeLaunch {
  session: string;
  repository: string;
  runtimeSession: string;
  connection: string;
  generation: number;
  certificate: string;
  image: string;
  name: string;
  container?: string;
  requestHash: string;
  model: { model: string; reasoning: string };
  status:
    | "prepared"
    | "attached"
    | "stopping"
    | "stopped"
    | "requires_reconciliation";
  created: number;
  error?: string;
}
export const runtimePrepareSchema = z
  .object({
    certificate: z.string(),
    goal: z.string().min(1).max(64_000).optional(),
  })
  .strict();

/** The engine records launch intent before the trusted, externally started
 * bridge creates a container. This service never launches a root process. */
export class Runtimes {
  private cleaning = new Map<string, Promise<RuntimeLaunch>>();
  private closed = false;
  constructor(
    readonly store: Store,
    readonly identity: Identity,
    readonly operations: Operations,
    readonly containment: Containment,
    readonly compaction: Compaction,
    private control: RuntimeControl = dockerRuntimeControl,
  ) {}
  prepare(token: string, connection: string, input: unknown) {
    this.store.assertHealthy();
    const request = runtimePrepareSchema.parse(input),
      scope = this.identity.authenticate(token, connection);
    const certificate = this.containment.forSession(scope, request.certificate);
    check(scope.model, "model_not_assigned");
    check(
      !request.goal ||
        (scope.role === "Conductor" && scope.root === scope.session),
      "root_goal_required",
    );
    return this.store.transaction(() => {
      const existing = this.store.get<RuntimeLaunch>(
          "runtime-launch",
          scope.session,
        ),
        requestHash = digest(request);
      if (existing) {
        check(
          existing.requestHash === requestHash &&
            existing.generation === scope.generation &&
            ["prepared", "attached"].includes(existing.status),
          "runtime_launch_conflict",
        );
        return existing;
      }
      check(scope.enforcement === "unverified", "runtime_already_bound");
      const launch: RuntimeLaunch = {
        session: scope.session,
        repository: scope.repository,
        runtimeSession: scope.runtimeSession,
        connection: scope.connection,
        generation: scope.generation,
        certificate: certificate.id,
        image: certificate.image,
        name: `agent-harness-runtime-${scope.session}`,
        requestHash,
        model: scope.model!,
        status: "prepared",
        created: this.store.clock.now(),
      };
      if (request.goal) {
        check(
          !this.store.get("authority", scope.root),
          "authority_already_set",
        );
        this.store.put(
          "authority",
          scope.root,
          {
            goals: [request.goal],
            constraints: [],
            decisions: [],
            findings: [],
          },
          scope.repository,
          scope.root,
        );
      }
      if (!this.store.get("context", scope.session))
        this.compaction.configure(scope, 32768, 8192);
      this.save(launch);
      this.store.audit(
        "runtime.launch_prepared",
        {
          session: scope.session,
          name: launch.name,
          image: launch.image,
          certificate: launch.certificate,
          requestHash,
        },
        scope.repository,
        scope.session,
      );
      return launch;
    });
  }
  async attach(token: string, connection: string, container: string) {
    const scope = this.identity.authenticate(token, connection);
    check(/^[a-f0-9]{64}$/.test(container), "container_id");
    const launch = this.store.get<RuntimeLaunch>(
      "runtime-launch",
      scope.session,
    );
    check(
      launch && ["prepared", "attached"].includes(launch.status),
      "runtime_launch_missing",
    );
    check(
      !launch.container || launch.container === container,
      "runtime_already_bound",
    );
    const inspected = await this.control.inspect(launch.name);
    check(inspected && inspected.Id === container, "runtime_launch_identity");
    return this.store.transaction(() => {
      const current = this.identity.authenticate(token, connection);
      check(current.generation === launch.generation, "runtime_authority_lost");
      const fresh = this.store.get<RuntimeLaunch>(
        "runtime-launch",
        scope.session,
      )!;
      check(
        ["prepared", "attached"].includes(fresh.status),
        "runtime_launch_conflict",
      );
      this.containment.attach(current, container, launch.certificate);
      fresh.container = container;
      fresh.status = "attached";
      this.save(fresh);
      this.store.audit(
        "runtime.launch_attached",
        { container },
        scope.repository,
        scope.session,
      );
      return fresh;
    });
  }
  async stop(token: string, connection: string) {
    const scope = this.identity.authenticate(token, connection);
    this.operations.invalidate(scope.session, "session_terminated");
    if (!this.store.get("runtime-launch", scope.session))
      return { session: scope.session, status: "stopped" as const };
    return this.cleanup(scope.session);
  }
  private save(launch: RuntimeLaunch) {
    this.store.put(
      "runtime-launch",
      launch.session,
      launch,
      launch.repository,
      launch.session,
    );
  }
  cleanup(session: string): Promise<RuntimeLaunch> {
    const running = this.cleaning.get(session);
    if (running) return running;
    const cleanup = this.remove(session).finally(() =>
      this.cleaning.delete(session),
    );
    this.cleaning.set(session, cleanup);
    return cleanup;
  }
  private async remove(session: string) {
    const launch = this.store.get<RuntimeLaunch>("runtime-launch", session);
    check(launch, "runtime_launch_missing");
    if (launch.status === "stopped") return launch;
    // Cleanup is only allowed after revocation/termination, including recovery.
    check(
      this.identity.session(session).status !== "active",
      "runtime_still_active",
    );
    this.store.transaction(() => {
      launch.status = "stopping";
      this.save(launch);
      this.store.audit(
        "runtime.cleanup_started",
        { name: launch.name },
        launch.repository,
        session,
      );
    });
    try {
      const actual = await this.control.inspect(
        launch.container ?? launch.name,
      );
      check(actual || launch.container, "runtime_creation_outcome_unknown");
      if (actual) {
        check(
          actual.Image === launch.image &&
            actual.Config.Labels["agent-harness.session"] ===
              launch.runtimeSession &&
            actual.Config.Labels["agent-harness.connection"] ===
              launch.connection &&
            (!launch.container || actual.Id === launch.container),
          "runtime_cleanup_identity",
        );
        await this.control.remove(actual.Id);
        launch.container = actual.Id;
      }
      launch.status = "stopped";
      delete launch.error;
    } catch (error) {
      launch.status = "requires_reconciliation";
      launch.error =
        error instanceof Error ? error.message : "runtime_cleanup_failed";
    }
    if (!this.closed)
      this.store.transaction(() => {
        this.save(launch);
        this.store.audit(
          "runtime.cleanup_outcome",
          { status: launch.status, error: launch.error },
          launch.repository,
          session,
        );
      });
    return launch;
  }
  async sweep() {
    if (this.closed) return;
    const inactive = this.store
      .list<RuntimeLaunch>("runtime-launch")
      .filter(
        (launch) =>
          !["stopped", "requires_reconciliation"].includes(launch.status) &&
          this.identity.session(launch.session).status !== "active",
      );
    await Promise.all(inactive.map((launch) => this.cleanup(launch.session)));
  }
  close() {
    this.closed = true;
  }
}
