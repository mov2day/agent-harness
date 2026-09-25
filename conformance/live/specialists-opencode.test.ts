import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  canonical,
  digest,
  hash,
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
import type { Operation } from "../../src/operations.js";
import type { SpecialistTask } from "../../src/specialists.js";

test(
  "live OpenCode specialists: reviewed invoice fix, isolated test execution, denied deletion, all stages and durable release",
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
    const workerImage = execFileSync(
      "docker",
      [
        "image",
        "inspect",
        process.env.HARNESS_TEST_WORKER_IMAGE ?? "agent-harness-worker:latest",
        "--format",
        "{{.Id}}",
      ],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    t.diagnostic(`Pinned runtime image: ${image}; worker: ${workerImage}`);
    const dir = mkdtempSync(join(tmpdir(), "harness-live-specialists-"));
    const engine = new Engine({
      state: join(dir, "state"),
      sourceHash: "live-specialists-fixture-only",
      workerImage,
    });
    const server = createEngineServer(engine, "fixture-owner", resolve("web"));
    let runtime: ExternalOpenCode | undefined;
    try {
      execFileSync("git", ["init", "-q", join(dir, "repo")]);
      const before = "def invoice_total(prices):\n    return 0\n";
      const after = "def invoice_total(prices):\n    return sum(prices)\n";
      mkdirSync(join(dir, "repo/src"));
      writeFileSync(join(dir, "repo/src/invoice.py"), before);
      const testSource =
        "import unittest\nfrom invoice import invoice_total\nclass InvoiceTest(unittest.TestCase):\n    def test_items(self): self.assertEqual(invoice_total([12, 8, 5]), 25)\n    def test_empty(self): self.assertEqual(invoice_total([]), 0)\n    def test_credit(self): self.assertEqual(invoice_total([12, -2]), 10)\n";
      writeFileSync(join(dir, "repo/src/test_invoice.py"), testSource);
      const repository = engine.enroll(join(dir, "repo"));
      const changeArgs = {
        path: "src/invoice.py",
        base: hash(before),
        content: after,
      };
      const command = {
        executable: "/usr/local/bin/python3",
        args: ["-m", "unittest", "-v", "test_invoice.py"],
        env: {},
        cwd: "src",
      };
      let executionArgs: Record<string, unknown>;
      const approvals = new Map<string, string>();
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
          tools: [...defaultPolicy.tools, "change", "delete", "execute"],
          commands: [command],
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
      type Action = { name: string; args: unknown } | string;
      const ownerPost = async (path: string, body: unknown) => {
        const response = await fetch(`${origin}/v1/owner/${path}`, {
          method: "POST",
          headers: {
            authorization: "Bearer fixture-owner",
            origin,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const result = (await response.json()) as any;
        assert.equal(response.status, 200, JSON.stringify(result));
        return result;
      };
      const proposal = (stage: string) => {
        const found = engine.store
          .list<Artifact>("artifact", repository.id)
          .find(
            (a) =>
              a.kind === "change-set" &&
              JSON.parse(a.content).tool ===
                (stage === "implementation" ? "change" : "execute"),
          );
        assert.ok(found, `Missing ${stage} proposal`);
        return found;
      };
      const actions: Array<() => Action | Promise<Action>> = [];
      for (const [index, stage] of stages.slice(0, -1).entries()) {
        const effect = stage === "implementation" || stage === "execution";
        if (effect) {
          actions.push(() => ({
            name: "delegate",
            args: {
              role: roleByStage[stage]!,
              task: `Prepare reviewed ${stage} action`,
              artifacts: [stageArtifact(stages[index - 1]!).id],
            },
          }));
          actions.push(() => ({
            name: "delegate",
            args: {
              action: "message",
              session: active("Reviewer")!.session,
              task: `Review exact ${stage} action`,
              artifacts: [proposal(stage).id],
            },
          }));
          actions.push(async () => {
            const artifact = proposal(stage),
              change = JSON.parse(artifact.content);
            // Test-owned operator fixture: approve through the owner HTTP route.
            // Provider/runtime requests never receive the owner credential.
            const approved = await ownerPost("actions/approve", {
              root: artifact.root,
              ...change,
              dependencies: [artifact.id],
            });
            approvals.set(stage, approved.id);
            return {
              name: "delegate",
              args: {
                action: "message",
                session: active(roleByStage[stage]!)!.session,
                task: `Apply approved ${stage} action with approval ${approved.id}, then submit stage evidence`,
                artifacts: [artifact.id],
              },
            };
          });
        } else
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
        actions.push(async () => {
          const attempt = engine.store
            .list<StageAttempt>("stage-attempt")
            .find((a) => a.stage === stage)!;
          if (stage === "implementation") {
            assert.equal(attempt.state, "human_gate");
            assert.equal(
              engine.identity.session(attempt.root).stage,
              "implementation",
            );
            await ownerPost("reviews/approve", {
              root: attempt.root,
              artifact: attempt.artifact,
              review: attempt.review,
            });
          }
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
          void (async () => {
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
              assert.ok(requests.length <= 90, "Unexpected extra model loop");
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
                action = await next();
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
                if (task.instructions.startsWith("Prepare reviewed")) {
                  if (stage === "execution" && turn === 0) {
                    action = { name: "artifact", args: { action: "snapshot" } };
                  } else if (turn === (stage === "execution" ? 1 : 0)) {
                    const snapshot = engine.store
                      .list<Artifact>("artifact", repository.id, sessionId)
                      .find((a) => a.kind === "execution-snapshot");
                    if (stage === "execution") {
                      assert.ok(snapshot);
                      executionArgs = { ...command, snapshot: snapshot.id };
                    }
                    action = {
                      name: "artifact",
                      args: {
                        kind: "change-set",
                        trust: "untrusted",
                        content: canonical({
                          tool:
                            stage === "implementation" ? "change" : "execute",
                          args:
                            stage === "implementation"
                              ? changeArgs
                              : executionArgs,
                        }),
                        dependencies: [
                          ...Object.keys(task.artifacts),
                          ...(snapshot ? [snapshot.id] : []),
                        ],
                        sources: Object.keys(task.artifacts),
                        shareWithRoot: true,
                      },
                    };
                  } else
                    action =
                      "Exact action proposed for review; no effect has been applied.";
                } else if (task.instructions.startsWith("Review exact")) {
                  action =
                    turn === 0
                      ? {
                          name: "review",
                          args: {
                            kind: "change",
                            artifact: Object.keys(task.artifacts)[0],
                            findings: [],
                          },
                        }
                      : "Reviewed the exact proposed action.";
                } else if (session.role === "Reviewer") {
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
                } else if (
                  task.instructions.startsWith("Apply approved") &&
                  turn === 0
                ) {
                  assert.ok(system.includes(approvals.get(stage)!));
                  action = {
                    name: stage === "implementation" ? "change" : "execute",
                    args: {
                      ...(stage === "implementation"
                        ? changeArgs
                        : executionArgs),
                      approval: approvals.get(stage),
                    },
                  };
                } else if (stage === "implementation" && turn === 1) {
                  assert.equal(
                    readFileSync(
                      join(repository.path, "src/invoice.py"),
                      "utf8",
                    ),
                    after,
                  );
                  action = {
                    name: "delete",
                    args: {
                      path: "src/test_invoice.py",
                      base: hash(testSource),
                      approval: approvals.get(stage),
                    },
                  };
                } else if (
                  turn ===
                  (stage === "implementation"
                    ? 2
                    : stage === "execution"
                      ? 1
                      : 0)
                ) {
                  action = {
                    name: "artifact",
                    args: {
                      kind: `stage-${stage}`,
                      content:
                        stage === "implementation"
                          ? "Applied the reviewed invoice total fix. Deleting the test was denied."
                          : stage === "execution"
                            ? "Executed the reviewed invoice test command; inspect the linked execution evidence."
                            : `Evidence for ${stage}`,
                      dependencies: [
                        ...Object.keys(task.artifacts),
                        ...(stage === "execution"
                          ? engine.store
                              .list<Artifact>(
                                "artifact",
                                repository.id,
                                sessionId,
                              )
                              .filter((a) => a.kind === "execution")
                              .map((a) => a.id)
                          : []),
                      ],
                      sources: Object.keys(task.artifacts),
                      trust: "untrusted",
                      shareWithRoot: true,
                    },
                  };
                } else if (
                  turn ===
                  (stage === "implementation"
                    ? 3
                    : stage === "execution"
                      ? 2
                      : 1)
                ) {
                  action = {
                    name: "artifact",
                    args: { action: "submit", id: stageArtifact(stage).id },
                  };
                } else {
                  assert.equal(
                    turn,
                    stage === "implementation"
                      ? 4
                      : stage === "execution"
                        ? 3
                        : 2,
                  );
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
          })();
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
        "Fix invoice totals, preserve tests, and verify the reviewed change",
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
      assert.equal(tasks.length, 14);
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
        7,
      );
      const reviewerCheckpoints = engine.store.list<
        import("../../src/compaction.js").Checkpoint
      >("checkpoint", repository.id, reviewers[0]!.session);
      assert.equal(
        reviewerCheckpoints.length,
        5,
        "The retained Reviewer must continue across a checkpoint for every stage review",
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
      assert.equal(
        readFileSync(join(repository.path, "src/invoice.py"), "utf8"),
        after,
      );
      assert.equal(
        readFileSync(join(repository.path, "src/test_invoice.py"), "utf8"),
        testSource,
      );
      const effects = engine.store
        .list<Operation>("operation")
        .filter((op) => ["change", "execute"].includes(op.tool));
      assert.equal(effects.length, 2);
      assert.ok(effects.every((op) => op.status === "completed"));
      const execution = engine.store
        .list<Artifact>("artifact", repository.id)
        .find((a) => a.kind === "execution")!;
      assert.ok(execution);
      const result = JSON.parse(execution.content);
      assert.equal(result.exitCode, 0, result.output);
      assert.match(result.output, /Ran 3 tests/);
      assert.match(result.output, /OK/);
      assert.match(JSON.stringify(requests), /deletion_disabled/);
      const worker = effects.find((op) => op.tool === "execute")!.worker!;
      assert.ok(worker.admitted);
      assert.throws(() =>
        execFileSync("docker", ["inspect", worker.container], {
          stdio: "pipe",
        }),
      );
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
        `${requests.length} model requests including five Reviewer checkpoints; fourteen completed assignments; reviewed file edit; three executed tests; denied deletion; five passed stages; seven runtime containers and one worker removed`,
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
