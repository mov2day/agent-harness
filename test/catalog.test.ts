import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCatalog } from "../src/catalog.js";

function tree() {
  const dir = mkdtempSync(join(tmpdir(), "harness-catalog-")),
    home = join(dir, "home"),
    repo = join(dir, "repo");
  const skill = (root: string, name: string, body: string) => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "SKILL.md"), body);
  };
  skill(
    join(home, ".claude", "skills"),
    "lint",
    "---\nname: lint\ndescription: Lint code\n---\nbody",
  );
  skill(
    join(
      home,
      ".claude",
      "plugins",
      "cache",
      "market",
      "tools",
      "1.0.0",
      "skills",
    ),
    "deploy",
    "---\nname: deploy\ndescription: Ship it\n---\n",
  );
  skill(join(repo, ".claude", "skills"), "house-style", "no frontmatter");
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        github: {
          command: "gh",
          args: ["--token", "s3cret"],
          env: { TOKEN: "s3cret" },
        },
        docs: {
          type: "http",
          url: "https://x.test/?key=s3cret",
          headers: { Authorization: "s3cret" },
        },
      },
    }),
  );
  writeFileSync(
    join(repo, ".mcp.json"),
    JSON.stringify({ mcpServers: { local: { command: "node" } } }),
  );
  return { dir, home, repo };
}

test("catalog lists global and repository skills and MCP servers", () => {
  const t = tree();
  try {
    const c = discoverCatalog({ home: t.home, repositoryPath: t.repo });
    assert.deepEqual(
      c.skills.map((s) => [s.name, s.scope]),
      [
        ["house-style", "repo"],
        ["lint", "global"],
        ["tools:deploy", "global"],
      ],
    );
    assert.equal(
      c.skills.find((s) => s.name === "lint")?.description,
      "Lint code",
    );
    assert.deepEqual(
      c.mcps.map((m) => [m.name, m.scope, m.transport]),
      [
        ["docs", "global", "http"],
        ["github", "global", "stdio"],
        ["local", "repo", "stdio"],
      ],
    );
    assert.ok(c.tools.includes("research"));
    assert.equal(
      discoverCatalog({ home: t.home }).skills.some((s) => s.scope === "repo"),
      false,
    );
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("catalog never exposes secrets and tolerates malformed or hostile config", () => {
  const t = tree();
  try {
    assert.ok(
      !JSON.stringify(
        discoverCatalog({ home: t.home, repositoryPath: t.repo }),
      ).includes("s3cret"),
    );
    writeFileSync(join(t.repo, ".mcp.json"), "{not json");
    writeFileSync(
      join(t.home, ".claude.json"),
      JSON.stringify({ mcpServers: ["x"] }),
    );
    mkdirSync(join(t.dir, "outside", "evil"), { recursive: true });
    writeFileSync(
      join(t.dir, "outside", "evil", "SKILL.md"),
      "---\nname: evil\n---",
    );
    symlinkSync(
      join(t.dir, "outside", "evil"),
      join(t.repo, ".claude", "skills", "evil"),
    );
    const c = discoverCatalog({ home: t.home, repositoryPath: t.repo });
    assert.deepEqual(c.mcps, []);
    assert.ok(!c.skills.some((s) => s.name === "evil"));
    assert.deepEqual(
      discoverCatalog({
        home: join(t.dir, "missing"),
        repositoryPath: join(t.dir, "nope"),
      }).skills,
      [],
    );
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});
