import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { check, sign, type Session } from "../core.js";
import type { Integration, Registration } from "../identity.js";
import type { RuntimeLaunch } from "../runtimes.js";
import type { TaskView } from "../specialists.js";
export interface BridgeTransport {
  request(
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<any>;
}
export class HttpTransport implements BridgeTransport {
  constructor(private origin: string) {
    const url = new URL(origin);
    check(
      url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      "bridge_loopback",
    );
  }
  async request(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    check(path.startsWith("/v1/"), "bridge_api_version");
    const response = await fetch(new URL(path, this.origin), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(
        path === "/v1/operations" || path === "/v1/model" ? 3_610_000 : 10_000,
      ),
    });
    const result = await response.json();
    check(
      response.ok,
      "bridge_request_failed",
      JSON.stringify(result),
      response.status,
    );
    return result;
  }
}
export function loadPairing(
  path: string,
  repositoryRoots: string[],
): Integration {
  const stat = lstatSync(path);
  check(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o077) === 0 &&
      stat.uid === process.getuid?.(),
    "pairing_permissions",
  );
  const canonical = realpathSync(path);
  check(
    !repositoryRoots.some(
      (root) => canonical === root || canonical.startsWith(`${root}/`),
    ),
    "pairing_in_repository",
  );
  const value = JSON.parse(readFileSync(path, "utf8"));
  check(
    value &&
      typeof value.id === "string" &&
      typeof value.secret === "string" &&
      ["opencode", "codex"].includes(value.runtime),
    "pairing_invalid",
  );
  return value;
}
/** Lives in the trusted host process. Never import this into a runtime/plugin or copy its pairing file into a worker. */
export class IntegrationBridge {
  private capability = "";
  private expires = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private session?: Session;
  private stopped = false;
  constructor(
    private credential: Integration,
    private transport: BridgeTransport,
    private binding: Omit<Registration, "nonce" | "integration">,
    private onFailure: (error: unknown) => void = () => {},
  ) {}
  async register() {
    const binding = { ...this.binding, integration: this.credential.id };
    const { nonce } = await this.transport.request(
      "/v1/integrations/challenge",
      binding,
    );
    const registration = { ...binding, nonce };
    let result;
    try {
      result = await this.transport.request("/v1/integrations/register", {
        binding: registration,
        proof: sign(this.credential.secret, registration),
      });
    } catch (error) {
      const time = Date.now();
      const recovered = await this.transport.request(
        "/v1/integrations/status",
        {
          binding: registration,
          time,
          proof: sign(this.credential.secret, {
            action: "registration-status",
            binding: registration,
            time,
          }),
        },
      );
      if (!recovered.registered) throw error;
      result = recovered;
    }
    this.session = result.session;
    this.accept(result);
    return this.session!;
  }
  async registerSpecialist(session: string) {
    const challenge = await this.transport.request(
      "/v1/specialists/challenge",
      {
        integration: this.credential.id,
        session,
        connection: this.binding.connection,
      },
    );
    const { expires: _expires, ...binding } = challenge;
    check(
      binding.runtimeSession === this.binding.runtimeSession &&
        binding.repository === this.binding.repository,
      "specialist_binding",
    );
    let result;
    try {
      result = await this.transport.request("/v1/specialists/register", {
        binding,
        proof: sign(this.credential.secret, {
          action: "specialist-registration",
          binding,
        }),
      });
    } catch (error) {
      const time = Date.now();
      const recovered = await this.transport.request(
        "/v1/integrations/status",
        {
          binding,
          time,
          proof: sign(this.credential.secret, {
            action: "registration-status",
            binding,
            time,
          }),
        },
      );
      if (!recovered.registered) throw error;
      result = recovered;
    }
    this.session = result.session;
    this.accept(result);
    return this.session!;
  }
  private accept(result: { capability: string; expires: number }) {
    this.capability = result.capability;
    this.expires = result.expires;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.renew().catch(() => {}),
      Math.max(0, this.expires - Date.now() - 60_000),
    );
    this.timer.unref();
  }
  private headers() {
    check(
      !this.stopped && this.capability && Date.now() < this.expires,
      "bridge_authority_expired",
    );
    return {
      authorization: `Bearer ${this.capability}`,
      "x-harness-connection": this.binding.connection,
    };
  }
  async renew() {
    try {
      this.accept(
        await this.transport.request(
          "/v1/capabilities/renew",
          {},
          this.headers(),
        ),
      );
    } catch (error) {
      this.stop();
      this.onFailure(error);
      throw error;
    }
  }
  async operation(tool: string, args: unknown, idempotencyKey: string) {
    return this.transport.request(
      "/v1/operations",
      { tool, args, idempotencyKey },
      this.headers(),
    );
  }
  async context() {
    return this.transport.request("/v1/context", {}, this.headers());
  }
  completeTool(
    call: string,
    tool: string,
    args: unknown,
    output: unknown,
  ): Promise<{ output: unknown }> {
    return this.transport.request(
      "/v1/context/tool-result",
      { call, tool, args, output },
      this.headers(),
    );
  }
  claimTool(call: string, tool: string, args: unknown) {
    return this.transport.request(
      "/v1/context/tool-start",
      { call, tool, args },
      this.headers(),
    );
  }
  async model(request: unknown, idempotencyKey: string) {
    return this.transport.request(
      "/v1/model",
      { request, idempotencyKey },
      this.headers(),
    );
  }
  claimTask(
    task: string,
    claim: string,
  ): Promise<{ task: TaskView; session: Session }> {
    return this.transport.request(
      "/v1/specialist-tasks/claim",
      { task, claim },
      this.headers(),
    );
  }
  completeTask(
    task: string,
    claim: string,
    artifact: string,
  ): Promise<TaskView> {
    return this.transport.request(
      "/v1/specialist-tasks/complete",
      { task, claim, artifact },
      this.headers(),
    );
  }
  failTask(task: string, claim: string): Promise<TaskView> {
    return this.transport.request(
      "/v1/specialist-tasks/fail",
      { task, claim },
      this.headers(),
    );
  }
  releaseSpecialist(
    session: string,
  ): Promise<Pick<RuntimeLaunch, "session" | "status">> {
    return this.transport.request(
      "/v1/specialist-tasks/release",
      { session },
      this.headers(),
    );
  }
  abandonTask(task: string): Promise<TaskView> {
    return this.transport.request(
      "/v1/specialist-tasks/abandon",
      { task },
      this.headers(),
    );
  }
  prepareRuntime(certificate: string, goal?: string): Promise<RuntimeLaunch> {
    return this.transport.request(
      "/v1/runtime/prepare",
      { certificate, goal },
      this.headers(),
    );
  }
  attachRuntime(container: string): Promise<RuntimeLaunch> {
    return this.transport.request(
      "/v1/runtime/attach",
      { container },
      this.headers(),
    );
  }
  async stopRuntime(): Promise<Pick<RuntimeLaunch, "session" | "status">> {
    try {
      return await this.transport.request(
        "/v1/runtime/stop",
        {},
        this.headers(),
      );
    } finally {
      this.stop();
    }
  }
  stop() {
    this.stopped = true;
    this.capability = "";
    clearTimeout(this.timer);
  }
}
export interface RuntimeRequest {
  session: string;
  tool: string;
  args: unknown;
  call: string;
}
export interface RuntimeRelay {
  execute(request: RuntimeRequest): Promise<unknown>;
  context(session: string): Promise<unknown>;
  model?(session: string, request: unknown, call: string): Promise<unknown>;
}
/** A relay transports only scoped operation requests. There is deliberately no pairing, policy, role, or approval RPC. */
export function boundRelay(
  bridge: IntegrationBridge,
  runtimeSession: string,
): RuntimeRelay {
  return {
    model(session, request, call) {
      check(session === runtimeSession, "runtime_session_spoof");
      return bridge.model(request, call);
    },
    execute(request) {
      check(request.session === runtimeSession, "runtime_session_spoof");
      check(/^[a-z_]+$/.test(request.tool), "runtime_tool");
      return bridge.operation(request.tool, request.args, request.call);
    },
    context(session) {
      check(session === runtimeSession, "runtime_session_spoof");
      return bridge.context();
    },
  };
}
