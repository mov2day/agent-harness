import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "../src/core.js";

/** Specification section 5: every subject x context cell needs a passing test
 * or an independently approved, non-stale N/A. Unmapped cells are visible gaps
 * that only strict (release) mode rejects. */
type Cell =
  | { status: "test"; tests: string[]; needsReview?: string }
  | {
      status: "na";
      reason: string;
      evidence: string;
      author: string;
      reviewer: string;
      reviewedAt: string;
      scope: string[];
      scopeHash: string;
    }
  | { status: "unmapped" };

export type Matrix = {
  rows: string[];
  columns: string[];
  tests: Record<string, { file: string; title: string }>;
  cells: Record<string, Cell>;
};

export type MatrixReport = {
  errors: string[];
  unmapped: string[];
  /** Mapped to indirect tests; a reviewer must confirm before release. */
  needsReview: string[];
  total: number;
  covered: number;
};

/** Hash of the implementation files an N/A claim depends on. A change to any
 * of them makes the approval stale. */
export function scopeHash(root: string, scope: string[]) {
  return hash(
    scope
      .toSorted()
      .map((path) => `${path}\n${hash(readFileSync(join(root, path)))}`)
      .join("\n"),
  );
}

export function checkMatrix(matrix: Matrix, root: string): MatrixReport {
  const errors: string[] = [],
    unmapped: string[] = [],
    needsReview: string[] = [];
  const expected = matrix.rows.flatMap((row) =>
    matrix.columns.map((column) => `${row}/${column}`),
  );
  for (const key of expected)
    if (!(key in matrix.cells)) errors.push(`${key}: missing cell`);
  for (const key of Object.keys(matrix.cells))
    if (!expected.includes(key)) errors.push(`${key}: unknown cell`);
  for (const [id, entry] of Object.entries(matrix.tests)) {
    const path = join(root, entry.file);
    if (!existsSync(path))
      errors.push(`test ${id}: missing file ${entry.file}`);
    else if (!readFileSync(path, "utf8").includes(`"${entry.title}`))
      errors.push(
        `test ${id}: no test titled "${entry.title}" in ${entry.file}`,
      );
  }
  let covered = 0;
  for (const key of expected) {
    const cell = matrix.cells[key];
    if (!cell) continue;
    if (cell.status === "unmapped") unmapped.push(key);
    else if (cell.status === "test") {
      if (!cell.tests.length) errors.push(`${key}: no tests listed`);
      for (const id of cell.tests)
        if (!(id in matrix.tests)) errors.push(`${key}: unknown test ${id}`);
      if (cell.needsReview !== undefined && !cell.needsReview.trim())
        errors.push(`${key}: needsReview has no rationale`);
      if (cell.needsReview) needsReview.push(key);
      else if (
        cell.tests.length &&
        cell.tests.every((id) => id in matrix.tests)
      )
        covered++;
    } else if (cell.status === "na") {
      const before = errors.length;
      for (const field of [
        "reason",
        "evidence",
        "author",
        "reviewer",
        "reviewedAt",
      ] as const)
        if (!cell[field]?.trim()) errors.push(`${key}: N/A lacks ${field}`);
      if (
        cell.author?.trim().toLowerCase() ===
        cell.reviewer?.trim().toLowerCase()
      )
        errors.push(`${key}: N/A is self-approved`);
      if (!cell.scope?.length) errors.push(`${key}: N/A has no scope files`);
      else if (cell.scope.some((path) => !existsSync(join(root, path))))
        errors.push(`${key}: N/A scope file is missing`);
      else if (scopeHash(root, cell.scope) !== cell.scopeHash)
        errors.push(`${key}: N/A approval is stale`);
      if (errors.length === before) covered++;
    } else errors.push(`${key}: unknown status`);
  }
  return { errors, unmapped, needsReview, total: expected.length, covered };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(import.meta.url), "../..");
  const strict = process.argv.includes("--strict");
  const matrix = JSON.parse(
    readFileSync(join(root, "conformance/matrix.json"), "utf8"),
  ) as Matrix;
  const report = checkMatrix(matrix, root);
  console.log(
    `conformance matrix: ${report.covered}/${report.total} cells covered, ${report.unmapped.length} unmapped, ${report.needsReview.length} awaiting reviewer confirmation`,
  );
  for (const error of report.errors) console.error(`error: ${error}`);
  if (strict)
    for (const key of [...report.unmapped, ...report.needsReview])
      console.error(
        `${report.unmapped.includes(key) ? "unmapped" : "needs review"}: ${key}`,
      );
  process.exitCode =
    report.errors.length ||
    (strict && (report.unmapped.length || report.needsReview.length))
      ? 1
      : 0;
}
