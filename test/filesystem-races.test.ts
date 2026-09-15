import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  symlinkSync,
  linkSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fixture } from "./helpers.js";
for (const attack of [
  "leaf-symlink",
  "intermediate-swap",
  "ancestor-rename",
  "deletion-race",
  "hard-link",
] as const)
  test(`native race: ${attack} after descriptor pinning rejects mutation`, async () => {
    const f = fixture();
    try {
      mkdirSync(join(f.repo.path, "src/nested"), { recursive: true });
      const target = join(f.repo.path, "src/nested/file");
      writeFileSync(target, "original");
      writeFileSync(join(f.other.path, "private"), "private");
      const expected = join(f.dir, "expected"),
        content = join(f.dir, "content");
      writeFileSync(expected, "original");
      writeFileSync(content, "replacement");
      const helper = spawn(
        resolve("native/file-helper-test"),
        [
          f.repo.path,
          String(f.repo.device),
          String(f.repo.inode),
          "replace",
          "src/nested/file",
          expected,
          content,
        ],
        { env: { HARNESS_TEST_PAUSE: "1" }, stdio: ["pipe", "pipe", "pipe"] },
      );
      let stderr = "";
      helper.stderr.on("data", (data) => (stderr += data));
      const exited = new Promise<number | null>((resolve, reject) => {
        helper.on("close", resolve);
        helper.on("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        helper.stdout.once("data", (data) => {
          if (data.toString().includes("READY")) resolve();
          else reject(new Error("No ready barrier"));
        });
        helper.once("error", reject);
      });
      if (attack === "leaf-symlink") {
        unlinkSync(target);
        symlinkSync(join(f.other.path, "private"), target);
      }
      if (attack === "intermediate-swap") {
        renameSync(join(f.repo.path, "src/nested"), join(f.repo.path, "old"));
        symlinkSync(f.other.path, join(f.repo.path, "src/nested"));
      }
      if (attack === "ancestor-rename") {
        renameSync(join(f.repo.path, "src"), join(f.other.path, "moved"));
        mkdirSync(join(f.repo.path, "src/nested"), { recursive: true });
        writeFileSync(target, "original");
      }
      if (attack === "deletion-race") unlinkSync(target);
      if (attack === "hard-link")
        linkSync(target, join(f.other.path, "shared"));
      helper.stdin.end("g");
      assert.notEqual(await exited, 0, stderr);
      assert.equal(
        readFileSync(join(f.other.path, "private"), "utf8"),
        "private",
      );
      if (attack === "ancestor-rename")
        assert.equal(readFileSync(target, "utf8"), "original");
      if (attack === "hard-link")
        assert.equal(
          readFileSync(join(f.other.path, "shared"), "utf8"),
          "original",
        );
    } finally {
      f.close();
    }
  });
test("case behavior: native volume detection controls deny matching without changing path spelling", () => {
  const f = fixture();
  try {
    const e = f.policies.effective(f.repo.id);
    assert.equal(f.policies.path(e, ".ENV"), f.repo.caseSensitive);
    const replica = { ...f.repo, caseSensitive: false };
    f.store.put("repository", replica.id, replica, replica.id);
    assert.equal(f.policies.path(e, ".ENV"), false);
    replica.caseSensitive = true;
    f.store.put("repository", replica.id, replica, replica.id);
    assert.equal(f.policies.path(e, ".ENV"), true);
  } finally {
    f.close();
  }
});
