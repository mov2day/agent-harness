import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../../test/helpers.js";
import { id } from "../../src/core.js";
import { defaultPolicy } from "../../src/policy.js";
import { Operations } from "../../src/operations.js";
import { NativeFiles } from "../../src/files.js";
import { Artifacts } from "../../src/workflow.js";
import { Snapshots } from "../../src/snapshots.js";
import { CommandWorkers } from "../../src/workers.js";
const image = process.env.HARNESS_TEST_WORKER_IMAGE;
assert.match(
  image ?? "",
  /^sha256:[a-f0-9]{64}$/,
  "Set HARNESS_TEST_WORKER_IMAGE to the built worker image ID. This suite never substitutes a mock runtime.",
);
const isolation = `import json,os,socket,pathlib
result={"uid":os.getuid(),"private_host":os.path.exists("/host/private"),"docker_socket":os.path.exists("/var/run/docker.sock"),"interfaces":os.listdir("/sys/class/net"),"previous_temporary":os.path.exists("/tmp/previous-worker")}
try:
 s=socket.create_connection(("1.1.1.1",443),timeout=1);s.close();result["network"]=True
except OSError:
 result["network"]=False
result["source"]=pathlib.Path("file").read_text()
pathlib.Path("file").write_text("worker scratch edit")
pathlib.Path("/tmp/previous-worker").write_text("temporary")
result["capabilities"]=[line.strip() for line in pathlib.Path("/proc/self/status").read_text().splitlines() if line.startswith("CapEff:")][0]
print(json.dumps(result))`;
function setup(script: string) {
  const f = fixture();
  f.policies.publish(
    "global",
    {
      ...defaultPolicy,
      timeoutMs: 30_000,
      tools: [...defaultPolicy.tools, "execute"],
      commands: [
        {
          executable: "/usr/local/bin/python3",
          args: ["-c", script],
          env: {},
          cwd: "src",
        },
      ],
    },
    true,
  );
  const scope = f.register().session;
  scope.role = "Verifier";
  scope.enforcement = "enforced";
  scope.stage = "execution";
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
    ),
    workers = new CommandWorkers(operations, image!, snapshots);
  mkdirSync(join(f.repo.path, "src"));
  writeFileSync(join(f.repo.path, "src/file"), "reviewed source");
  const begin = () => {
    const snapshot = snapshots.capture(scope),
      args = {
        executable: "/usr/local/bin/python3",
        args: ["-c", script],
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
    return operations.begin(token, scope.connection, {
      tool: "execute",
      args: { ...args, approval },
      idempotencyKey: id(),
    });
  };
  return { ...f, scope, operations, workers, begin };
}
test(
  "live worker: no network, host mounts, sockets or retained temporary data; source snapshot is isolated",
  { timeout: 60_000 },
  async () => {
    const f = setup(isolation);
    try {
      for (let n = 0; n < 2; n++) {
        const op = f.begin(),
          result = await f.operations.run(op, (signal) =>
            f.workers.execute(op, signal),
          );
        assert.equal(result.status, "completed", result.error);
        const execution = result.result as { exitCode: number; output: string };
        assert.equal(execution.exitCode, 0, execution.output);
        const evidence = JSON.parse(execution.output);
        assert.equal(evidence.uid, 1000);
        assert.equal(evidence.network, false);
        assert.equal(evidence.private_host, false);
        assert.equal(evidence.docker_socket, false);
        assert.equal(evidence.previous_temporary, false);
        assert.deepEqual(evidence.interfaces, ["lo"]);
        assert.match(evidence.capabilities, /0000000000000000$/);
        assert.equal(evidence.source, "reviewed source");
        assert.equal(
          readFileSync(join(f.repo.path, "src/file"), "utf8"),
          "reviewed source",
        );
        const remaining = execFileSync(
          "docker",
          [
            "ps",
            "-a",
            "--filter",
            `name=${result.worker!.container}`,
            "--format",
            "{{.ID}}",
          ],
          { encoding: "utf8" },
        ).trim();
        assert.equal(remaining, "");
      }
    } finally {
      f.close();
    }
  },
);
test(
  "live worker: authority revocation cancels an admitted command and records the interrupted outcome",
  { timeout: 60_000 },
  async () => {
    const f = setup('import time; print("started",flush=True); time.sleep(20)');
    try {
      const op = f.begin(),
        running = f.operations.run(op, (signal) =>
          f.workers.execute(op, signal),
        );
      let revoked = false;
      const interval = setInterval(() => {
        if (f.operations.current(op).worker?.admitted) {
          revoked = true;
          f.operations.invalidate(op.session, "capability_revoked");
          clearInterval(interval);
        }
      }, 25);
      try {
        const result = await running;
        assert.equal(revoked, true);
        assert.equal(result.status, "requires_reconciliation");
        assert.equal(result.invalidated?.reason, "capability_revoked");
        const remaining = execFileSync(
          "docker",
          [
            "ps",
            "-a",
            "--filter",
            `name=${result.worker!.container}`,
            "--format",
            "{{.ID}}",
          ],
          { encoding: "utf8" },
        ).trim();
        assert.equal(remaining, "");
      } finally {
        clearInterval(interval);
      }
    } finally {
      f.close();
    }
  },
);
