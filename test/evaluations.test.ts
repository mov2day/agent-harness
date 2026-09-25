import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientRequest, IncomingMessage } from "node:http";
import { fixture } from "./helpers.js";
import { digest, id, type Session } from "../src/core.js";
import { defaultPolicy } from "../src/policy.js";
import { Operations } from "../src/operations.js";
import { Artifacts } from "../src/workflow.js";
import { Learning, suiteHash, type Evaluation } from "../src/learning.js";
import {
  Evaluations,
  type EvaluationJob,
  type EvaluationRun,
} from "../src/evaluations.js";
import {
  validateEvaluationSuite,
  scoreResponse,
  type EvaluationSuite,
} from "../src/evaluation-suites.js";
import { ModelChannel, type ModelResponse } from "../src/model-channel.js";
import type { HttpsRequestFactory } from "../src/gateway.js";

function setup() {
  const f = fixture();
  f.policies.setModelCapabilities(() => ({ Conductor: { fixture: ["none"] } }));
  f.policies.publish(
    "global",
    {
      ...defaultPolicy,
      models: { Conductor: { model: "fixture", reasoning: "none" } },
    },
    true,
  );
  const scope = f.register().session;
  // No runtime is trusted here. Evaluation inference has no effect dispatcher.
  const operations = new Operations(
    f.store,
    f.identity,
    f.policies,
    () => false,
  );
  const artifacts = new Artifacts(f.store, f.identity);
  const learning = new Learning(f.store, artifacts, operations);
  const candidate = learning.propose(scope, {
    kind: "instruction",
    target: "reporting",
    before: "",
    after: "Use the improved reporting method.",
    baseVersion: "initial",
    sources: [
      artifacts.create(scope, {
        kind: "observation",
        content: "Private proposal evidence",
        sources: [],
        dependencies: [],
      }).id,
    ],
  });
  const suiteBody = {
    version: "evaluation-fixture-1",
    scope: f.repo.id,
    cases: (["fixture", "heldout"] as const).flatMap((split) =>
      (["control", "quality"] as const).map((kind) => ({
        id: `${split}-${kind}`,
        kind,
        split,
        modelDependent: true as const,
        prompt: `${split} ${kind}: return a structured answer`,
        output: "json" as const,
        maxOutputTokens: 256,
        checks: [
          {
            path: [kind],
            operator: "equals" as const,
            expected:
              kind === "control" ? true : "golden-value-known-only-to-scorer",
          },
        ],
      })),
    ),
  };
  const suite: EvaluationSuite = { ...suiteBody, id: suiteHash(suiteBody) };
  const controls = { hold: false, mode: "normal", seen: () => {}, aborted: 0 };
  const requests: any[] = [];
  const request: HttpsRequestFactory = (_url, options, callback) => {
    assert.equal(options.rejectUnauthorized, true);
    const req = new EventEmitter() as ClientRequest;
    req.setTimeout = () => req;
    req.destroy = (error?: Error) => {
      queueMicrotask(() => req.emit("error", error));
      return req;
    };
    const abort = () => {
      controls.aborted++;
      req.destroy(new Error("aborted"));
    };
    options.signal!.addEventListener("abort", abort, { once: true });
    req.end = ((body: string) => {
      const input = JSON.parse(body);
      requests.push(input);
      controls.seen();
      if (controls.hold) return req;
      const proposed = input.messages[1].content.includes(candidate.after);
      const heldout = input.messages.at(-1).content.includes("heldout");
      const output: Record<string, unknown> = {
        control:
          !(controls.mode === "baseline-control" && !proposed) &&
          !(controls.mode === "proposed-control" && proposed),
        quality: (
          controls.mode === "tie"
            ? true
            : controls.mode === "regression" && heldout
              ? !proposed
              : proposed
        )
          ? "golden-value-known-only-to-scorer"
          : "baseline-answer",
      };
      const message: ModelResponse["choices"][0]["message"] = {
        role: "assistant",
        content:
          controls.mode === "malformed" && proposed
            ? "{invalid"
            : JSON.stringify(output),
      };
      if (controls.mode === "tool" && proposed)
        message.tool_calls = [
          {
            id: "attempted-effect",
            type: "function",
            function: { name: "harness_execute", arguments: "{}" },
          },
        ];
      if (controls.mode === "credential")
        message.content = "private-provider-token";
      queueMicrotask(() => {
        options.signal!.removeEventListener("abort", abort);
        const response = Readable.from([
          Buffer.from(JSON.stringify({ choices: [{ message }] })),
        ]) as IncomingMessage;
        response.statusCode = 200;
        response.headers = {};
        callback(response);
      });
      return req;
    }) as ClientRequest["end"];
    return req;
  };
  const models = new ModelChannel(
    f.store,
    operations,
    async () => [{ address: "93.184.216.34", family: 4 }],
    request,
  );
  const credentialFile = join(f.dir, "provider.key");
  writeFileSync(credentialFile, "private-provider-token", { mode: 0o600 });
  const profile = {
    id: "fixture",
    endpoint: "https://provider.example/v1/chat/completions",
    credentialFile,
    models: [
      {
        id: "fixture",
        upstream: "fixture-upstream",
        reasoning: ["none"],
        maxOutputTokens: 1024,
        contextWindow: 32768,
        tokenizer: "utf8_bytes",
      },
    ],
  };
  models.install(profile);
  const evaluations = new Evaluations(f.store, learning, () => models);
  evaluations.install(suite);
  const start = (key: string = id()) =>
    evaluations.start(scope, candidate.id, suite.id, key);
  async function finish() {
    return evaluations.wait(start().id);
  }
  return {
    ...f,
    scope,
    operations,
    artifacts,
    learning,
    candidate,
    suite,
    models,
    evaluations,
    controls,
    requests,
    profile,
    start,
    finish,
    close() {
      evaluations.close();
      f.close();
    },
  };
}

