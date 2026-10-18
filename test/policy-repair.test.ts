import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/core.js";
import { defaultPolicy, type Policy } from "../src/policy.js";
import { fixture } from "./helpers.js";

const wide: Policy = {
  ...defaultPolicy,
  tools: [...defaultPolicy.tools, "research", "execute"],
  domains: ["a.test", "b.test"],
  commands: [{ executable: "/bin/echo", args: ["ok"], env: {}, cwd: "src" }],
  allowedMcps: ["db"],
  maxDepth: 4,
};
/** Writes a policy record directly, as an older build or an edited database
 * could have left it, bypassing the checks publish applies. */
const put = (f: ReturnType<typeof fixture>, scope: string, policy: Policy) => {
  const record = { id: digest(policy), policy, activated: true, created: 1 };
  f.store.put(
    "policy",
    `${scope}:${record.id}`,
    record,
    scope === "global" ? "" : scope,
  );
  f.store.put("policy-active", scope, { id: record.id });
  f.store.put("policy-required", scope, { required: true });
};
const prohibition: Policy = {
  ...defaultPolicy,
  tools: [...defaultPolicy.tools, "research"],
  domains: ["a.test"],
  forbiddenTools: ["execute"],
  forbiddenDomains: ["b.test"],
  deniedMcps: ["db"],
};

test("a prohibition added later blocks a repository that already used it, and the exact fields are listed", () => {
  const f = fixture();
  try {
    f.policies.publish("global", wide, true);
    f.policies.publish(f.repo.id, wide, true, { acknowledgeGrants: true });
    f.policies.effective(f.repo.id);
    put(f, "global", prohibition);
    assert.throws(
      () => f.policies.effective(f.repo.id),
      /breaks a global limit/,
    );
    const fields = f.policies.violations(f.repo.id)!;
    for (const key of [
      "tools",
      "domains",
      "allowedMcps",
      "deniedMcps",
      "forbiddenTools",
      "forbiddenDomains",
    ])
      assert.ok(key in fields, key);
    assert.match(fields.tools!, /execute/);
    // Granted extras the repository was given are not violations.
    assert.ok(!("maxDepth" in fields) && !("commands" in fields));
    assert.equal(
      f.policies.violations(f.other.id),
      undefined,
      "a repository without a policy is fine",
    );
  } finally {
    f.close();
  }
});

test("repair removes only what breaks a global limit and keeps the repository's other grants", () => {
  const f = fixture();
  try {
    f.policies.publish("global", wide, true);
    f.policies.publish(f.repo.id, wide, true, { acknowledgeGrants: true });
    put(f, "global", prohibition);
    const record = f.policies.repair(f.repo.id);
    const repaired = f.policies.effective(f.repo.id).policy;
    assert.equal(f.policies.active(f.repo.id).id, record.id);
    assert.deepEqual(
      f.policies.hardErrors(prohibition, f.policies.active(f.repo.id).policy),
      {},
    );
    assert.ok(!repaired.tools.includes("execute"));
    assert.ok(repaired.tools.includes("research"), "other grants stay");
    assert.deepEqual(repaired.domains, ["a.test"]);
    assert.equal(repaired.maxDepth, 4);
    assert.deepEqual(repaired.commands, wide.commands);
    assert.deepEqual(repaired.allowedMcps, []);
    assert.deepEqual(repaired.deniedMcps, ["db"]);
    assert.deepEqual(repaired.forbiddenTools, ["execute"]);
    assert.ok(
      f.store.db
        .prepare("SELECT 1 FROM audit WHERE event='policy.repaired'")
        .get(),
    );
    assert.throws(() => f.policies.repair(f.repo.id), /Nothing to repair/);
  } finally {
    f.close();
  }
});

test("a global publish is refused only when it would break a limit, and can fix the repositories it affects", () => {
  const f = fixture();
  try {
    f.policies.publish("global", wide, true);
    f.policies.publish(f.repo.id, wide, true, { acknowledgeGrants: true });
    // Taking an ordinary default away from the global policy does not block anything.
    const lessDefault: Policy = {
      ...wide,
      tools: wide.tools.filter((t) => t !== "execute"),
      domains: ["a.test"],
    };
    f.policies.publish("global", lessDefault, true);
    assert.ok(
      f.policies.effective(f.repo.id).policy.tools.includes("execute"),
      "the repository keeps its own grant",
    );
    assert.equal(
      f.policies.effective(f.other.id).policy.tools.includes("execute"),
      false,
    );
    // A prohibition is different.
    let details: any;
    try {
      f.policies.publish("global", prohibition, true);
      assert.fail("expected a refusal");
    } catch (error) {
      details = (error as { details: unknown }).details;
      assert.match((error as Error).message, /would block 1 repository/);
    }
    assert.deepEqual(
      details.repositories.map((r: { id: string }) => r.id),
      [f.repo.id],
    );
    assert.ok("tools" in details.repositories[0].fields);
    assert.deepEqual(
      f.policies.active("global").policy.forbiddenTools,
      [],
      "nothing was published",
    );
    f.policies.publish("global", prohibition, false);
    f.policies.publish("global", prohibition, true, { repair: true });
    assert.deepEqual(f.policies.active("global").policy.forbiddenTools, [
      "execute",
    ]);
    assert.ok(
      !f.policies.effective(f.repo.id).policy.tools.includes("execute"),
    );
    assert.equal(f.policies.violations(f.repo.id), undefined);
    f.policies.publish("global", prohibition, true);
  } finally {
    f.close();
  }
});
