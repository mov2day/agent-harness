import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
execFileSync(process.execPath, ["scripts/build-native.mjs"], {
  stdio: "inherit",
});
await mkdir("dist/web", { recursive: true });
await build({
  entryPoints: ["web/App.tsx"],
  bundle: true,
  format: "esm",
  outfile: "dist/web/app.js",
  minify: true,
  sourcemap: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
await copyFile("web/index.html", "dist/web/index.html");
await build({
  entryPoints: ["src/runtime-cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/runtime-cli.js",
  packages: "external",
  sourcemap: true,
});
await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/cli.js",
  packages: "external",
  sourcemap: true,
});
