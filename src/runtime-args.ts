import { check } from "./core.js";

/** The launcher accepts only these arguments. Anything else, including options
 * that would set policy, models, skills, review gates or specialist limits, is
 * rejected rather than ignored: the engine is the only authority for those. */
const valueFlags = [
  "--repository",
  "--repository-path",
  "--pairing",
  "--certificate",
  "--goal",
  "--restart-from",
  "--engine",
] as const;
const booleanFlags = ["--once", "--help"] as const;

export function parseRuntimeArguments(args: string[]) {
  const values = new Map<string, string>(),
    flags = new Set<string>();
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if ((valueFlags as readonly string[]).includes(arg)) {
      const value = args[at + 1];
      check(
        value && !value.startsWith("--"),
        "runtime_argument",
        `Missing ${arg}`,
      );
      check(!values.has(arg), "runtime_argument", `Repeated ${arg}`);
      values.set(arg, value);
      at++;
    } else if ((booleanFlags as readonly string[]).includes(arg))
      flags.add(arg);
    else check(false, "runtime_argument", `Unsupported argument ${arg}`);
  }
  return {
    option: (flag: (typeof valueFlags)[number]) => values.get(flag),
    has: (flag: (typeof booleanFlags)[number]) => flags.has(flag),
  };
}
