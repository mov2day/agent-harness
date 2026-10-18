import test from "node:test";
import assert from "node:assert/strict";
import { defaultPolicy, type Policy } from "../src/policy.js";
import { builtinAgents, type AgentDef } from "../src/agents.js";
import { digest } from "../src/core.js";
import { fixture } from "./helpers.js";

const agent = (id: string, patch: Partial<AgentDef> = {}): AgentDef => ({
  id,
  name: id,
  kind: "custom",
  baseRole: "Planner",
  description: "",
  systemPrompt: "Plan carefully.",
  tools: ["read", "artifact", "compact", "model"],
  skills: [],
  mcps: [],
  enabled: true,
  ...patch,
});
const withAgents = (
  agents: AgentDef[],
  patch: Partial<Policy> = {},
): Policy => ({ ...defaultPolicy, agents, ...patch });
const builtin = (id: string, patch: Partial<AgentDef> = {}) =>
  builtinAgents.map((a) => (a.id === id ? { ...a, ...patch } : a));

test("default policy carries the mandatory and default agents", () => {
  const f = fixture();
  try {
    const ids = f.policies.effective(f.repo.id).policy.agents.map((a) => a.id);
    assert.deepEqual(ids, [
      "orchestrator",
      "verifier",
      "reviewer",
      "researcher",
      "planner",
      "implementer",
      "executor",
    ]);
  } finally {
    f.close();
  }
});

test("mandatory agents cannot be removed, disabled or retargeted", () => {
  const f = fixture();
  try {
    const publish = (agents: AgentDef[]) =>
      f.policies.publish("global", withAgents(agents), true);
    assert.throws(
      () => publish(builtinAgents.filter((a) => a.id !== "verifier")),
      /Agent configuration is invalid/,
    );
    assert.throws(
      () => publish(builtin("reviewer", { enabled: false })),
      /Policy validation failed/,
    );
    assert.throws(
      () => publish(builtin("orchestrator", { baseRole: "Planner" })),
      /Policy validation failed/,
    );
    assert.throws(
      () => publish(builtin("verifier", { kind: "custom" })),
      /Policy validation failed/,
    );
    // Prompts stay owner-editable.
    publish(builtin("verifier", { systemPrompt: "Be strict." }));
  } finally {
    f.close();
  }
});

test("agents are bounded by their base role, id rules and policy lists", () => {
  const f = fixture();
  try {
    const bad = (a: AgentDef, re: RegExp) =>
      assert.throws(
        () =>
          f.policies.publish("global", withAgents([...builtinAgents, a]), true),
        re,
      );
    bad(agent("scout", { tools: ["read", "change"] }), /Policy validation/);
    bad(agent("researcher"), /Policy validation/);
    bad(agent("boss", { baseRole: "Conductor" }), /Policy validation/);
    bad(agent("sneaky", { kind: "mandatory" }), /Policy validation/);
    bad(agent("skilled", { skills: ["lint"] }), /Agent configuration/);
    f.policies.publish(
      "global",
      withAgents([...builtinAgents, agent("skilled", { skills: ["lint"] })], {
        allowedSkills: ["lint"],
      }),
      true,
    );
    assert.throws(
      () =>
        f.policies.publish(
          "global",
          withAgents(
            [...builtinAgents, agent("skilled", { skills: ["lint"] })],
            { allowedSkills: ["lint"], deniedSkills: ["lint"] },
          ),
          true,
        ),
      /Agent configuration/,
    );
  } finally {
    f.close();
  }
});

