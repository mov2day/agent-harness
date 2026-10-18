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
import { Policies, defaultPolicy, type Policy } from "./policy.js";
import {
  effectiveList,
  coreTools,
  leastPrivilegeNotes,
  mandatoryIssues,
  recommendedTools,
  requiredPolicyTools,
  requiredTools,
  rolePermissions,
  sessionAgent,
  stageRoles,
} from "./agents.js";
import { discoverCatalog } from "./catalog.js";
import {
  listOpenCodeAgents,
  listOpenCodeModels,
  type Check,
  type SyncTargets,
} from "./harness-sync.js";
import {
  applyTomlWrite,
  planTomlWrite,
  policyToToml,
  readTomlFile,
  tomlToPolicy,
} from "./harness-toml.js";
import { ExternalReviews } from "./external-review.js";
import {
  applyExport,
  planExport,
  webSearchEnabled,
} from "./opencode-export.js";
import { Identity, Repositories } from "./identity.js";
import { Containment } from "./containment.js";
import { Operations } from "./operations.js";
import { NativeFiles } from "./files.js";
import { Gateway } from "./gateway.js";
import { CommandWorkers } from "./workers.js";
import { Snapshots } from "./snapshots.js";
import { Artifacts, Workflow } from "./workflow.js";
import { Compaction } from "./compaction.js";
import { ContextWindow } from "./context-window.js";
import { Learning } from "./learning.js";
import { Evaluations } from "./evaluations.js";
import { taskViews } from "./task-view.js";
import { ModelChannel } from "./model-channel.js";
import { Runtimes, type RuntimeLaunch } from "./runtimes.js";
import { Specialists, type SpecialistTask } from "./specialists.js";
import { homedir } from "node:os";
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
  readonly externalReviews: ExternalReviews;
  readonly models: ModelChannel;
  readonly runtimes: Runtimes;
  readonly artifacts: Artifacts;
  readonly workflow: Workflow;
  readonly specialists: Specialists;
  readonly compaction: Compaction;
  readonly contextWindow: ContextWindow;
  readonly learning: Learning;
  readonly evaluations: Evaluations;
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
    let openedStore: Store | undefined,
      initializedContainment: Containment | undefined,
      initializedRuntimes: Runtimes | undefined,
      initializedEvaluations: Evaluations | undefined;
    try {
      this.store = openedStore = new Store(
        join(state, "engine.sqlite"),
        options.clock,
      );
      this.policies = new Policies(this.store);
      this.repositories = new Repositories(this.store);
      this.identity = new Identity(
        this.store,
        this.policies,
        this.repositories,
      );
      this.containment = initializedContainment = new Containment(
        this.store,
        options.sourceHash,
      );
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
      this.externalReviews = new ExternalReviews(this.store, this.policies);
      this.models = new ModelChannel(this.store, this.operations);
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
      this.specialists = new Specialists(
        this.store,
        this.identity,
        this.operations,
        this.workflow,
        this.artifacts,
      );
      this.compaction = new Compaction(
        this.store,
        this.identity,
        this.artifacts,
      );
      this.compaction.setInvalidator((session, reason) =>
        this.operations.invalidate(session, reason),
      );
      this.contextWindow = new ContextWindow(
        this.compaction,
        (scope) => this.specialists.context(scope),
        (scope) => this.agentContext(scope),
      );
      this.learning = new Learning(this.store, this.artifacts, this.operations);
      this.evaluations = initializedEvaluations = new Evaluations(
        this.store,
        this.learning,
        () => this.models,
        options.sourceHash,
      );
      this.runtimes = initializedRuntimes = new Runtimes(
        this.store,
        this.identity,
        this.operations,
        this.containment,
        this.compaction,
      );
      if (options.workerImage)
        this.workers = new CommandWorkers(
          this.operations,
          options.workerImage,
          this.snapshots,
        );
      this.policies.migrateLegacy();
      if (!this.store.get("meta", "initialized"))
        this.store.transaction(() => {
          this.policies.publish("global", defaultPolicy, true);
          this.store.put("meta", "initialized", { version: 1 });
        });
      this.operations.recover();
      void this.runtimes
        .sweep()
        .catch((error) =>
          process.stderr.write(`Runtime recovery failed: ${String(error)}\n`),
        );
      void this.workers
        ?.recover()
        .catch((error) =>
          process.stderr.write(`Worker recovery failed: ${String(error)}\n`),
        );
      this.sweep = setInterval(() => {
        try {
          this.operations.sweep();
          this.evaluations.sweep();
          void this.runtimes
            .sweep()
            .catch((error) =>
              process.stderr.write(
                `Runtime cleanup failed: ${String(error)}\n`,
              ),
            );
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
      initializedEvaluations?.close();
      initializedRuntimes?.close();
      initializedContainment?.close();
      openedStore?.close();
      closeSync(this.lockHandle);
      unlinkSync(this.lock);
      throw error;
    }
  }
  resolveRepository(path: string) {
    return this.repositories.resolve(path);
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
        case "model": {
          const profile = this.models.configuration(scope);
          const prepared = await this.contextWindow.prepare(
            scope,
            op.id,
            op.args.request,
            profile,
            async (request, outputLimit) =>
              (
                await this.models.send(op, signal, outputLimit, {
                  request,
                  purpose: "compaction",
                })
              ).response,
          );
          const outputLimit = await this.compaction.beginModel(
            scope,
            op.id,
            prepared,
            profile,
          );
          try {
            const result = await this.models.send(op, signal, outputLimit, {
              request: prepared,
              purpose: "continuation",
            });
            await this.compaction.finishModel(scope, op.id, result.response);
            const artifact = this.artifacts.create(scope, {
              kind: "model-response",
              content: JSON.stringify(result.response),
              dependencies: [],
              sources: [],
            });
            return { ...result, artifact: artifact.id };
          } finally {
            this.compaction.endModel(scope, op.id);
          }
        }
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
        case "research":
          return this.externalReviews.handle(scope, op.args.url, () =>
            this.gateway.fetch(op, signal),
          );
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
          return this.specialists.execute(
            scope,
            op.args as import("./specialists.js").Delegation,
          );
        case "artifact": {
          switch (op.args.action) {
            case "snapshot":
              return this.snapshots.capture(scope);
            case "get":
              return this.artifacts.get(scope, op.args.id);
            case "page":
              return this.artifacts.page(
                scope,
                op.args.id,
                op.args.hash,
                op.args.offset,
                op.args.bytes,
              );
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
          if (op.args.action === "request")
            return this.compaction.request(scope);
          return op.args.action === "context"
            ? {
                state: this.compaction.authoritative(scope),
                budget: this.compaction.budget(scope),
                session: {
                  id: scope.session,
                  root: scope.root,
                  role: scope.role,
                  model: scope.model,
                  ...this.agentContext(scope),
                },
                assignments: this.specialists.context(scope),
              }
            : op.args.action === "get"
              ? this.compaction.get(scope, op.args.id)
              : this.compaction.accept(scope, op.args.checkpoint);
        case "learn":
          return this.learning.propose(scope, op.args.candidate);
      }
    });
  }
  /** harness.toml for a scope: the repository's own policy if it has one,
   * otherwise an empty override list so it keeps inheriting the global harness. */
  exportToml(repository?: string) {
    if (!repository) return policyToToml(this.policies.active("global").policy);
    this.repositories.verify(repository);
    const effective = this.policies.effective(repository);
    return policyToToml(
      effective.repository?.policy ?? {
        ...effective.global.policy,
        agents: [],
      },
    );
  }
  /** Validate (and optionally publish) a harness.toml. The owner reviews the
   * result first; errors name the offending fields. */
  importToml(
    repository: string | undefined,
    text: string,
    publish: boolean,
    acknowledgeGrants = false,
  ) {
    const scope = repository ?? "global";
    if (repository) this.repositories.verify(repository);
    const candidate = tomlToPolicy(text);
    this.policies.validate(scope, candidate);
    return publish
      ? {
          published: this.policies.publish(scope, candidate, true, {
            acknowledgeGrants,
          }).id,
        }
      : { valid: true };
  }
  private tomlPath(repository?: string) {
    return repository
      ? join(
          this.repositories.verify(repository).path,
          ".agent-harness",
          "harness.toml",
        )
      : join(
          process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
          "agent-harness",
          "harness.toml",
        );
  }
  tomlFile(repository?: string) {
    return readTomlFile(this.tomlPath(repository));
  }
  /** Preview, or write, the published harness as harness.toml in its home:
   * the repository's `.agent-harness/` or the user's config directory. The
   * file mirrors the published policy; it is never read back automatically. */
  writeToml(repository: string | undefined, write: boolean, replace = false) {
    const path = this.tomlPath(repository),
      content = this.exportToml(repository),
      plan = planTomlWrite(path, content);
    if (!write)
      return {
        ...plan,
        replaceable:
          plan.action === "conflict" &&
          plan.reason?.startsWith("A harness.toml you wrote") === true,
      };
    applyTomlWrite(plan, content, replace);
    this.store.audit(
      "toml.written",
      { path, action: plan.action, replaced: plan.action === "conflict" },
      repository ?? "",
    );
    return { ...plan, written: true };
  }
  private modelCache?: { key: string; at: number; value: unknown };
  /** Models from the providers connected in OpenCode, and which of them an
   * enforced session may use (those a runtime certificate lists). Cached for
   * a few minutes; `refresh` asks OpenCode again. */
  async openCodeModels(repository: string | undefined, refresh: boolean) {
    const cwd = repository ? this.targets(repository).cwd : homedir(),
      key = `${cwd}`;
    const fresh =
      this.modelCache &&
      this.modelCache.key === key &&
      Date.now() - this.modelCache.at < 300_000;
    if (!refresh && fresh)
      return {
        ...(this.modelCache!.value as object),
        certified: this.containment.capabilities(),
      };
    const found = await listOpenCodeModels(cwd, refresh);
    if (found.available)
      this.modelCache = { key, at: Date.now(), value: found };
    return { ...found, certified: this.containment.capabilities() };
  }
  private targets(repository?: string) {
    const root = repository
      ? this.repositories.verify(repository).path
      : undefined;
    return {
      cwd: root ?? homedir(),
      openCodeBase: this.openCodeTarget(repository).base,
    };
  }
  /** One preview for everything published from the harness: the readable
   * harness.toml and the native OpenCode agents. Writes nothing. */
  syncPreview(repository: string | undefined, targets: SyncTargets) {
    return {
      toml: targets.toml ? this.writeToml(repository, false) : undefined,
      opencode: targets.opencode
        ? this.openCodeExport(repository, false)
        : undefined,
    };
  }
  /** Write the chosen outputs from the published harness, then check them.
   * A target that cannot be written (for example a file you own) is reported
   * and does not stop the other. */
  async syncWrite(
    repository: string | undefined,
    targets: SyncTargets,
    replaceToml = false,
  ) {
    const attempt = <T>(work: () => T) => {
      try {
        return { ok: true as const, result: work() };
      } catch (error) {
        return { ok: false as const, error: (error as Error).message };
      }
    };
    const toml = targets.toml
      ? attempt(() => this.writeToml(repository, true, replaceToml))
      : undefined;
    const opencode = targets.opencode
      ? attempt(() => this.openCodeExport(repository, true))
      : undefined;
    return {
      toml,
      opencode,
      checks: await this.verifyHarness(repository, false),
    };
  }
  /** Is what the harness published what is actually in force and on disk?
   * `load` also asks the installed OpenCode which agents it resolves. */
  async verifyHarness(repository: string | undefined, load: boolean) {
    const checks: Check[] = [];
    const add = (
      id: string,
      label: string,
      status: Check["status"],
      detail: string,
    ) => checks.push({ id, label, status, detail });
    let policy: Policy;
    try {
      policy = repository
        ? this.policies.effective(repository).policy
        : this.policies.active("global").policy;
    } catch (error) {
      add("policy", "Published policy loads", "fail", (error as Error).message);
      return checks;
    }
    const enabled = policy.agents.filter((a) => a.enabled);
    add(
      "policy",
      "Published policy loads",
      "ok",
      `${enabled.length} of ${policy.agents.length} agents enabled`,
    );
    const issues = mandatoryIssues(policy.agents);
    add(
      "mandatory",
      "Orchestrator, Verifier and Reviewer are enabled",
      Object.keys(issues).length ? "fail" : "ok",
      Object.values(issues).join("; ") || "All three are present",
    );
    if (repository) {
      const grants = this.policies.grantsFor(repository);
      add(
        "grants",
        "Granted to this repository only",
        "ok",
        Object.keys(grants).length
          ? Object.values(grants).join("; ")
          : "Nothing beyond the global defaults",
      );
    }
    const lacking = requiredPolicyTools.filter(
      (t) => !policy.tools.includes(t),
    );
    add(
      "tools-required",
      "Tools every workflow needs are enabled",
      lacking.length ? "fail" : "ok",
      lacking.length
        ? `Enable ${lacking.join(", ")} in Policy → Protected tools, or the Orchestrator, Verifier or Reviewer cannot work`
        : "model, compact, artifact, delegate and review are enabled",
    );
    const unused = [
      policy.tools.includes("execute") &&
        !policy.commands.length &&
        "execute is enabled but no command is approved",
      policy.tools.includes("research") &&
        !policy.domains.length &&
        "research is enabled but no domain is allowed",
      policy.tools.includes("delegate") &&
        (policy.maxDepth === 0 || policy.maxSpecialists === 0) &&
        "delegation is enabled but the depth or agent limit is 0",
    ].filter(Boolean) as string[];
    add(
      "tools-resources",
      "Enabled tools have what they need",
      unused.length ? "warn" : "ok",
      unused.join("; ") ||
        "Every enabled tool has its commands, domains or limits",
    );
    const certified = this.containment.capabilities(),
      uncertified = enabled.filter(
        (a) =>
          a.model &&
          !certified[a.baseRole]?.[a.model.model]?.includes(a.model.reasoning),
      );
    add(
      "models",
      "Agent models can run in enforced sessions",
      uncertified.length ? "warn" : "ok",
      uncertified.length
        ? `${uncertified.map((a) => `${a.name} (${a.model!.model})`).join(", ")} ${uncertified.length === 1 ? "works" : "work"} in native OpenCode, but enforced sessions refuse ${uncertified.length === 1 ? "it" : "them"} until a runtime certificate lists the model`
        : enabled.some((a) => a.model)
          ? "Every agent model is certified"
          : "No agent overrides the role's model",
    );
    // Why a Researcher can or cannot reach outside sources right now.
    const researchers = enabled.filter(
      (a) => a.baseRole === "Researcher" && a.tools.includes("research"),
    );
    const blockers = [
      !researchers.length &&
        "no enabled agent holds the research tool (turn on the Researcher)",
      !policy.tools.includes("research") &&
        "research is off in the policy (turn on Web research)",
      !policy.domains.length &&
        "no domain is allowed, so every address is refused (add domains)",
    ].filter(Boolean) as string[];
    const review = policy.humanReview;
    add(
      "research",
      "Web research is ready",
      blockers.length ? "warn" : "ok",
      blockers.length
        ? `The Researcher cannot fetch anything yet: ${blockers.join("; ")}.`
        : `Allowed: ${policy.domains.join(", ")}. ${
            review.externalContent === "off"
              ? "Fetched text goes straight to the agent (cleaned, untrusted)."
              : review.externalContent === "approve-url"
                ? "Each address waits for your approval under Reviews."
                : "Fetched text waits for your approval under Reviews before the agent sees it."
          } Research runs during the research stage.`,
    );
    // Native OpenCode: the websearch permission is exported, but OpenCode
    // only registers the tool when it is started with a search provider flag.
    if (researchers.length && policy.tools.includes("research"))
      add(
        "opencode-websearch",
        "Web search in your own OpenCode",
        webSearchEnabled() ? "ok" : "warn",
        webSearchEnabled()
          ? "A search provider flag is set, so OpenCode started from this environment offers websearch"
          : "OpenCode offers websearch only with the OpenCode Zen or Go provider or when started as `OPENCODE_ENABLE_EXA=1 opencode` (or OPENCODE_ENABLE_PARALLEL=1). Without it the Researcher can only fetch known pages with webfetch",
      );
    const notes = leastPrivilegeNotes(policy.agents);
    add(
      "least-privilege",
      "Built-in agents follow least privilege",
      notes.length ? "warn" : "ok",
      notes.length
        ? `${notes.join("; ")}. Use "Use recommended tools" on the agent.`
        : "Researcher is web-only and Verifier does not run commands",
    );
    const catalog = this.catalog(repository),
      known = new Set([...catalog.skills, ...catalog.mcps].map((e) => e.name)),
      missing = [
        ...new Set(
          enabled.flatMap((a) =>
            [...a.skills, ...a.mcps].filter((x) => !known.has(x)),
          ),
        ),
      ];
    add(
      "references",
      "Skills and MCP servers exist",
      missing.length ? "warn" : "ok",
      missing.length
        ? `Not found in your configuration: ${missing.join(", ")}`
        : "Every skill and MCP server an agent uses was found",
    );
    // harness.toml
    const tomlPlan = planTomlWrite(
      this.tomlPath(repository),
      this.exportToml(repository),
    );
    const file = readTomlFile(tomlPlan.path);
    let tomlDetail = "";
    let tomlStatus: Check["status"] = "ok";
    if (tomlPlan.action === "unchanged")
      tomlDetail = "Matches the published harness";
    else if (tomlPlan.action === "create") {
      tomlStatus = "warn";
      tomlDetail = "Not written yet (optional)";
    } else {
      tomlStatus = "warn";
      let loads = "";
      try {
        this.policies.validate(
          repository ?? "global",
          tomlToPolicy(file.text ?? ""),
        );
        loads =
          " The file is valid; import it to apply it, or write to overwrite it.";
      } catch (error) {
        tomlStatus = "fail";
        loads = ` The file does not load: ${(error as Error).message.split("\n")[0]}`;
      }
      tomlDetail =
        (tomlPlan.action === "update"
          ? "Out of sync with the published harness."
          : (tomlPlan.reason ?? "Kept.")) + loads;
    }
    add("toml", "harness.toml", tomlStatus, tomlDetail);
    // OpenCode files
    const { base, policy: openCodePolicy } = this.openCodeTarget(repository);
    let plan: ReturnType<typeof planExport> | undefined;
    try {
      plan = planExport(base, openCodePolicy.agents, openCodePolicy);
    } catch (error) {
      add(
        "opencode-files",
        "OpenCode agent files",
        "fail",
        (error as Error).message,
      );
    }
    if (plan) {
      const count = (action: string) =>
        plan!.files.filter((f) => f.action === action).length;
      const behind = count("create") + count("update") + count("remove"),
        kept = count("conflict");
      add(
        "opencode-files",
        "OpenCode agent files",
        behind || kept ? "warn" : "ok",
        behind || kept
          ? [
              count("unchanged") && `${count("unchanged")} in sync`,
              count("create") && `${count("create")} not written`,
              count("update") && `${count("update")} out of date`,
              count("remove") &&
                `${count("remove")} left from a disabled agent`,
              kept && `${kept} kept because you wrote them`,
            ]
              .filter(Boolean)
              .join(", ")
          : `All ${count("unchanged")} agent files match the published harness`,
      );
      if (load) {
        const found = await listOpenCodeAgents(
          repository ? this.targets(repository).cwd : homedir(),
        );
        if (!found.ok)
          add(
            "opencode-load",
            "OpenCode loads the agents",
            found.missing ? "warn" : "fail",
            found.reason,
          );
        else {
          const expected = plan.files.filter((f) => f.action === "unchanged");
          const wrong = expected.filter((f) => {
            const name = f.name.replace(/\.md$/, "");
            const mode = found.agents.get(name);
            return (
              !mode ||
              (name === "harness-orchestrator"
                ? mode !== "primary"
                : mode === "primary")
            );
          });
          add(
            "opencode-load",
            "OpenCode loads the agents",
            wrong.length ? "fail" : expected.length ? "ok" : "warn",
            wrong.length
              ? `OpenCode did not resolve: ${wrong.map((f) => f.name.replace(/\.md$/, "")).join(", ")}`
              : expected.length
                ? `OpenCode resolved all ${expected.length} agents`
                : "No agent files are in sync to check yet",
          );
        }
      }
    }
    return checks;
  }
  /** Skills and MCP servers the owner can allow, from global and repository
   * configuration. Repositories are identified by enrollment, never by path. */
  catalog(repository?: string) {
    const record = repository
      ? this.store.get<{ id: string; path: string }>("repository", repository)
      : undefined;
    check(!repository || record, "repository_not_enrolled");
    return discoverCatalog({ home: homedir(), repositoryPath: record?.path });
  }
  /** Where native OpenCode config lives: the enrolled worktree for a
   * repository, the user's OpenCode config directory for the global harness. */
  private openCodeTarget(repository?: string) {
    if (!repository)
      return {
        base: join(
          process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
          "opencode",
        ),
        policy: this.policies.active("global").policy,
      };
    const record = this.repositories.verify(repository);
    return {
      base: join(record.path, ".opencode"),
      policy: this.policies.effective(repository).policy,
    };
  }
  /** Preview, or write, the native OpenCode agents for the published harness.
   * Owner action only; nothing an agent produces can reach it. */
  openCodeExport(repository: string | undefined, write: boolean) {
    const { base, policy } = this.openCodeTarget(repository);
    const plan = planExport(base, policy.agents, policy);
    if (!write)
      return {
        directory: plan.directory,
        files: plan.files.map(({ content: _c, ...file }) => file),
      };
    const written = applyExport(base, plan);
    this.store.audit(
      "opencode.exported",
      { directory: plan.directory, written },
      repository ?? "",
    );
    return {
      directory: plan.directory,
      files: plan.files.map(({ content: _c, ...file }) => file),
      written,
    };
  }
  /** Owner-written agent instructions and what this session may delegate to.
   * Prompts are governing text; they come only from the owner's policy. */
  private agentContext(scope: Session) {
    const policy = this.policies.effective(scope.repository).policy,
      agent = sessionAgent(policy.agents, scope),
      root = this.identity.session(scope.root);
    return {
      agent: agent && {
        id: agent.id,
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        tools: agent.tools.filter((t) => policy.tools.includes(t)),
        skills: effectiveList(
          agent.skills.filter((x) => policy.allowedSkills.includes(x)),
          policy.deniedSkills,
        ),
        mcps: effectiveList(
          agent.mcps.filter((x) => policy.allowedMcps.includes(x)),
          policy.deniedMcps,
        ),
      },
      route: root.route,
      stage: root.stage,
      awaitingOwner: {
        stageStart: this.workflow
          .startReviews(root.root)
          .filter((g) => g.state === "pending")
          .map((g) => g.stage),
        externalContent: this.externalReviews
          .pending(root.root)
          .map((r) => ({ review: r.id, url: r.url, mode: r.mode })),
      },
      stageFeedback: this.store
        .list<{ state: string; feedback?: string; stage: string }>(
          "stage-attempt",
          root.repository,
          root.root,
        )
        .find((a) => a.stage === root.stage && a.state === "revision_required")
        ?.feedback,
      orchestration: policy.orchestration,
      agents:
        scope.role === "Conductor"
          ? policy.agents
              .filter((a) => a.enabled && a.baseRole !== "Conductor")
              .map((a) => ({
                id: a.id,
                name: a.name,
                baseRole: a.baseRole,
                description: a.description,
              }))
          : undefined,
    };
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
      agentRoles: rolePermissions,
      agentRules: {
        core: coreTools,
        required: requiredTools,
        recommended: recommendedTools,
      },
      stageRoles,
      storageHealth: this.store.fault
        ? { healthy: false, failure: this.store.fault }
        : { healthy: true },
      repositories,
      tasks: taskViews(this.store),
      sessions: this.store.list<Session>("session"),
      runtimes: this.store.list<RuntimeLaunch>("runtime-launch"),
      specialistTasks: this.store
        .list<SpecialistTask>("specialist-task")
        .map((task) => this.specialists.view(task)),
      policies: repositories.map((r) => {
        try {
          return {
            repository: r.id,
            effective: this.policies.effective(r.id),
            // What this repository has been granted beyond the global defaults.
            grants: this.policies.grantsFor(r.id),
          };
        } catch (error) {
          return {
            repository: r.id,
            error: String(error),
            // What the saved repository policy asks for beyond the global one.
            violations: this.policies.violations(r.id),
          };
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
      externalReviews: this.externalReviews.list(),
      stageStarts: this.store.list("stage-start"),
      stages: this.store.list("stage-attempt"),
      contexts: this.store.list("context"),
      candidates: this.store.list("candidate"),
      evaluationSuites: this.evaluations.suites(),
      evaluationJobs: this.store.list("evaluation-job"),
      evaluations: this.store.list("evaluation"),
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
    this.runtimes.close();
    this.evaluations.close();
    this.compaction.close();
    this.store.close();
    closeSync(this.lockHandle);
    unlinkSync(this.lock);
  }
}
