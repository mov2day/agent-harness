import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import { check, HarnessError } from "./core.js";
import type { Policy } from "./policy.js";

/** harness.toml is a readable, diffable form of a published policy: the same
 * keys, as TOML. It carries no authority by itself. Only the owner importing
 * it through the control tower validates and publishes it, under the same
 * rules as any other candidate. */
const limit = 512 * 1024;
export const tomlMarker = "# agent-harness policy (format 1)";
const header = [
  tomlMarker,
  "# Import this in the control tower (Agents > harness.toml). Importing validates",
  "# and publishes it under the same rules as the form; nothing here applies by itself.",
  "",
].join("\n");
export const policyToToml = (policy: Policy) =>
  // JSON round trip drops undefined, which TOML cannot hold.
  header + stringify(JSON.parse(JSON.stringify(policy)));
export function tomlToPolicy(text: string): unknown {
  check(
    Buffer.byteLength(text) <= limit,
    "toml_too_large",
    "harness.toml is too large",
    413,
  );
  try {
    // Plain JSON values only: no null prototypes, dates or bigints reach policy.
    return JSON.parse(JSON.stringify(parse(text)));
  } catch (error) {
    throw new HarnessError(
      "toml_invalid",
      `harness.toml is not valid TOML: ${(error as Error).message}`,
      400,
    );
  }
}
/** Read a harness.toml for the owner to review. Regular files only. */
export function readTomlFile(path: string) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
      return {
        path,
        text: null,
        reason: "Not a regular file within the size limit",
      };
    return { path, text: readFileSync(path, "utf8") };
  } catch {
    return { path, text: null };
  }
}

export interface TomlWritePlan {
  path: string;
  action: "create" | "update" | "unchanged" | "conflict";
  reason?: string;
}
const entry = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};
/** A file the harness wrote starts with its marker. Anything else is the
 * owner's own and is replaced only when they explicitly say so. */
export function planTomlWrite(path: string, content: string): TomlWritePlan {
  const directory = entry(dirname(path));
  if (directory && (!directory.isDirectory() || directory.isSymbolicLink()))
    return {
      path,
      action: "conflict",
      reason: "The folder is not a regular directory",
    };
  const stat = entry(path);
  if (!stat) return { path, action: "create" };
  if (!stat.isFile() || stat.isSymbolicLink())
    return { path, action: "conflict", reason: "Not a regular file" };
  const current = readFileSync(path, "utf8");
  if (current === content) return { path, action: "unchanged" };
  return current.startsWith(tomlMarker)
    ? { path, action: "update" }
    : {
        path,
        action: "conflict",
        reason: "A harness.toml you wrote already exists",
      };
}
/** Writes a planned create or update; `replace` also replaces a conflicting
 * regular file the owner chose to overwrite. Never writes through a link. */
export function applyTomlWrite(
  plan: TomlWritePlan,
  content: string,
  replace = false,
) {
  check(
    plan.action !== "unchanged" &&
      (plan.action !== "conflict" ||
        (replace && plan.reason === "A harness.toml you wrote already exists")),
    "toml_write_refused",
    plan.action === "unchanged"
      ? "Nothing to write"
      : (plan.reason ?? "The file was not written"),
  );
  const directory = dirname(plan.path);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  const temp = `${plan.path}.harness-tmp`;
  if (entry(temp)) unlinkSync(temp);
  writeFileSync(temp, content, { flag: "wx", mode: 0o644 });
  renameSync(temp, plan.path);
}