test("repository policy inherits, narrows and adds; widening an agent is a confirmed grant to that repository only", () => {
  const f = fixture();
  try {
    f.policies.publish(
      "global",
      withAgents(builtin("executor", { enabled: false })),
      true,
    );
    const publish = (
      agents: AgentDef[],
      patch: Partial<Policy> = {},
      acknowledgeGrants = false,
    ) =>
      f.policies.publish(
        f.repo.id,
        { ...f.policies.effective(f.repo.id).policy, ...patch, agents },
        true,
        { acknowledgeGrants },
      );
    // Enabling an agent the global harness keeps off is a grant: it needs the
    // owner's confirmation, and it applies to this repository only.
    assert.throws(
      () => publish(builtin("executor", { enabled: true })),
      /Needs your confirmation[^]*Enable Executor/,
    );
    publish(builtin("executor", { enabled: true }), {}, true);
    assert.equal(
      f.policies
        .effective(f.repo.id)
        .policy.agents.find((a) => a.id === "executor")?.enabled,
      true,
    );
    assert.equal(
      f.policies
        .effective(f.other.id)
        .policy.agents.find((a) => a.id === "executor")?.enabled,
      false,
      "another repository still follows the global default",
    );
    assert.deepEqual(Object.keys(f.policies.grantsFor(f.repo.id)), [
      "agents.executor.enabled",
    ]);
    // Turning the grant off again needs no confirmation.
    publish(builtin("executor", { enabled: false }));
    assert.deepEqual(f.policies.grantsFor(f.repo.id), {});
    assert.throws(
      () =>
        publish(
          builtin("planner", {
            tools: ["read", "artifact", "compact", "model", "change"] as any,
          }),
        ),
      /Policy validation/,
    );
    publish([
      agent("repo-reviewer", {
        baseRole: "Reviewer",
        tools: ["review", "artifact", "compact", "model"],
      }),
      { ...builtinAgents[4]!, enabled: false } /* planner */,
    ]);
    const merged = f.policies.effective(f.repo.id).policy.agents;
    assert.equal(merged.find((a) => a.id === "planner")?.enabled, false);
    assert.equal(merged.find((a) => a.id === "researcher")?.enabled, true);
    assert.ok(merged.some((a) => a.id === "repo-reviewer"));
    // A global denial cannot be dropped by a repository: the change is refused
    // while the repository would be left blocked, unless it is tightened too.
    const stricter = withAgents(builtinAgents, { deniedMcps: ["shell"] });
    assert.throws(
      () => f.policies.publish("global", stricter, true),
      /would block 1 repository/,
    );
    f.policies.publish("global", stricter, true, { repair: true });
    assert.deepEqual(f.policies.effective(f.repo.id).policy.deniedMcps, [
      "shell",
    ]);
  } finally {
    f.close();
  }
});

import { Operations } from "../src/operations.js";
import { Artifacts, Workflow } from "../src/workflow.js";

function runtime(patch: Partial<Policy> = {}) {
  const f = fixture();
  f.policies.publish(
    "global",
    {
      ...defaultPolicy,
      tools: [...defaultPolicy.tools, "execute", "research"],
      ...patch,
    },
    true,
  );
  const root = f.register().session;
  root.enforcement = "enforced";
  f.identity.saveSession(root);
  const operations = new Operations(
      f.store,
      f.identity,
      f.policies,
      () => true,
    ),
    artifacts = new Artifacts(f.store, f.identity),
    workflow = new Workflow(
      f.store,
      f.identity,
      f.policies,
      artifacts,
      operations,
      { Planner: { m: ["high"] }, Executor: { m: ["high"] } },
    );
  const admit = (
    ...args: Parameters<Workflow["admit"]> extends [any, ...infer R] ? R : never
  ) => {
    const { session } = workflow.admit(
      f.identity.session(root.session),
      ...args,
    );
    session.enforcement = "enforced";
    f.identity.saveSession(session);
    return session;
  };
  return { ...f, root, operations, workflow, admit };
}

test("admission is limited to enabled, owner-approved agents", () => {
  const f = runtime({
    agents: builtin("executor", { enabled: false }).concat(
      agent("auditor", {
        baseRole: "Reviewer",
        tools: ["review", "artifact", "compact", "model"],
      }),
    ),
  });
  try {
    assert.throws(() => f.admit("Executor"), /agent_unavailable/);
    assert.throws(
      () => f.admit(undefined, undefined, "ghost"),
      /agent_unavailable/,
    );
    assert.throws(
      () => f.admit("Planner", undefined, "auditor"),
      /agent_role_mismatch/,
    );
    const custom = f.admit(undefined, undefined, "auditor");
    assert.equal(custom.role, "Reviewer");
    assert.equal(custom.agent, "auditor");
    assert.equal(f.admit("Planner").agent, "planner");
    assert.equal(f.root.agent, "orchestrator");
  } finally {
    f.close();
  }
});

