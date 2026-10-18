import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { defaultPolicy } from "../src/policy.js";
import {
  policyToToml,
  tomlToPolicy,
  readTomlFile,
} from "../src/harness-toml.js";
import { builtinAgents } from "../src/agents.js";
import { Engine } from "../src/engine.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

test("a policy survives a round trip through harness.toml", () => {
  const policy = {
    ...defaultPolicy,
    domains: ["docs.example.com"],
    commands: [{ executable: "/bin/echo", args: ["ok"], env: {}, cwd: "src" }],
    models: { Planner: { model: "m", reasoning: "high" } },
    agents: [
      ...builtinAgents,
      {
        id: "doc-writer",
        name: "Doc writer",
        kind: "custom" as const,
        baseRole: "Planner" as const,
        description: "Writes docs plans",
        systemPrompt: "Line one.\nLine \"two\" with 'quotes' and \\ slashes.",
        model: { model: "m", reasoning: "high" },
        tools: [
          "read" as const,
          "artifact" as const,
          "compact" as const,
          "model" as const,
        ],
        skills: [],
        mcps: [],
        enabled: true,
      },
    ],
    humanReview: {
      beforeStages: ["plan" as const],
      externalContent: "approve-url" as const,
      trustedDomains: ["docs.example.com"],
    },
  };
  const text = policyToToml(policy);
  assert.match(text, /^# agent-harness policy/);
  assert.match(text, /\[\[agents\]\]/);
  assert.deepEqual(tomlToPolicy(text), JSON.parse(JSON.stringify(policy)));
});

test("harness.toml input is bounded and syntax errors are reported", () => {
  assert.throws(() => tomlToPolicy("version = "), /not valid TOML/);
  assert.throws(() => tomlToPolicy("a = 1\n".repeat(200_000)), /too large/);
});

test("toml files are read only when regular", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-toml-"));
  try {
    writeFileSync(join(dir, "ok.toml"), "version = 1");
    symlinkSync(join(dir, "ok.toml"), join(dir, "link.toml"));
    assert.equal(readTomlFile(join(dir, "ok.toml")).text, "version = 1");
    assert.equal(readTomlFile(join(dir, "link.toml")).text, null);
    assert.equal(readTomlFile(join(dir, "missing.toml")).text, null);
    assert.equal(readTomlFile(dir).text, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importing harness.toml validates under the same rules and publishes only on import", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-toml-engine-"));
  const engine = new Engine({
    state: join(dir, "state"),
    sourceHash: "fixture-only",
  });
  try {
    execFileSync("git", ["init", "-q", join(dir, "repo")], { stdio: "pipe" });
    const repo = engine.enroll(join(dir, "repo"));
    const exported = engine.exportToml();
    const edited = exported.replace("maxDepth = 2", "maxDepth = 3");
    assert.notEqual(edited, exported);
    assert.deepEqual(engine.importToml(undefined, edited, false), {
      valid: true,
    });
    assert.equal(
      engine.policies.active("global").policy.maxDepth,
      2,
      "validation publishes nothing",
    );
    assert.ok(engine.importToml(undefined, edited, true).published);
    assert.equal(engine.policies.active("global").policy.maxDepth, 3);
    // Mandatory agents cannot be dropped through a file either.
    const noVerifier = edited.replace(
      /\[\[agents\]\]\nid = "verifier"[\s\S]*?(?=\[\[agents\]\])/,
      "",
    );
    assert.notEqual(noVerifier, edited);
    assert.throws(
      () => engine.importToml(undefined, noVerifier, true),
      /Agent configuration is invalid/,
    );
    // A repository file cannot raise a limit without the owner confirming the grant.
    const repoToml = engine.exportToml(repo.id);
    assert.match(repoToml, /agents = \[\]/);
    assert.throws(
      () =>
        engine.importToml(
          repo.id,
          repoToml.replace("maxDepth = 3", "maxDepth = 5"),
          true,
        ),
      /Needs your confirmation[^]*maxDepth 3 → 5/,
    );
    assert.ok(
      engine.importToml(
        repo.id,
        repoToml.replace("maxDepth = 3", "maxDepth = 5"),
        true,
        true,
      ).published,
      "a confirmed grant is accepted for this repository",
    );
    assert.equal(engine.policies.effective(repo.id).policy.maxDepth, 5);
    assert.equal(engine.policies.active("global").policy.maxDepth, 3);
    assert.ok(
      engine.importToml(
        repo.id,
        repoToml.replace("maxDepth = 3", "maxDepth = 1"),
        true,
      ).published,
    );
    assert.equal(engine.policies.effective(repo.id).policy.maxDepth, 1);
    // The repository's own file is only read for review, never applied.
    mkdirSync(join(dir, "repo", ".agent-harness"));
    writeFileSync(
      join(dir, "repo", ".agent-harness", "harness.toml"),
      "maxDepth = 8\n",
    );
    assert.equal(engine.tomlFile(repo.id).text, "maxDepth = 8\n");
    assert.equal(engine.policies.effective(repo.id).policy.maxDepth, 1);
    assert.throws(() => engine.exportToml("nope"), /repository_unknown/);
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import {
  applyTomlWrite,
  planTomlWrite,
  tomlMarker,
} from "../src/harness-toml.js";
import { existsSync, readFileSync } from "node:fs";

test("harness.toml is written only when the harness owns the file or the owner replaces it", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-toml-write-"));
  try {
    const path = join(dir, ".agent-harness", "harness.toml"),
      content = `${tomlMarker}\nversion = 1\n`;
    const create = planTomlWrite(path, content);
    assert.equal(create.action, "create");
    assert.equal(
      existsSync(join(dir, ".agent-harness")),
      false,
      "planning writes nothing",
    );
    applyTomlWrite(create, content);
    assert.equal(readFileSync(path, "utf8"), content);
    assert.equal(planTomlWrite(path, content).action, "unchanged");
    assert.throws(
      () => applyTomlWrite(planTomlWrite(path, content), content),
      /Nothing to write/,
    );
    const next = `${tomlMarker}\nversion = 2\n`;
    assert.equal(planTomlWrite(path, next).action, "update");
    applyTomlWrite(planTomlWrite(path, next), next);
    assert.equal(readFileSync(path, "utf8"), next);
    // The owner's own file is a conflict that only an explicit replace overwrites.
    writeFileSync(path, "my own settings = true\n");
    const conflict = planTomlWrite(path, content);
    assert.equal(conflict.action, "conflict");
    assert.throws(
      () => applyTomlWrite(conflict, content),
      /harness.toml you wrote/,
    );
    assert.equal(readFileSync(path, "utf8"), "my own settings = true\n");
    applyTomlWrite(conflict, content, true);
    assert.equal(readFileSync(path, "utf8"), content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness.toml is never written through links", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-toml-link-"));
  try {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "victim"), "victim");
    mkdirSync(join(dir, "a"));
    symlinkSync(outside, join(dir, "linked"));
    const viaDir = planTomlWrite(join(dir, "linked", "harness.toml"), "x");
    assert.equal(viaDir.action, "conflict");
    assert.throws(() => applyTomlWrite(viaDir, "x", true), /regular directory/);
    symlinkSync(join(outside, "victim"), join(dir, "a", "harness.toml"));
    const viaFile = planTomlWrite(join(dir, "a", "harness.toml"), "x");
    assert.equal(viaFile.action, "conflict");
    assert.throws(
      () => applyTomlWrite(viaFile, "x", true),
      /Not a regular file/,
    );
    // A planted temporary link cannot redirect the write.
    unlinkSync(join(dir, "a", "harness.toml"));
    symlinkSync(
      join(outside, "victim"),
      join(dir, "a", "harness.toml.harness-tmp"),
    );
    applyTomlWrite(planTomlWrite(join(dir, "a", "harness.toml"), "ok"), "ok");
    assert.equal(readFileSync(join(outside, "victim"), "utf8"), "victim");
    assert.equal(readFileSync(join(dir, "a", "harness.toml"), "utf8"), "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the engine writes the published harness to the repository and global locations", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-toml-engine2-")),
    config = join(dir, "xdg"),
    previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = config;
  const engine = new Engine({
    state: join(dir, "state"),
    sourceHash: "fixture-only",
  });
  try {
    execFileSync("git", ["init", "-q", join(dir, "repo")], { stdio: "pipe" });
    const repo = engine.enroll(join(dir, "repo"));
    const preview = engine.writeToml(repo.id, false) as { action: string };
    assert.equal(preview.action, "create");
    assert.equal(existsSync(join(dir, "repo", ".agent-harness")), false);
    engine.writeToml(repo.id, true);
    const text = readFileSync(
      join(dir, "repo", ".agent-harness", "harness.toml"),
      "utf8",
    );
    assert.ok(text.startsWith(tomlMarker));
    assert.equal(engine.writeToml(repo.id, false).action, "unchanged");
    // What was written imports back unchanged.
    assert.deepEqual(engine.importToml(repo.id, text, false), { valid: true });
    engine.writeToml(undefined, true);
    assert.ok(existsSync(join(config, "agent-harness", "harness.toml")));
    // Publishing a new global harness makes the file an update.
    engine.importToml(
      undefined,
      engine.exportToml().replace("maxDepth = 2", "maxDepth = 3"),
      true,
    );
    assert.equal(engine.writeToml(undefined, false).action, "update");
    // A hand-written file is reported, kept, and replaced only on request.
    writeFileSync(
      join(dir, "repo", ".agent-harness", "harness.toml"),
      "mine = 1\n",
    );
    const conflict = engine.writeToml(repo.id, false) as {
      action: string;
      replaceable: boolean;
    };
    assert.deepEqual(
      [conflict.action, conflict.replaceable],
      ["conflict", true],
    );
    assert.throws(
      () => engine.writeToml(repo.id, true),
      /harness.toml you wrote/,
    );
    assert.equal(
      readFileSync(join(dir, "repo", ".agent-harness", "harness.toml"), "utf8"),
      "mine = 1\n",
    );
    engine.writeToml(repo.id, true, true);
    assert.ok(
      readFileSync(
        join(dir, "repo", ".agent-harness", "harness.toml"),
        "utf8",
      ).startsWith(tomlMarker),
    );
    assert.ok(
      engine.store.db
        .prepare("SELECT 1 FROM audit WHERE event='toml.written'")
        .get(),
    );
  } finally {
    engine.close();
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
