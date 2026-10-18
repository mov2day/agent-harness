import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sourceFingerprint } from "../src/fingerprint.js";
import { checkMatrix, type Matrix } from "../conformance/matrix.js";
import {
  releaseBlockers,
  type Signoff,
  type StepResult,
} from "../conformance/release.js";

// Runs the OpenCode release gate and writes conformance/results/release.json.
// Needs Docker: set DOCKER_CONTEXT to the dedicated daemon first. Exit 0 only
// when there are no blockers.
const root = resolve(import.meta.dirname, "..");
const docker = process.env.DOCKER_CONTEXT ? "docker" : null;
const steps: StepResult[] = [];

function run(
  name: string,
  command: string,
  args: string[],
  env: Record<string, string> = {},
) {
  const started = Date.now();
  console.log(`\n=== ${name}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  steps.push({
    name,
    status: result.status === 0 ? "passed" : "failed",
    seconds: Math.round((Date.now() - started) / 100) / 10,
  });
}
const skip = (name: string) =>
  steps.push({ name, status: "skipped", seconds: 0 });

run("format", "npm", ["run", "format:check"]);
run("verify", "npm", ["run", "verify"]);
run("matrix-strict", "npm", ["run", "conformance:matrix", "--", "--strict"]);

if (!docker)
  for (const name of [
    "linux-container",
    "live-workers",
    "live-opencode",
    "live-engine",
    "live-specialists",
    "benchmark",
  ])
    skip(name);
else {
  const image = (reference: string) =>
    `sha256:${execFileSync("docker", ["image", "inspect", reference, "--format", "{{.Id}}"], { encoding: "utf8" }).trim().replace("sha256:", "")}`;
  run("linux-container", "sh", [
    "-c",
    "docker build -q -f conformance/Dockerfile.linux -t agent-harness-linux-tests:release . && docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges agent-harness-linux-tests:release",
  ]);
  const env = {
    HARNESS_TEST_WORKER_IMAGE: image(
      process.env.HARNESS_TEST_WORKER_IMAGE ?? "agent-harness-worker:latest",
    ),
    HARNESS_TEST_OPENCODE_IMAGE:
      process.env.HARNESS_TEST_OPENCODE_IMAGE ??
      "agent-harness-opencode:1.18.31",
  };
  run("live-workers", "npm", ["run", "test:workers:live"], env);
  run("live-opencode", "npm", ["run", "test:opencode:live"], env);
  run("live-engine", "npm", ["run", "test:opencode:engine"], env);
  run("live-specialists", "npm", ["run", "test:opencode:specialists"], env);
  run("benchmark", "npm", ["run", "benchmark:authorization"], env);
}

const fingerprint = sourceFingerprint(root),
  dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim() !== "",
  matrix = checkMatrix(
    JSON.parse(
      readFileSync(join(root, "conformance/matrix.json"), "utf8"),
    ) as Matrix,
    root,
  ),
  signoffPath = join(root, "conformance/release-signoff.json"),
  signoff = existsSync(signoffPath)
    ? (JSON.parse(readFileSync(signoffPath, "utf8")) as Signoff)
    : null,
  blockers = releaseBlockers({ fingerprint, dirty, steps, matrix, signoff });

mkdirSync(join(root, "conformance/results"), { recursive: true });
writeFileSync(
  join(root, "conformance/results/release.json"),
  JSON.stringify(
    {
      head: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      fingerprint,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      steps,
      matrix: {
        total: matrix.total,
        covered: matrix.covered,
        unmapped: matrix.unmapped.length,
        needsReview: matrix.needsReview.length,
      },
      blockers,
      releaseReady: blockers.length === 0,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  blockers.length
    ? `\nNOT release ready (${blockers.length} blockers):\n- ${blockers.join("\n- ")}`
    : "\nRelease ready: no blockers.",
);
process.exitCode = blockers.length ? 1 : 0;
