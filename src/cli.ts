#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "./engine.js";
import { createEngineServer, ownerCredential } from "./server.js";
import { check } from "./core.js";
import { sourceFingerprint } from "./fingerprint.js";
const args = process.argv.slice(2),
  command = args.shift() ?? "help";
const value = (flag: string, fallback?: string) => {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const value = args[index + 1];
  check(
    value && !value.startsWith("--"),
    "cli_argument",
    `Missing value for ${flag}`,
  );
  return value;
};
const state = resolve(
  value("--state", join(homedir(), ".local", "state", "agent-harness"))!,
);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
if (command === "help") {
  process.stdout.write(
    `agent-harness — local engine controls\n\nCommands:\n  init                         Create owner-only state and web credential\n  serve [--port 4317]           Run loopback engine and web controls\n  enroll --repository PATH     Verify and enroll a Git worktree\n  pair --runtime opencode      Provision a trusted bridge credential\n  credential-path              Print the web credential file location\n  fingerprint                  Print the enforcement source fingerprint\n\nOptions: --state PATH (outside repositories); --worker-image sha256:DIGEST\nRoot coding sessions are started independently. No command launches a root session.\n`,
  );
} else if (command === "credential-path") {
  process.stdout.write(`${join(state, "web.credential")}\n`);
} else if (command === "fingerprint") {
  process.stdout.write(`${sourceFingerprint(projectRoot)}\n`);
} else {
  const engine = new Engine({
    state,
    sourceHash: sourceFingerprint(projectRoot),
    workerImage: value("--worker-image"),
  });
  if (command === "serve") {
    const credential = ownerCredential(state),
      port = Number(value("--port", "4317"));
    check(Number.isInteger(port) && port >= 0 && port <= 65535, "invalid_port");
    const directory = resolve("dist/web");
    check(
      existsSync(join(directory, "index.html")),
      "web_build_missing",
      "Run npm run build before starting the engine",
    );
    const server = createEngineServer(engine, credential.token, directory);
    server.on("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      engine.close();
      process.exitCode = 1;
    });
    server.listen(port, "127.0.0.1", () =>
      process.stdout.write(
        `Engine controls: http://127.0.0.1:${(server.address() as { port: number }).port}\nWeb credential file: ${credential.file}\n`,
      ),
    );
    const close = () => {
      server.close(() => {
        engine.close();
        process.exit(0);
      });
      server.closeAllConnections();
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
  } else {
    try {
      if (command === "init") {
        const credential = ownerCredential(state);
        process.stdout.write(
          `Initialized: ${state}\nWeb credential file: ${credential.file}\n`,
        );
      } else if (command === "enroll") {
        const repository = value("--repository");
        check(repository, "repository_required");
        const r = engine.enroll(repository);
        process.stdout.write(`${r.id}\n${r.path}\n`);
      } else if (command === "pair") {
        const runtime = value("--runtime");
        check(
          runtime === "opencode" || runtime === "codex",
          "runtime_required",
        );
        const integration = engine.identity.pair(runtime);
        const directory = join(state, "pairings");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `${integration.id}.json`);
        writeFileSync(path, JSON.stringify(integration), {
          mode: 0o600,
          flag: "wx",
        });
        process.stdout.write(
          `Pairing credential: ${path}\nKeep this file in the trusted host bridge, outside runtime mounts and agent context.\n`,
        );
      } else throw new Error(`Unknown command: ${command}`);
    } finally {
      engine.close();
    }
  }
}
