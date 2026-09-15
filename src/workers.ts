import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { check, hash, id, secret } from "./core.js";
import type { Operation, Operations } from "./operations.js";
import type { Snapshots } from "./snapshots.js";
const exec = promisify(execFile);
export interface WorkerResult {
  exitCode: number;
  output: string;
  truncated: boolean;
  container: string;
  snapshot: string;
}
export interface WorkerInspection {
  State: { Running: boolean };
  Config: { Labels: Record<string, string> };
  Image: string;
}
export interface WorkerTransport {
  command(args: string[]): Promise<string>;
  start(args: string[]): ReturnType<typeof spawn>;
}
const docker: WorkerTransport = {
  async command(args) {
    return (
      await exec("docker", args, { timeout: 10_000, maxBuffer: 1024 * 1024 })
    ).stdout;
  },
  start(args) {
    return spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
      },
    });
  },
};
/** Each command receives a fresh private tmpfs snapshot; the protected repository is never mounted. */
export class CommandWorkers {
  private cancellations = new Map<string, Promise<boolean>>();
  constructor(
    private operations: Operations,
    private image: string,
    private snapshots: Snapshots,
    private transport: WorkerTransport = docker,
  ) {
    check(/^sha256:[a-f0-9]{64}$/.test(image), "worker_image_digest");
  }
  private async cancel(op: Operation): Promise<boolean> {
    const name = op.worker?.container;
    if (!name) return true;
    const pending = this.cancellations.get(name);
    if (pending) return pending;
    const result = this.remove(op).finally(() =>
      this.cancellations.delete(name),
    );
    this.cancellations.set(name, result);
    return result;
  }
  private async remove(op: Operation): Promise<boolean> {
    const name = op.worker!.container;
    try {
      const found = JSON.parse(
        await this.transport.command(["inspect", "--type", "container", name]),
      ) as WorkerInspection[];
      check(
        found.length === 1 &&
          found[0]?.Config.Labels["agent-harness.operation"] === op.id &&
          found[0]?.Config.Labels["agent-harness.repository"] ===
            op.repository &&
          found[0]?.Image === op.worker?.image,
        "worker_identity",
      );
      if (found[0]!.State.Running) await this.transport.command(["kill", name]);
      await this.transport.command(["rm", name]);
      return true;
    } catch (error) {
      if (/No such (object|container)/i.test(String(error))) return true;
      this.operations.store.audit(
        "worker.cancellation_failed",
        { operation: op.id, container: name, error: String(error) },
        op.repository,
        op.session,
      );
      return false;
    }
  }
  async recover() {
    for (const op of this.operations.store.list<Operation>("operation")) {
      if (
        !op.worker ||
        !op.invalidated ||
        op.status !== "requires_reconciliation"
      )
        continue;
      const cancelled = await this.cancel(op);
      this.operations.store.audit(
        "worker.recovery",
        { operation: op.id, container: op.worker.container, cancelled },
        op.repository,
        op.session,
      );
    }
  }
  async execute(op: Operation, signal: AbortSignal): Promise<WorkerResult> {
    this.operations.validate(op);
    const scope = this.operations.identity.session(op.session);
    this.snapshots.assertCurrent(scope, op.args.snapshot);
    const archive = this.snapshots.archive(scope, op.args.snapshot),
      name = `harness-worker-${id()}`,
      nonce = secret();
    for (const key of Object.keys(op.args.env))
      check(
        /^[A-Z_][A-Z0-9_]*$/.test(key) &&
          ![
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
            "DYLD_INSERT_LIBRARIES",
            "DOCKER_HOST",
            "SSH_AUTH_SOCK",
            "NODE_OPTIONS",
            "BASH_ENV",
            "ENV",
          ].includes(key),
        "worker_environment",
      );
    this.operations.store.transaction(() => {
      op = this.operations.validate(op);
      op.worker = {
        container: name,
        image: this.image,
        snapshot: op.args.snapshot,
        admitted: false,
      };
      this.operations.save(op);
      this.operations.store.audit(
        "worker.intent",
        {
          operation: op.id,
          container: name,
          image: this.image,
          snapshot: op.args.snapshot,
        },
        op.repository,
        op.session,
      );
    });
    let cancelled = false;
    const cancel = async () => {
      cancelled = true;
      return this.cancel(this.operations.current(op));
    };
    this.operations.onCancel(op, cancel);
    const create = [
      "create",
      "--interactive",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "64",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--user",
      "1000:1000",
      "--ipc",
      "private",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000",
      "--tmpfs",
      "/workspace:rw,nosuid,nodev,size=64m,uid=1000,gid=1000",
      "--label",
      `agent-harness.operation=${op.id}`,
      "--label",
      `agent-harness.repository=${op.repository}`,
      "--entrypoint",
      "/usr/local/bin/python3",
      this.image,
      "-I",
      "/opt/agent-harness/runner.py",
    ];
    try {
      await this.transport.command(create);
      signal.throwIfAborted();
      this.operations.validate(op);
      const child = this.transport.start([
        "start",
        "--attach",
        "--interactive",
        name,
      ]);
      check(child.stdin && child.stdout && child.stderr, "worker_transport");
      const header = {
        size: archive.length,
        hash: hash(archive),
        nonce,
        executable: op.args.executable,
        args: op.args.args,
        env: op.args.env,
        cwd: op.args.cwd,
      };
      let output = Buffer.alloc(0),
        truncated = false,
        admitted = false,
        protocol = Buffer.alloc(0),
        protocolError: unknown;
      const append = (data: Buffer) => {
        const room = 256 * 1024 - output.length;
        if (data.length > room) truncated = true;
        if (room > 0) output = Buffer.concat([output, data.subarray(0, room)]);
      };
      const abort = () => {
        void cancel();
      };
      signal.addEventListener("abort", abort, { once: true });
      const result = await new Promise<WorkerResult>((resolve, reject) => {
        child.on("error", reject);
        child.stdin!.on("error", reject);
        child.stderr!.on("data", append);
        child.stdout!.on("data", (data: Buffer) => {
          if (admitted) {
            append(data);
            return;
          }
          protocol = Buffer.concat([protocol, data]);
          if (protocol.length > 256) {
            protocolError = new Error("worker_handshake_limit");
            void cancel();
            return;
          }
          const newline = protocol.indexOf(10);
          if (newline < 0) return;
          try {
            check(
              protocol.subarray(0, newline).toString("utf8") ===
                `HARNESS_READY ${nonce}`,
              "worker_handshake",
            );
            signal.throwIfAborted();
            this.snapshots.assertCurrent(scope, op.args.snapshot);
            this.operations.commit(op, () => {
              const current = this.operations.current(op);
              current.worker!.admitted = true;
              this.operations.store.transaction(() =>
                this.operations.save(current),
              );
              child.stdin!.end(`ADMIT ${nonce}\n`);
            });
            admitted = true;
            append(protocol.subarray(newline + 1));
          } catch (error) {
            protocolError = error;
            void cancel();
          }
        });
        child.on("close", (code) => {
          signal.removeEventListener("abort", abort);
          if (protocolError) reject(protocolError);
          else if (cancelled || signal.aborted)
            reject(new Error("worker_cancelled"));
          else if (!admitted) reject(new Error("worker_not_admitted"));
          else
            resolve({
              exitCode: code ?? -1,
              output: output.toString("utf8"),
              truncated,
              container: name,
              snapshot: op.args.snapshot,
            });
        });
        child.stdin!.write(JSON.stringify(header) + "\n");
        child.stdin!.write(archive);
        if (signal.aborted) abort();
      });
      return result;
    } finally {
      // Removal follows the observed exit or cancellation, never retries the command.
      check(
        await this.cancel(this.operations.current(op)),
        "worker_cleanup_failed",
      );
    }
  }
}
