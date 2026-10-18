import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Engine } from "../src/engine.js";
import { parseAgentList } from "../src/harness-sync.js";
import { sign, id } from "../src/core.js";
import { builtinAgents } from "../src/agents.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "harness-sync-")),
    env = {
      xdg: process.env.XDG_CONFIG_HOME,
      path: process.env.PATH,
      home: process.env.HOME,
    };
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  process.env.HOME = join(dir, "home");
  mkdirSync(process.env.HOME);
  const engine = new Engine({
    state: join(dir, "state"),
    sourceHash: "fixture-only",
  });
  execFileSync("git", ["init", "-q", join(dir, "repo")], { stdio: "pipe" });
  const repo = engine.enroll(join(dir, "repo"));
  const by = (
    checks: Array<{ id: string; status: string; detail: string }>,
    key: string,
  ) => checks.find((c) => c.id === key)!;
  return {
    dir,
    engine,
    repo,
    by,
    close() {
      engine.close();
      for (const [k, v] of [
        ["XDG_CONFIG_HOME", env.xdg],
        ["PATH", env.path],
        ["HOME", env.home],
      ] as const)
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const both = { toml: true, opencode: true };

test("parsing OpenCode's agent list reads names and modes", () => {
  const agents = parseAgentList(
    'build (primary)\n  [ {"x":1} ]\nharness-planner (subagent)\n  []\nharness-orchestrator (primary)\n',
  );
  assert.deepEqual(
    [...agents],
    [
      ["build", "primary"],
      ["harness-planner", "subagent"],
      ["harness-orchestrator", "primary"],
    ],
  );
});

test("one preview and one write publish both outputs and the checks confirm they match", async () => {
  const f = setup();
  try {
    const before = await f.engine.verifyHarness(f.repo.id, false);
    assert.equal(f.by(before, "policy").status, "ok");
    assert.equal(f.by(before, "mandatory").status, "ok");
    assert.equal(f.by(before, "toml").status, "warn");
    assert.match(f.by(before, "opencode-files").detail, /7 not written/);
    const preview = f.engine.syncPreview(f.repo.id, both);
    assert.equal(preview.toml?.action, "create");
    assert.equal(preview.opencode?.files.length, 7);
    assert.equal(
      existsSync(join(f.repo.path, ".agent-harness")),
      false,
      "preview writes nothing",
    );
    const written = await f.engine.syncWrite(f.repo.id, both);
    assert.equal(written.toml?.ok, true);
    assert.equal(written.opencode?.ok, true);
    assert.equal(f.by(written.checks, "toml").status, "ok");
    assert.equal(f.by(written.checks, "opencode-files").status, "ok");
    assert.ok(
      existsSync(join(f.repo.path, ".opencode", "agent", "harness-planner.md")),
    );
    // A single target can be written alone.
    const alone = f.engine.syncPreview(f.repo.id, {
      toml: false,
      opencode: true,
    });
    assert.equal(alone.toml, undefined);
    assert.ok(alone.opencode?.files.every((x) => x.action === "unchanged"));
  } finally {
    f.close();
  }
});

test("a published change makes both outputs out of date until they are written again", async () => {
  const f = setup();
  try {
    await f.engine.syncWrite(f.repo.id, both);
    // Global limits flow through to the repository's inherited harness.
    f.engine.importToml(
      undefined,
      f.engine.exportToml().replace("maxDepth = 2", "maxDepth = 3"),
      true,
    );
    const checks = await f.engine.verifyHarness(undefined, false);
    assert.equal(f.by(checks, "toml").status, "warn");
    assert.match(f.by(checks, "toml").detail, /No|Not written|Out of sync/);
    const repoChecks = await f.engine.verifyHarness(f.repo.id, false);
    assert.equal(f.by(repoChecks, "toml").status, "warn");
    assert.match(f.by(repoChecks, "toml").detail, /Out of sync/);
    assert.match(f.by(repoChecks, "opencode-files").detail, /1 out of date/);
    const fixed = await f.engine.syncWrite(f.repo.id, both);
    assert.equal(f.by(fixed.checks, "toml").status, "ok");
    assert.equal(f.by(fixed.checks, "opencode-files").status, "ok");
  } finally {
    f.close();
  }
});

test("files you wrote are kept and one target never blocks the other", async () => {
  const f = setup();
  try {
    mkdirSync(join(f.repo.path, ".agent-harness"));
    writeFileSync(
      join(f.repo.path, ".agent-harness", "harness.toml"),
      "mine = 1\n",
    );
    mkdirSync(join(f.repo.path, ".opencode", "agent"), { recursive: true });
    writeFileSync(
      join(f.repo.path, ".opencode", "agent", "harness-planner.md"),
      "mine",
    );
    const out = await f.engine.syncWrite(f.repo.id, both);
    assert.equal(out.toml?.ok, false);
    assert.match(out.toml!.ok ? "" : out.toml!.error, /harness.toml you wrote/);
    assert.equal(out.opencode?.ok, true);
    assert.equal(
      readFileSync(join(f.repo.path, ".agent-harness", "harness.toml"), "utf8"),
      "mine = 1\n",
    );
    assert.equal(
      readFileSync(
        join(f.repo.path, ".opencode", "agent", "harness-planner.md"),
        "utf8",
      ),
      "mine",
    );
    assert.match(
      f.by(out.checks, "opencode-files").detail,
      /1 kept because you wrote them/,
    );
    assert.match(f.by(out.checks, "toml").detail, /file does not load/);
    const replaced = await f.engine.syncWrite(
      f.repo.id,
      { toml: true, opencode: false },
      true,
    );
    assert.equal(replaced.toml?.ok, true);
    assert.equal(f.by(replaced.checks, "toml").status, "ok");
  } finally {
    f.close();
  }
});

test("checks report a missing skill and an edited file that no longer loads", async () => {
  const f = setup();
  try {
    const policy = f.engine.policies.active("global").policy;
    f.engine.policies.publish(
      "global",
      {
        ...policy,
        allowedSkills: ["not-installed"],
        agents: policy.agents.map((a) =>
          a.id === "planner" ? { ...a, skills: ["not-installed"] } : a,
        ),
      },
      true,
    );
    let checks = await f.engine.verifyHarness(undefined, false);
    assert.equal(f.by(checks, "references").status, "warn");
    assert.match(f.by(checks, "references").detail, /not-installed/);
    await f.engine.syncWrite(undefined, { toml: true, opencode: false });
    const path = join(
      process.env.XDG_CONFIG_HOME!,
      "agent-harness",
      "harness.toml",
    );
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("maxDepth = 2", "maxDepth = 99"),
    );
    checks = await f.engine.verifyHarness(undefined, false);
    assert.equal(f.by(checks, "toml").status, "fail");
    assert.match(f.by(checks, "toml").detail, /does not load/);
  } finally {
    f.close();
  }
});

test("the load check asks the installed OpenCode which agents it resolves", async () => {
  const f = setup();
  try {
    await f.engine.syncWrite(f.repo.id, both);
    const bin = join(f.dir, "bin");
    mkdirSync(bin);
    const script = (names: string[]) => {
      writeFileSync(
        join(bin, "opencode"),
        `#!/bin/sh\n${names.map((n) => `echo '${n}'`).join("\n")}\n`,
      );
      chmodSync(join(bin, "opencode"), 0o755);
    };
    const all = builtinAgents.map(
      (a) =>
        `harness-${a.id} (${a.id === "orchestrator" ? "primary" : "subagent"})`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;
    script(["build (primary)", ...all]);
    let load = f.by(
      await f.engine.verifyHarness(f.repo.id, true),
      "opencode-load",
    );
    assert.deepEqual(
      [load.status, load.detail],
      ["ok", "OpenCode resolved all 7 agents"],
    );
    script(["build (primary)", ...all.filter((x) => !x.includes("planner"))]);
    load = f.by(await f.engine.verifyHarness(f.repo.id, true), "opencode-load");
    assert.equal(load.status, "fail");
    assert.match(load.detail, /harness-planner/);
    script([
      "build (primary)",
      ...all.map((x) =>
        x.replace(
          "harness-orchestrator (primary)",
          "harness-orchestrator (subagent)",
        ),
      ),
    ]);
    assert.equal(
      f.by(await f.engine.verifyHarness(f.repo.id, true), "opencode-load")
        .status,
      "fail",
    );
    mkdirSync(join(f.dir, "empty"));
    process.env.PATH = `${join(f.dir, "empty")}:/usr/bin:/bin`;
    load = f.by(await f.engine.verifyHarness(f.repo.id, true), "opencode-load");
    assert.deepEqual(
      [load.status, load.detail],
      ["warn", "opencode was not found on PATH"],
    );
    // Without the flag OpenCode is never started.
    assert.equal(
      (await f.engine.verifyHarness(f.repo.id, false)).some(
        (c) => c.id === "opencode-load",
      ),
      false,
    );
  } finally {
    f.close();
  }
});

test("a publish ends running sessions and the next session loads the new prompt and review settings", () => {
  const f = setup();
  try {
    const register = () => {
      const integration = f.engine.identity.pair("opencode");
      const binding = {
        integration: integration.id,
        repository: f.repo.id,
        runtimeSession: id(),
        connection: id(),
      };
      const registration = {
        ...binding,
        nonce: f.engine.identity.challenge(binding).nonce,
      };
      return f.engine.identity.register(
        registration,
        sign(integration.secret, registration),
      ).session;
    };
    const first = register();
    const context = (session: typeof first) =>
      (
        f.engine as unknown as { agentContext(s: typeof first): any }
      ).agentContext(session);
    assert.match(context(first).agent.systemPrompt, /You are the Orchestrator/);
    const policy = f.engine.policies.active("global").policy;
    f.engine.policies.publish(
      "global",
      {
        ...policy,
        agents: policy.agents.map((a) =>
          a.id === "orchestrator"
            ? { ...a, systemPrompt: "Custom orchestrator prompt." }
            : a,
        ),
        humanReview: { ...policy.humanReview, beforeStages: ["plan"] },
      },
      true,
    );
    assert.notEqual(
      f.engine.identity.session(first.session).status,
      "active",
      "the old session was ended",
    );
    const second = register();
    assert.equal(second.policy, f.engine.policies.effective(f.repo.id).id);
    const loaded = context(second);
    assert.equal(loaded.agent.systemPrompt, "Custom orchestrator prompt.");
    assert.deepEqual(loaded.orchestration.verifyStages.length, 5);
    assert.ok(
      loaded.agents.every(
        (a: { baseRole: string }) => a.baseRole !== "Conductor",
      ),
    );
  } finally {
    f.close();
  }
});

test("checks flag missing required tools, tools without resources and wide built-in agents", async () => {
  const f = setup();
  try {
    let checks = await f.engine.verifyHarness(undefined, false);
    for (const key of ["tools-required", "tools-resources", "least-privilege"])
      assert.equal(f.by(checks, key).status, "ok", key);
    const policy = f.engine.policies.active("global").policy;
    // Wide agents, execute with no approved command, research with no domain.
    f.engine.policies.publish(
      "global",
      {
        ...policy,
        tools: [...policy.tools, "execute", "research"],
        agents: policy.agents.map((a) =>
          a.id === "researcher"
            ? { ...a, tools: [...a.tools, "read" as const] }
            : a.id === "verifier"
              ? { ...a, tools: [...a.tools, "execute" as const] }
              : a,
        ),
      },
      true,
    );
    checks = await f.engine.verifyHarness(undefined, false);
    assert.match(
      f.by(checks, "tools-resources").detail,
      /no command is approved/,
    );
    assert.match(
      f.by(checks, "tools-resources").detail,
      /no domain is allowed/,
    );
    assert.equal(f.by(checks, "tools-resources").status, "warn");
    assert.match(
      f.by(checks, "least-privilege").detail,
      /Researcher can read the repository/,
    );
    assert.match(
      f.by(checks, "least-privilege").detail,
      /Verifier can run commands/,
    );
    // A policy without the review tool cannot run the Verifier or Reviewer.
    f.engine.policies.publish(
      "global",
      { ...policy, tools: policy.tools.filter((t) => t !== "review") },
      true,
    );
    checks = await f.engine.verifyHarness(undefined, false);
    assert.equal(f.by(checks, "tools-required").status, "fail");
    assert.match(f.by(checks, "tools-required").detail, /Enable review/);
  } finally {
    f.close();
  }
});

import { parseModels } from "../src/harness-sync.js";

const sample = [
  "opencode/beam-free",
  "{",
  '  "id": "beam-free",',
  '  "name": "Beam Free",',
  '  "status": "active",',
  '  "limit": { "context": 1048576, "output": 131072 },',
  '  "capabilities": { "reasoning": true },',
  '  "variants": { "low": {}, "high": {} }',
  "}",
  "\u001b[0mopenai/gpt-x",
  "{",
  '  "name": "GPT X",',
  '  "status": "deprecated",',
  '  "capabilities": { "reasoning": false }',
  "}",
  "bare/model-only",
  "not a model line",
].join("\n");

test("OpenCode's model listing is parsed into ids, providers, variants and status", () => {
  assert.deepEqual(parseModels(sample), [
    {
      id: "bare/model-only",
      provider: "bare",
      name: "model-only",
      status: "active",
      variants: [],
      reasoning: false,
    },
    {
      id: "openai/gpt-x",
      provider: "openai",
      name: "GPT X",
      status: "deprecated",
      variants: [],
      reasoning: false,
    },
    {
      id: "opencode/beam-free",
      provider: "opencode",
      name: "Beam Free",
      status: "active",
      variants: ["low", "high"],
      reasoning: true,
      context: 1048576,
    },
  ]);
  assert.deepEqual(parseModels("nothing useful\n"), []);
});

test("connected models load dynamically from the installed OpenCode and are cached until refreshed", async () => {
  const f = setup();
  try {
    const bin = join(f.dir, "bin");
    mkdirSync(bin);
    const counter = join(f.dir, "calls");
    writeFileSync(
      join(bin, "opencode"),
      `#!/bin/sh\necho "$@" >> '${counter}'\ncat <<'EOF'\n${sample}\nEOF\n`,
    );
    chmodSync(join(bin, "opencode"), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const first = (await f.engine.openCodeModels(undefined, false)) as {
      available: boolean;
      models: Array<{ id: string }>;
      certified: object;
    };
    assert.equal(first.available, true);
    assert.deepEqual(
      first.models.map((m) => m.id),
      ["bare/model-only", "openai/gpt-x", "opencode/beam-free"],
    );
    assert.deepEqual(first.certified, {});
    await f.engine.openCodeModels(undefined, false);
    assert.equal(
      readFileSync(counter, "utf8").trim().split("\n").length,
      1,
      "second call is cached",
    );
    await f.engine.openCodeModels(undefined, true);
    const calls = readFileSync(counter, "utf8").trim().split("\n");
    assert.equal(calls.length, 2);
    assert.match(calls[1]!, /models --verbose --refresh/);
    // Without OpenCode the picker degrades to a clear reason.
    mkdirSync(join(f.dir, "empty"));
    process.env.PATH = `${join(f.dir, "empty")}:/usr/bin:/bin`;
    const fresh = (await f.engine.openCodeModels(f.repo.id, false)) as {
      available: boolean;
      reason: string;
    };
    assert.deepEqual(
      [fresh.available, fresh.reason],
      [false, "opencode was not found on PATH"],
    );
  } finally {
    f.close();
  }
});

test("a check flags agent models that no runtime certificate lists", async () => {
  const f = setup();
  try {
    assert.equal(
      f.by(await f.engine.verifyHarness(undefined, false), "models").status,
      "ok",
    );
    const policy = f.engine.policies.active("global").policy;
    f.engine.policies.publish(
      "global",
      {
        ...policy,
        agents: policy.agents.map((a) =>
          a.id === "planner"
            ? { ...a, model: { model: "openai/gpt-x", reasoning: "high" } }
            : a,
        ),
      },
      true,
    );
    const check = f.by(
      await f.engine.verifyHarness(undefined, false),
      "models",
    );
    assert.equal(check.status, "warn");
    assert.match(
      check.detail,
      /Planner \(openai\/gpt-x\) works in native OpenCode/,
    );
  } finally {
    f.close();
  }
});

import { researchUrl } from "../src/gateway.js";
import { renderAgent, webSearchFlags } from "../src/opencode-export.js";

test("a fresh install cannot research, Verify says exactly why, and enabling it fixes each cause", async () => {
  const f = setup();
  try {
    const policy = f.engine.policies.active("global").policy;
    const url = "https://github.com/karatelabs/karate/releases";
    // Causes: research is off in the policy, no domain is allowed.
    assert.throws(() => researchUrl(url, policy.domains), /domain_denied/);
    const researcher = policy.agents.find((a) => a.id === "researcher")!;
    const native = renderAgent(researcher, policy, policy.agents);
    assert.match(native, /  webfetch: deny/);
    assert.match(
      native,
      /  read: deny/,
      "the Researcher has no repository read by design",
    );
    const before = f.by(
      await f.engine.verifyHarness(undefined, false),
      "research",
    );
    assert.equal(before.status, "warn");
    assert.match(before.detail, /research is off in the policy/);
    assert.match(before.detail, /no domain is allowed/);
    // Turning on research and allowing the domains clears both.
    const next = {
      ...policy,
      tools: [...policy.tools, "research" as const],
      domains: ["github.com", "karatelabs.io"],
    };
    f.engine.policies.publish("global", next, true);
    const after = f.by(
      await f.engine.verifyHarness(undefined, false),
      "research",
    );
    assert.equal(after.status, "ok");
    assert.match(after.detail, /github\.com, karatelabs\.io/);
    assert.match(after.detail, /waits for your approval under Reviews/);
    // Native OpenCode needs a launch flag before it offers websearch.
    const flags = webSearchFlags.map((k) => [k, process.env[k]] as const);
    try {
      for (const [k] of flags) delete process.env[k];
      const search = f.by(
        await f.engine.verifyHarness(undefined, false),
        "opencode-websearch",
      );
      assert.equal(search.status, "warn");
      assert.match(search.detail, /OPENCODE_ENABLE_EXA=1 opencode/);
      process.env.OPENCODE_ENABLE_EXA = "1";
      assert.equal(
        f.by(
          await f.engine.verifyHarness(undefined, false),
          "opencode-websearch",
        ).status,
        "ok",
      );
    } finally {
      for (const [k, v] of flags)
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    researchUrl(url, next.domains);
    assert.match(renderAgent(researcher, next, next.agents), /  webfetch: ask/);
    // Exact host names: the site is not covered by its parent or sibling hosts.
    assert.throws(
      () => researchUrl("https://www.karatelabs.io/", next.domains),
      /domain_denied/,
    );
    // Without the Researcher agent the policy alone is not enough.
    f.engine.policies.publish(
      "global",
      {
        ...next,
        agents: next.agents.map((a) =>
          a.id === "researcher" ? { ...a, enabled: false } : a,
        ),
      },
      true,
    );
    assert.match(
      f.by(await f.engine.verifyHarness(undefined, false), "research").detail,
      /no enabled agent holds the research tool/,
    );
  } finally {
    f.close();
  }
});