test("an agent can use only the tools its definition keeps", () => {
  const agents = builtinAgents
    .map((a) =>
      a.id === "researcher"
        ? {
            ...a,
            enabled: true,
            tools: [
              "read",
              "artifact",
              "compact",
              "model",
            ] as AgentDef["tools"],
          }
        : a,
    )
    .concat(agent("thinker", { tools: ["compact", "model", "artifact"] }));
  const f = runtime({ agents });
  try {
    const researcher = f.admit("Researcher");
    f.operations.authorize(researcher, "read", { path: "a.txt" });
    assert.throws(
      () =>
        f.operations.authorize(researcher, "research", {
          url: "https://x.test/",
        }),
      /agent_tool_denied/,
    );
    const thinker = f.admit(undefined, undefined, "thinker");
    assert.throws(
      () => f.operations.authorize(thinker, "read", { path: "a.txt" }),
      /agent_tool_denied/,
    );
    // Web research stays with the Researcher base role whatever an agent lists.
    const executor = f.admit("Executor");
    assert.throws(
      () =>
        f.operations.authorize(executor, "research", {
          url: "https://x.test/",
        }),
      /role_authority/,
    );
  } finally {
    f.close();
  }
});

test("a session whose agent was disabled loses authority", () => {
  const f = runtime();
  try {
    const planner = f.admit("Planner");
    f.policies.publish(
      "global",
      withAgents(builtin("planner", { enabled: false })),
      true,
    );
    assert.throws(
      () => f.operations.authorize(planner, "read", { path: "a" }),
      /policy_changed|agent_unavailable/,
    );
  } finally {
    f.close();
  }
});

test("agent model overrides apply and are validated against capabilities", () => {
  const f = runtime({
    agents: builtin("planner", { model: { model: "m", reasoning: "high" } }),
  });
  try {
    assert.deepEqual(f.admit("Planner").model, {
      model: "m",
      reasoning: "high",
    });
  } finally {
    f.close();
  }
  const bad = runtime({
    agents: builtin("planner", { model: { model: "m", reasoning: "ultra" } }),
  });
  try {
    assert.throws(() => bad.admit("Planner"), /unsupported_model/);
  } finally {
    bad.close();
  }
});

test("a session whose agent does not match its role is denied", () => {
  const f = runtime();
  try {
    const planner = f.admit("Planner");
    f.operations.authorize(planner, "read", { path: "a" });
    f.identity.saveSession({ ...planner, agent: "orchestrator" });
    assert.throws(
      () =>
        f.operations.authorize(f.identity.session(planner.session), "read", {
          path: "a",
        }),
      /agent_unavailable/,
    );
  } finally {
    f.close();
  }
});

test("policies from before agents existed are upgraded with restrictive defaults", () => {
  const f = fixture();
  try {
    const legacy = (p: Policy) => {
      const {
        agents: _a,
        allowedSkills: _s,
        deniedSkills: _ds,
        allowedMcps: _m,
        deniedMcps: _dm,
        orchestration: _o,
        ...old
      } = p;
      return old;
    };
    const put = (scope: string, policy: object) => {
      const record = {
        id: digest(policy),
        policy,
        activated: true,
        created: 1,
      };
      f.store.put(
        "policy",
        `${scope}:${record.id}`,
        record,
        scope === "global" ? "" : scope,
      );
      f.store.put("policy-active", scope, { id: record.id });
    };
    put("global", { ...legacy(defaultPolicy), maxDepth: 3 });
    put(f.repo.id, { ...legacy(defaultPolicy), maxDepth: 2 });
    f.store.put("policy-required", f.repo.id, { required: true });
    assert.throws(() => f.policies.effective(f.repo.id), /invalid/);
    assert.deepEqual(f.policies.migrateLegacy(), ["global", f.repo.id]);
    const e = f.policies.effective(f.repo.id);
    assert.equal(e.policy.maxDepth, 2);
    assert.equal(e.policy.agents.length, 7);
    assert.deepEqual(e.policy.allowedSkills, []);
    assert.equal(f.policies.active("global").policy.maxDepth, 3);
    assert.deepEqual(f.policies.migrateLegacy(), []);
    // Genuinely invalid policies stay blocked.
    put("global", { ...legacy(defaultPolicy), maxDepth: 99 });
    assert.deepEqual(f.policies.migrateLegacy(), []);
    assert.throws(() => f.policies.effective(f.repo.id), /invalid/);
  } finally {
    f.close();
  }
});

