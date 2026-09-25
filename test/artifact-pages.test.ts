import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import { Artifacts } from "../src/workflow.js";
import { Compaction } from "../src/compaction.js";
import { toolSchemas } from "../src/operations.js";
import { hash } from "../src/core.js";

test("artifact pages: a bounded large-output reference can reconstruct exact UTF-8 content without losing identity or trust", async () => {
  const f = fixture(),
    scope = f.register().session;
  const artifacts = new Artifacts(f.store, f.identity),
    compaction = new Compaction(f.store, f.identity, artifacts);
  try {
    compaction.configure(scope, 32768, 8192);
    const original = artifacts.create(scope, {
      kind: "large-report",
      content: "🙂你好 é\n\u0000 ".repeat(400),
      sources: [],
      dependencies: [],
    });
    const bounded = (await compaction.completeTool(
      scope,
      "large-result",
      "artifact",
      {},
      original,
    )) as {
      id: string;
      hash: string;
      outputArtifact: string;
      outputHash: string;
    };
    assert.equal(bounded.id, original.id);
    assert.equal(bounded.hash, original.hash);
    assert.ok(bounded.outputArtifact);
    let offset: number | null = 0,
      content = "";
    while (offset !== null) {
      const page = artifacts.page(scope, bounded.id, bounded.hash, offset, 17);
      assert.equal(page.id, original.id);
      assert.equal(page.hash, original.hash);
      assert.equal(page.trust, "untrusted");
      assert.ok(page.bytes > 0 && page.bytes <= 17);
      assert.equal(Buffer.byteLength(page.content), page.bytes);
      assert.equal(page.content.includes("�"), false);
      assert.equal(page.totalBytes, Buffer.byteLength(original.content));
      content += page.content;
      if (page.next !== null) assert.ok(page.next > offset);
      offset = page.next;
    }
    assert.equal(content, original.content);
    assert.equal(hash(content), original.hash);
    const wrapped = artifacts.page(
      scope,
      bounded.outputArtifact,
      bounded.outputHash,
    );
    assert.equal(wrapped.trust, "untrusted");
    assert.match(wrapped.content, /large-report/);
    assert.deepEqual(artifacts.get(scope, bounded.outputArtifact).sources, [
      original.id,
    ]);
  } finally {
    compaction.close();
    f.close();
  }
});

test("artifact pages: exact versions, scope, offsets, page limits and invalidated evidence remain enforced", () => {
  const f = fixture(),
    scope = f.register().session,
    artifacts = new Artifacts(f.store, f.identity);
  try {
    const artifact = artifacts.create(scope, {
      kind: "evidence",
      content: "🙂 first page\nsecond page",
      sources: [],
      dependencies: [],
    });
    const query = { action: "page", id: artifact.id, hash: artifact.hash };
    assert.deepEqual(toolSchemas.artifact.parse(query), {
      ...query,
      offset: 0,
      bytes: 512,
    });
    for (const invalid of [
      { offset: -1 },
      { offset: 0.5 },
      { bytes: 3 },
      { bytes: 1025 },
      { hash: "invented" },
      { trust: "governing" },
    ])
      assert.throws(() => toolSchemas.artifact.parse({ ...query, ...invalid }));
    assert.throws(
      () => artifacts.page(scope, artifact.id, "0".repeat(64)),
      /artifact_version_changed/,
    );
    assert.throws(
      () =>
        artifacts.page(
          { ...scope, repository: f.other.id },
          artifact.id,
          artifact.hash,
        ),
      /Artifact not found/,
    );
    assert.throws(
      () =>
        artifacts.page(
          { ...scope, session: "unshared" },
          artifact.id,
          artifact.hash,
        ),
      /Artifact not found/,
    );
    assert.throws(
      () => artifacts.page(scope, artifact.id, artifact.hash, 1),
      /artifact_page_boundary/,
    );
    assert.throws(
      () => artifacts.page(scope, artifact.id, artifact.hash, 1000),
      /artifact_page_range/,
    );
    assert.throws(
      () => artifacts.page(scope, artifact.id, artifact.hash, 0, 2048),
      /artifact_page_range/,
    );
    const eof = artifacts.page(
      scope,
      artifact.id,
      artifact.hash,
      Buffer.byteLength(artifact.content),
    );
    assert.equal(eof.content, "");
    assert.equal(eof.next, null);
    artifacts.invalidate(scope, artifact.id);
    assert.equal(
      artifacts.page(scope, artifact.id, artifact.hash).valid,
      false,
    );
    artifact.content = "tampered";
    f.store.put(
      "artifact",
      artifact.id,
      artifact,
      scope.repository,
      scope.session,
    );
    assert.throws(
      () => artifacts.page(scope, artifact.id, artifact.hash),
      /artifact_integrity/,
    );
  } finally {
    f.close();
  }
});
