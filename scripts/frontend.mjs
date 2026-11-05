#!/usr/bin/env node
// Runs a frontend npm script from the repository root regardless of the
// caller's working directory (Tauri may run beforeBuildCommand from either the
// package root or src-tauri).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const frontendDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "frontend");
const script = process.argv[2] ?? "build";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["run", script], {
  cwd: frontendDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error) {
  console.error(`Failed to run frontend script "${script}": ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
