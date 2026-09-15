import { execFileSync } from "node:child_process";
if (!["darwin", "linux"].includes(process.platform))
  throw new Error("Native file broker supports only Linux and macOS");
execFileSync(
  process.env.CC || "clang",
  [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "native/file-helper.c",
    "-o",
    "native/file-helper",
  ],
  { stdio: "inherit" },
);

if (process.argv.includes("--test"))
  execFileSync(
    process.env.CC || "clang",
    [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-DHARNESS_TESTING",
      "native/file-helper.c",
      "-o",
      "native/file-helper-test",
    ],
    { stdio: "inherit" },
  );
