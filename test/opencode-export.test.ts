import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicy, type Policy } from "../src/policy.js";
import { builtinAgents, type AgentDef } from "../src/agents.js";
import {
  applyExport,
  managedMarker,
  openCodePathPatterns,
  planExport,
  renderAgent,
} from "../src/opencode-export.js";

const policy: Policy = {
  ...defaultPolicy,
  tools: [...defaultPolicy.tools, "change", "execute", "research"],
  humanGates: [],
  allowedMcps: ["repo-db", "shell"],
  deniedMcps: ["shell"],
};
const agent = (id: string) => builtinAgents.find((a) => a.id === id)!;
const temp = () => mkdtempSync(join(tmpdir(), "harness-opencode-"));

test("agents render with OpenCode permissions limited to what the harness grants", () => {
  const planner = renderAgent(
    {
      ...agent("planner"),
      mcps: ["repo-db", "shell"],
      model: { model: "m", reasoning: "high" },
    },
    policy,
    builtinAgents,
  );
  assert.match(planner, /^---\ndescription: "Reads approved context/);
  assert.match(planner, /mode: subagent/);
  assert.match(planner, /model: "m"/);
  // Paths the policy protects stay denied even where reading is granted.
  assert.match(
    planner,
    /permission:\n  read:\n    "\*": allow\n    "\.git\/\*": deny\n    "\.git": deny\n    "\.env": deny\n    "\.env\.\*": deny\n    "\*\/secrets\/\*": deny\n    "secrets\/\*": deny\n/,
  );
  assert.match(planner, /  edit: deny/);
  assert.match(planner, /  bash: deny/);
  assert.match(planner, /  webfetch: deny/);
  assert.match(planner, /  external_directory: deny/);
  assert.match(planner, /  task:\n    "\*": deny\n  skill:/, "no delegation");
  // MCP servers are switched in `permission`; the `tools` map is deprecated.
  assert.match(planner, /  "repo-db_\*": allow/);
  assert.match(
    planner,
    /  "shell_\*": deny/,
    "a denied server is never granted",
  );
  assert.doesNotMatch(planner, /^tools:/m);
  assert.match(
    renderAgent(agent("planner"), policy, builtinAgents),
    /  "repo-db_\*": deny/,
    "allowed but not given to this agent",
  );
  assert.match(planner, new RegExp(managedMarker));
  assert.match(planner, /You are the Planner\./);
  assert.doesNotMatch(planner, /Harness protocol/);
  // Writes, commands and web access follow the policy and manual review settings.
  const implementer = renderAgent(agent("implementer"), policy, builtinAgents);
  assert.match(implementer, /  edit:\n    "\*": allow\n    "\.git\/\*": deny/);
  assert.match(
    renderAgent(
      agent("implementer"),
      { ...policy, humanGates: ["implementation"] },
      builtinAgents,
    ),
    /  edit:\n    "\*": ask\n/,
  );
  assert.match(
    renderAgent(
      agent("implementer"),
      {
        ...policy,
        humanReview: {
          ...policy.humanReview,
          beforeStages: ["implementation"],
        },
      },
      builtinAgents,
    ),
    /  edit:\n    "\*": ask\n/,
  );
  assert.match(
    renderAgent(agent("executor"), policy, builtinAgents),
    /  bash: ask/,
  );
  assert.match(
    renderAgent(
      agent("executor"),
      { ...policy, tools: ["read"] },
      builtinAgents,
    ),
    /  bash: deny/,
    "tools the policy does not enable are off",
  );
  const researcher = (mode: Policy["humanReview"]["externalContent"]) =>
    renderAgent(
      agent("researcher"),
      {
        ...policy,
        domains: ["github.com"],
        humanReview: { ...policy.humanReview, externalContent: mode },
      },
      builtinAgents,
    );
  assert.match(
    researcher("approve-content"),
    /  webfetch: ask\n  websearch: ask/,
  );
  assert.match(researcher("approve-url"), /  webfetch: ask/);
  assert.match(researcher("off"), /  webfetch: allow/);
  const skilled = renderAgent(
    { ...agent("planner"), skills: ["lint", "denied"] },
    { ...policy, allowedSkills: ["lint", "denied"], deniedSkills: ["denied"] },
    builtinAgents,
  );
  assert.match(skilled, /  skill:\n    "\*": deny\n    "lint": allow/);
  assert.doesNotMatch(skilled, /"denied": allow/);
});

test("the orchestrator may delegate only to enabled harness agents and carries the protocol", () => {
  const agents = builtinAgents.map((a) =>
    a.id === "executor" ? { ...a, enabled: false } : a,
  );
  const orchestrator = renderAgent(
    agent("orchestrator"),
    {
      ...policy,
      maxDepth: 2,
      humanGates: ["plan"],
      humanReview: {
        beforeStages: ["implementation"],
        externalContent: "approve-content",
        trustedDomains: ["docs.example.com"],
      },
    },
    agents,
  );
  assert.match(orchestrator, /mode: primary/);
  assert.match(
    orchestrator,
    /  task:\n    "\*": deny\n    "harness-verifier": allow\n    "harness-reviewer": allow\n    "harness-researcher": allow\n    "harness-planner": allow\n    "harness-implementer": allow\n/,
  );
  assert.doesNotMatch(orchestrator, /harness-executor": allow/);
  assert.doesNotMatch(orchestrator, /harness-orchestrator": allow/);
  assert.match(orchestrator, /## Harness protocol/);
  assert.match(
    orchestrator,
    /approves before the stage starts: implementation/,
  );
  assert.match(orchestrator, /approves after the stage finishes: plan/);
  assert.match(
    orchestrator,
    /external content: approve-content \(trusted: docs\.example\.com\)/,
  );
  assert.match(orchestrator, /At most 2 levels of delegation/);
});

test("plan and apply create managed files, are idempotent and skip disabled agents", () => {
  const dir = temp(),
    base = join(dir, ".opencode");
  try {
    const agents = builtinAgents.map((a) =>
      a.id === "executor" ? { ...a, enabled: false } : a,
    );
    const first = planExport(base, agents, policy);
    assert.deepEqual(
      first.files.map((f) => [f.name, f.action]),
      [
        ["harness-orchestrator.md", "create"],
        ["harness-verifier.md", "create"],
        ["harness-reviewer.md", "create"],
        ["harness-researcher.md", "create"],
        ["harness-planner.md", "create"],
        ["harness-implementer.md", "create"],
      ],
    );
    assert.equal(existsSync(base), false, "planning writes nothing");
    assert.equal(applyExport(base, first).length, 6);
    assert.ok(
      planExport(base, agents, policy).files.every(
        (f) => f.action === "unchanged",
      ),
    );
    // A changed prompt updates the managed file only.
    const edited = agents.map((a) =>
      a.id === "planner" ? { ...a, systemPrompt: "New prompt." } : a,
    );
    const update = planExport(base, edited, policy).files.filter(
      (f) => f.action !== "unchanged",
    );
    assert.deepEqual(
      update.map((f) => [f.name, f.action]),
      [["harness-planner.md", "update"]],
    );
    applyExport(base, planExport(base, edited, policy));
    assert.match(
      readFileSync(join(base, "agent", "harness-planner.md"), "utf8"),
      /New prompt\./,
    );
    // Turning an agent off removes only its managed file.
    writeFileSync(join(base, "agent", "mine.md"), "my own agent");
    writeFileSync(join(base, "agent", "harness-custom.md"), "not managed");
    const off = edited.map((a) =>
      a.id === "researcher" ? { ...a, enabled: false } : a,
    );
    const plan = planExport(base, off, policy);
    assert.deepEqual(
      plan.files.filter((f) => f.action === "remove").map((f) => f.name),
      ["harness-researcher.md"],
    );
    applyExport(base, plan);
    assert.deepEqual(readdirSync(join(base, "agent")).sort(), [
      "harness-custom.md",
      "harness-implementer.md",
      "harness-orchestrator.md",
      "harness-planner.md",
      "harness-reviewer.md",
      "harness-verifier.md",
      "mine.md",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("files the harness did not create are never overwritten", () => {
  const dir = temp(),
    base = join(dir, ".opencode");
  try {
    mkdirSync(join(base, "agent"), { recursive: true });
    const own = join(base, "agent", "harness-planner.md");
    writeFileSync(own, "hand written");
    const plan = planExport(base, builtinAgents, policy);
    assert.deepEqual(
      plan.files.find((f) => f.name === "harness-planner.md")?.action,
      "conflict",
    );
    const written = applyExport(base, plan);
    assert.equal(readFileSync(own, "utf8"), "hand written");
    assert.ok(!written.some((w) => w.name === "harness-planner.md"));
    assert.ok(existsSync(join(base, "agent", "harness-reviewer.md")));
    // A file edited after the preview is not replaced.
    const later = planExport(base, builtinAgents, policy);
    writeFileSync(join(base, "agent", "harness-reviewer.md"), "changed");
    assert.equal(
      later.files.find((f) => f.name === "harness-reviewer.md")?.action,
      "unchanged",
    );
    const stale = planExport(
      base,
      builtinAgents.map((a) =>
        a.id === "reviewer" ? { ...a, systemPrompt: "Other." } : a,
      ),
      policy,
    );
    assert.equal(
      stale.files.find((f) => f.name === "harness-reviewer.md")?.action,
      "conflict",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("symlinked configuration directories and files are refused", () => {
  const dir = temp(),
    outside = join(dir, "outside");
  try {
    mkdirSync(outside);
    const repo = join(dir, "repo");
    mkdirSync(repo);
    symlinkSync(outside, join(repo, ".opencode"));
    assert.throws(
      () => planExport(join(repo, ".opencode"), builtinAgents, policy),
      /must be a regular directory/,
    );
    const other = join(dir, "other", ".opencode");
    mkdirSync(join(other, "agent"), { recursive: true });
    const target = join(outside, "victim.md");
    writeFileSync(target, "victim");
    symlinkSync(target, join(other, "agent", "harness-planner.md"));
    const plan = planExport(other, builtinAgents, policy);
    assert.equal(
      plan.files.find((f) => f.name === "harness-planner.md")?.action,
      "conflict",
    );
    // A planted temporary-file link cannot redirect the write.
    symlinkSync(
      target,
      join(other, "agent", "harness-reviewer.md.harness-tmp"),
    );
    applyExport(other, plan);
    assert.equal(readFileSync(target, "utf8"), "victim");
    assert.match(
      readFileSync(join(other, "agent", "harness-reviewer.md"), "utf8"),
      /You are the Reviewer\./,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a native Researcher is told what it really has instead of waiting for a gateway", () => {
  const on: Policy = {
    ...policy,
    tools: [...policy.tools, "research"],
    domains: ["github.com", "karatelabs.io"],
    humanReview: { ...policy.humanReview, externalContent: "approve-content" },
  };
  const text = renderAgent(agent("researcher"), on, builtinAgents);
  assert.match(text, /## Web access in this OpenCode session/);
  assert.match(text, /not available here\. Do not report that you cannot work/);
  assert.match(
    text,
    /use OpenCode's `websearch` tool to find pages and its `webfetch` tool to read them/,
  );
  assert.match(text, /started with `OPENCODE_ENABLE_EXA=1`/);
  assert.match(text, /OpenCode asks the owner before each search and fetch/);
  assert.match(text, /Fetch only these hosts: github\.com, karatelabs\.io/);
  assert.match(text, /github\.com\/OWNER\/REPO\/releases/);
  assert.doesNotMatch(
    text,
    /api\.github\.com/,
    "never suggests a host the policy does not allow",
  );
  assert.match(
    renderAgent(
      agent("researcher"),
      { ...on, domains: ["api.github.com", "github.com"] },
      builtinAgents,
    ),
    /api\.github\.com\/repos\/OWNER\/REPO\/releases\/latest/,
  );
  assert.match(
    text,
    /If a fetch is denied, rejected or pending, say exactly that/,
  );
  assert.match(text, /  webfetch: ask/);
  // The default prompt no longer insists on a gateway that is not there.
  assert.doesNotMatch(
    agent("researcher").systemPrompt,
    /only through the research gateway/,
  );
  // No allowed hosts: the agent is told to fetch nothing and cannot.
  const none = renderAgent(
    agent("researcher"),
    { ...on, domains: [] },
    builtinAgents,
  );
  assert.match(none, /allows no hosts, so do not fetch anything/);
  assert.match(none, /  webfetch: deny\n  websearch: deny/);
  assert.doesNotMatch(
    renderAgent(
      agent("researcher"),
      { ...on, humanReview: { ...on.humanReview, externalContent: "off" } },
      builtinAgents,
    ),
    /OpenCode asks the owner/,
    "with review off nothing asks",
  );
  // Research off in the policy: it says so and points to the control tower.
  const off = renderAgent(
    agent("researcher"),
    { ...policy, tools: policy.tools.filter((t) => t !== "research") },
    builtinAgents,
  );
  assert.match(off, /turned off in the harness policy/);
  assert.match(off, /Agents → Web research/);
  assert.match(off, /  webfetch: deny/);
  // Other agents get no web section.
  assert.doesNotMatch(
    renderAgent(agent("planner"), on, builtinAgents),
    /Web access in this OpenCode session/,
  );
});

test("policy path globs become OpenCode deny patterns that never cover less", () => {
  assert.deepEqual(openCodePathPatterns(".env"), [".env"]);
  assert.deepEqual(openCodePathPatterns(".git/**"), [".git/*", ".git"]);
  assert.deepEqual(openCodePathPatterns("**/secrets/**"), [
    "*/secrets/*",
    "secrets/*",
    "*/secrets",
    "secrets",
  ]);
  assert.deepEqual(openCodePathPatterns("config/*.{pem,key}"), [
    "config/*.pem",
    "config/*.key",
  ]);
  assert.deepEqual(openCodePathPatterns("id_[rd]sa"), ["id_?sa"]);
  // No protected paths: plain actions, as before.
  const open = renderAgent(
    agent("implementer"),
    { ...policy, denyPaths: [] },
    builtinAgents,
  );
  assert.match(open, /  read: allow\n/);
  assert.match(open, /  edit: allow\n/);
  // A denied tool stays a single deny.
  assert.match(
    renderAgent(agent("researcher"), policy, builtinAgents),
    /  read: deny\n/,
  );
});
