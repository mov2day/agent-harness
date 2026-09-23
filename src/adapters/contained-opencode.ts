import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { check, id } from "../core.js";
import { validateContainer, type ContainerInspection } from "../containment.js";
import type { RuntimeRelay } from "./bridge.js";
import { dockerRuntimeControl } from "../runtimes.js";

const exec = promisify(execFile);
const messageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("ready"),
      session: z.string().min(1).max(256),
      runtime: z.literal("opencode"),
      version: z.literal("1.18.31"),
    })
    .strict(),
  z
    .object({
      type: z.literal("request"),
      id: z.string().uuid(),
      method: z.enum(["execute", "context", "model"]),
      params: z.unknown(),
    })
    .strict(),
  z
    .object({ type: z.literal("result"), id: z.string(), result: z.unknown() })
    .strict(),
]);
const executeSchema = z
  .object({
    session: z.string(),
    tool: z.string(),
    args: z.unknown(),
    call: z.string().min(1).max(256),
  })
  .strict();
const contextSchema = z.object({ session: z.string() }).strict();
const modelSchema = z
  .object({
    session: z.string(),
    request: z.unknown(),
    call: z.string().min(1).max(256),
  })
  .strict();
export interface ContainedOpenCodeOptions {
  image: string;
  name?: string;
  runtimeSession: string;
  connection: string;
  model: { model: string; reasoning: string };
  relay: (rawSession: string) => RuntimeRelay;
  attached: (container: string) => Promise<void>;
  onFailure?: (error: unknown) => void;
}
/** Trusted host transport. Its stdin pipe is the only container-to-engine route;
 * no owner credential, integration credential or capability enters the image. */
