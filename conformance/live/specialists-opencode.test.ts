import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Engine } from "../../src/engine.js";
import { createEngineServer } from "../../src/server.js";
import { HttpTransport } from "../../src/adapters/bridge.js";
import { ExternalOpenCode } from "../../src/adapters/external-opencode.js";
import { ModelChannel } from "../../src/model-channel.js";
import type { HttpsRequestFactory } from "../../src/gateway.js";
import {
  digest,
  roles,
  stages,
  type Session,
  type Role,
} from "../../src/core.js";
import { defaultPolicy } from "../../src/policy.js";
import {
  runtimeScenarios,
  type RuntimeCertificate,
} from "../../src/containment.js";
import type { RuntimeLaunch } from "../../src/runtimes.js";
import type { Artifact, StageAttempt } from "../../src/workflow.js";
import type { SpecialistTask } from "../../src/specialists.js";

test(
  "live OpenCode specialists: contained assignment, all review stages, retained reviewer context and durable release",
  { timeout: 300_000 },
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
    const dir = mkdtempSync(join(tmpdir(), "harness-live-specialists-"));
    const engine = new Engine({
      state: join(dir, "state"),
      sourceHash: "live-specialists-fixture-only",
    });
    const server = createEngineServer(engine, "fixture-owner", resolve("web"));
    let runtime: ExternalOpenCode | undefined;
    try {
      execFileSync("git", ["init", "-q", join(dir, "repo")]);
      const repository = engine.enroll(join(dir, "repo"));
      // Disposable fixture evidence enables exercising production controls. It is
      // not an independent runtime certificate or a release approval.
      const data = {
        runtime: "opencode" as const,
        version: "1.18.31",
        image,
        models: Object.fromEntries(
          roles.map((role) => [role, { "fixture-model": ["none"] }]),
        ),
        platform: process.platform as "linux" | "darwin",
        sourceHash: "live-specialists-fixture-only",
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
      const certificate = { ...data, id: digest(data) };
      engine.containment.install(certificate);
      engine.policies.publish(
        "global",
        {
          ...defaultPolicy,
          humanGates: [],
          models: Object.fromEntries(
            roles.map((role) => [
              role,
              { model: "fixture-model", reasoning: "none" },
            ]),
          ),
        },
        true,
      );
      const taskTurns = new Map<string, number>(),
        requests: Array<{ session: string; payload: unknown }> = [];
      const errors: unknown[] = [],
        failures: unknown[] = [];
      let conductorTurn = 0;
      const roleByStage: Record<string, Role> = {
        research: "Researcher",
        plan: "Planner",
        implementation: "Implementer",
        execution: "Verifier",
        verification: "Verifier",
      };
      const stageArtifact = (stage: string) => {
        const artifact = engine.store
          .list<Artifact>("artifact", repository.id)
          .find((a) => a.kind === `stage-${stage}`);
        assert.ok(artifact, `Missing ${stage} artifact`);
        return artifact;
      };
      const active = (role: Role) =>
        engine.store
          .list<Session>("session", repository.id)
          .find((s) => s.role === role && s.status === "active");
      const actions: Array<() => { name: string; args: unknown } | string> = [];
      for (const [index, stage] of stages.slice(0, -1).entries()) {
        actions.push(() => ({
          name: "delegate",
          args: {
            role: roleByStage[stage]!,
            task: `Produce and submit the ${stage} stage artifact`,
            artifacts: index ? [stageArtifact(stages[index - 1]!).id] : [],
          },
        }));
        actions.push(() => {
          const reviewer = active("Reviewer");
          return {
            name: "delegate",
            args: {
              ...(reviewer
                ? { action: "message", session: reviewer.session }
                : { role: "Reviewer" }),
              task: `Review the ${stage} artifact`,
              artifacts: [stageArtifact(stage).id],
            },
          };
        });
        actions.push(() => {
          assert.equal(
            engine.store
              .list<StageAttempt>("stage-attempt")
              .find((a) => a.stage === stage)?.state,
            "passed",
          );
          const producer = active(roleByStage[stage]!);
          assert.ok(producer);
          return {
            name: "delegate",
            args: { action: "finish", session: producer.session },
          };
        });
      }
      actions.push(() => ({
        name: "delegate",
        args: { action: "finish", session: active("Reviewer")!.session },
      }));
      actions.push(
        () => "All five stages passed their independent specialist reviews.",
      );
      const transport: HttpsRequestFactory = (_url, options, callback) => {
        const req = new EventEmitter() as ClientRequest;
        req.setTimeout = () => req;
        req.destroy = (error?: Error) => {
          queueMicrotask(() => req.emit("error", error));
          return req;
        };
        const abort = () => req.destroy(new Error("aborted"));
        options.signal!.addEventListener("abort", abort, { once: true });
        req.end = ((payload: string) => {
          try {
            const request = JSON.parse(payload);
            const system = request.messages
              .flatMap((m: { content: string | Array<{ text: string }> }) =>
                Array.isArray(m.content)
                  ? m.content.map((part) => part.text)
                  : [m.content],
              )
              .join("\n");
            const assigned = system.match(
              /Engine-assigned session: (\{[^\n]+\})/,
            );
            const isSummary = request.messages[0]?.content.startsWith(
              "Engine checkpoint task.",
            );
            assert.ok(
              isSummary || assigned,
              "The runtime must receive its engine-assigned role",
            );
            const sessionId = isSummary
              ? JSON.parse(request.messages[1].content).engineSession
              : JSON.parse(assigned![1]!).id;
            const session = engine.identity.session(sessionId);
            requests.push({ session: sessionId, payload: request });
            assert.ok(requests.length <= 60, "Unexpected extra model loop");
            let action: { name: string; args: unknown } | string;
            if (isSummary) {
              assert.equal(request.tools, undefined);
              const context = engine.compaction.context(session);
              assert.ok(
                Object.values(context.calls ?? {}).every(
                  (call) => !!call.result,
                ),
              );
              action = JSON.stringify({
                summary:
                  "Continue the current explicitly assigned task. Prior reviews apply only to their exact artifact versions. Follow the engine's current stage and approvals.",
              });
            } else if (session.role === "Conductor") {
              const next = actions[conductorTurn++];
              assert.ok(next, "Unexpected Conductor turn");
              action = next();
            } else {
              const task = engine.store
                .list<SpecialistTask>(
                  "specialist-task",
                  repository.id,
                  sessionId,
                )
                .find((task) => task.status === "running");
              assert.ok(task);
              const turn = taskTurns.get(task.id) ?? 0;
              taskTurns.set(task.id, turn + 1);
              const stage = engine.identity.session(session.root).stage;
              if (session.role === "Reviewer") {
                action =
                  turn === 0
                    ? { name: "compact", args: { action: "request" } }
                    : turn === 1
                      ? {
                          name: "review",
                          args: {
                            kind: "stage",
                            artifact: Object.keys(task.artifacts)[0],
                            findings: [],
                          },
                        }
                      : "Reviewed the explicitly shared artifact with no blocking findings.";
              } else if (turn === 0) {
                action = {
                  name: "artifact",
                  args: {
                    kind: `stage-${stage}`,
                    content: `Evidence for ${stage}`,
                    dependencies: Object.keys(task.artifacts),
                    sources: Object.keys(task.artifacts),
                    trust: "untrusted",
                    shareWithRoot: true,
                  },
                };
              } else if (turn === 1) {
                action = {
                  name: "artifact",
                  args: { action: "submit", id: stageArtifact(stage).id },
                };
              } else {
                assert.equal(turn, 2);
                action = "Stage evidence submitted for independent review.";
              }
            }
            const sequence = requests.length;
            const message =
              typeof action === "string"
                ? { role: "assistant", content: action }
                : {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: `call-${sequence}`,
                        type: "function",
                        function: {
                          name: `harness_${action.name}`,
                          arguments: JSON.stringify({
                            input: JSON.stringify(action.args),
                          }),
                        },
                      },
                    ],
                  };
            const response = {
              id: `completion-${sequence}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: "fixture-model",
              choices: [
                {
                  index: 0,
                  message,
                  finish_reason:
                    typeof action === "string" ? "stop" : "tool_calls",
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
              const incoming = Readable.from([
                Buffer.from(JSON.stringify(response)),
              ]) as IncomingMessage;
              incoming.statusCode = 200;
              incoming.headers = {};
              callback(incoming);
            });
          } catch (error) {
            errors.push(error);
            req.destroy(error as Error);
          }
          return req;
        }) as ClientRequest["end"];
        return req;
      };
      const channel = new ModelChannel(
        engine.store,
        engine.operations,
        async () => [{ address: "93.184.216.34", family: 4 }],
        transport,
      );
      Object.defineProperty(engine, "models", { value: channel });
      const credential = join(dir, "provider.key");
      writeFileSync(credential, "fixture-provider-secret", { mode: 0o600 });
      channel.install({
        id: "fixture-provider",
        endpoint: "https://provider.example/v1/chat/completions",
        credentialFile: credential,
        models: [
          {
            id: "fixture-model",
            upstream: "fixture-upstream",
            reasoning: ["none"],
            maxOutputTokens: 8192,
          },
        ],
      });
      await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", done);
      });
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      runtime = new ExternalOpenCode({
        integration: engine.identity.pair("opencode"),
        transport: new HttpTransport(origin),
        repository: repository.id,
        certificate: certificate.id,
        onFailure: (error) => failures.push(error),
      });
      const ready = await runtime.start(
        "Exercise the complete reviewed specialist workflow",
      );
      const answer = await runtime.prompt(
        "Complete all five stages through the engine and release idle specialists.",
      );
      assert.deepEqual(errors, []);
      assert.match(JSON.stringify(answer), /All five stages passed/);
      assert.equal(
        engine.identity.session(ready.engineSession).stage,
        "complete",
      );
      const tasks = engine.store.list<SpecialistTask>("specialist-task");
      assert.equal(tasks.length, 10);
      assert.ok(
        tasks.every(
          (task) =>
            task.status === "completed" && task.result?.trust === "untrusted",
        ),
      );
      const reviewers = engine.store
        .list<Session>("session")
        .filter((s) => s.role === "Reviewer");
      assert.equal(
        reviewers.length,
        1,
        "Reviewer must retain its own process/context across stages",
      );
      assert.equal(
        tasks.filter((task) => task.session === reviewers[0]!.session).length,
        5,
      );
      const reviewerCheckpoints = engine.store.list<
        import("../../src/compaction.js").Checkpoint
      >("checkpoint", repository.id, reviewers[0]!.session);
      assert.equal(
        reviewerCheckpoints.length,
        5,
        "The retained Reviewer must continue across a checkpoint for every assignment",
      );
      assert.ok(
        reviewerCheckpoints.every((checkpoint) =>
          checkpoint.segments.every((segment) => segment.trust === "untrusted"),
        ),
      );
      const launches = engine.store.list<RuntimeLaunch>("runtime-launch");
      assert.equal(launches.length, 7);
      assert.equal(
        new Set(launches.map((launch) => launch.connection)).size,
        7,
      );
      assert.ok(
        launches
          .filter((launch) => launch.session !== ready.engineSession)
          .every((launch) => launch.status === "stopped"),
      );
      assert.equal(
        JSON.stringify(requests).includes("fixture-provider-secret"),
        false,
      );
      for (const task of tasks) {
        const artifact = engine.artifacts.get(
          engine.identity.session(ready.engineSession),
          task.result!.artifact,
        );
        assert.equal(artifact.session, task.session);
        assert.deepEqual(
          artifact.dependencies.sort(),
          Object.keys(task.artifacts).sort(),
        );
      }
      await runtime.stop();
      assert.deepEqual(failures, []);
      for (const launch of engine.store.list<RuntimeLaunch>("runtime-launch")) {
        assert.equal(launch.status, "stopped");
        assert.throws(() =>
          execFileSync("docker", ["inspect", launch.container!], {
            stdio: "pipe",
          }),
        );
      }
      t.diagnostic(
        `${requests.length} model requests including five Reviewer checkpoints; ten completed assignments; five passed stages; seven containers removed`,
      );
    } finally {
      await runtime?.stop().catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      engine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
