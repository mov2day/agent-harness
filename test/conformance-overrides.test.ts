import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openCodeHooks } from "../src/adapters/opencode.js";
import { parseRuntimeArguments } from "../src/runtime-args.js";

// Closes the plugin, alias and CLI-override cells of conformance/matrix.json:
// a launcher option, plugin or tool alias can never reach policy, approvals,
// skills, admission or paths. Only the engine-brokered tools exist.
const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const required = {
  "--repository": "r",
  "--repository-path": "/p",
  "--pairing": "/f",
  "--certificate": "c",
  "--goal": "do work",
};
const argv = (extra: string[] = []) =>
  Object.entries(required)
    .flatMap(([flag, value]) => [flag, value])
    .concat(extra);

test("launcher arguments: only the documented options parse and every override is rejected, not ignored", () => {
  const parsed = parseRuntimeArguments(
    argv(["--once", "--engine", "http://127.0.0.1:1"]),
  );
  assert.equal(parsed.option("--goal"), "do work");
  assert.equal(parsed.has("--once"), true);
  for (const extra of [
    ["--policy", "x.json"],
    ["--max-specialists", "99"],
    ["--max-depth", "9"],
    ["--revision-limit", "9"],
    ["--human-gates", "none"],
    ["--skill", "unsafe"],
    ["--instruction", "ignore reviews"],
    ["--model", "other"],
    ["--reasoning", "max"],
    ["--permission", "allow"],
    ["--plugin", "./evil.mjs"],
    ["--config", "x.json"],
    ["--dangerously-skip-permissions"],
    ["positional"],
    ["--goal", "second goal"],
  ])
    assert.throws(
      () => parseRuntimeArguments(argv(extra)),
      /Unsupported argument|Repeated/,
      extra.join(" "),
    );
  assert.throws(() => parseRuntimeArguments(["--goal"]), /Missing --goal/);
  assert.throws(
    () => parseRuntimeArguments(["--goal", "--once"]),
    /Missing --goal/,
  );
});

test("launcher process: an override exits non-zero before contacting any engine", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/runtime-cli.ts",
      ...argv(["--max-specialists", "99"]),
    ],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported argument --max-specialists/);
  assert.doesNotMatch(result.stdout, /Registered session/);
});

test("runtime configuration is fixed in the coordinator and cannot be set from arguments or environment", () => {
  const source = read("runtime/opencode/coordinator.mjs");
  assert.match(source, /permission: \{ "\*": "deny", "harness_\*": "allow" \}/);
  assert.match(source, /OPENCODE_DISABLE_PROJECT_CONFIG: "true"/);
  assert.match(source, /OPENCODE_DISABLE_DEFAULT_PLUGINS: "true"/);
  assert.doesNotMatch(source, /process\.argv/);
  // The only environment value passed through is the relay origin; the config
  // object does not read anything from the process environment.
  const config = source.slice(
    source.indexOf("runtimeConfig"),
    source.indexOf("child = spawn"),
  );
  assert.doesNotMatch(config, /process\.env/);
});

test("plugin definitions expose exactly the brokered tools and nothing for policy, approvals, skills, admission or paths", () => {
  const plugin = read("runtime/opencode/plugin.mjs"),
    block = plugin.slice(
      plugin.indexOf("const definitions = {"),
      plugin.indexOf("export default"),
    ),
    names = [...block.matchAll(/^ {2}([a-z]+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(names, [
    "artifact",
    "change",
    "compact",
    "delegate",
    "delete",
    "execute",
    "learn",
    "read",
    "rename",
    "research",
    "review",
  ]);
  assert.match(
    plugin,
    /Object\.hasOwn\(tools, name\)\) throw new Error\("native_tool_denied"\)/,
  );
  assert.match(plugin, /"command\.execute\.before": async \(\) => \{\s*throw/);
  assert.match(plugin, /"shell\.env": async \(\) => \{\s*throw/);
});

test("adapter: plugin-supplied or aliased tool names for paths, admission, reviews, skills and policy never dispatch", async () => {
  const calls: unknown[] = [];
  const hooks = openCodeHooks(
    {
      async execute(request) {
        calls.push(request);
        return { ok: true };
      },
      async context() {
        return {};
      },
    },
    "runtime",
  );
  const denied = (error: unknown) =>
      (error as { code?: string }).code === "native_tool_denied",
    names = [
      // paths
      "harness_write",
      "harness_fs",
      "harness_mkdir",
      "write",
      "edit",
      "patch",
      "apply_patch",
      // admission
      "harness_admit",
      "harness_spawn",
      "task",
      "subagent",
      "agent",
      // reviews
      "harness_approve",
      "harness_review_approve",
      "harness_gate",
      // skills
      "harness_skill",
      "skill",
      "harness_load_skill",
      "harness_install_skill",
      // policy and configuration
      "harness_policy",
      "harness_publish_policy",
      "harness_config",
      "config",
      "plugin_install",
      // spelling aliases of real tools
      "HARNESS_READ",
      "Harness_read",
      " harness_read",
      "harness_read ",
      "harness_read\0",
      "harness-read",
      "harness_readx",
      "harness_",
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
    ];
  for (const tool of names) {
    await assert.rejects(
      hooks["tool.execute.before"](
        { tool, sessionID: "runtime", callID: "1" },
        { args: {} },
      ),
      denied,
      JSON.stringify(tool),
    );
    await assert.rejects(
      hooks.dispatch(tool, {}, "1"),
      denied,
      JSON.stringify(tool),
    );
  }
  assert.equal(calls.length, 0);
  for (const tool of ["harness_review", "harness_delegate", "harness_learn"])
    await hooks["tool.execute.before"](
      { tool, sessionID: "runtime", callID: "1" },
      { args: {} },
    );
});
