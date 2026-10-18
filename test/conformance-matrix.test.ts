import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { checkMatrix, scopeHash, type Matrix } from "../conformance/matrix.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "matrix-"));
  mkdirSync(join(root, "test"));
  writeFileSync(
    join(root, "test/a.test.ts"),
    'test("a: real case", () => {});',
  );
  writeFileSync(join(root, "impl.ts"), "export const v = 1;");
  const matrix = (cell: Matrix["cells"][string]): Matrix => ({
    rows: ["r"],
    columns: ["c"],
    tests: { a: { file: "test/a.test.ts", title: "a: real case" } },
    cells: { "r/c": cell },
  });
  return { root, matrix, cleanup: () => rmSync(root, { recursive: true }) };
}

const na = (root: string, patch: object = {}) => ({
  status: "na" as const,
  reason: "no plugin surface",
  evidence: "docs/x.md",
  author: "alice",
  reviewer: "bob",
  reviewedAt: "2026-10-18",
  scope: ["impl.ts"],
  scopeHash: scopeHash(root, ["impl.ts"]),
  ...patch,
});

test("conformance matrix: tests must exist, cells must be complete, unmapped cells are reported", () => {
  const w = workspace();
  try {
    assert.deepEqual(
      checkMatrix(w.matrix({ status: "test", tests: ["a"] }), w.root).errors,
      [],
    );
    const bad = checkMatrix(
      w.matrix({ status: "test", tests: ["zzz"] }),
      w.root,
    );
    assert.match(bad.errors.join(), /unknown test zzz/);
    const ghost = w.matrix({ status: "test", tests: ["a"] });
    ghost.tests.a!.title = "a: renamed away";
    assert.match(checkMatrix(ghost, w.root).errors.join(), /no test titled/);
    const missing = w.matrix({ status: "test", tests: ["a"] });
    missing.columns.push("d");
    assert.match(
      checkMatrix(missing, w.root).errors.join(),
      /r\/d: missing cell/,
    );
    const gap = checkMatrix(w.matrix({ status: "unmapped" }), w.root);
    assert.deepEqual(gap.errors, []);
    assert.deepEqual(gap.unmapped, ["r/c"]);
  } finally {
    w.cleanup();
  }
});

test("conformance matrix: N/A needs an independent reviewer and goes stale when its scope changes", () => {
  const w = workspace();
  try {
    assert.deepEqual(checkMatrix(w.matrix(na(w.root)), w.root).errors, []);
    assert.match(
      checkMatrix(
        w.matrix(na(w.root, { reviewer: "Alice " })),
        w.root,
      ).errors.join(),
      /self-approved/,
    );
    assert.match(
      checkMatrix(w.matrix(na(w.root, { evidence: "" })), w.root).errors.join(),
      /lacks evidence/,
    );
    const approved = w.matrix(na(w.root));
    writeFileSync(join(w.root, "impl.ts"), "export const v = 2;");
    assert.match(checkMatrix(approved, w.root).errors.join(), /stale/);
  } finally {
    w.cleanup();
  }
});

test("conformance matrix: the committed matrix is well formed", () => {
  const root = join(import.meta.dirname, "..");
  const matrix = JSON.parse(
    readFileSync(join(root, "conformance/matrix.json"), "utf8"),
  ) as Matrix;
  assert.deepEqual(checkMatrix(matrix, root).errors, []);
});