test("production evaluation: independent actual provider requests, three runs per side/case, durable evidence and promotion verification", async () => {
  const f = setup();
  try {
    const job = await f.finish();
    assert.equal(job.status, "completed", job.error);
    assert.equal(job.finished, 24);
    assert.equal(f.requests.length, 24);
    assert.equal(f.store.list("operation").length, 0);
    assert.equal(
      f.store.list("artifact").length,
      1,
      "Held-out inputs and replies never become runtime artifacts",
    );
    for (const request of f.requests) {
      assert.equal(request.model, "fixture-upstream");
      assert.equal(request.tool_choice, "none");
      assert.equal(request.tools, undefined);
      assert.equal(request.messages.length, 4);
      assert.equal(request.max_completion_tokens, 256);
      assert.equal(
        JSON.stringify(request).includes("golden-value-known-only-to-scorer"),
        false,
      );
      assert.equal(
        JSON.stringify(request).includes("Private proposal evidence"),
        false,
      );
    }
    const evaluation = f.store.get<Evaluation>("evaluation", job.evaluation!)!;
    assert.equal(evaluation.eligible, true);
    assert.equal(evaluation.run, job.id);
    assert.equal(evaluation.candidateVersion, f.candidate.version);
    const runs = f.store.list<EvaluationRun>(
      "evaluation-run",
      f.repo.id,
      f.scope.session,
    );
    assert.equal(runs.length, 24);
    assert.ok(
      runs.every(
        (run) =>
          run.status === "completed" &&
          run.responseHash === digest(run.response),
      ),
    );
    const promoted = f.learning.promote(f.scope, f.candidate.id, true);
    assert.equal(promoted.content, f.candidate.after);
    assert.equal(f.evaluations.get(job.id).status, "completed");
  } finally {
    f.close();
  }
});

test("production evaluation: baseline/proposed controls, held-out regression, ties, malformed output and tool attempts cannot be approved", async () => {
  for (const mode of [
    "baseline-control",
    "proposed-control",
    "regression",
    "tie",
    "malformed",
    "tool",
  ]) {
    const f = setup();
    try {
      f.controls.mode = mode;
      const job = await f.finish();
      assert.equal(job.status, "completed", `${mode}: ${job.error}`);
      const evaluation = f.store.get<Evaluation>(
        "evaluation",
        job.evaluation!,
      )!;
      assert.equal(evaluation.eligible, false, mode);
      assert.throws(
        () => f.learning.promote(f.scope, f.candidate.id, true),
        /learning_ineligible/,
        mode,
      );
      assert.equal(f.store.list("operation").length, 0, mode);
      assert.equal(f.store.list("skill").length, 0, mode);
    } finally {
      f.close();
    }
  }
});

