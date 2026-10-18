import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers.js";

// Specification section 2: detect actual case behavior and test both
// case-sensitive and case-insensitive volumes. macOS can create both kinds of
// volume without privileges; Linux runners cannot, so those runs are skipped.
function hdiutil(...args: string[]) {
  return execFileSync("hdiutil", args, { stdio: "pipe" });
}
const volumes = [
  { filesystem: "APFS", caseSensitive: false },
  { filesystem: "Case-sensitive APFS", caseSensitive: true },
] as const;

for (const { filesystem, caseSensitive } of volumes)
  test(
    `case behavior: real ${filesystem} volume is detected and drives deny matching`,
    {
      skip: process.platform !== "darwin" && "needs macOS disk images",
    },
    () => {
      const f = fixture(),
        image = join(f.dir, "volume.dmg"),
        mount = join(f.dir, "mount");
      let attached = false;
      try {
        hdiutil(
          "create",
          "-size",
          "32m",
          "-fs",
          filesystem,
          "-volname",
          "h",
          image,
        );
        mkdirSync(mount);
        hdiutil(
          "attach",
          image,
          "-mountpoint",
          mount,
          "-nobrowse",
          "-noverify",
        );
        attached = true;
        execFileSync("git", ["init", "-q", join(mount, "repo")], {
          stdio: "pipe",
        });
        const repo = f.repositories.enroll(join(mount, "repo")),
          effective = f.policies.effective(repo.id);
        assert.equal(repo.caseSensitive, caseSensitive);
        // The default policy denies ".env". On a case-insensitive volume ".ENV"
        // is the same file and must be denied; on a case-sensitive volume it is
        // a different file and keeps its own spelling.
        assert.equal(f.policies.path(effective, ".env"), false);
        assert.equal(f.policies.path(effective, ".ENV"), caseSensitive);
      } finally {
        if (attached) hdiutil("detach", mount, "-force");
        f.close();
      }
    },
  );
