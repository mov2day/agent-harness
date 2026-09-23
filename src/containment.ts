import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { check, digest, roles, type Session } from "./core.js";
import {
  Policies,
  modelCapabilitiesSchema,
  type ModelCapabilities,
} from "./policy.js";
import type { Store } from "./store.js";
export const runtimeScenarios = [
  "identity",
  "interception",
  "overrides",
  "plugins",
  "aliases",
  "delegation",
  "network",
  "filesystem",
  "host-control",
  "lifecycle",
  "compaction",
] as const;
export interface RuntimeCertificate {
  id: string;
  runtime: "opencode" | "codex";
  version: string;
  models: ModelCapabilities;
  platform: "linux" | "darwin";
  image: string;
  sourceHash: string;
  author: string;
  reviewer: string;
  scenarios: Record<
    (typeof runtimeScenarios)[number],
    { passed: boolean; evidence: string }
  >;
  approved: boolean;
  expires: number;
}
export interface ContainerInspection {
  Id: string;
  Name?: string;
  Image: string;
  State: { Running: boolean };
  Config: { User: string; Env: string[]; Labels: Record<string, string> };
  HostConfig: {
    NetworkMode: string;
    Privileged: boolean;
    ReadonlyRootfs: boolean;
    CapDrop: string[];
    CapAdd: string[] | null;
    SecurityOpt: string[];
    PidMode: string;
    IpcMode: string;
    Devices: unknown[] | null;
    DeviceRequests: unknown[] | null;
    Binds: string[] | null;
    VolumesFrom: string[] | null;
    PidsLimit: number;
    Memory: number;
    PortBindings: Record<string, unknown> | null;
  };
  Mounts: unknown[];
}
export function validateContainer(
  c: ContainerInspection,
  expected: {
    container: string;
    image: string;
    session: string;
    connection: string;
  },
) {
  check(
    c.Id === expected.container &&
      c.Image === expected.image &&
      c.State.Running,
    "container_identity",
  );
  const h = c.HostConfig;
  check(
    h.NetworkMode === "none" && !h.Privileged && h.ReadonlyRootfs,
    "container_isolation",
  );
  check(
    h.CapDrop?.includes("ALL") &&
      !h.CapAdd?.length &&
      h.SecurityOpt?.includes("no-new-privileges"),
    "container_privilege",
  );
  check(
    !["host", "container"].some(
      (x) => h.PidMode.startsWith(x) || h.IpcMode.startsWith(x),
    ),
    "container_namespace",
  );
  check(
    !h.Devices?.length &&
      !h.DeviceRequests?.length &&
      !h.Binds?.length &&
      !h.VolumesFrom?.length &&
      !c.Mounts.length &&
      !Object.keys(h.PortBindings ?? {}).length,
    "container_host_access",
  );
  check(
    h.PidsLimit > 0 &&
      h.PidsLimit <= 256 &&
      h.Memory > 0 &&
      h.Memory <= 4 * 1024 ** 3,
    "container_limits",
  );
  check(
    /^\d+:\d+$/.test(c.Config.User) && !c.Config.User.startsWith("0:"),
    "container_user",
  );
  check(
    c.Config.Labels["agent-harness.session"] === expected.session &&
      c.Config.Labels["agent-harness.connection"] === expected.connection,
    "container_binding",
  );
  check(
    !c.Config.Env.some((e) =>
      /^(DOCKER_HOST|CONTAINER_HOST|HARNESS_.*(?:TOKEN|CREDENTIAL|SECRET)|AWS_|SSH_AUTH_SOCK|OPENAI_API_KEY|ANTHROPIC_API_KEY)/.test(
        e,
      ),
    ),
    "container_credentials",
  );
}
export const inspectContainer = (container: string): ContainerInspection => {
  check(/^[a-f0-9]{64}$/.test(container), "container_id");
  const results = JSON.parse(
    execFileSync("docker", ["inspect", "--type", "container", container], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }),
  );
  check(Array.isArray(results) && results.length === 1, "container_inspection");
  return results[0];
};
const exec = promisify(execFile);
export const inspectContainers = async (
  containers: string[],
): Promise<ContainerInspection[]> => {
  check(
    containers.length > 0 && containers.every((c) => /^[a-f0-9]{64}$/.test(c)),
    "container_id",
  );
  const { stdout } = await exec(
    "docker",
    ["inspect", "--type", "container", ...containers],
    { timeout: 1000, maxBuffer: 8 * 1024 * 1024 },
  );
  const results = JSON.parse(stdout);
  check(
    Array.isArray(results) && results.length === containers.length,
    "container_inspection",
  );
  return results;
};
export const HEALTH_MAX_AGE_MS = 1000;
export interface RuntimeBinding {
  session: string;
  connection: string;
  container: string;
  certificate: string;
  image: string;
  checked: number;
  healthy: boolean;
}
export class Containment {
  private onFailure: (session: string) => void = () => {};
  private refreshing = false;
  private closed = false;
  constructor(
    readonly store: Store,
    private sourceHash: string,
    private inspect = inspectContainer,
  ) {}
  setInvalidator(fn: (session: string) => void) {
    this.onFailure = fn;
  }
  close() {
    this.closed = true;
  }
  private fail(session: Session, binding: RuntimeBinding, error: unknown) {
    if (!binding.healthy) return;
    binding.healthy = false;
    this.store.transaction(() => {
      this.store.put(
        "runtime-binding",
        session.session,
        binding,
        session.repository,
        session.session,
      );
      this.store.audit(
        "runtime.health_failed",
        { reason: String(error) },
        session.repository,
        session.session,
      );
      this.onFailure(session.session);
    });
  }
  async refresh(inspect = inspectContainers) {
    if (this.refreshing || this.closed) return;
    const sessions = this.store
      .list<Session>("session")
      .filter((s) => s.status === "active" && s.enforcement === "enforced");
    const active = sessions.flatMap((session) => {
      const binding = this.store.get<RuntimeBinding>(
        "runtime-binding",
        session.session,
      );
      return binding?.healthy ? [{ session, binding }] : [];
    });
    if (!active.length) return;
    this.refreshing = true;
    const started = this.store.clock.now();
    try {
      const containers = [...new Set(active.map((a) => a.binding.container))];
      const results = await inspect(containers);
      if (this.closed) return;
      for (const { session, binding } of active) {
        const current = this.store.get<RuntimeBinding>(
          "runtime-binding",
          session.session,
        );
        if (
          !current?.healthy ||
          current.container !== binding.container ||
          current.connection !== binding.connection
        )
          continue;
        try {
          check(
            this.store.clock.now() - started < HEALTH_MAX_AGE_MS,
            "runtime_health_stale",
          );
          const inspection = results.find((c) => c.Id === binding.container);
          check(inspection, "container_inspection");
          validateContainer(inspection, {
            container: binding.container,
            image: binding.image,
            session: session.runtimeSession,
            connection: binding.connection,
          });
          current.checked = started;
          this.store.put(
            "runtime-binding",
            session.session,
            current,
            session.repository,
            session.session,
          );
        } catch (error) {
          this.fail(session, current, error);
        }
      }
    } catch (error) {
      if (!this.closed)
        for (const { session, binding } of active)
          this.fail(session, binding, error);
    } finally {
      this.refreshing = false;
    }
  }
  certificate(c: RuntimeCertificate) {
    check(
      modelCapabilitiesSchema.safeParse(c.models).success,
      "runtime_model_capabilities",
    );
    check(
      c.approved && c.author !== c.reviewer && c.reviewer.length > 0,
      "independent_runtime_review",
    );
    check(
      c.sourceHash === this.sourceHash &&
        c.expires > this.store.clock.now() &&
        /^sha256:[a-f0-9]{64}$/.test(c.image),
      "stale_runtime_certificate",
    );
    for (const scenario of runtimeScenarios)
      check(
        c.scenarios[scenario]?.passed &&
          /^[a-f0-9]{64}$/.test(c.scenarios[scenario].evidence),
        "runtime_evidence",
        `Missing ${scenario} evidence`,
      );
    check(c.id === digest({ ...c, id: undefined }), "certificate_hash");
    return c;
  }
  capabilities(session?: Session): ModelCapabilities {
    let certificates = this.store
      .list<RuntimeCertificate>("runtime-certificate")
      .filter((c) => {
        try {
          return c.platform === process.platform && !!this.certificate(c);
        } catch {
          return false;
        }
      });
    if (session) {
      const binding = this.store.get<RuntimeBinding>(
        "runtime-binding",
        session.session,
      );
      certificates = certificates.filter((c) => c.id === binding?.certificate);
    }
    const first = certificates[0];
    if (!first) return {};
    const result: ModelCapabilities = {};
    for (const role of roles) {
      for (const [model, levels] of Object.entries(first.models[role] ?? {})) {
        const shared = levels.filter((level) =>
          certificates.every((c) => c.models[role]?.[model]?.includes(level)),
        );
        if (shared.length) (result[role] ??= {})[model] = shared;
      }
    }
    return result;
  }
  // Only the authenticated owner control plane installs certificates. Runtime callers cannot self-attest.
  install(c: RuntimeCertificate) {
    this.certificate(c);
    this.store.transaction(() => {
      this.store.put("runtime-certificate", c.id, c);
      this.store.audit("runtime.certificate_installed", {
        id: c.id,
        reviewer: c.reviewer,
      });
    });
  }
  forSession(session: Session, certificate: string) {
    const c = this.store.get<RuntimeCertificate>(
      "runtime-certificate",
      certificate,
    );
    check(c, "runtime_uncertified");
    this.certificate(c);
    check(c.platform === process.platform, "runtime_platform");
    const integration = this.store.get<{ runtime: string }>(
      "integration",
      session.integration,
    );
    check(integration?.runtime === c.runtime, "runtime_identity");
    const policies = new Policies(this.store),
      effective = policies.effective(session.repository);
    policies.validateModels(effective.policy, c.models);
    if (session.model)
      check(
        c.models[session.role]?.[session.model.model]?.includes(
          session.model.reasoning,
        ),
        "unsupported_model",
      );
    return c;
  }
  attach(session: Session, container: string, certificate: string) {
    check(session.status === "active", "session_inactive");
    const c = this.forSession(session, certificate);
    const previous = this.store.get<RuntimeBinding>(
      "runtime-binding",
      session.session,
    );
    check(
      !previous ||
        (previous.container === container &&
          previous.certificate === certificate &&
          previous.connection === session.connection &&
          previous.healthy),
      "runtime_already_bound",
    );
    validateContainer(this.inspect(container), {
      container,
      image: c.image,
      session: session.runtimeSession,
      connection: session.connection,
    });
    const binding: RuntimeBinding = {
      session: session.session,
      connection: session.connection,
      container,
      certificate,
      image: c.image,
      checked: this.store.clock.now(),
      healthy: true,
    };
    this.store.transaction(() => {
      this.store.put(
        "runtime-binding",
        session.session,
        binding,
        session.repository,
        session.session,
      );
      session.enforcement = "enforced";
      this.store.put(
        "session",
        session.session,
        session,
        session.repository,
        session.session,
      );
      this.store.audit(
        "runtime.attached",
        { container, certificate },
        session.repository,
        session.session,
      );
    });
    return binding;
  }
  healthy(session: Session): boolean {
    if (session.enforcement !== "enforced") return false;
    const b = this.store.get<RuntimeBinding>(
      "runtime-binding",
      session.session,
    );
    if (!b || !b.healthy || b.connection !== session.connection) return false;
    try {
      const c = this.store.get<RuntimeCertificate>(
        "runtime-certificate",
        b.certificate,
      );
      check(c, "runtime_uncertified");
      this.certificate(c);
      check(
        this.store.clock.now() - b.checked < HEALTH_MAX_AGE_MS,
        "runtime_health_stale",
      );
      return true;
    } catch (error) {
      this.fail(session, b, error);
      return false;
    }
  }
}
