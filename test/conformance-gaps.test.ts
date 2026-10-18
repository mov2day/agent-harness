import test from "node:test";
import assert from "node:assert/strict";
import { hash, id, type Role } from "../src/core.js";
import { Operations, type Tool } from "../src/operations.js";
import { defaultPolicy } from "../src/policy.js";
import { fixture } from "./helpers.js";

// Adversarial cases that close conformance-matrix cells (conformance/matrix.json).
function setup(role: Role) {
  const f = fixture();
  f.policies.publish(
    "global",
    {
      ...defaultPolicy,
      deletion: true,
      tools: ["read", "change", "delete", "rename", "execute", "research"],
      domains: ["example.com"],
      commands: [
        { executable: "/bin/echo", args: ["ok"], env: {}, cwd: "src" },
      ],
    },
    true,
  );
  const auth = f.register();
  auth.session.role = role;
  auth.session.agent = auth.session.role.toLowerCase();
  auth.session.enforcement = "enforced";
  auth.session.stage =
    role === "Researcher"
      ? "research"
      : role === "Executor"
        ? "execution"
        : "implementation";
  f.identity.saveSession(auth.session);
  f.identity.revokeTokens(auth.session.session);
  const token = f.identity.issue(auth.session).capability;
  const operations = new Operations(
    f.store,
    f.identity,
    f.policies,
    () => true,
  );
  const begin = (
    tool: Tool,
    args: Record<string, unknown>,
    capability = token,
  ) =>
    operations.begin(capability, f.binding.connection, {
      tool,
      args,
      idempotencyKey: id(),
    });
  const approve = (tool: Tool, args: Record<string, unknown>) => {
    const approval = id();
    f.store.put("action-approval", approval, {
      id: approval,
      repository: f.repo.id,
      session: auth.session.root,
      action: operations.actionHash(tool, args),
      policy: auth.session.policy,
      human: true,
      valid: true,
      dependencies: [],
    });
    return { ...args, approval };
  };
  return { ...f, operations, begin, approve, token, session: auth.session };
}

test("capability gate: forged, revoked and cross-connection credentials admit no tool", () => {
  const f = setup("Implementer");
  try {
    const attempts: Array<[Tool, Record<string, unknown>]> = [
      ["read", { path: "src/a" }],
      ["change", { path: "src/a", base: null, content: "x" }],
      [
        "execute",
        { executable: "/bin/echo", args: ["ok"], env: {}, cwd: "src" },
      ],
      ["research", { url: "https://example.com/" }],
    ];
    for (const [tool, args] of attempts) {
      assert.throws(() => f.begin(tool, args, "forged-capability"));
      assert.throws(() =>
        f.operations.begin(f.token, "another-connection", {
          tool,
          args,
          idempotencyKey: id(),
        }),
      );
    }
    f.identity.revokeTokens(f.session.session);
    for (const [tool, args] of attempts)
      assert.throws(() => f.begin(tool, args));
  } finally {
    f.close();
  }
});

test("path spelling: traversal, absolute and dot-segment aliases of denied or outside paths fail", () => {
  const f = setup("Implementer");
  try {
    for (const path of [
      "../outside",
      "src/../../outside",
      "/etc/passwd",
      "src/../.env",
      "./.env",
      ".git/config",
      "src/./../.git/hooks/pre-commit",
    ])
      assert.throws(
        () =>
          f.begin(
            "change",
            f.approve("change", { path, base: null, content: "x" }),
          ),
        /path_denied|invalid|unsafe/,
        path,
      );
    assert.throws(
      () =>
        f.begin(
          "rename",
          f.approve("rename", { path: "src/a", to: "../x", base: hash("a") }),
        ),
      /path_denied|invalid|unsafe/,
    );
  } finally {
    f.close();
  }
});

test("network spelling: only exact allowlisted hostnames pass, whatever the URL form", () => {
  const f = setup("Researcher");
  try {
    for (const url of [
      "https://sub.example.com/",
      "https://example.com.evil.net/",
      "https://example.com@evil.net/",
      "https://evil.net/?host=example.com",
      "https://127.0.0.1/",
      "https://2130706433/",
      "https://[::1]/",
      "https://localhost/",
    ])
      assert.throws(() => f.begin("research", { url }), /domain_denied/, url);
    f.begin("research", { url: "https://EXAMPLE.com/path" });
  } finally {
    f.close();
  }
});

test("command spelling: path aliases, extra arguments, environment and working directory do not match", () => {
  const f = setup("Executor");
  try {
    const exact = {
      executable: "/bin/echo",
      args: ["ok"],
      env: {},
      cwd: "src",
      snapshot: "fixture-snapshot",
    };
    for (const patch of [
      { executable: "/bin/../bin/echo" },
      { executable: "echo" },
      { executable: "/bin//echo" },
      { args: ["ok", "extra"] },
      { args: [] },
      { env: { LD_PRELOAD: "/tmp/x" } },
      { cwd: "." },
      { cwd: "src/../src" },
    ])
      assert.throws(
        () => f.begin("execute", f.approve("execute", { ...exact, ...patch })),
        /command_denied/,
        JSON.stringify(patch),
      );
    f.begin("execute", f.approve("execute", exact));
  } finally {
    f.close();
  }
});
