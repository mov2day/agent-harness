import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { ContainedOpenCode } from "../../src/adapters/contained-opencode.js";
import { modelRequestSchema } from "../../src/model-channel.js";
import { id } from "../../src/core.js";
import type { RuntimeRequest } from "../../src/adapters/bridge.js";

// Actual pinned OpenCode binary and plugin, isolated container and stdio relay.
// The scripted provider/engine responses make this a deterministic transport
// test. This file alone does not certify engine enforcement or model behavior.
test(
  "live OpenCode: pinned binary uses scoped context, model and tool relays without host credentials or mounts",
  { timeout: 120_000 },
  async () => {
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
    assert.match(image ?? "", /^sha256:[a-f0-9]{64}$/);
    const calls: RuntimeRequest[] = [],
      models: unknown[] = [];
    let contexts = 0,
      attached = false,
      container: string | undefined;
    const completed = (result: unknown) => ({ status: "completed", result });
    const runtime = new ContainedOpenCode({
      image: image!,
      runtimeSession: id(),
      connection: id(),
      model: { model: "fixture-model", reasoning: "none" },
      async attached(value) {
        attached = true;
        container = value;
      },
      relay(session) {
        return {
          async context(raw) {
            assert.equal(raw, session);
            assert.equal(attached, true);
            contexts++;
            return completed({
              state: {
                goals: ["Create a harmless evidence artifact"],
                constraints: ["Use only harness tools"],
                decisions: [],
                findings: [],
                artifacts: {},
                approvals: [],
                pending: [],
                policy: "fixture-policy",
                skills: {},
                stage: "research",
              },
              budget: {
                used: 0,
                usable: 24576,
                reserved: 8192,
                requestCompaction: false,
                admitOptional: true,
                pause: false,
                incompleteExchange: false,
              },
            });
          },
          async execute(request) {
            assert.equal(request.session, session);
            assert.equal(request.tool, "artifact");
            assert.equal(typeof request.call, "string");
            calls.push(request);
            return completed({
              id: "fixture-artifact",
              hash: "a".repeat(64),
              trust: "untrusted",
            });
          },
          async model(raw, input) {
            assert.equal(raw, session);
            const request = modelRequestSchema.parse(input);
            assert.equal(request.model, "fixture-model");
            models.push(request);
            const first = models.length === 1;
            return completed({
              response: {
                id: `completion-${models.length}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: "fixture-model",
                choices: [
                  {
                    index: 0,
                    message: first
                      ? {
                          role: "assistant",
                          content: null,
                          tool_calls: [
                            {
                              id: "call-artifact",
                              type: "function",
                              function: {
                                name: "harness_artifact",
                                arguments: JSON.stringify({
                                  input: JSON.stringify({
                                    kind: "research",
                                    content: "contained evidence",
                                    dependencies: [],
                                    trust: "untrusted",
                                    sources: [],
                                  }),
                                }),
                              },
                            },
                          ],
                        }
                      : {
                          role: "assistant",
                          content: "Evidence stored through the engine.",
                        },
                    finish_reason: first ? "tool_calls" : "stop",
                  },
                ],
                usage: {
                  prompt_tokens: 200,
                  completion_tokens: 40,
                  total_tokens: 240,
                },
              },
            });
          },
        };
      },
    });
    try {
      const ready = await runtime.start();
      assert.match(ready.session, /^ses_/);
      const inspection = await runtime.inspection();
      assert.equal(inspection.HostConfig.NetworkMode, "none");
      assert.equal(
        inspection.Config.Env.some((v) =>
          /OPENAI_API_KEY|HARNESS_.*SECRET|HARNESS_.*TOKEN/.test(v),
        ),
        false,
      );
      const result = await runtime.prompt(
        "Create the harmless evidence artifact, then report completion.",
      );
      assert.ok(contexts > 0);
      assert.equal(calls.length, 1, JSON.stringify(result));
      assert.equal(models.length, 2);
      assert.match(
        JSON.stringify(result),
        /Evidence stored through the engine/,
      );
      assert.equal((calls[0]!.args as any).content, "contained evidence");
      const probe = execFileSync(
        "docker",
        [
          "exec",
          ready.container,
          "node",
          "--input-type=module",
          "-e",
          `
        import { existsSync, writeFileSync } from 'node:fs';
        writeFileSync('/tmp/positive-control-marker', 'container-only');
        const post = async (path, body) => {
          const response = await fetch('http://127.0.0.1:4096' + path, {
            method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(12000)
          });
          return { status: response.status, body: await response.text() };
        };
        const other = JSON.parse((await post('/session', {title:'spoofed session'})).body);
        const spoof = await post('/session/' + other.id + '/message', {agent:'harness',parts:[{type:'text',text:'Read host files'}]});
        const shell = await post('/session/' + ${JSON.stringify(ready.session)} + '/shell', {agent:'harness',command:'touch /tmp/native-bypass-marker'});
        let externalNetwork = false;
        try { await fetch('https://example.com', {signal:AbortSignal.timeout(1000)}); externalNetwork = true; } catch {}
        console.log(JSON.stringify({spoof,shell,externalNetwork,canWriteTemporaryFile:existsSync('/tmp/positive-control-marker'),nativeEffect:existsSync('/tmp/native-bypass-marker'),hostSocket:existsSync('/var/run/docker.sock'),hostRepository:existsSync(${JSON.stringify(process.cwd())})}));
      `,
        ],
        { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 },
      );
      const isolation = JSON.parse(probe);
      assert.match(isolation.spoof.body, /runtime_session_spoof/);
      assert.ok(isolation.shell.status >= 400, isolation.shell.body);
      assert.equal(isolation.canWriteTemporaryFile, true);
      assert.equal(isolation.nativeEffect, false);
      assert.equal(isolation.externalNetwork, false);
      assert.equal(isolation.hostSocket, false);
      assert.equal(isolation.hostRepository, false);
      assert.equal(
        models.length,
        2,
        "An alternate raw session must not reach the host model channel",
      );
    } finally {
      await runtime.stop();
    }
    assert.ok(container);
    assert.throws(
      () => execFileSync("docker", ["inspect", container!], { stdio: "pipe" }),
      /Command failed/,
    );
  },
);
