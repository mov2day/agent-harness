import test from "node:test";
import assert from "node:assert/strict";
import { defaultPolicy, type Policy } from "../src/policy.js";
import { fixture } from "./helpers.js";

const granted = (over: Partial<Policy> = {}): Policy => ({
  ...defaultPolicy,
  tools: [...defaultPolicy.tools, "research"],
  domains: ["github.com", "karatelabs.io"],
  ...over,
});

test("one repository can be granted web research without enabling it globally or for any other repository", () => {
  const f = fixture();
  try {
    // The global defaults stay conservative: no research, no domains.
    assert.ok(!f.policies.active("global").policy.tools.includes("research"));
    assert.throws(
      () => f.policies.publish(f.repo.id, granted(), true),
      (e) => {
        const grants = (e as { details: { grants: Record<string, string> } })
          .details.grants;
        assert.deepEqual(Object.keys(grants).sort(), [
          "domains.github.com",
          "domains.karatelabs.io",
          "tools.research",
        ]);
        assert.match(
          (e as Error).message,
          /Other repositories are not affected/,
        );
        return true;
      },
    );
    assert.equal(f.policies.grantsFor(f.repo.id).length, undefined);
    assert.deepEqual(
      f.policies.grantsFor(f.repo.id),
      {},
      "nothing was published",
    );
    f.policies.publish(f.repo.id, granted(), true, { acknowledgeGrants: true });
    const mine = f.policies.effective(f.repo.id).policy;
    assert.ok(mine.tools.includes("research"));
    assert.deepEqual(mine.domains, ["github.com", "karatelabs.io"]);
    // Nothing leaked to the global policy or the other repository.
    assert.ok(!f.policies.active("global").policy.tools.includes("research"));
    assert.deepEqual(f.policies.active("global").policy.domains, []);
    const other = f.policies.effective(f.other.id).policy;
    assert.ok(!other.tools.includes("research"));
    assert.deepEqual(other.domains, []);
    assert.deepEqual(Object.keys(f.policies.grantsFor(f.repo.id)).sort(), [
      "domains.github.com",
      "domains.karatelabs.io",
      "tools.research",
    ]);
    assert.ok(
      f.store.db
        .prepare("SELECT 1 FROM audit WHERE event='policy.granted'")
        .get(),
    );
  } finally {
    f.close();
  }
});

test("only new grants need confirming, and removing a grant needs nothing", () => {
  const f = fixture();
  try {
    f.policies.publish(f.repo.id, granted(), true, { acknowledgeGrants: true });
    // The same grants again, with an unrelated edit: no prompt.
    f.policies.publish(f.repo.id, granted({ maxSpecialists: 3 }), true);
    // One new domain asks only about that domain.
    const preview = f.policies.grantPreview(
      f.repo.id,
      granted({ domains: ["github.com", "karatelabs.io", "api.github.com"] }),
    );
    assert.deepEqual(Object.keys(preview.fresh), ["domains.api.github.com"]);
    assert.equal(Object.keys(preview.grants).length, 4);
    assert.throws(
      () =>
        f.policies.publish(
          f.repo.id,
          granted({
            domains: ["github.com", "karatelabs.io", "api.github.com"],
          }),
          true,
        ),
      /Fetching from api\.github\.com/,
    );
    // Removing grants, or going back to the defaults, never prompts.
    f.policies.publish(f.repo.id, granted({ domains: ["github.com"] }), true);
    f.policies.publish(f.repo.id, defaultPolicy, true);
    assert.deepEqual(f.policies.grantsFor(f.repo.id), {});
    // A removed grant has to be confirmed again if it is asked for later.
    assert.throws(
      () => f.policies.publish(f.repo.id, granted(), true),
      /Needs your confirmation/,
    );
  } finally {
    f.close();
  }
});

const details = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { details: Record<string, string> }).details;
  }
  assert.fail("expected a refusal");
};

test("things forbidden everywhere cannot be granted to any repository", () => {
  const f = fixture();
  try {
    const global = {
      ...defaultPolicy,
      forbiddenTools: ["execute" as const],
      forbiddenDomains: ["evil.test"],
    };
    f.policies.publish("global", global, true);
    const publish = (patch: Partial<Policy>, acknowledgeGrants = true) =>
      f.policies.publish(f.repo.id, { ...global, ...patch }, true, {
        acknowledgeGrants,
      });
    assert.match(
      details(() => publish({ tools: [...defaultPolicy.tools, "execute"] }))!
        .tools!,
      /Forbidden in every repository: execute/,
    );
    assert.match(
      details(() => publish({ domains: ["evil.test"] }))!.domains!,
      /Forbidden in every repository: evil\.test/,
    );
    // Confirming grants never overrides a prohibition, and a repository cannot drop one.
    assert.ok(
      "forbiddenTools" in details(() => publish({ forbiddenTools: [] }))!,
    );
    assert.throws(
      () =>
        f.policies.publish(
          "global",
          { ...defaultPolicy, forbiddenTools: ["read"] },
          true,
        ),
      /both allowed and forbidden/,
    );
  } finally {
    f.close();
  }
});

test("grants cover limits, commands, review settings and agents, each reported per permission", () => {
  const f = fixture();
  try {
    const keys = Object.keys(
      f.policies.grantsBeyond(defaultPolicy, {
        ...defaultPolicy,
        maxDepth: 5,
        deletion: true,
        commands: [
          { executable: "/bin/echo", args: ["ok"], env: {}, cwd: "src" },
        ],
        humanGates: [],
        orchestration: { verifyStages: [], reviewStages: ["plan"] },
        humanReview: {
          beforeStages: [],
          externalContent: "off",
          trustedDomains: [],
        },
      }),
    );
    for (const key of [
      "maxDepth",
      "deletion",
      "humanGates.implementation",
      "orchestration.verifyStages.research",
      "orchestration.reviewStages.implementation",
      "humanReview.externalContent",
    ])
      assert.ok(keys.includes(key), key);
    assert.ok(keys.some((k) => k.startsWith("commands.")));
    // Staying at or below the defaults grants nothing.
    assert.deepEqual(
      f.policies.grantsBeyond(defaultPolicy, {
        ...defaultPolicy,
        maxDepth: 1,
        humanGates: ["implementation", "plan"],
      }),
      {},
    );
  } finally {
    f.close();
  }
});
