import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform, release, arch } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Policies, defaultPolicy } from "../src/policy.js";
import { Identity, Repositories } from "../src/identity.js";
import {
  Containment,
  runtimeScenarios,
  type RuntimeCertificate,
} from "../src/containment.js";
import { Operations } from "../src/operations.js";
import { digest, id, sign, type Session } from "../src/core.js";
const exec = promisify(execFile),
  image = process.env.HARNESS_TEST_WORKER_IMAGE;
assert.match(
  image ?? "",
  /^sha256:[a-f0-9]{64}$/,
  "Set the actual built worker image ID; this benchmark never substitutes a container mock.",
);
const directory = mkdtempSync(join(tmpdir(), "harness-benchmark-")),
  containers: string[] = [];
const store = new Store(join(directory, "engine.sqlite")),
  policies = new Policies(store),
  repositories = new Repositories(store),
  identity = new Identity(store, policies, repositories),
  containment = new Containment(store, "mechanism-benchmark-fixture"),
  operations = new Operations(store, identity, policies, (s) =>
    containment.healthy(s),
  );
containment.setInvalidator((session) =>
  operations.invalidate(session, "enforcement_unhealthy"),
);
const refresh = setInterval(() => {
  void containment
    .refresh()
    .catch((error) => process.stderr.write(String(error) + "\n"));
}, 250);
const percentile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;
try {
  await exec("git", ["init", "-q", join(directory, "repo")]);
  const repository = repositories.enroll(join(directory, "repo"));
  policies.publish("global", defaultPolicy, true);
  const integration = identity.pair("opencode");
  // The Python image exercises the production container-inspection mechanism.
  // These fixture attestations are confined to disposable state and are NOT
  // evidence that an OpenCode or Codex binary was independently certified.
  const value = {
    runtime: "opencode" as const,
    version: "python-mechanism-fixture",
    models: {},
    platform: process.platform as "linux" | "darwin",
    image: image!,
    sourceHash: "mechanism-benchmark-fixture",
    author: "benchmark-fixture",
    reviewer: "fixture-not-independent-review",
    scenarios: Object.fromEntries(
      runtimeScenarios.map((name) => [
        name,
        { passed: true, evidence: "a".repeat(64) },
      ]),
    ) as RuntimeCertificate["scenarios"],
    approved: true,
    expires: store.clock.now() + 3_600_000,
  };
  const certificate = { ...value, id: digest(value) };
  containment.install(certificate);
  const sessions: Array<{ session: Session; capability: string }> = [];
  for (let n = 0; n < 8; n++) {
    const binding = {
      integration: integration.id,
      repository: repository.id,
      runtimeSession: id(),
      connection: id(),
    };
    const registration = {
      ...binding,
      nonce: identity.challenge(binding).nonce,
    };
    const session = identity.register(
      registration,
      sign(integration.secret, registration),
    );
    const created = (
      await exec(
        "docker",
        [
          "run",
          "--detach",
          "--name",
          `harness-benchmark-${id()}`,
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "64",
          "--memory",
          "256m",
          "--user",
          "1000:1000",
          "--ipc",
          "private",
          "--label",
          `agent-harness.session=${binding.runtimeSession}`,
          "--label",
          `agent-harness.connection=${binding.connection}`,
          "--entrypoint",
          "/usr/local/bin/python3",
          image!,
          "-I",
          "-c",
          "import time; time.sleep(120)",
        ],
        { timeout: 15_000 },
      )
    ).stdout.trim();
    containers.push(created);
    containment.attach(session.session, created, certificate.id);
    sessions.push(session);
  }
  const request = (n: number) => {
    const s = sessions[n % 8]!;
    operations.begin(s.capability, s.session.connection, {
      tool: "artifact",
      args: {
        kind: "plan",
        content: "benchmark input",
        dependencies: [],
        trust: "untrusted",
        sources: [],
      },
      idempotencyKey: `benchmark-${n}`,
    });
  };
  for (let n = 0; n < 16; n++) request(n);
  const admission: number[] = [],
    audit: number[] = [],
    lateness: number[] = [],
    count = 500,
    started = performance.now();
  await Promise.all(
    Array.from(
      { length: count },
      (_, n) =>
        new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            try {
              const before = performance.now();
              lateness.push(Math.max(0, before - started - n * 20));
              request(n + 16);
              admission.push(performance.now() - before);
              const auditStarted = performance.now();
              store.transaction(() =>
                store.audit("benchmark.durable_audit", { sample: n }),
              );
              audit.push(performance.now() - auditStarted);
              resolve();
            } catch (error) {
              reject(error);
            }
          }, n * 20);
        }),
    ),
  );
  const elapsed = performance.now() - started;
  await exec("docker", ["stop", "--time", "0", containers[0]!]);
  await containment.refresh();
  const healthDeadline = performance.now() + 1500;
  while (
    identity.session(sessions[0]!.session.session).status === "active" &&
    performance.now() < healthDeadline
  )
    await new Promise((resolve) => setTimeout(resolve, 25));
  const report = {
    kind: "authorization-mechanism-benchmark",
    runtimeCertification: false,
    limitation:
      "Uses the real container health inspector with a Python image and disposable fixture attestations. Full OpenCode/Codex runtime certification remains separate.",
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      architecture: arch(),
      image,
    },
    sessions: 8,
    scheduledRequestsPerSecond: 50,
    samples: admission.length,
    elapsedMs: elapsed,
    admissionIncludingDurableIntentMs: {
      p95: percentile(admission, 0.95),
      p99: percentile(admission, 0.99),
      max: Math.max(...admission),
    },
    durableAuditMs: {
      p95: percentile(audit, 0.95),
      p99: percentile(audit, 0.99),
    },
    schedulingLatenessMs: {
      p95: percentile(lateness, 0.95),
      p99: percentile(lateness, 0.99),
    },
    observedContainerStop:
      identity.session(sessions[0]!.session.session).status === "paused",
  };
  mkdirSync("conformance/results", { recursive: true });
  writeFileSync(
    "conformance/results/authorization.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  assert.equal(report.observedContainerStop, true);
  assert.ok(
    report.admissionIncludingDurableIntentMs.p95 <= 20,
    "p95 authorization exceeds 20 ms",
  );
  assert.ok(
    report.admissionIncludingDurableIntentMs.p99 <= 50,
    "p99 authorization exceeds 50 ms",
  );
  assert.ok(
    elapsed <= 10_500,
    "The engine did not sustain the scheduled request rate",
  );
} finally {
  clearInterval(refresh);
  containment.close();
  if (containers.length)
    await exec("docker", ["rm", "--force", ...containers]).catch((error) =>
      process.stderr.write(`Benchmark cleanup failed: ${String(error)}\n`),
    );
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
