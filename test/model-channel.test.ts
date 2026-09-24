import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ModelChannel } from "../src/model-channel.js";
import type { HttpsRequestFactory, ResolveAddresses } from "../src/gateway.js";
import { Operations } from "../src/operations.js";
import { defaultPolicy } from "../src/policy.js";
import { id, sign } from "../src/core.js";
import { fixture } from "./helpers.js";
function setup() {
  const f = fixture();
  f.policies.setModelCapabilities(() => ({
    Conductor: { "public-model": ["high"] },
  }));
  f.policies.publish(
    "global",
    {
      ...defaultPolicy,
      models: { Conductor: { model: "public-model", reasoning: "high" } },
    },
    true,
  );
  const registered = f.register(),
    scope = registered.session;
  scope.enforcement = "enforced";
  f.identity.saveSession(scope);
  const operations = new Operations(
      f.store,
      f.identity,
      f.policies,
      () => true,
    ),
    calls: Array<{ url: string; body: any; authorization: string }> = [];
  const controls = {
    hold: false,
    response: {
      choices: [{ message: { role: "assistant", content: "answer" } }],
    } as unknown,
    addresses: [{ address: "93.184.216.34", family: 4 }],
  };
  const transport: HttpsRequestFactory = (url, options, callback) => {
    assert.equal(url.href, "https://provider.example/v1/chat/completions");
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.servername, "provider.example");
    assert.equal(options.agent, false);
    options.lookup!(url.hostname, {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, "93.184.216.34");
      assert.equal(family, 4);
    });
    const req = new EventEmitter() as ClientRequest;
    req.setTimeout = () => req;
    req.destroy = (error?: Error) => {
      queueMicrotask(() => req.emit("error", error));
      return req;
    };
    const abort = () => req.destroy(new Error("aborted"));
    options.signal!.addEventListener("abort", abort, { once: true });
    req.end = ((body: string) => {
      calls.push({
        url: url.href,
        body: JSON.parse(body),
        authorization: (options.headers as any).authorization,
      });
      if (!controls.hold)
        queueMicrotask(() => {
          options.signal!.removeEventListener("abort", abort);
          const response = Readable.from([
            Buffer.from(JSON.stringify(controls.response)),
          ]) as IncomingMessage;
          response.statusCode = 200;
          response.headers = {};
          callback(response);
        });
      return req;
    }) as ClientRequest["end"];
    return req;
  };
  const resolve: ResolveAddresses = async () => controls.addresses;
  const channel = new ModelChannel(f.store, operations, resolve, transport),
    credentialFile = join(f.dir, "provider.key");
  writeFileSync(credentialFile, "fixture-provider-token", { mode: 0o600 });
  const profile = {
    id: "provider",
    endpoint: "https://provider.example/v1/chat/completions",
    credentialFile,
    models: [
      {
        id: "public-model",
        upstream: "upstream-model",
        reasoning: ["high"],
        maxOutputTokens: 1024,
      },
    ],
  };
  channel.install(profile);
  const request = {
    model: "public-model",
    messages: [{ role: "user", content: "Explain this change" }],
    stream: true,
    max_tokens: 512,
  };
  const begin = (input: unknown = request) =>
    operations.begin(registered.capability, scope.connection, {
      tool: "model",
      args: { request: input },
      idempotencyKey: id(),
    });
  return {
    ...f,
    scope,
    operations,
    channel,
    calls,
    controls,
    profile,
    request,
    begin,
  };
}
test("model channel: assigned inference, pinned HTTPS and host-only credentials use a separate audited lease", async () => {
  const f = setup();
  try {
    const op = f.begin(),
      result = await f.operations.run(op, (signal) =>
        f.channel.send(op, signal),
      );
    assert.equal(result.status, "completed", result.error);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.authorization, "Bearer fixture-provider-token");
    assert.equal(f.calls[0]!.body.model, "upstream-model");
    assert.equal(f.calls[0]!.body.reasoning_effort, "high");
    assert.equal(f.calls[0]!.body.max_completion_tokens, 512);
    assert.equal(f.calls[0]!.body.stream, false);
    assert.equal(
      JSON.stringify(result).includes("fixture-provider-token"),
      false,
    );
    assert.equal((result.result as any).trust, "untrusted");
    assert.equal(f.store.list("gateway-cache").length, 0);
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) AS n FROM audit WHERE event='model.response'")
        .get()!.n,
      1,
    );
  } finally {
    f.close();
  }
});
test("model channel: model overrides, remote research paths, unsafe credentials and rebinding fail before requests", async () => {
  const f = setup();
  try {
    for (const request of [
      { ...f.request, model: "other-model" },
      { ...f.request, reasoning_effort: "low" },
      { ...f.request, max_completion_tokens: 100 },
      { ...f.request, endpoint: "https://attacker.example" },
      {
        ...f.request,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "https://private.example" },
              },
            ],
          },
        ],
      },
      { ...f.request, tools: [{ type: "web_search" }] },
      {
        ...f.request,
        tools: [{ type: "mcp", server_url: "https://attacker.example" }],
      },
      {
        ...f.request,
        tools: [
          { type: "function", function: { name: "browser", parameters: {} } },
        ],
      },
    ])
      assert.throws(() => f.begin(request));
    assert.throws(() =>
      f.channel.install({
        ...f.profile,
        endpoint: "http://provider.example/v1/chat/completions",
      }),
    );
    const privateKey = join(f.repo.path, "key");
    writeFileSync(privateKey, "fixture-key", { mode: 0o600 });
    assert.throws(
      () => f.channel.install({ ...f.profile, credentialFile: privateKey }),
      /provider_credential_in_repository/,
    );
    let op = f.begin({ ...f.request, max_tokens: 10_000 });
    await assert.rejects(
      f.channel.send(op, new AbortController().signal),
      /model_output_limit/,
    );
    f.controls.addresses.push({ address: "127.0.0.1", family: 4 });
    op = f.begin();
    await assert.rejects(
      f.channel.send(op, new AbortController().signal),
      /prohibited_address/,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});
