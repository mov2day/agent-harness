import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { Engine } from "../src/engine.js";
import { createEngineServer, ownerCredential } from "../src/server.js";
import { sign } from "../src/core.js";
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