test("production evaluation: idempotency and immutable complete evidence defeat duplicate jobs, missing runs and edited scores", async () => {
  const f = setup();
  try {
    const job = f.start("same-request");
    assert.equal(f.start("same-request").id, job.id);
    assert.throws(() => f.start("another-request"), /evaluation_running/);
    assert.throws(
      () =>
        f.evaluations.start(
          f.scope,
          f.candidate.id,
          "a".repeat(64),
          "same-request",
        ),
      /idempotency_conflict/,
    );
    const completed = await f.evaluations.wait(job.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(f.requests.length, 24);
    const sample = f.store.list<EvaluationRun>("evaluation-run")[0]!;
    f.store.remove("evaluation-run", sample.id);
    assert.throws(
      () => f.learning.promote(f.scope, f.candidate.id, true),
      /evaluation_incomplete/,
    );
    f.store.put(
      "evaluation-run",
      sample.id,
      { ...sample, result: { ...sample.result, score: 0.73 } },
      f.repo.id,
      f.scope.session,
    );
    assert.throws(
      () => f.learning.promote(f.scope, f.candidate.id, true),
      /evaluation_score_integrity/,
    );
    f.store.put(
      "evaluation-run",
      sample.id,
      { ...sample, responseHash: "changed" },
      f.repo.id,
      f.scope.session,
    );
    assert.throws(
      () => f.learning.promote(f.scope, f.candidate.id, true),
      /evaluation_evidence_integrity/,
    );
    f.store.put(
      "evaluation-run",
      sample.id,
      sample,
      f.repo.id,
      f.scope.session,
    );
    f.store.put(
      "evaluation-job",
      completed.id,
      { ...completed, runner: "previous-engine-source" },
      f.repo.id,
      f.scope.session,
    );
    assert.throws(
      () => f.learning.promote(f.scope, f.candidate.id, true),
      /evaluation_runner_changed/,
    );
    f.store.put(
      "evaluation-job",
      completed.id,
      completed,
      f.repo.id,
      f.scope.session,
    );
    const source = f.artifacts.get(f.scope, f.candidate.sources[0]!);
    f.store.put(
      "artifact",
      source.id,
      { ...source, trust: "governing" },
      f.repo.id,
      f.scope.session,
    );
    assert.throws(
      () => f.learning.promote(f.scope, f.candidate.id, true),
      /learning_provenance_changed/,
    );
  } finally {
    f.close();
  }
});

test("production evaluation: cancelled requests keep interrupted evidence and a new request starts fresh without replay", async () => {
  const f = setup();
  try {
    f.controls.hold = true;
    const requested = new Promise<void>((resolve) => {
      f.controls.seen = resolve;
    });
    const job = f.start("cancelled-request");
    await requested;
    assert.equal(f.evaluations.cancel(job.id).status, "cancelled");
    assert.equal((await f.evaluations.wait(job.id)).status, "cancelled");
    assert.equal(f.controls.aborted, 1);
    assert.equal(
      f.store.list<EvaluationRun>("evaluation-run")[0]!.status,
      "interrupted",
    );
    assert.equal(f.store.list("evaluation").length, 0);
    assert.equal(f.start("cancelled-request").id, job.id);
    assert.equal(f.requests.length, 1);
    f.controls.hold = false;
    const next = await f.finish();
    assert.equal(next.status, "completed", next.error);
    assert.notEqual(next.id, job.id);
    assert.equal(f.requests.length, 25);
  } finally {
    f.close();
  }
});

test("production evaluation: profile changes abort inference and completed evidence cannot cross a changed configuration", async () => {
  const f = setup();
  try {
    f.controls.hold = true;
    const requested = new Promise<void>((resolve) => {
      f.controls.seen = resolve;
    });
    const job = f.start();
    await requested;
    f.models.install({
      ...f.profile,
      models: [{ ...f.profile.models[0], upstream: "changed-upstream" }],
    });
    assert.equal((await f.evaluations.wait(job.id)).status, "cancelled");
    assert.equal(f.controls.aborted, 1);
    assert.equal(f.store.list("evaluation").length, 0);
    f.controls.hold = false;
    const completed = await f.finish();
    assert.equal(completed.status, "completed", completed.error);
    f.models.install(f.profile);
    assert.throws(
      () => f.learning.promote(f.scope, f.candidate.id, true),
      /evaluation_model_changed/,
    );
    const repeated = f.start("recheck-current-model");
    assert.throws(
      () => f.learning.promote(f.scope, f.candidate.id, true),
      /learning_ineligible/,
    );
    assert.equal((await f.evaluations.wait(repeated.id)).status, "completed");
    assert.equal(
      f.learning.promote(f.scope, f.candidate.id, true).content,
      f.candidate.after,
    );
  } finally {
    f.close();
  }
});

test("production evaluation: recovery never replays unfinished jobs and fixture scores cannot bypass the production gate", async () => {
  const f = setup();
  let recovered: Evaluations | undefined;
  try {
    const job = f.start("interrupted");
    f.evaluations.close();
    await f.evaluations.wait(job.id);
    f.store.put(
      "evaluation-job",
      job.id,
      { ...job, status: "running" },
      f.repo.id,
      f.scope.session,
    );
    recovered = new Evaluations(f.store, f.learning, () => f.models);
    assert.equal(recovered.get(job.id).status, "interrupted");
    assert.equal(f.requests.length, 0);
    assert.equal(
      recovered.start(f.scope, f.candidate.id, f.suite.id, "interrupted")
        .status,
      "interrupted",
    );
    await f.learning.evaluate(
      f.scope,
      f.candidate.id,
      f.suite.id,
      async (content, test) => ({
        passed: true,
        score: test.kind === "control" ? 1 : content ? 0.9 : 0.4,
      }),
    );
    assert.throws(
      () => f.learning.promote(f.scope, f.candidate.id, true),
      /production_evaluation_required/,
    );
  } finally {
    recovered?.close();
    f.close();
  }
});

test("evaluation suites: strict repository scope, coverage, exact checks, output parsing and credential filtering", async () => {
  const f = setup();
  try {
    const otherSuite = { ...f.suite, scope: f.other.id };
    otherSuite.id = suiteHash(otherSuite);
    f.evaluations.install(otherSuite);
    assert.throws(
      () =>
        f.evaluations.start(f.scope, f.candidate.id, otherSuite.id, "other"),
      /suite_scope/,
    );
    assert.throws(() =>
      f.evaluations.install({ ...f.suite, permissions: ["delete"] }),
    );
    assert.throws(() =>
      validateEvaluationSuite({ ...f.suite, cases: f.suite.cases.slice(0, 2) }),
    );
    assert.throws(
      () => validateEvaluationSuite({ ...f.suite, version: "changed" }),
      /suite_hash/,
    );
    assert.throws(() => f.evaluations.get(id()), /evaluation_not_found/);
    const sample = f.suite.cases[0]!;
    const response = (content: string): ModelResponse => ({
      choices: [{ message: { role: "assistant", content } }],
    });
    assert.equal(
      scoreResponse(
        {
          ...sample,
          checks: [{ path: [], operator: "equals", expected: null }],
        },
        response("1e999"),
      ).passed,
      false,
    );
    assert.equal(
      scoreResponse(
        {
          ...sample,
          checks: [{ path: [], operator: "at_least", expected: 1 }],
        },
        response("1e999"),
      ).passed,
      false,
    );
    assert.equal(
      scoreResponse(
        {
          ...sample,
          checks: [
            { path: ["constructor"], operator: "equals", expected: null },
          ],
        },
        response("{}"),
      ).passed,
      false,
    );
    assert.equal(
      scoreResponse(
        {
          ...sample,
          output: "text",
          checks: [{ path: [], operator: "contains", expected: "review" }],
        },
        response("Preserve review gates"),
      ).score,
      1,
    );
    f.controls.mode = "credential";
    const job = await f.finish();
    assert.equal(job.status, "failed");
    assert.equal(job.error, "provider_credential_in_response");
    assert.equal(f.store.list("evaluation").length, 0);
    assert.equal(
      JSON.stringify(f.store.list("evaluation-run")).includes(
        "private-provider-token",
      ),
      false,
    );
  } finally {
    f.close();
  }
});
