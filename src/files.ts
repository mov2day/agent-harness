import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { check, hash } from "./core.js";
import type { Repository } from "./identity.js";
import type { Operations, Operation } from "./operations.js";
export class NativeFiles {
  constructor(private helper = resolve("native/file-helper")) {}
  private invoke(
    repo: Repository,
    op: string,
    path: string,
    expected = "-",
    extra?: string,
  ) {
    const result = spawnSync(
      this.helper,
      [
        repo.path,
        String(repo.device),
        String(repo.inode),
        op,
        path,
        expected,
        ...(extra ? [extra] : []),
      ],
      { maxBuffer: 2_100_000, timeout: 10_000 },
    );
    check(!result.error, "native_helper_unavailable", String(result.error));
    if (op === "read" && result.status === 44) return null;
    check(
      result.status === 0,
      "filesystem_rejected",
      result.stderr?.toString() || `Helper exited ${result.status}`,
    );
    return result.stdout;
  }
  read(repo: Repository, path: string) {
    return this.invoke(repo, "read", path);
  }
  mutate(repo: Repository, op: Operation, operations: Operations) {
    const current = this.read(repo, op.args.path),
      base = current === null ? null : hash(current);
    check(base === op.args.base, "base_conflict", "File changed since review");
    const dir = mkdtempSync(join(tmpdir(), "harness-effect-"));
    try {
      const expected = current === null ? "-" : join(dir, "expected");
      if (current !== null) writeFileSync(expected, current, { mode: 0o600 });
      const content = join(dir, "content");
      if (op.tool === "change")
        writeFileSync(content, op.args.content, { mode: 0o600 });
      return operations.commit(op, () => {
        this.invoke(
          repo,
          op.tool === "change" ? "replace" : op.tool,
          op.args.path,
          expected,
          op.tool === "change" ? content : op.args.to,
        );
        return {
          path: op.args.path,
          to: op.args.to,
          hash: op.tool === "change" ? hash(op.args.content) : null,
        };
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
