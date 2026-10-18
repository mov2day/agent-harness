import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { policyTools } from "./agents.js";

export interface CatalogEntry {
  name: string;
  scope: "global" | "repo";
  source: string;
  description?: string;
  transport?: string;
}
export interface Catalog {
  skills: CatalogEntry[];
  mcps: CatalogEntry[];
  tools: string[];
}
const limit = 500;
const safeName = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const read = (path: string, bytes = 1_000_000) => {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.size <= bytes
      ? readFileSync(path, "utf8")
      : undefined;
  } catch {
    return undefined;
  }
};
const entries = (path: string) => {
  try {
    return readdirSync(path, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && !e.isSymbolicLink(),
    );
  } catch {
    return [];
  }
};
function skillsIn(
  dir: string,
  scope: CatalogEntry["scope"],
  prefix = "",
): CatalogEntry[] {
  return entries(dir).flatMap((e) => {
    const file = join(dir, e.name, "SKILL.md"),
      text = read(file, 200_000);
    if (text === undefined) return [];
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "",
      field = (key: string) =>
        new RegExp(`^${key}:\\s*(.+)$`, "m")
          .exec(front)?.[1]
          ?.trim()
          .replace(/^["']|["']$/g, "");
    const name = `${prefix}${field("name") ?? e.name}`;
    return safeName.test(name)
      ? [
          {
            name,
            scope,
            source: file,
            description: field("description")?.slice(0, 300),
          },
        ]
      : [];
  });
}
/** Server names and transports only: environments, headers, arguments and URLs
 * routinely hold credentials and are never read into the catalog. */
function mcpsIn(
  file: string,
  scope: CatalogEntry["scope"],
  pick: (json: any) => unknown = (json) => json?.mcpServers,
): CatalogEntry[] {
  const text = read(file);
  if (text === undefined) return [];
  let servers: unknown;
  try {
    servers = pick(JSON.parse(text));
  } catch {
    return [];
  }
  if (!servers || typeof servers !== "object" || Array.isArray(servers))
    return [];
  return Object.entries(servers as Record<string, any>).flatMap(
    ([name, config]) =>
      safeName.test(name)
        ? [
            {
              name,
              scope,
              source: file,
              transport:
                typeof config?.type === "string"
                  ? config.type.slice(0, 16)
                  : config?.url
                    ? "http"
                    : "stdio",
            },
          ]
        : [],
  );
}
/** Everything the owner may allow or deny, from global and repository config. */
export function discoverCatalog(options: {
  home: string;
  repositoryPath?: string;
}): Catalog {
  const global = join(options.home, ".claude");
  const plugins = join(global, "plugins", "cache");
  const pluginSkills = entries(plugins).flatMap((market) =>
    entries(join(plugins, market.name)).flatMap((plugin) =>
      entries(join(plugins, market.name, plugin.name)).flatMap((version) =>
        skillsIn(
          join(plugins, market.name, plugin.name, version.name, "skills"),
          "global",
          `${plugin.name}:`,
        ),
      ),
    ),
  );
  const repo = options.repositoryPath;
  const skills = [
    ...skillsIn(join(global, "skills"), "global"),
    ...pluginSkills,
    ...(repo ? skillsIn(join(repo, ".claude", "skills"), "repo") : []),
  ];
  const mcps = [
    ...mcpsIn(join(options.home, ".claude.json"), "global"),
    ...(repo ? mcpsIn(join(repo, ".mcp.json"), "repo") : []),
  ];
  const unique = (list: CatalogEntry[]) => {
    const seen = new Set<string>();
    return list
      .filter((e) => !seen.has(e.name) && !!seen.add(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit);
  };
  return {
    skills: unique(skills),
    mcps: unique(mcps),
    tools: [...policyTools],
  };
}