test("a repository can give its own skills and MCP servers to an agent but not allow a globally denied one", () => {
  const f = fixture();
  try {
    f.policies.publish(
      "global",
      withAgents(builtinAgents, { deniedMcps: ["shell"] }),
      true,
    );
    const publish = (patch: Partial<Policy>, agents: AgentDef[]) =>
      f.policies.publish(
        f.repo.id,
        {
          ...f.policies.effective(f.repo.id).policy,
          deniedMcps: ["shell"],
          ...patch,
          agents,
        },
        true,
      );
    const planner = {
      ...builtinAgents[4]!,
      skills: ["house-style"],
      mcps: ["repo-db"],
    };
    publish({ allowedSkills: ["house-style"], allowedMcps: ["repo-db"] }, [
      planner,
    ]);
    assert.deepEqual(
      f.policies
        .effective(f.repo.id)
        .policy.agents.find((a) => a.id === "planner")?.skills,
      ["house-style"],
    );
    assert.throws(
      () =>
        publish({ allowedMcps: ["shell"] }, [{ ...planner, mcps: ["shell"] }]),
      /breaks a global limit/,
    );
  } finally {
    f.close();
  }
});

import { coreTools, leastPrivilegeNotes, stageRoles } from "../src/agents.js";

test("agents cannot be built without the tools they need to work", () => {
  const f = fixture();
  try {
    const publish = (agents: AgentDef[]) =>
      f.policies.publish("global", withAgents(agents), true);
    // Plumbing tools are not optional for any agent.
    for (const tool of coreTools)
      assert.throws(
        () =>
          publish(
            builtin("planner", {
              tools: ["read", ...coreTools.filter((t) => t !== tool)],
            }),
          ),
        /Policy validation failed/,
        tool,
      );
    // The mandatory agents cannot lose the tool that is their job.
    assert.throws(
      () =>
        publish(
          builtin("orchestrator", {
            tools: coreTools,
          }),
        ),
      /Policy validation failed/,
    );
    for (const id of ["verifier", "reviewer"])
      assert.throws(
        () => publish(builtin(id, { tools: ["read", ...coreTools] })),
        /Policy validation failed/,
        id,
      );
    // A custom agent with no capabilities beyond the plumbing is allowed.
    publish([...builtinAgents, agent("quiet", { tools: [...coreTools] })]);
  } finally {
    f.close();
  }
});

test("built-in agents default to least privilege and notes flag departures", () => {
  const by = (id: string) => builtinAgents.find((a) => a.id === id)!;
  assert.deepEqual([...by("researcher").tools].sort(), [
    "artifact",
    "compact",
    "model",
    "research",
  ]);
  assert.ok(!by("verifier").tools.includes("execute"));
  assert.ok(by("verifier").tools.includes("review"));
  assert.ok(by("executor").tools.includes("execute"));
  assert.deepEqual(leastPrivilegeNotes(builtinAgents), []);
  const widened = builtinAgents.map((a) =>
    a.id === "researcher"
      ? { ...a, tools: [...a.tools, "read" as const] }
      : a.id === "verifier"
        ? { ...a, tools: [...a.tools, "execute" as const] }
        : a,
  );
  assert.equal(leastPrivilegeNotes(widened).length, 2);
  // The Executor can run the verification stage; the Verifier only judges it.
  assert.deepEqual(stageRoles.verification, ["Executor", "Verifier"]);
});
