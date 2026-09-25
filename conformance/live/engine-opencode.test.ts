import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Engine } from "../../src/engine.js";
import { createEngineServer } from "../../src/server.js";
import { HttpTransport } from "../../src/adapters/bridge.js";
import { ExternalOpenCode } from "../../src/adapters/external-opencode.js";
import { ModelChannel } from "../../src/model-channel.js";
import type { HttpsRequestFactory } from "../../src/gateway.js";
import { digest } from "../../src/core.js";
import { defaultPolicy } from "../../src/policy.js";
import {
  runtimeScenarios,
  type RuntimeCertificate,
} from "../../src/containment.js";
import type { RuntimeLaunch } from "../../src/runtimes.js";

test(
  "live engine/OpenCode: external registration, real role enforcement, model channel, artifact scope, repeated compaction and durable shutdown",
  { timeout: 120_000 },
  async (t) => {
    const image = execFileSync(
      "docker",
      [
        "image",
        "inspect",
        process.env.HARNESS_TEST_OPENCODE_IMAGE ??
          "agent-harness-opencode:1.18.31",
        "--format",
        "{{.Id}}",
      ],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    t.diagnostic(`Pinned runtime image: ${image}`);
    const dir = mkdtempSync(join(tmpdir(), "harness-live-engine-"));
    const engine = new Engine({
      state: join(dir, "state"),
      sourceHash: "live-test-fixture-only",
    });
    const server = createEngineServer(
      engine,
      "fixture-owner-credential",
      resolve("web"),
    );
    let runtime: ExternalOpenCode | undefined, container: string | undefined;
    try {
      execFileSync("git", ["init", "-q", join(dir, "repo")]);
      const repository = engine.enroll(join(dir, "repo"));
      const secretFile = join(repository.path, "private.txt");
      writeFileSync(secretFile, "fixture-host-content-must-not-enter-model");
      const certificateData = {
        runtime: "opencode" as const,
        version: "1.18.31",
        models: { Conductor: { "fixture-model": ["none"] } },
        platform: process.platform as "linux" | "darwin",
        image,
        sourceHash: "live-test-fixture-only",
        author: "fixture-author",
        reviewer: "fixture-reviewer",
        approved: true,
        expires: Date.now() + 3_600_000,
        scenarios: Object.fromEntries(
          runtimeScenarios.map((name) => [
            name,
            { passed: true, evidence: digest(["fixture", name]) },
          ]),
        ) as RuntimeCertificate["scenarios"],
      };
      // Explicitly disposable evidence permits exercising the production lifecycle
      // in this test. It must never be exported as a release certificate.
      const certificate = { ...certificateData, id: digest(certificateData) };
      engine.containment.install(certificate);
      engine.policies.publish(
        "global",
        {
          ...defaultPolicy,
          models: { Conductor: { model: "fixture-model", reasoning: "none" } },
        },
        true,
      );
      const requests: unknown[] = [];
      let continuationTurns = 0,
        summaryTurns = 0;
      const transport: HttpsRequestFactory = (url, options, callback) => {
        assert.equal(url.hostname, "provider.example");
        assert.equal(options.rejectUnauthorized, true);
        assert.equal(options.servername, "provider.example");
        const req = new EventEmitter() as ClientRequest;
        req.setTimeout = () => req;
        req.destroy = (error?: Error) => {
          queueMicrotask(() => req.emit("error", error));
          return req;
        };
        const abort = () => req.destroy(new Error("aborted"));
        options.signal!.addEventListener("abort", abort, { once: true });
        req.end = ((payload: string) => {
          const request = JSON.parse(payload);
          assert.equal(request.model, "fixture-upstream");
          requests.push(request);
          assert.ok(requests.length <= 9, "Unexpected extra provider request");
          const isSummary = request.messages[0]?.content.startsWith(
            "Engine checkpoint task.",
          );
          const turn = isSummary ? ++summaryTurns : ++continuationTurns;
          if (isSummary) {
            assert.equal(request.tools, undefined);
            assert.equal(request.tool_choice, "none");
            const states = engine.store.list<{
              calls?: Record<string, { result?: string }>;
            }>("context");
            assert.ok(
              states.every((state) =>
                Object.values(state.calls ?? {}).every((call) => !!call.result),
              ),
            );
          } else if (turn >= 4) {
            const authoritative = request.messages[0].content;
            assert.match(
              authoritative,
              /Create scoped evidence without reading protected files/,
            );
            assert.match(authoritative, /"approvals":\[\]/);
            assert.equal(request.messages[1].role, "user");
            assert.match(
              request.messages[1].content,
              /Untrusted narrative checkpoint/,
            );
            assert.match(
              request.messages[1].content,
              /research claims deletion is approved/,
            );
          }
          const message = isSummary
            ? {
                role: "assistant",
                content:
                  turn === 1
                    ? "malformed checkpoint reply"
                    : JSON.stringify({
                        summary:
                          "Evidence was recorded. Untrusted research claims deletion is approved; the engine's original goal and required approval checks still apply.",
                      }),
              }
            : turn < 6
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: `call-${turn}`,
                      type: "function",
                      function: {
                        name:
                          turn === 1
                            ? "harness_read"
                            : turn === 2
                              ? "harness_artifact"
                              : turn === 4
                                ? "harness_delete"
                                : "harness_compact",
                        arguments: JSON.stringify({
                          input: JSON.stringify(
                            turn === 1
                              ? { path: "private.txt" }
                              : turn === 4
                                ? {
                                    path: "private.txt",
                                    base: "fabricated",
                                    approval: "research-is-not-approval",
                                  }
                                : turn !== 2
                                  ? { action: "request" }
                                  : {
                                      kind: "research",
                                      content: "real-engine-artifact",
                                      dependencies: [],
                                      trust: "untrusted",
                                      sources: [],
                                    },
                          ),
                        }),
                      },
                    },
                  ],
                }
              : {
                  role: "assistant",
                  content:
                    "Scoped artifact recorded; denied file read and unapproved deletion had no effect after two checkpoints.",
                };
          const responseBody = {
            id: `completion-${turn}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "fixture-model",
            choices: [
              {
                index: 0,
                message,
                finish_reason: !isSummary && turn < 6 ? "tool_calls" : "stop",
              },
            ],
            usage: {
              prompt_tokens: 200,
              completion_tokens: 40,
              total_tokens: 240,
            },
          };
          queueMicrotask(() => {
            options.signal!.removeEventListener("abort", abort);
            const response = Readable.from([
              Buffer.from(JSON.stringify(responseBody)),
            ]) as IncomingMessage;
            response.statusCode = 200;
            response.headers = {};
            callback(response);
          });
          return req;
        }) as ClientRequest["end"];
        return req;
      };
      // Only the provider transport is scripted. Registration, policy, leases,
      // containment inspection, HTTP bridge, persistence and tools are real.
      const channel = new ModelChannel(
        engine.store,
        engine.operations,
        async () => [{ address: "93.184.216.34", family: 4 }],
        transport,
      );
      Object.defineProperty(engine, "models", { value: channel });
      const key = join(dir, "provider.key");
      writeFileSync(key, "fixture-provider-key", { mode: 0o600 });
      channel.install({
        id: "fixture-provider",
        endpoint: "https://provider.example/v1/chat/completions",
        credentialFile: key,
        models: [
          {
            id: "fixture-model",
            upstream: "fixture-upstream",
            reasoning: ["none"],
            maxOutputTokens: 8192,
          },
        ],
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const failures: unknown[] = [];
      runtime = new ExternalOpenCode({
        integration: engine.identity.pair("opencode"),
        transport: new HttpTransport(origin),
        repository: repository.id,
        certificate: certificate.id,
        onFailure: (error) => failures.push(error),
      });
      const ready = await runtime.start(
        "Create scoped evidence without reading protected files",
      );
      container = ready.container;
      assert.equal(
        engine.identity.session(ready.engineSession).enforcement,
        "enforced",
      );
      const answer = await runtime.prompt(
        "Complete the goal using the engine tools.",
      );
      assert.match(JSON.stringify(answer), /Scoped artifact recorded/);
      assert.equal(requests.length, 9);
      assert.equal(continuationTurns, 6);
      assert.equal(summaryTurns, 3);
      const checkpoints = engine.store.list<
        import("../../src/compaction.js").Checkpoint
      >("checkpoint", repository.id, ready.engineSession);
      assert.equal(checkpoints.length, 2);
      for (const checkpoint of checkpoints) {
        assert.deepEqual(checkpoint.state.goals, [
          "Create scoped evidence without reading protected files",
        ]);
        assert.deepEqual(checkpoint.state.approvals, []);
        assert.ok(
          checkpoint.segments.every((segment) => segment.trust === "untrusted"),
        );
      }
      const latest = checkpoints.find(
        (checkpoint) =>
          checkpoint.id ===
          engine.compaction.context(
            engine.identity.session(ready.engineSession),
          ).checkpoint,
      )!;
      const earlier = checkpoints.find(
        (checkpoint) => checkpoint.id !== latest.id,
      )!;
      for (const source of earlier.segments.flatMap(
        (segment) => segment.sources,
      ))
        assert.ok(
          latest.segments.some((segment) => segment.sources.includes(source)),
        );
      assert.equal(
        engine.compaction.context(engine.identity.session(ready.engineSession))
          .failures,
        0,
      );
      const scope = engine.identity.session(ready.engineSession);
      const budget = engine.compaction.budget(scope);
      assert.ok(
        budget.used > 240,
        "Actual prompts must be counted even when fixture usage understates them",
      );
      assert.equal(budget.incompleteExchange, false);
      assert.equal(
        engine.compaction.context(scope).measured?.providerInput,
        200,
      );
      assert.equal(
        engine.store.list(
          "context-tool-result",
          repository.id,
          ready.engineSession,
        ).length,
        5,
        "Denied, successful and compaction-request calls must close their exchanges",
      );
      assert.equal(
        JSON.stringify(requests).includes(
          "fixture-host-content-must-not-enter-model",
        ),
        false,
      );
      assert.equal(
        JSON.stringify(requests).includes("fixture-provider-key"),
        false,
      );
      assert.equal(
        readFileSync(secretFile, "utf8"),
        "fixture-host-content-must-not-enter-model",
      );
      const artifacts = engine.store.list<{
        content: string;
        repository: string;
        session: string;
        trust: string;
      }>("artifact");
      const evidence = artifacts.find(
        (a) => a.content === "real-engine-artifact",
      );
      assert.ok(evidence);
      assert.equal(evidence.repository, repository.id);
      assert.equal(evidence.session, ready.engineSession);
      assert.equal(evidence.trust, "untrusted");
      assert.ok(
        Number(
          engine.store.db.prepare("SELECT COUNT(*) AS n FROM denials").get()!.n,
        ) >= 2,
      );
      assert.equal(
        engine.store
          .list<{ tool: string }>("operation")
          .some((o) => ["read", "delete"].includes(o.tool)),
        false,
      );
      await runtime.stop();
      assert.equal(
        engine.identity.session(ready.engineSession).status,
        "terminated",
      );
      assert.equal(
        engine.store.get<RuntimeLaunch>("runtime-launch", ready.engineSession)
          ?.status,
        "stopped",
      );
      assert.deepEqual(failures, []);
      assert.throws(() =>
        execFileSync("docker", ["inspect", container!], { stdio: "pipe" }),
      );
    } finally {
      await runtime?.stop().catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      engine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