export class ContainedOpenCode {
  private child?: ChildProcessWithoutNullStreams;
  private container?: string;
  private relay?: RuntimeRelay;
  private buffer = Buffer.alloc(0);
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private requests = new Set<string>();
  private stopping?: Promise<void>;
  private quiescing = false;
  private failure?: unknown;
  private attached = false;
  private ready?: {
    resolve: (session: string) => void;
    reject: (error: unknown) => void;
  };
  private stderr = "";
  constructor(readonly options: ContainedOpenCodeOptions) {
    check(/^sha256:[a-f0-9]{64}$/.test(options.image), "runtime_image_digest");
    check(
      /^[a-zA-Z0-9_:-]{1,256}$/.test(options.runtimeSession) &&
        /^[a-zA-Z0-9_-]{1,256}$/.test(options.connection),
      "runtime_binding",
    );
    check(
      !options.name ||
        /^agent-harness-runtime-[a-f0-9-]{36}$/.test(options.name),
      "runtime_name",
    );
  }
  private expected() {
    return {
      container: this.container!,
      image: this.options.image,
      session: this.options.runtimeSession,
      connection: this.options.connection,
    };
  }
  async inspection() {
    check(this.container, "runtime_not_started");
    const { stdout } = await exec(
      "docker",
      ["inspect", "--type", "container", this.container],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    const inspections = JSON.parse(stdout) as ContainerInspection[];
    check(inspections.length === 1, "container_inspection");
    return inspections[0]!;
  }
  async start() {
    check(!this.container && !this.stopping, "runtime_already_started");
    const { stdout } = await exec(
      "docker",
      [
        "create",
        ...(this.options.name ? ["--name", this.options.name] : []),
        "--interactive",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "1000:1000",
        "--pids-limit",
        "128",
        "--memory",
        "768m",
        "--cpus",
        "1",
        "--ipc",
        "private",
        "--tmpfs",
        "/home/node:rw,nosuid,nodev,uid=1000,gid=1000,size=128m",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,uid=1000,gid=1000,size=128m",
        "--tmpfs",
        "/workspace:rw,nosuid,nodev,noexec,uid=1000,gid=1000,size=32m",
        "--label",
        `agent-harness.session=${this.options.runtimeSession}`,
        "--label",
        `agent-harness.connection=${this.options.connection}`,
        this.options.image,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    this.container = stdout.trim();
    check(/^[a-f0-9]{64}$/.test(this.container), "container_id");
    try {
      const ready = new Promise<string>((resolve, reject) => {
        this.ready = { resolve, reject };
      });
      // Observe rejection immediately even when startup fails before awaiting it.
      void ready.catch(() => {});
      this.child = spawn(
        "docker",
        ["start", "--attach", "--interactive", this.container],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
      this.child.stderr.on("data", (chunk: Buffer) => {
        this.stderr = (this.stderr + chunk.toString("utf8")).slice(-32_768);
      });
      this.child.once("error", (error) => this.fail(error));
      this.child.stdin.on("error", (error) => this.fail(error));
      this.child.once("exit", (code) => {
        if (!this.stopping && !this.quiescing)
          this.fail(new Error(`runtime_stopped:${code}\n${this.stderr}`));
      });
      const timeout = setTimeout(
        () => this.fail(new Error(`runtime_startup_timeout\n${this.stderr}`)),
        45_000,
      );
      try {
        this.send({ type: "init", model: this.options.model });
        const rawSession = await ready;
        validateContainer(await this.inspection(), this.expected());
        await this.options.attached(this.container);
        this.attached = true;
        return { container: this.container, session: rawSession };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  private send(value: unknown) {
    check(
      this.child && !this.failure && !this.stopping && !this.quiescing,
      "runtime_unavailable",
    );
    const line = JSON.stringify(value);
    check(Buffer.byteLength(line) <= 2_500_000, "runtime_message_limit");
    this.child.stdin.write(line + "\n");
  }
  private receive(chunk: Buffer) {
    if (this.quiescing) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end: number;
    try {
      while ((end = this.buffer.indexOf(10)) >= 0) {
        check(end <= 2_500_000, "runtime_message_limit");
        const line = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end + 1);
        const value = messageSchema.parse(JSON.parse(line.toString("utf8")));
        if (value.type === "ready") {
          check(!this.relay && this.ready, "runtime_session_rebound");
          this.relay = this.options.relay(value.session);
          this.ready.resolve(value.session);
          this.ready = undefined;
        } else if (value.type === "result") {
          const pending = this.pending.get(value.id);
          check(pending, "runtime_result_identity");
          clearTimeout(pending.timer);
          this.pending.delete(value.id);
          pending.resolve(value.result);
        } else {
          check(
            this.relay &&
              this.attached &&
              !this.requests.has(value.id) &&
              this.requests.size < 16,
            "runtime_request_denied",
          );
          this.requests.add(value.id);
          void this.dispatch(value)
            .catch((error) => this.fail(error))
            .finally(() => this.requests.delete(value.id));
        }
      }
      check(this.buffer.length <= 2_500_000, "runtime_message_limit");
    } catch (error) {
      this.fail(error);
    }
  }
  private async dispatch(value: {
    id: string;
    method: string;
    params?: unknown;
  }) {
    let result: unknown, error: string | undefined;
    try {
      if (value.method === "execute") {
        const request = executeSchema.parse(value.params);
        result = await this.relay!.execute({ ...request, args: request.args });
      } else if (value.method === "context")
        result = await this.relay!.context(
          contextSchema.parse(value.params).session,
        );
      else {
        const request = modelSchema.parse(value.params);
        check(this.relay!.model, "runtime_model_unavailable");
        result = await this.relay!.model(
          request.session,
          request.request,
          request.call,
        );
      }
    } catch (reason) {
      error =
        reason instanceof Error ? reason.message : "engine_request_failed";
    }
    if (!this.stopping && !this.failure)
      this.send({ type: "response", id: value.id, result, error });
  }
  prompt(text: string) {
    check(this.attached && !this.pending.size, "runtime_prompt_unavailable");
    check(text.length > 0 && text.length <= 64_000, "runtime_prompt_limit");
    const call = id();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error("runtime_turn_timeout")),
        3_600_000,
      );
      this.pending.set(call, { resolve, reject, timer });
      try {
        this.send({ type: "prompt", id: call, text });
      } catch (error) {
        this.fail(error);
      }
    });
  }
  private fail(error: unknown) {
    if (this.failure || this.stopping || this.quiescing) return;
    this.failure = error;
    this.ready?.reject(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.options.onFailure?.(error);
    void this.stop().catch(() => {});
  }
  stop(): Promise<void> {
    this.quiesce();
    return (this.stopping ??= this.cleanup());
  }
  quiesce() {
    this.quiescing = true;
    this.ready?.reject(new Error("runtime_stopped"));
    this.ready = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("runtime_stopped"));
    }
    this.pending.clear();
  }
  private async cleanup() {
    const reference = this.container ?? this.options.name;
    if (!reference) return;
    const actual = await dockerRuntimeControl.inspect(reference);
    if (!actual) return;
    check(
      (!this.container || actual.Id === this.container) &&
        actual.Image === this.options.image &&
        actual.Config.Labels["agent-harness.session"] ===
          this.options.runtimeSession &&
        actual.Config.Labels["agent-harness.connection"] ===
          this.options.connection,
      "runtime_cleanup_identity",
    );
    await exec("docker", ["rm", "--force", actual.Id], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    this.child?.stdin.destroy();
  }
}
