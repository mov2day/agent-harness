import test from "node:test";
import assert from "node:assert/strict";
import {
  validateContainer,
  Containment,
  type ContainerInspection,
} from "../src/containment.js";
import { openCodeHooks } from "../src/adapters/opencode.js";
import { fixture } from "./helpers.js";
const expected = {
  container: "a".repeat(64),
  image: "sha256:" + "b".repeat(64),
  session: "runtime",
  connection: "bridge",
};
const safe = (): ContainerInspection => ({
  Id: expected.container,
  Image: expected.image,
  State: { Running: true },
  Config: {
    User: "1000:1000",
    Env: [],
    Labels: {
      "agent-harness.session": "runtime",
      "agent-harness.connection": "bridge",
    },
  },
  HostConfig: {
    NetworkMode: "none",
    Privileged: false,
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    CapAdd: [],
    SecurityOpt: ["no-new-privileges"],
    PidMode: "",
    IpcMode: "private",
    Devices: [],
    DeviceRequests: [],
    Binds: [],
    VolumesFrom: [],
    PidsLimit: 64,
    Memory: 512 * 1024 ** 2,
    PortBindings: {},
  },
  Mounts: [],
});
test("containment: host sockets, mounts, network, devices, privileges, credentials and identity are rejected", () => {
  validateContainer(safe(), expected);
  const mutations: Array<(c: ContainerInspection) => void> = [
    (c) => (c.HostConfig.NetworkMode = "host"),
    (c) => (c.HostConfig.Privileged = true),
    (c) => (c.HostConfig.ReadonlyRootfs = false),
    (c) => c.Mounts.push({ Source: "/var/run/docker.sock" }),
    (c) => (c.HostConfig.Binds = ["/host:/host"]),
    (c) => (c.HostConfig.Devices = ["/dev/disk0"]),
    (c) => (c.HostConfig.CapAdd = ["SYS_ADMIN"]),
    (c) => (c.Config.User = "0:0"),
    (c) => (c.Config.Env = ["OPENAI_API_KEY=secret"]),
    (c) => (c.HostConfig.PidMode = "host"),
    (c) => (c.Config.Labels["agent-harness.connection"] = "spoof"),
    (c) => (c.Image = "unapproved"),
    (c) => (c.HostConfig.VolumesFrom = ["other"]),
    (c) => (c.HostConfig.PortBindings = { "80/tcp": [] }),
    (c) => (c.State.Running = false),
  ];
  for (const mutate of mutations) {
    const c = safe();
    mutate(c);
    assert.throws(() => validateContainer(c, expected));
  }
});
test("OpenCode adapter: native tools, aliases, plugins and other sessions cannot dispatch", async () => {
  const calls: unknown[] = [];
  const hooks = openCodeHooks(
    {
      async execute(r) {
        calls.push(r);
        return { ok: true };
      },
      async context() {
        return { goals: ["preserve"] };
      },
    },
    "runtime",
  );
  for (const tool of [
    "bash",
    "write",
    "edit",
    "read",
    "webfetch",
    "task",
    "plugin_run",
    "shell",
    "harness_policy",
  ])
    await assert.rejects(
      hooks["tool.execute.before"](
        { tool, sessionID: "runtime", callID: "1" },
        { args: {} },
      ),
    );
  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "harness_read", sessionID: "other", callID: "1" },
      { args: {} },
    ),
  );
  await hooks["tool.execute.before"](
    { tool: "harness_read", sessionID: "runtime", callID: "1" },
    { args: {} },
  );
  await hooks.dispatch("harness_read", { path: "src/a" }, "1");
  assert.equal(calls.length, 1);
  const out = { context: [] as string[] };
  await hooks["experimental.session.compacting"]({ sessionID: "runtime" }, out);
  assert.match(out.context[0]!, /preserve/);
});
test("containment: unregistered and uncertified runtimes never show enforced", () => {
  const f = fixture();
  try {
    const { session } = f.register(),
      containment = new Containment(f.store, "codehash", () => safe());
    assert.equal(containment.healthy(session), false);
    assert.throws(
      () => containment.attach(session, expected.container, "guess"),
      /runtime_uncertified/,
    );
    assert.equal(f.identity.session(session.session).enforcement, "unverified");
  } finally {
    f.close();
  }
});
