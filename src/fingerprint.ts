import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { check, digest, hash } from "./core.js";

/** Certificates bind all shipped enforcement, runtime and build inputs. Runtime
 * dependency trees are represented by lockfiles, never mutable local caches. */
export function sourceFingerprint(root: string) {
  const files = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    ".dockerignore",
  ];
  function walk(directory: string) {
    for (const entry of readdirSync(join(root, directory), {
      withFileTypes: true,
    })) {
      if (["node_modules", "__pycache__"].includes(entry.name)) continue;
      check(!entry.isSymbolicLink(), "fingerprint_symlink");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        entry.isFile() &&
        (/\.(ts|tsx|mjs|c|py|json|css|html)$/.test(entry.name) ||
          entry.name.startsWith("Dockerfile"))
      )
        files.push(path);
    }
  }
  for (const directory of [
    "src",
    "native",
    "worker",
    "runtime",
    "scripts",
    "web",
  ])
    walk(directory);
  return digest(
    files
      .sort()
      .map((path) => ({
        path: relative(root, join(root, path)),
        hash: hash(readFileSync(join(root, path))),
      })),
  );
}
