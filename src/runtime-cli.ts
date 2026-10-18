#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { check } from "./core.js";
import { parseRuntimeArguments } from "./runtime-args.js";
import { ExternalOpenCode } from "./adapters/external-opencode.js";
import { HttpTransport, loadPairing } from "./adapters/bridge.js";

const args = process.argv.slice(2);
if (args.includes("--help") || !args.length) {
  process.stdout.write(
    "Externally start a contained OpenCode session.\n\nRequired: --repository ID --repository-path PATH --pairing FILE --certificate ID\nChoose: --goal TEXT or --restart-from PREVIOUS_ROOT_ID\nOptional: --engine http://127.0.0.1:4317 --once\n\nRun the engine separately. The owner must install current runtime evidence and configure role models first. The web interface does not launch root sessions. Restart requires completed cleanup and reconciliation of the old root and its specialists.\n",
  );
} else {
  let runtime: ExternalOpenCode | undefined;
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const { option, has } = parseRuntimeArguments(args);
    const repository = option("--repository"),
      repositoryPath = option("--repository-path"),
      pairing = option("--pairing"),
      certificate = option("--certificate"),
      goal = option("--goal"),
      restartFrom = option("--restart-from");
    check(
      repository &&
        repositoryPath &&
        pairing &&
        certificate &&
        !!goal !== !!restartFrom,
      "runtime_arguments_required",
    );
    const integration = loadPairing(resolve(pairing), [
      resolve(repositoryPath),
    ]);
    runtime = new ExternalOpenCode({
      integration,
      repository,
      certificate,
      transport: new HttpTransport(
        option("--engine") ?? "http://127.0.0.1:4317",
      ),
      onFailure(error) {
        process.stderr.write(`Runtime stopped: ${String(error)}\n`);
        input.close();
      },
    });
    const interrupt = () => {
      input.close();
      void runtime
        ?.stop()
        .catch((error) => process.stderr.write(`${String(error)}\n`));
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    const session = await runtime.start(goal, restartFrom);
    process.stdout.write(`Registered session: ${session.engineSession}\n`);
    let prompt =
      goal ??
      "Continue the engine's restored goal from the clean checkpoint, following current approved instructions and review gates.";
    for (;;) {
      const result = (await runtime.prompt(prompt)) as {
        info?: { error?: unknown };
        parts?: Array<{ type: string; text?: string }>;
      };
      check(
        !result.info?.error,
        "runtime_turn_failed",
        JSON.stringify(result.info?.error),
      );
      for (const part of result.parts ?? [])
        if (part.type === "text" && part.text)
          process.stdout.write(`${part.text}\n`);
      if (has("--once")) break;
      prompt = await input.question("Next instruction (empty to finish): ");
      if (!prompt.trim()) break;
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    input.close();
    try {
      await runtime?.stop();
    } catch (error) {
      process.stderr.write(`Cleanup needs attention: ${String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
