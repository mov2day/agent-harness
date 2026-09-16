import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceFingerprint } from "../src/fingerprint.js";

test("runtime evidence: fingerprints include adapters, images, workers and locked build inputs but exclude generated caches", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-fingerprint-"));
  try {
    for (const directory of [
      "src",
      "native",
      "worker",
      "runtime",
      "scripts",
      "web",
    ])
      mkdirSync(join(root, directory));
    const inputs = [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      ".dockerignore",
      "src/adapter.ts",
      "native/helper.c",
      "worker/runner.py",
      "worker/Dockerfile",
      "runtime/plugin.mjs",
      "runtime/package-lock.json",
      "runtime/Dockerfile",
      "scripts/build.mjs",
      "web/App.tsx",
    ];
    for (const path of inputs) writeFileSync(join(root, path), "original");
    const original = sourceFingerprint(root);
    for (const path of inputs) {
      writeFileSync(join(root, path), "changed");
      assert.notEqual(sourceFingerprint(root), original, path);
      writeFileSync(join(root, path), "original");
    }
    mkdirSync(join(root, "runtime/node_modules"));
    writeFileSync(join(root, "runtime/node_modules/cache.json"), "generated");
    writeFileSync(join(root, "native/file-helper"), "compiled");
    assert.equal(sourceFingerprint(root), original);
    symlinkSync(join(root, "package.json"), join(root, "src/external.ts"));
    assert.throws(() => sourceFingerprint(root), /fingerprint_symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
