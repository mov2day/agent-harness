import { z } from "zod";
import { check } from "./core.js";
import { suiteHash, type Score } from "./learning.js";
import type { ModelResponse } from "./model-channel.js";

const scalar = z.union([
  z.string().max(16000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const assertion = z
  .object({
    path: z
      .array(
        z.union([
          z.string().max(128),
          z.number().int().nonnegative().max(10000),
        ]),
      )
      .max(16),
    operator: z.enum(["equals", "contains", "excludes", "at_least", "at_most"]),
    expected: scalar,
  })
  .strict()
  .refine(
    (value) =>
      value.operator === "equals" ||
      ((value.operator === "contains" || value.operator === "excludes") &&
        typeof value.expected === "string" &&
        value.expected.length > 0) ||
      ((value.operator === "at_least" || value.operator === "at_most") &&
        typeof value.expected === "number"),
    "Assertion value does not match its operator",
  );
export const evaluationSuiteSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    version: z.string().min(1).max(128),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    cases: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
            kind: z.enum(["control", "quality"]),
            split: z.enum(["fixture", "heldout"]),
            modelDependent: z.literal(true),
            prompt: z.string().min(1).max(16000),
            output: z.enum(["text", "json"]),
            maxOutputTokens: z.number().int().min(256).max(8192),
            checks: z.array(assertion).min(1).max(64),
          })
          .strict(),
      )
      .min(4)
      .max(64),
  })
  .strict();
export type EvaluationSuite = z.infer<typeof evaluationSuiteSchema>;
export function validateEvaluationSuite(input: unknown) {
  const suite = evaluationSuiteSchema.parse(input);
  check(suite.id === suiteHash(suite), "suite_hash");
  check(
    new Set(suite.cases.map((test) => test.id)).size === suite.cases.length,
    "suite_duplicate_case",
  );
  for (const split of ["fixture", "heldout"])
    for (const kind of ["control", "quality"])
      check(
        suite.cases.some((test) => test.split === split && test.kind === kind),
        "suite_coverage",
      );
  check(
    suite.cases.every(
      (test) =>
        test.output === "json" ||
        test.checks.every((rule) => rule.path.length === 0),
    ),
    "suite_text_path",
  );
  return suite;
}

/** Scoring uses owner-defined assertions only. Model text cannot define a score,
 * supply new criteria, or request an external effect. */
export function scoreResponse(
  test: EvaluationSuite["cases"][number],
  response: ModelResponse,
): Score & { checks: boolean[]; malformed: boolean } {
  const message = response.choices[0]!.message;
  let value: unknown = message.content;
  let malformed = typeof value !== "string" || !!message.tool_calls?.length;
  if (!malformed && test.output === "json") {
    try {
      value = JSON.parse(value as string);
    } catch {
      malformed = true;
    }
  }
  const checks = test.checks.map((rule) => {
    if (malformed) return false;
    let actual = value;
    for (const key of rule.path) {
      if (!actual || typeof actual !== "object" || !Object.hasOwn(actual, key))
        return false;
      actual = (actual as Record<string | number, unknown>)[key];
    }
    switch (rule.operator) {
      case "equals":
        return actual === rule.expected;
      case "contains":
        return (
          typeof actual === "string" && actual.includes(rule.expected as string)
        );
      case "excludes":
        return (
          typeof actual === "string" &&
          !actual.includes(rule.expected as string)
        );
      case "at_least":
        return (
          typeof actual === "number" &&
          Number.isFinite(actual) &&
          actual >= (rule.expected as number)
        );
      case "at_most":
        return (
          typeof actual === "number" &&
          Number.isFinite(actual) &&
          actual <= (rule.expected as number)
        );
    }
  });
  return {
    passed: checks.every(Boolean),
    score: checks.filter(Boolean).length / checks.length,
    checks,
    malformed,
  };
}
