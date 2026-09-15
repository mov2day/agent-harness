import {
  mkdirSync,
  realpathSync,
  openSync,
  writeFileSync,
  closeSync,
  unlinkSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { Store } from "./store.js";
import { Policies, defaultPolicy } from "./policy.js";
import { Identity, Repositories } from "./identity.js";
import { Containment } from "./containment.js";
import { Operations } from "./operations.js";
import { NativeFiles } from "./files.js";
import { Gateway } from "./gateway.js";
import { CommandWorkers } from "./workers.js";
import { Snapshots } from "./snapshots.js";
import { Artifacts, Workflow } from "./workflow.js";
import { Compaction } from "./compaction.js";
import { Learning } from "./learning.js";
import { check, id, type Clock, type Session } from "./core.js";
export interface EngineOptions {
  state: string;
  sourceHash: string;
  helper?: string;
  workerImage?: string;
  clock?: Clock;
}
export class Engine {
  readonly store: Store;
  readonly policies: Policies;
  readonly repositories: Repositories;
  readonly identity: Identity;
  readonly containment: Containment;
  readonly operations: Operations;
  readonly files: NativeFiles;
  readonly gateway: Gateway;
  readonly artifacts: Artifacts;
  readonly workflow: Workflow;
  readonly compaction: Compaction;
  readonly learning: Learning;
  readonly workers?: CommandWorkers;
  readonly snapshots: Snapshots;
  private lock: string;
  private lockHandle: number;
  private sweep: ReturnType<typeof setInterval>;
  private healthCheck: ReturnType<typeof setInterval>;
  constructor(readonly options: EngineOptions) {
    const requested = resolve(options.state);
    mkdirSync(requested, { recursive: true, mode: 0o700 });
    const state = realpathSync(requested);
    check(
      !lstatSync(requested).isSymbolicLink() &&
        (lstatSync(state).mode & 0o077) === 0,
      "state_permissions",
      "State directory must be canonical, owner-only and outside repositories",
    );
    this.lock = join(state, "engine.lock");
    try {
      this.lockHandle = openSync(this.lock, "wx", 0o600);
    } catch {
      let alive = true;
      try {
        const pid = Number(readFileSync(this.lock, "utf8"));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH")
              alive = false;
          }
        }
      } catch {}
      check(
        !alive,
        "engine_already_running",
        "An engine lock exists. Verify the other engine has stopped.",
      );
      unlinkSync(this.lock);
      this.lockHandle = openSync(this.lock, "wx", 0o600);
    }
    writeFileSync(this.lockHandle, String(process.pid));
    try {
      this.store = new Store(join(state, "engine.sqlite"), options.clock);
      this.policies = new Policies(this.store);
      this.repositories = new Repositories(this.store);
      this.identity = new Identity(
        this.store,
        this.policies,
        this.repositories,
      );
      this.containment = new Containment(this.store, options.sourceHash);
      this.policies.setModelCapabilities(() => this.containment.capabilities());
      this.operations = new Operations(
        this.store,
        this.identity,
        this.policies,
        (s) => this.containment.healthy(s),
      );
      this.containment.setInvalidator((session) =>
        this.operations.invalidate(session, "enforcement_unhealthy"),
      );
      this.files = new NativeFiles(options.helper);
      this.gateway = new Gateway(this.store, this.operations);
      this.artifacts = new Artifacts(this.store, this.identity);
      this.snapshots = new Snapshots(
        this.store,
        this.identity,
        this.policies,
        this.files,
        this.artifacts,
      );
      this.workflow = new Workflow(
        this.store,
        this.identity,
        this.policies,
        this.artifacts,
        this.operations,
        (session) => this.containment.capabilities(session),
      );
      this.artifacts.setInvalidator((root) =>
        this.operations.invalidate(root, "artifact_changed"),
      );
      this.compaction = new Compaction(
        this.store,
        this.identity,
        this.artifacts,
      );
      this.learning = new Learning(this.store, this.artifacts, this.operations);
      if (options.workerImage)
        this.workers = new CommandWorkers(
          this.operations,
          options.workerImage,
          this.snapshots,
        );
      if (!this.store.get("meta", "initialized"))
        this.store.transaction(() => {
          this.policies.publish("global", defaultPolicy, true);
          this.store.put("meta", "initialized", { version: 1 });
        });
      this.operations.recover();
      void this.workers
        ?.recover()
        .catch((error) =>
          process.stderr.write(`Worker recovery failed: ${String(error)}\n`),
        );
      this.sweep = setInterval(() => {
        try {
          this.operations.sweep();
        } catch (error) {
          process.stderr.write(`Authority sweep failed: ${String(error)}\n`);
        }
      }, 1000);
      this.sweep.unref();
      this.healthCheck = setInterval(() => {
        void this.containment
          .refresh()
          .catch((error) =>
            process.stderr.write(
              `Runtime health check failed: ${String(error)}\n`,
            ),
          );
      }, 250);
      this.healthCheck.unref();
    } catch (error) {
      closeSync(this.lockHandle);
      unlinkSync(this.lock);
      throw error;
    }
  }
  enroll(path: string) {
    const canonical = realpathSync(path),
      state = realpathSync(this.options.state);
    check(
      state !== canonical && !state.startsWith(`${canonical}/`),
      "state_in_repository",
    );
    return this.repositories.enroll(path);
  }
  async execute(
    token: string,
    connection: string,
    input: { tool: string; args: unknown; idempotencyKey: string },
  ) {
    const op = this.operations.begin(token, connection, input);
    return this.operations.run(op, async (signal) => {
      const scope = this.identity.session(op.session);
      switch (op.tool) {
        case "read": {
          const repo = this.repositories.verify(scope.repository),
            content = this.files.read(repo, op.args.path);
          check(content !== null, "file_not_found", "File not found", 404);
          if (content.length > 32_768) {
            const a = this.artifacts.create(scope, {
              kind: "file-content",
              content: content.toString("utf8"),
              dependencies: [],
              sources: [],
            });
            return { artifact: a.id, hash: a.hash, bytes: content.length };
          }
          return { content: content.toString("utf8") };
        }
        case "change":
        case "delete":
        case "rename":
          return this.files.mutate(
            this.repositories.verify(scope.repository),
            op,
            this.operations,
          );
        case "research": {
          const evidence = await this.gateway.fetch(op, signal);
          return {
            id: evidence.id,
            hash: evidence.hash,
            url: evidence.url,
            trust: evidence.trust,
            content: evidence.content.slice(0, 16_384),
            truncated: evidence.content.length > 16_384,
          };
        }
        case "execute": {
          check(this.workers, "workers_unconfigured");
          const result = await this.workers.execute(op, signal);
          const artifact = this.artifacts.create(scope, {
            kind: "execution",
            content: JSON.stringify(result),
            dependencies: [op.args.snapshot],
            sources: [],
          });
          return {
            exitCode: result.exitCode,
            artifact: artifact.id,
            hash: artifact.hash,
            truncated: result.truncated,
          };
        }
        case "delegate":
          return this.workflow.admit(
            scope,
            op.args.role,
            op.args.model
              ? { model: op.args.model, reasoning: op.args.reasoning }
              : undefined,
          );
        case "artifact": {
          switch (op.args.action) {
            case "snapshot":
              return this.snapshots.capture(scope);
            case "get":
              return this.artifacts.get(scope, op.args.id);
            case "evidence":
              return this.artifacts.source(scope, op.args.id);
            case "share":
              this.artifacts.share(scope, op.args.id, op.args.session);
              return { shared: true };
            case "invalidate":
              return this.artifacts.invalidate(scope, op.args.id);
            case "submit":
              return this.workflow.submit(scope, op.args.id);
            default:
              return this.artifacts.create(scope, op.args as any);
          }
        }
        case "review":
          return op.args.kind === "change"
            ? this.workflow.reviewChange(
                scope,
                op.args.artifact,
                op.args.findings,
              )
            : this.workflow.review(scope, op.args.artifact, op.args.findings);
        case "compact":
          return op.args.action === "context"
            ? {
                state: this.compaction.authoritative(scope),
                budget: this.compaction.budget(scope),
              }
            : op.args.action === "get"
              ? this.compaction.get(scope, op.args.id)
              : this.compaction.accept(scope, op.args.checkpoint);
        case "learn":
          return this.learning.propose(scope, op.args.candidate);
      }
    });
  }
  state() {
    const repositories = this.store.list<{
      id: string;
      path: string;
      caseSensitive: boolean;
    }>("repository");
    return {
      version: "0.1.0",
      platform: process.platform,
      repositories,
      sessions: this.store.list<Session>("session"),
      policies: repositories.map((r) => {
        try {
          return { repository: r.id, effective: this.policies.effective(r.id) };
        } catch (error) {
          return { repository: r.id, error: String(error) };
        }
      }),
      globalPolicy: (() => {
        try {
          return this.policies.active("global");
        } catch (error) {
          return { error: String(error) };
        }
      })(),
      operations: this.store
        .list<any>("operation")
        .map(({ args, result, ...op }) => ({
          ...op,
          resultSummary: result
            ? JSON.stringify(result).slice(0, 500)
            : undefined,
        })),
      reviews: this.store.list("review"),
      stages: this.store.list("stage-attempt"),
      contexts: this.store.list("context"),
      candidates: this.store.list("candidate"),
      skills: this.store.list("skill"),
      alerts: this.store.list("alert"),
      certificates: this.store.list("runtime-certificate"),
      workerConfigured: !!this.workers,
      audit: this.store.db
        .prepare(
          "SELECT seq,time,repository,session,event,data FROM audit ORDER BY seq DESC LIMIT 100",
        )
        .all(),
    };
  }
  close() {
    clearInterval(this.sweep);
    clearInterval(this.healthCheck);
    this.containment.close();
    this.store.close();
    closeSync(this.lockHandle);
    unlinkSync(this.lock);
  }
}