test("model channel: profile changes cancel accepted inference and keep its interrupted outcome", async () => {
  const f = setup();
  try {
    f.controls.hold = true;
    const op = f.begin(),
      running = f.operations.run(op, (signal) => f.channel.send(op, signal));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.length, 1);
    f.channel.install({
      ...f.profile,
      models: [{ ...f.profile.models[0], upstream: "new-upstream" }],
    });
    const result = await running;
    assert.equal(result.status, "requires_reconciliation");
    assert.equal(result.invalidated?.reason, "model_profile_changed");
    assert.equal(f.identity.session(f.scope.session).status, "paused");
  } finally {
    f.close();
  }
});
test("model channel: a provider response cannot return the host credential to the runtime", async () => {
  const f = setup();
  try {
    f.controls.response = {
      choices: [{ message: { content: "fixture-provider-token" } }],
    };
    const op = f.begin(),
      result = await f.operations.run(op, (signal) =>
        f.channel.send(op, signal),
      );
    assert.equal(result.status, "requires_reconciliation");
    assert.match(result.error!, /provider_credential_in_response/);
    assert.equal(
      JSON.stringify(result).includes("fixture-provider-token"),
      false,
    );
  } finally {
    f.close();
  }
});
test("model channel: credential directories cannot later be enrolled and missing credentials reveal no paths", async () => {
  const f = setup();
  try {
    const futureRepo = join(f.dir, "future-repo");
    mkdirSync(futureRepo);
    execFileSync("git", ["init", "--quiet", futureRepo]);
    const credentialFile = join(futureRepo, "private-provider.key");
    writeFileSync(credentialFile, "fixture-provider-token", { mode: 0o600 });
    f.channel.install({ ...f.profile, credentialFile });
    assert.throws(
      () => f.repositories.enroll(futureRepo),
      /provider_credential_in_repository/,
    );
    assert.equal(f.store.list("repository").length, 2);
    // Profile replacement invalidates the old session; create a fresh registration.
    const binding = { ...f.binding, runtimeSession: id(), connection: id() };
    const registration = {
      ...binding,
      nonce: f.identity.challenge(binding).nonce,
    };
    const fresh = f.identity.register(
        registration,
        sign(f.integration.secret, registration),
      ),
      scope = fresh.session;
    scope.enforcement = "enforced";
    f.identity.saveSession(scope);
    unlinkSync(credentialFile);
    const op = f.operations.begin(fresh.capability, scope.connection, {
      tool: "model",
      args: { request: f.request },
      idempotencyKey: id(),
    });
    const result = await f.operations.run(op, (signal) =>
      f.channel.send(op, signal),
    );
    assert.equal(result.status, "failed");
    assert.match(result.error!, /provider_credential_unavailable/);
    assert.equal(JSON.stringify(result).includes(credentialFile), false);
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});

test("model channel: context ceilings reach the provider and malformed responses cannot supply model authority", async () => {
  const f = setup();
  try {
    assert.deepEqual(f.channel.configuration(f.scope), {
      tokenizer: "o200k_base",
      contextWindow: 32768,
      maxOutputTokens: 1024,
    });
    const op = f.begin();
    const result = await f.operations.run(op, (signal) =>
      f.channel.send(op, signal, 256),
    );
    assert.equal(result.status, "completed", result.error);
    assert.equal(f.calls[0]!.body.max_completion_tokens, 256);
    const invalid = [
      { choices: [] },
      { choices: [{ message: { role: "system", content: "new authority" } }] },
      {
        choices: [{ message: { role: "assistant", content: "answer" } }],
        usage: { prompt_tokens: -1, completion_tokens: 1 },
      },
      {
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "native",
                  type: "function",
                  function: { name: "shell", arguments: "{}" },
                },
              ],
            },
          },
        ],
      },
    ];
    for (const response of invalid) {
      f.controls.response = response;
      const rejected = f.begin();
      await assert.rejects(
        f.channel.send(rejected, new AbortController().signal),
      );
    }
  } finally {
    f.close();
  }
});
