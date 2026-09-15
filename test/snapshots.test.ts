import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { id, hash } from "../src/core.js";
import { Snapshots, snapshotTar } from "../src/snapshots.js";
import { NativeFiles } from "../src/files.js";
import { Artifacts } from "../src/workflow.js";
import { Operations, type Operation } from "../src/operations.js";
import { CommandWorkers, type WorkerTransport } from "../src/workers.js";
import { defaultPolicy } from "../src/policy.js";
import { fixture } from "./helpers.js";
function setup() {
  const f = fixture();
  f.policies.publish(
    "global",
    {
      ...defaultPolicy,
      tools: [...defaultPolicy.tools, "execute"],
      commands: [
        { executable: "/bin/echo", args: ["ok"], env: {}, cwd: "src" },
      ],
    },
    true,
  );
  const scope = f.register().session;
  scope.role = "Verifier";
  scope.stage = "execution";
  scope.enforcement = "enforced";
  f.identity.saveSession(scope);
  const token = f.identity.issue(scope).capability,
    operations = new Operations(f.store, f.identity, f.policies, () => true),
    files = new NativeFiles(),
    artifacts = new Artifacts(f.store, f.identity),
    snapshots = new Snapshots(
      f.store,
      f.identity,
      f.policies,
      files,
      artifacts,
    );
  mkdirSync(join(f.repo.path, "src"));
  writeFileSync(join(f.repo.path, "src/file"), "approved source");
  const execution = () => {
    const snapshot = snapshots.capture(scope),
      args = {
        executable: "/bin/echo",
        args: ["ok"],
        env: {},
        cwd: "src",
        snapshot: snapshot.id,
      },
      approval = id();
    f.store.put(
      "action-approval",
      approval,
      {
        id: approval,
        repository: f.repo.id,
        session: scope.root,
        action: operations.actionHash("execute", args),
        policy: scope.policy,
        human: true,
        valid: true,
        dependencies: [snapshot.id],
      },
      f.repo.id,
      scope.root,
    );
    return {
      snapshot,
      operation: operations.begin(token, scope.connection, {
        tool: "execute",
        args: { ...args, approval },
        idempotencyKey: id(),
      }),
    };
  };
  return {
    ...f,
    scope,
    token,
    operations,
    files,
    artifacts,
    snapshots,
    execution,
  };
}
class FakeDocker implements WorkerTransport {
  calls: string[][] = [];
  created?: {
    name: string;
    operation: string;
    repository: string;
    image: string;
  };
  admissions = 0;
  beforeReady?: () => void;
  loseCreateResponse = false;
  failCleanup = false;
  async command(args: string[]) {
    this.calls.push(args);
    if (args[0] === "create") {
      this.created = {
        name: args[args.indexOf("--name") + 1]!,
        operation: args
          .find((a) => a.startsWith("agent-harness.operation="))!
          .split("=")[1]!,
        repository: args
          .find((a) => a.startsWith("agent-harness.repository="))!
          .split("=")[1]!,
        image: args.find((a) => a.startsWith("sha256:"))!,
      };
      if (this.loseCreateResponse)
        throw new Error("connection lost after create");
      return "c".repeat(64);
    }
    if (args[0] === "inspect") {
      if (!this.created) throw new Error("No such container");
      return JSON.stringify([
        {
          Image: this.created.image,
          State: { Running: false },
          Config: {
            Labels: {
              "agent-harness.operation": this.created.operation,
              "agent-harness.repository": this.created.repository,
            },
          },
        },
      ]);
    }
    if (args[0] === "rm") {
      if (this.failCleanup)
        throw new Error("daemon unavailable during removal");
      this.created = undefined;
    }
    return "";
  }
  start(args: string[]) {
    this.calls.push(args);
    const child = new EventEmitter() as ChildProcess;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let data = Buffer.alloc(0),
      header: any,
      ready = false;
    child.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        data = Buffer.concat([data, Buffer.from(chunk)]);
        if (!header) {
          const at = data.indexOf(10);
          if (at >= 0) {
            header = JSON.parse(data.subarray(0, at).toString());
            data = data.subarray(at + 1);
          }
        }
        if (header && !ready && data.length >= header.size) {
          assert.equal(hash(data.subarray(0, header.size)), header.hash);
          data = data.subarray(header.size);
          ready = true;
          queueMicrotask(() => {
            this.beforeReady?.();
            child.stdout!.emit(
              "data",
              Buffer.from(`HARNESS_READY ${header.nonce}\n`),
            );
          });
        } else if (ready && data.includes(10)) {
          assert.equal(data.toString(), `ADMIT ${header.nonce}\n`);
          this.admissions++;
          queueMicrotask(() => {
            child.stdout!.emit("data", Buffer.from("ok\n"));
            child.emit("close", 0);
          });
        }
        done();
      },
    });
    return child;
  }
}
test("snapshots: immutable, repository-scoped content, private paths and changed inputs", () => {
  const f = setup();
  try {
    writeFileSync(join(f.repo.path, ".env"), "private credential");
    const snapshot = f.snapshots.capture(f.scope),
      manifest = f.snapshots.get(f.scope, snapshot.id).manifest;
    assert.deepEqual(
      manifest.files.map((f) => f.path),
      ["src/file"],
    );
    const tar = f.snapshots.archive(f.scope, snapshot.id);
    assert.ok(tar.includes(Buffer.from("approved source")));
    assert.equal(tar.includes(Buffer.from("private credential")), false);
    assert.throws(
      () =>
        f.snapshots.archive(
          { ...f.scope, repository: f.other.id },
          snapshot.id,
        ),
      /Artifact not found/,
    );
    writeFileSync(join(f.repo.path, "src/file"), "external edit");
    assert.throws(
      () => f.snapshots.assertCurrent(f.scope, snapshot.id),
      /changed since/,
    );
    assert.ok(
      f.snapshots
        .archive(f.scope, snapshot.id)
        .includes(Buffer.from("approved source")),
    );
  } finally {
    f.close();
  }
});
test("snapshots: new paths, symlinks and fabricated snapshot artifacts fail closed", () => {
  const f = setup();
  try {
    const snapshot = f.snapshots.capture(f.scope);
    writeFileSync(join(f.repo.path, "src/new"), "new");
    assert.throws(
      () => f.snapshots.assertCurrent(f.scope, snapshot.id),
      /changed since/,
    );
    symlinkSync(join(f.repo.path, "src/file"), join(f.repo.path, "src/link"));
    assert.throws(() => f.snapshots.capture(f.scope), /leaf resolution/);
    const fake = f.artifacts.create(f.scope, {
      kind: "execution-snapshot",
      content: snapshot.content,
      dependencies: [],
      sources: [],
    });
    assert.throws(
      () => f.snapshots.archive(f.scope, fake.id),
      /snapshot_invalid/,
    );
    assert.throws(
      () =>
        snapshotTar([
          { path: "../outside", content: Buffer.from("x"), mode: 0o644 },
        ]),
      /snapshot_path/,
    );
  } finally {
    f.close();
  }
});
test("worker: isolated snapshot protocol admits the exact command and removes temporary state", async () => {
  const f = setup();
  try {
    const { snapshot, operation } = f.execution(),
      docker = new FakeDocker(),
      worker = new CommandWorkers(
        f.operations,
        "sha256:" + "a".repeat(64),
        f.snapshots,
        docker,
      );
    const result = await f.operations.run(operation, (signal) =>
      worker.execute(operation, signal),
    );
    assert.equal(result.status, "completed");
    assert.equal(docker.admissions, 1);
    assert.equal(docker.created, undefined);
    assert.equal(result.worker?.snapshot, snapshot.id);
    assert.equal(result.worker?.admitted, true);
    const create = docker.calls.find((args) => args[0] === "create")!;
    assert.equal(create.includes("--network"), true);
    assert.equal(create[create.indexOf("--network") + 1], "none");
    assert.equal(create.includes("--volume"), false);
    assert.equal(create.includes("--mount"), false);
    assert.equal(create.includes("--privileged"), false);
    assert.ok(create.includes("--read-only"));
    assert.ok(
      create.includes("/workspace:rw,nosuid,nodev,size=64m,uid=1000,gid=1000"),
    );
  } finally {
    f.close();
  }
});
test("worker: ambiguous creation is not retried and is reconciled with durable container identity", async () => {
  const f = setup();
  try {
    const { operation } = f.execution(),
      docker = new FakeDocker();
    docker.loseCreateResponse = true;
    const worker = new CommandWorkers(
        f.operations,
        "sha256:" + "a".repeat(64),
        f.snapshots,
        docker,
      ),
      result = await f.operations.run(operation, (signal) =>
        worker.execute(operation, signal),
      );
    assert.equal(result.status, "requires_reconciliation");
    assert.equal(docker.calls.filter((args) => args[0] === "create").length, 1);
    assert.equal(
      docker.calls.some((args) => args[0] === "start"),
      false,
    );
    assert.equal(docker.created, undefined);
    assert.ok(result.worker?.container.startsWith("harness-worker-"));
  } finally {
    f.close();
  }
});
test("worker: cleanup failure preserves reconciliation and never reports ordinary success", async () => {
  const f = setup();
  try {
    const { operation } = f.execution(),
      docker = new FakeDocker();
    docker.failCleanup = true;
    const worker = new CommandWorkers(
      f.operations,
      "sha256:" + "a".repeat(64),
      f.snapshots,
      docker,
    );
    const result = await f.operations.run(operation, (signal) =>
      worker.execute(operation, signal),
    );
    assert.equal(result.status, "requires_reconciliation");
    assert.match(result.error!, /worker_cleanup_failed/);
    assert.equal(docker.admissions, 1);
    assert.ok(docker.created);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM audit WHERE event='worker.cancellation_failed'",
        )
        .get()!.n,
      1,
    );
  } finally {
    f.close();
  }
});
test("worker archive parser: actual Python extraction rejects links and traversal", () => {
  const f = setup();
  try {
    const archive = f.snapshots.archive(
        f.scope,
        f.snapshots.capture(f.scope).id,
      ),
      root = join(f.dir, "extract");
    mkdirSync(root);
    const program =
      'import importlib.util,sys; s=importlib.util.spec_from_file_location("runner",sys.argv[1]); m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.extract_snapshot(sys.stdin.buffer.read(),sys.argv[2])';
    const run = (tar: Buffer, out: string) =>
      spawnSync("python3", ["-c", program, resolve("worker/runner.py"), out], {
        input: tar,
        encoding: "utf8",
      });
    assert.equal(run(archive, root).status, 0);
    assert.equal(
      readFileSync(join(root, "src/file"), "utf8"),
      "approved source",
    );
    for (const attack of ["symlink", "hardlink", "traversal"]) {
      const tar = Buffer.from(archive);
      if (attack === "traversal") {
        tar.fill(0, 0, 100);
        tar.write("../outside", 0);
      } else tar[156] = attack === "symlink" ? 50 : 49;
      tar.fill(32, 148, 156);
      let sum = 0;
      for (const byte of tar.subarray(0, 512)) sum += byte;
      tar.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
      const result = run(tar, join(f.dir, attack));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unsafe snapshot/);
    }
  } finally {
    f.close();
  }
});
