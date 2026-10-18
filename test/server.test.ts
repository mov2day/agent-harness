import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { Engine } from "../src/engine.js";
import { createEngineServer, ownerCredential } from "../src/server.js";
import { sign, id } from "../src/core.js";
import {
  IntegrationBridge,
  HttpTransport,
  boundRelay,
} from "../src/adapters/bridge.js";
async function serve() {
  const dir = mkdtempSync(join(tmpdir(), "harness-http-")),
    engine = new Engine({
      state: join(dir, "state"),
      sourceHash: "fixture-only",
    }),
    credential = ownerCredential(join(dir, "state")),
    server = createEngineServer(engine, credential.token, resolve("web"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    engine,
    origin,
    dir,
    credential,
    async post(
      path: string,
      data: unknown,
      headers: Record<string, string> = {},
    ) {
      return fetch(origin + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(data),
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      engine.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("HTTP: evaluation suites and job controls require owner credentials and keep held-out criteria out of state summaries", async () => {
  const f = await serve();
  try {
    execFileSync("git", ["init", "-q", join(f.dir, "repository")], {
      stdio: "pipe",
    });
    const repo = f.engine.enroll(join(f.dir, "repository"));
    const integration = f.engine.identity.pair("opencode");
    const binding = {
      integration: integration.id,
      repository: repo.id,
      runtimeSession: id(),
      connection: id(),
    };
    const registration = {
      ...binding,
      nonce: f.engine.identity.challenge(binding).nonce,
    };
    const auth = f.engine.identity.register(
      registration,
      sign(integration.secret, registration),
    );
    const definition = {
      version: "http-suite-1",
      scope: repo.id,
      cases: (["fixture", "heldout"] as const).flatMap((split) =>
        (["control", "quality"] as const).map((kind) => ({
          id: `${split}-${kind}`,
          kind,
          split,
          modelDependent: true,
          prompt: "HTTP fixture task",
          output: "text",
          maxOutputTokens: 256,
          checks: [
            {
              path: [],
              operator: "equals",
              expected: "private-heldout-answer",
            },
          ],
        })),
      ),
    };
    const owner = {
      authorization: `Bearer ${f.credential.token}`,
      origin: f.origin,
    };
    assert.notEqual(
      (await f.post("/v1/owner/learning/suites", definition)).status,
      200,
    );
    assert.notEqual(
      (
        await f.post("/v1/owner/learning/suites", definition, {
          authorization: `Bearer ${auth.capability}`,
          "x-harness-connection": binding.connection,
        })
      ).status,
      200,
    );
    const installed = await f.post(
      "/v1/owner/learning/suites",
      definition,
      owner,
    );
    assert.equal(installed.status, 200);
    const suite = await installed.json();
    assert.equal(suite.cases, 4);
    assert.match(suite.id, /^[a-f0-9]{64}$/);
    const state = await (await f.post("/v1/owner/state", {}, owner)).json();
    assert.equal(
      JSON.stringify(state).includes("private-heldout-answer"),
      false,
    );
    assert.equal(state.evaluationSuites[0].scope, repo.id);
    for (const route of ["evaluate", "cancel", "evidence"]) {
      assert.notEqual(
        (
          await f.post(
            `/v1/owner/learning/${route}`,
            { job: id() },
            {
              authorization: `Bearer ${auth.capability}`,
              "x-harness-connection": binding.connection,
            },
          )
        ).status,
        200,
      );
    }
    const invalid = await f.post(
      "/v1/owner/learning/evaluate",
      {
        session: auth.session.session,
        candidate: id(),
        suite: suite.id,
        idempotencyKey: "run",
        checks: ["overwrite"],
      },
      owner,
    );
    assert.equal(invalid.status, 400);
    assert.equal(f.engine.store.list("evaluation-job").length, 0);
  } finally {
    await f.close();
  }
});
test("HTTP: live nonce race, lost response recovery and isolation bindings", async () => {
  const f = await serve();
  try {
    execFileSync("git", ["init", "-q", join(f.dir, "repository")], {
      stdio: "pipe",
    });
    const repo = f.engine.enroll(join(f.dir, "repository")),
      integration = f.engine.identity.pair("opencode"),
      binding = {
        integration: integration.id,
        repository: repo.id,
        runtimeSession: "externally-started",
        connection: "trusted-bridge",
      };
    const challenge = await (
        await f.post("/v1/integrations/challenge", binding)
      ).json(),
      registration = { ...binding, nonce: challenge.nonce },
      proof = sign(integration.secret, registration);
    const responses = await Promise.all(
      Array.from({ length: 16 }, () =>
        f.post("/v1/integrations/register", { binding: registration, proof }),
      ),
    );
    assert.equal(responses.filter((r) => r.status === 200).length, 1);
    assert.equal(f.engine.store.list("session").length, 1);
    const time = f.engine.store.clock.now(),
      recovery = await (
        await f.post("/v1/integrations/status", {
          binding: registration,
          time,
          proof: sign(integration.secret, {
            action: "registration-status",
            binding: registration,
            time,
          }),
        })
      ).json();
    assert.equal(recovery.registered, true);
    assert.equal(recovery.session.enforcement, "unverified");
    const denied = await f.post(
      "/v1/operations",
      { tool: "read", args: { path: "README.md" }, idempotencyKey: "read" },
      {
        authorization: `Bearer ${recovery.capability}`,
        "x-harness-connection": binding.connection,
      },
    );
    assert.equal(denied.status, 403);
    assert.equal(f.engine.store.list("operation").length, 0);
  } finally {
    await f.close();
  }
});
test("HTTP: browser registration, origin protection, credential separation, host checks and URL tokens", async () => {
  const f = await serve();
  try {
    const ownerHeaders = {
      authorization: `Bearer ${f.credential.token}`,
      origin: f.origin,
    };
    assert.equal(
      (await f.post("/v1/owner/state", {}, ownerHeaders)).status,
      200,
    );
    assert.equal((await f.post("/v1/owner/state", {})).status, 401);
    assert.equal(
      (
        await f.post(
          "/v1/owner/state",
          {},
          {
            authorization: `Bearer ${f.credential.token}`,
            origin: "https://evil.example",
          },
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.post("/v1/integrations/challenge", {}, ownerHeaders)).status,
      403,
    );
    assert.equal(
      (await f.post("/v1/owner/state?token=secret", {}, ownerHeaders)).status,
      403,
    );
    const badHost = await new Promise<number>((resolve) => {
      const r = httpRequest(
        f.origin + "/v1/owner/state",
        {
          method: "POST",
          headers: {
            ...ownerHeaders,
            host: "evil.example",
            "content-type": "application/json",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      r.end("{}");
    });
    assert.equal(badHost, 403);
    const integration = f.engine.identity.pair("opencode");
    assert.equal(
      (
        await f.post(
          "/v1/owner/state",
          {},
          { authorization: `Bearer ${integration.secret}`, origin: f.origin },
        )
      ).status,
      401,
    );
    const snapshot = await (
      await f.post("/v1/owner/state", {}, ownerHeaders)
    ).text();
    assert.equal(snapshot.includes(integration.secret), false);
    assert.equal(snapshot.includes(f.credential.token), false);
    const page = await fetch(f.origin);
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    assert.match(await page.text(), /Engine controls/);
  } finally {
    await f.close();
  }
});
test("engine: a second writer is rejected and state cannot live in an enrolled repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-lock-")),
    state = join(dir, "state"),
    engine = new Engine({ state, sourceHash: "fixture" });
  try {
    assert.throws(
      () => new Engine({ state, sourceHash: "fixture" }),
      /engine lock exists/,
    );
    execFileSync("git", ["init", "-q", dir], { stdio: "pipe" });
    assert.throws(() => engine.enroll(dir), /state_in_repository/);
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP: specialist host claims are scoped and model relays cannot complete or fail tasks", async () => {
  const f = await serve();
  let bridge: IntegrationBridge | undefined;
  try {
    execFileSync("git", ["init", "-q", join(f.dir, "repository")], {
      stdio: "pipe",
    });
    const repo = f.engine.enroll(join(f.dir, "repository")),
      integration = f.engine.identity.pair("opencode");
    bridge = new IntegrationBridge(integration, new HttpTransport(f.origin), {
      repository: repo.id,
      runtimeSession: id(),
      connection: id(),
    });
    const root = await bridge.register();
    // HTTP service fixture only. Real containment remains covered by live tests.
    f.engine.containment.healthy = () => true;
    root.enforcement = "enforced";
    f.engine.identity.saveSession(root);
    const requestKey = id(),
      assignment = { role: "Researcher", task: "Investigate safely" };
    const assigned = await bridge.operation("delegate", assignment, requestKey);
    assert.equal(assigned.status, "completed");
    assert.deepEqual(
      await bridge.operation("delegate", assignment, requestKey),
      assigned,
    );
    assert.equal(f.engine.store.list("specialist-task").length, 1);
    const task = assigned.result.task,
      claim = id();
    assert.equal(
      (await f.post("/v1/specialist-tasks/claim", { task: task.id, claim }))
        .status,
      401,
    );
    assert.equal(
      (
        await f.post(
          "/v1/specialist-tasks/claim",
          { task: task.id, claim },
          { origin: f.origin },
        )
      ).status,
      403,
    );
    assert.equal(
      (await bridge.claimTask(task.id, claim)).task.status,
      "running",
    );
    await assert.rejects(
      bridge.claimTask(task.id, id()),
      /specialist_task_claimed/,
    );
    const relay = boundRelay(bridge, "raw-session");
    await assert.rejects(
      relay.execute({
        session: "raw-session",
        tool: "complete_task",
        args: { task: task.id, claim, artifact: id() },
        call: id(),
      }),
      /tool_unlisted/,
    );
    await assert.rejects(
      relay.execute({
        session: "raw-session",
        tool: "delegate",
        args: { action: "fail", task: task.id, claim },
        call: id(),
      }),
      /invalid_request/,
    );
    const child = f.engine.identity.session(task.session);
    child.enforcement = "enforced";
    f.engine.identity.saveSession(child);
    await assert.rejects(
      bridge.releaseSpecialist(child.session),
      /specialist_release_scope/,
    );
    const artifact = f.engine.artifacts.create(child, {
      kind: "specialist-result",
      content: "Result",
      dependencies: [],
      sources: [],
      shareWithRoot: true,
    });
    assert.equal(
      (await bridge.completeTask(task.id, claim, artifact.id)).status,
      "completed",
    );
    assert.equal(
      (
        await bridge.operation(
          "delegate",
          { action: "status", task: task.id },
          id(),
        )
      ).result.task.result.artifact,
      artifact.id,
    );
    assert.equal(JSON.stringify(f.engine.state()).includes("claimHash"), false);
    const second = await bridge.operation(
      "delegate",
      { action: "message", session: child.session, task: "Continue" },
      id(),
    );
    const secondClaim = id();
    await bridge.claimTask(second.result.task.id, secondClaim);
    assert.equal(
      (await bridge.failTask(second.result.task.id, secondClaim)).status,
      "failed",
    );
    assert.equal(f.engine.identity.session(root.session).status, "paused");
  } finally {
    bridge?.stop();
    await f.close();
  }
});

test("HTTP: a failed specialist cleanup pauses dependent authority and remains visible", async () => {
  const f = await serve();
  let bridge: IntegrationBridge | undefined;
  try {
    execFileSync("git", ["init", "-q", join(f.dir, "repository")], {
      stdio: "pipe",
    });
    const repo = f.engine.enroll(join(f.dir, "repository")),
      integration = f.engine.identity.pair("opencode");
    bridge = new IntegrationBridge(integration, new HttpTransport(f.origin), {
      repository: repo.id,
      runtimeSession: id(),
      connection: id(),
    });
    const root = await bridge.register();
    f.engine.containment.healthy = () => true;
    root.enforcement = "enforced";
    f.engine.identity.saveSession(root);
    const child = f.engine.workflow.admit(root, "Researcher").session;
    f.engine.workflow.terminate(root, child.session);
    // No creation intent means no process could have been admitted.
    assert.equal(
      (await bridge.releaseSpecialist(child.session)).status,
      "stopped",
    );
    // An actual cleanup failure is retained by Runtimes. The HTTP orchestration
    // boundary must also pause the Conductor instead of just freeing a slot.
    f.engine.store.put(
      "runtime-launch",
      child.session,
      { session: child.session, status: "requires_reconciliation" },
      child.repository,
      child.session,
    );
    f.engine.runtimes.cleanup = async () =>
      ({ session: child.session, status: "requires_reconciliation" }) as any;
    const outcome = await bridge.releaseSpecialist(child.session);
    assert.equal(outcome.status, "requires_reconciliation");
    assert.equal(f.engine.identity.session(root.session).status, "paused");
    await assert.rejects(
      bridge.operation(
        "delegate",
        { role: "Researcher", task: "Ignore failed cleanup" },
        id(),
      ),
      /capability/,
    );
    assert.equal(
      f.engine.state().runtimes[0]!.status,
      "requires_reconciliation",
    );
  } finally {
    bridge?.stop();
    await f.close();
  }
});
test("HTTP: the owner alone configures agents and reads the catalog of enrolled repositories", async () => {
  const f = await serve();
  try {
    const owner = {
      authorization: `Bearer ${f.credential.token}`,
      origin: f.origin,
    };
    execFileSync("git", ["init", "-q", join(f.dir, "repository")], {
      stdio: "pipe",
    });
    const repo = f.engine.enroll(join(f.dir, "repository"));
    mkdirSync(join(f.dir, "repository", "src"));
    const sub = join(f.dir, "repository", "src");
    assert.equal(
      (await f.post("/v1/owner/repositories/resolve", { path: sub })).status,
      401,
    );
    const resolved = await (
      await f.post("/v1/owner/repositories/resolve", { path: sub }, owner)
    ).json();
    assert.equal(resolved.root, repo.path);
    assert.notEqual(resolved.path, resolved.root);
    // Enrollment itself still requires the exact root.
    assert.equal(
      (await f.post("/v1/owner/repositories", { path: sub }, owner)).status,
      403,
    );
    assert.equal(
      (await f.post("/v1/owner/repositories/resolve", { path: f.dir }, owner))
        .status,
      400,
    );
    assert.equal((await f.post("/v1/owner/catalog", {})).status, 401);
    const global = await (await f.post("/v1/owner/catalog", {}, owner)).json();
    assert.ok(Array.isArray(global.skills) && Array.isArray(global.mcps));
    assert.ok(global.tools.includes("research"));
    assert.equal(
      (await f.post("/v1/owner/catalog", { repository: repo.id }, owner))
        .status,
      200,
    );
    assert.equal(
      (await f.post("/v1/owner/catalog", { repository: "/etc" }, owner)).status,
      403,
    );
    // Custom agents and prompts are published only through the owner route.
    const policy = f.engine.policies.active("global").policy;
    const custom = {
      id: "doc-writer",
      name: "Doc writer",
      kind: "custom",
      baseRole: "Planner",
      description: "Drafts documentation plans",
      systemPrompt: "Write docs plans.",
      tools: ["read", "artifact", "compact", "model"],
      skills: [],
      mcps: [],
      enabled: true,
    };
    const body = {
      scope: "global",
      activate: true,
      policy: { ...policy, agents: [...policy.agents, custom] },
    };
    assert.equal((await f.post("/v1/owner/policies", body)).status, 401);
    assert.equal((await f.post("/v1/owner/policies", body, owner)).status, 200);
    const invalid = await f.post(
      "/v1/owner/policies",
      {
        ...body,
        policy: {
          ...policy,
          agents: policy.agents.filter(
            (a: { id: string }) => a.id !== "reviewer",
          ),
        },
      },
      owner,
    );
    assert.equal(invalid.status, 400);
    assert.ok(
      f.engine.policies
        .active("global")
        .policy.agents.some((a) => a.id === "doc-writer"),
    );
  } finally {
    await f.close();
  }
});
test("HTTP: the owner previews and publishes native OpenCode agents to the repository and global config", async () => {
  const f = await serve();
  const config = mkdtempSync(join(tmpdir(), "harness-xdg-")),
    previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = config;
  try {
    const owner = {
      authorization: `Bearer ${f.credential.token}`,
      origin: f.origin,
    };
    execFileSync("git", ["init", "-q", join(f.dir, "repository")], {
      stdio: "pipe",
    });
    const repo = f.engine.enroll(join(f.dir, "repository"));
    const call = async (path: string, data: unknown, headers = owner) =>
      f.post(`/v1/owner/opencode/${path}`, data, headers);
    assert.equal((await call("publish", {}, {} as never)).status, 401);
    const agentDir = join(repo.path, ".opencode", "agent");
    const preview = await (
      await call("preview", { repository: repo.id })
    ).json();
    assert.equal(preview.files.length, 7);
    assert.ok(
      preview.files.every((x: { action: string }) => x.action === "create"),
    );
    assert.equal(existsSync(agentDir), false, "preview writes nothing");
    const published = await (
      await call("publish", { repository: repo.id })
    ).json();
    assert.equal(published.written.length, 7);
    assert.ok(existsSync(join(agentDir, "harness-orchestrator.md")));
    assert.equal(
      (
        await (await call("preview", { repository: repo.id })).json()
      ).files.every((x: { action: string }) => x.action === "unchanged"),
      true,
    );
    assert.equal(
      (await call("publish", { repository: "nope" })).status >= 400,
      true,
    );
    await call("publish", {});
    assert.ok(
      existsSync(join(config, "opencode", "agent", "harness-verifier.md")),
    );
    assert.ok(
      f.engine.store.db
        .prepare("SELECT 1 FROM audit WHERE event='opencode.exported'")
        .get(),
    );
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    rmSync(config, { recursive: true, force: true });
    await f.close();
  }
});
test("HTTP: manual review decisions and review points are owner-only", async () => {
  const f = await serve();
  try {
    const owner = {
      authorization: `Bearer ${f.credential.token}`,
      origin: f.origin,
    };
    const bodies: Record<string, unknown> = {
      "/v1/owner/external/decide": { review: id(), decision: "approve" },
      "/v1/owner/stages/start": {
        root: id(),
        stage: "plan",
        decision: "approve",
      },
      "/v1/owner/reviews/reject": {
        root: id(),
        artifact: id(),
        review: id(),
        comment: "redo",
      },
    };
    for (const [path, body] of Object.entries(bodies)) {
      assert.equal((await f.post(path, body)).status, 401, path);
      assert.ok((await f.post(path, body, owner)).status >= 400, path);
    }
    assert.equal(
      (
        await f.post(
          "/v1/owner/reviews/reject",
          { ...(bodies["/v1/owner/reviews/reject"] as object), comment: " " },
          owner,
        )
      ).status,
      400,
    );
    const policy = f.engine.policies.active("global").policy;
    const publish = (humanReview: object) =>
      f.post(
        "/v1/owner/policies",
        {
          scope: "global",
          activate: true,
          policy: { ...policy, humanReview },
        },
        owner,
      );
    assert.equal(
      (
        await publish({
          beforeStages: ["plan", "implementation"],
          externalContent: "approve-url",
          trustedDomains: [],
        })
      ).status,
      200,
    );
    assert.deepEqual(
      f.engine.policies.active("global").policy.humanReview.beforeStages,
      ["plan", "implementation"],
    );
    assert.equal(
      (
        await publish({
          beforeStages: [],
          externalContent: "maybe",
          trustedDomains: [],
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
