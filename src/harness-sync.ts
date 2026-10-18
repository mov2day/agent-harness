import { execFile } from "node:child_process";

export interface Check {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}
export interface SyncTargets {
  toml: boolean;
  opencode: boolean;
}
export const parseAgentList = (text: string) =>
  new Map(
    [...text.matchAll(/^(\S+) \((primary|subagent|all)\)\s*$/gm)].map((m) => [
      m[1]!,
      m[2]!,
    ]),
  );
/** Asks the installed OpenCode which agents it resolves for a folder, the
 * same way it would when you start it there. Owner-initiated only. */
export function listOpenCodeAgents(cwd: string) {
  return new Promise<
    | { ok: true; agents: Map<string, string> }
    | { ok: false; reason: string; missing?: boolean }
  >((resolve) =>
    execFile(
      "opencode",
      ["agent", "list"],
      { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          return resolve({
            ok: false,
            missing: code === "ENOENT",
            reason:
              code === "ENOENT"
                ? "opencode was not found on PATH"
                : `opencode did not finish: ${error.message.split("\n")[0]}`,
          });
        }
        resolve({ ok: true, agents: parseAgentList(stdout) });
      },
    ),
  );
}

export interface OpenCodeModel {
  /** `provider/model`, the form OpenCode accepts in an agent's `model`. */
  id: string;
  provider: string;
  name: string;
  status: string;
  /** Reasoning levels OpenCode offers for this model, if any. */
  variants: string[];
  reasoning: boolean;
  context?: number;
}
// eslint-disable-next-line no-control-regex
const ansi = /\u001b\[[0-9;]*m/g;
/** `opencode models --verbose` prints `provider/model` and then that model's
 * metadata as an indented JSON object. */
export function parseModels(output: string): OpenCodeModel[] {
  const lines = output.replace(ansi, "").split("\n"),
    models: OpenCodeModel[] = [];
  for (let i = 0; i < lines.length; i++) {
    const id = /^([^\s{}"/]+)\/([^\s{}"]+)$/.exec(lines[i]!.trim());
    if (!id) continue;
    const entry: OpenCodeModel = {
      id: `${id[1]}/${id[2]}`,
      provider: id[1]!,
      name: id[2]!,
      status: "active",
      variants: [],
      reasoning: false,
    };
    if (lines[i + 1]?.trim() === "{") {
      let end = i + 1;
      while (end < lines.length && lines[end] !== "}") end++;
      try {
        const meta = JSON.parse(lines.slice(i + 1, end + 1).join("\n"));
        entry.name = typeof meta.name === "string" ? meta.name : entry.name;
        entry.status = typeof meta.status === "string" ? meta.status : "active";
        entry.variants = Object.keys(meta.variants ?? {});
        entry.reasoning = meta.capabilities?.reasoning === true;
        if (Number.isFinite(meta.limit?.context))
          entry.context = meta.limit.context;
        i = end;
      } catch {
        // Keep the bare id when the metadata cannot be read.
      }
    }
    models.push(entry);
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}
/** The models OpenCode can use right now: those of the providers you have
 * connected. Owner-initiated; `refresh` also refreshes OpenCode's own catalog. */
export function listOpenCodeModels(cwd: string, refresh = false) {
  return new Promise<
    | { available: true; models: OpenCodeModel[] }
    | { available: false; reason: string }
  >((resolve) =>
    execFile(
      "opencode",
      ["models", "--verbose", ...(refresh ? ["--refresh"] : [])],
      { cwd, timeout: 90_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          return resolve({
            available: false,
            reason:
              code === "ENOENT"
                ? "opencode was not found on PATH"
                : `opencode did not finish: ${error.message.split("\n")[0]}`,
          });
        }
        const models = parseModels(stdout);
        resolve(
          models.length
            ? { available: true, models }
            : {
                available: false,
                reason:
                  "OpenCode lists no models. Connect a provider with `opencode auth login`.",
              },
        );
      },
    ),
  );
}
