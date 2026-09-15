import { execFileSync } from "node:child_process";
import { check, canonical, digest, hash, type Session } from "./core.js";
import type { Store } from "./store.js";
import type { Identity } from "./identity.js";
import type { NativeFiles } from "./files.js";
import type { Policies } from "./policy.js";
import type { Artifacts, Artifact } from "./workflow.js";
export interface SnapshotEntry {
  path: string;
  hash: string;
  size: number;
  mode: number;
}
export interface SnapshotManifest {
  version: 1;
  repository: string;
  policy: string;
  tree: string;
  files: SnapshotEntry[];
}
interface SnapshotBlob {
  repository: string;
  session: string;
  snapshot: string;
  path: string;
  hash: string;
  content: string;
}
export function snapshotPath(path: string) {
  check(
    path.length > 0 &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.split("/").every((p) => p !== "." && p !== ".." && p !== ""),
    "snapshot_path",
  );
}
/** Only regular-file entries are emitted. There are no links, devices, or caller-selected archive headers. */
export function snapshotTar(
  entries: Array<{ path: string; mode: number; content: Buffer }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    snapshotPath(entry.path);
    let name = entry.path,
      prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const at = entry.path.lastIndexOf("/");
      check(at > 0, "snapshot_path_too_long");
      prefix = entry.path.slice(0, at);
      name = entry.path.slice(at + 1);
    }
    check(
      Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155,
      "snapshot_path_too_long",
    );
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    const oct = (value: number, start: number, length: number) => {
      const encoded = value.toString(8).padStart(length - 1, "0") + "\0";
      check(encoded.length === length, "snapshot_size");
      header.write(encoded, start, length, "ascii");
    };
    oct(entry.mode & 0o777, 100, 8);
    oct(1000, 108, 8);
    oct(1000, 116, 8);
    oct(entry.content.length, 124, 12);
    oct(0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.write(prefix, 345, 155, "utf8");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    chunks.push(
      header,
      entry.content,
      Buffer.alloc((512 - (entry.content.length % 512)) % 512),
    );
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
export class Snapshots {
  constructor(
    readonly store: Store,
    readonly identity: Identity,
    readonly policies: Policies,
    readonly files: NativeFiles,
    readonly artifacts: Artifacts,
  ) {}
  private paths(scope: Session) {
    const repository = this.identity.repositories.verify(scope.repository),
      effective = this.policies.effective(scope.repository);
    const output = execFileSync(
      "git",
      [
        "-C",
        repository.path,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      {
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const paths = [...new Set(output.split("\0").filter(Boolean))]
      .filter((path) => this.policies.path(effective, path))
      .sort();
    check(paths.length <= 4096, "snapshot_file_limit");
    return { repository, paths };
  }
  capture(scope: Session): Artifact {
    check(
      scope.role === "Verifier" || scope.role === "Implementer",
      "snapshot_role",
    );
    const { repository, paths } = this.paths(scope),
      entries: Array<SnapshotEntry & { content: Buffer }> = [];
    let total = 0;
    for (const path of paths) {
      snapshotPath(path);
      const content = this.files.read(repository, path);
      if (content === null) continue;
      const metadata = this.files.metadata(repository, path);
      check(metadata, "snapshot_changed");
      total += content.length;
      check(total <= 32 * 1024 * 1024, "snapshot_byte_limit");
      entries.push({
        path,
        hash: hash(content),
        size: content.length,
        mode: metadata.mode,
        content,
      });
    }
    const files = entries.map(({ content, ...entry }) => entry),
      manifest: SnapshotManifest = {
        version: 1,
        repository: scope.repository,
        policy: scope.policy,
        tree: digest(files),
        files,
      };
    // Build before persisting: unsupported paths cannot produce an apparently usable snapshot.
    snapshotTar(entries);
    return this.store.transaction(() => {
      const artifact = this.artifacts.create(scope, {
        kind: "execution-snapshot",
        content: canonical(manifest),
        dependencies: [],
        sources: [],
      });
      this.store.put(
        "snapshot-record",
        artifact.id,
        {
          repository: scope.repository,
          session: scope.session,
          hash: artifact.hash,
        },
        scope.repository,
        scope.session,
      );
      for (const entry of entries) {
        const blob: SnapshotBlob = {
          repository: scope.repository,
          session: scope.session,
          snapshot: artifact.id,
          path: entry.path,
          hash: entry.hash,
          content: entry.content.toString("base64"),
        };
        this.store.put(
          "snapshot-blob",
          digest([artifact.id, entry.path]),
          blob,
          scope.repository,
          scope.session,
        );
      }
      return artifact;
    });
  }
  get(scope: Session, key: string) {
    const artifact = this.artifacts.get(scope, key),
      record = this.store.get<{
        repository: string;
        session: string;
        hash: string;
      }>("snapshot-record", key);
    check(
      record?.repository === scope.repository &&
        record.session === artifact.session &&
        record.hash === artifact.hash &&
        artifact.valid &&
        artifact.kind === "execution-snapshot" &&
        artifact.root === scope.root &&
        artifact.policy === scope.policy &&
        hash(artifact.content) === artifact.hash,
      "snapshot_invalid",
    );
    const manifest = JSON.parse(artifact.content) as SnapshotManifest;
    check(
      manifest.repository === scope.repository &&
        manifest.policy === scope.policy &&
        manifest.version === 1 &&
        digest(manifest.files) === manifest.tree,
      "snapshot_integrity",
    );
    return { artifact, manifest };
  }
  assertCurrent(scope: Session, key: string) {
    const { manifest } = this.get(scope, key),
      { repository, paths } = this.paths(scope);
    const current: SnapshotEntry[] = [];
    for (const path of paths) {
      const content = this.files.read(repository, path);
      if (content === null) continue;
      const metadata = this.files.metadata(repository, path);
      check(metadata, "snapshot_changed");
      current.push({
        path,
        hash: hash(content),
        size: content.length,
        mode: metadata.mode,
      });
    }
    check(
      digest(current) === manifest.tree,
      "snapshot_changed",
      "Repository contents changed since execution review",
    );
    return manifest;
  }
  archive(scope: Session, key: string) {
    const { artifact, manifest } = this.get(scope, key);
    const entries = manifest.files.map((file) => {
      const blob = this.store.get<SnapshotBlob>(
        "snapshot-blob",
        digest([key, file.path]),
      );
      check(
        blob &&
          blob.repository === scope.repository &&
          blob.session === artifact.session &&
          blob.snapshot === key &&
          blob.path === file.path &&
          blob.hash === file.hash,
        "snapshot_blob_scope",
      );
      const content = Buffer.from(blob.content, "base64");
      check(
        hash(content) === file.hash && content.length === file.size,
        "snapshot_blob_integrity",
      );
      return { ...file, content };
    });
    return snapshotTar(entries);
  }
}
