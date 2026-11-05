#!/usr/bin/env node
/**
 * Stage the standalone AI runtime used by TradePanel's AI Analysis panel.
 *
 *   node backend/scripts/build-ai-runtime.mjs
 *   node backend/scripts/build-ai-runtime.mjs --target win-x64
 *   node backend/scripts/build-ai-runtime.mjs --target linux-x64 --target win-x64
 *
 * The output (src-tauri/ai-runtime) is a build artifact and is git-ignored:
 *
 *   node/node                     official Node.js executable (pinned)
 *   pi/node_modules/...           pinned @earendil-works/pi-coding-agent + deps
 *   pi/extensions/*.mjs           read-only analysis tools
 *   pi/prompts/analysis.md        analysis system prompt
 *   pi/settings-service.mjs      provider login/model catalogue bridge
 *   manifest.json                 paths + versions used by the Rust host
 *
 * Nothing here runs at application startup except the staged executables.
 * Downloads are SHA-256 verified against nodejs.org's SHASUMS256.txt.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const SOURCE = join(ROOT, "ai/runtime");
const OUTPUT = join(ROOT, "src-tauri/ai-runtime");
const CACHE = join(ROOT, "backend/build/ai-cache");

/** Keep in lockstep with ai/runtime/package.json and docs/STANDALONE_BUILD.md. */
const NODE_VERSION = process.env.TRADEPANEL_NODE_VERSION || "22.23.4";
const PI_VERSION = "1.5.0";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_CLI = `node_modules/${PI_PACKAGE}/dist/bundle/cli.js`;

const TARGETS = {
  "linux-x64": { platform: "linux", arch: "x64", nodeDir: "linux-x64", archive: "tar.xz", binary: "bin/node", exe: "node" },
  "linux-arm64": { platform: "linux", arch: "arm64", nodeDir: "linux-arm64", archive: "tar.xz", binary: "bin/node", exe: "node" },
  "darwin-x64": { platform: "darwin", arch: "x64", nodeDir: "darwin-x64", archive: "tar.gz", binary: "bin/node", exe: "node" },
  "darwin-arm64": { platform: "darwin", arch: "arm64", nodeDir: "darwin-arm64", archive: "tar.gz", binary: "bin/node", exe: "node" },
  "win-x64": { platform: "win32", arch: "x64", nodeDir: "win-x64", archive: "zip", binary: "node.exe", exe: "node.exe" },
  "win-arm64": { platform: "win32", arch: "arm64", nodeDir: "win-arm64", archive: "zip", binary: "node.exe", exe: "node.exe" },
};

function parseArgs(argv) {
  const targets = [];
  let clean = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target") {
      const value = argv[i + 1];
      if (!value || !TARGETS[value]) {
        throw new Error(`--target needs one of: ${Object.keys(TARGETS).join(", ")}`);
      }
      targets.push(value);
      i += 1;
    } else if (arg === "--clean") {
      clean = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node backend/scripts/build-ai-runtime.mjs [--target <id>]... [--clean]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!targets.length) {
    const host = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
    if (!TARGETS[host]) throw new Error(`Unsupported host platform: ${host}`);
    targets.push(host);
  }
  return { targets: [...new Set(targets)], clean };
}

function log(message) {
  console.log(`[ai-runtime] ${message}`);
}

function run(command, args, options = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

/** npm is a .cmd shim on Windows and needs an explicit extension. */
function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function sha256(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

async function download(url, destination) {
  log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

async function ensureNodeArchive(target) {
  const spec = TARGETS[target];
  const base = `node-v${NODE_VERSION}-${spec.nodeDir}`;
  const fileName = `${base}.${spec.archive}`;
  const archivePath = join(CACHE, fileName);
  mkdirSync(CACHE, { recursive: true });
  if (existsSync(archivePath)) return { archivePath, base, spec };

  const sumsPath = join(CACHE, `SHASUMS256-v${NODE_VERSION}.txt`);
  if (!existsSync(sumsPath)) {
    await download(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`, sumsPath);
  }
  const expected = readFileSync(sumsPath, "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === fileName)?.[0];
  if (!expected) throw new Error(`No SHA-256 entry for ${fileName} in SHASUMS256.txt`);

  await download(`https://nodejs.org/dist/v${NODE_VERSION}/${fileName}`, archivePath);
  const actual = sha256(archivePath);
  if (actual !== expected) {
    rmSync(archivePath, { force: true });
    throw new Error(`SHA-256 mismatch for ${fileName}: expected ${expected}, got ${actual}`);
  }
  log(`verified ${fileName}`);
  return { archivePath, base, spec };
}

function extract(archivePath, destination) {
  mkdirSync(destination, { recursive: true });
  if (archivePath.endsWith(".zip") && process.platform !== "win32") {
    run("unzip", ["-q", "-o", archivePath, "-d", destination]);
  } else {
    // bsdtar (Windows 10+) and GNU/BSD tar both handle zip/tar.* here.
    run("tar", ["-xf", archivePath, "-C", destination]);
  }
}

function installPi(staging) {
  const prefix = join(staging, "pi");
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(prefix, { recursive: true });
  copyFileSync(join(SOURCE, "package.json"), join(prefix, "package.json"));
  const lock = join(SOURCE, "package-lock.json");
  const env = { ...process.env, npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false" };
  if (existsSync(lock)) {
    copyFileSync(lock, join(prefix, "package-lock.json"));
    run(npmCommand(), ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix], { env });
  } else {
    run(npmCommand(), ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix], { env });
  }
  const installed = JSON.parse(readFileSync(join(prefix, "node_modules", PI_PACKAGE, "package.json"), "utf8"));
  if (installed.version !== PI_VERSION) {
    throw new Error(`Installed Pi ${installed.version}, expected ${PI_VERSION}`);
  }
  mkdirSync(join(prefix, "extensions"), { recursive: true });
  cpSync(join(SOURCE, "extensions"), join(prefix, "extensions"), { recursive: true });
  cpSync(join(SOURCE, "prompts"), join(prefix, "prompts"), { recursive: true });
  copyFileSync(join(SOURCE, "settings-service.mjs"), join(prefix, "settings-service.mjs"));
  // Source maps are development-only and dominate the small runtime files.
  for (const entry of readdirSync(join(prefix, "node_modules"), { withFileTypes: true })) {
    if (entry.isDirectory()) removeMaps(join(prefix, "node_modules", entry.name));
  }
  return prefix;
}

function removeMaps(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) removeMaps(path);
    else if (entry.name.endsWith(".map")) rmSync(path, { force: true });
  }
}

function directorySize(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += directorySize(child);
    else total += statSync(child).size;
  }
  return total;
}

async function buildTarget(target, installedPiDir) {
  const { archivePath, base, spec } = await ensureNodeArchive(target);
  const staging = join(ROOT, "backend/build/ai-staging", target);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  extract(archivePath, staging);
  const extracted = join(staging, base);
  const nodeBinary = join(extracted, spec.binary);
  if (!existsSync(nodeBinary)) throw new Error(`Node binary missing after extraction: ${nodeBinary}`);

  const out = join(OUTPUT, target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "node"), { recursive: true });
  const nodeOut = join(out, "node", spec.exe);
  copyFileSync(nodeBinary, nodeOut);
  if (spec.exe !== "node.exe") chmodSync(nodeOut, 0o755);
  cpSync(installedPiDir, join(out, "pi"), { recursive: true });

  // Verify the staged runtime actually runs before it is shipped.
  const probe = join(out, "pi");
  const cli = join(probe, "node_modules", "@earendil-works/pi-coding-agent", "dist/bundle/cli.js");
  const prompt = join(probe, "prompts", "analysis.md");
  const extension = join(probe, "extensions", "tradepanel-analysis.mjs");
  const settingsService = join(probe, "settings-service.mjs");
  for (const required of [nodeOut, cli, prompt, extension, settingsService]) {
    if (!existsSync(required)) throw new Error(`Staged runtime file missing: ${required}`);
  }
  const nodeVersion = execFileSync(nodeOut, ["--version"], { encoding: "utf8" }).trim();
  if (!nodeVersion.startsWith("v22.")) {
    throw new Error(`Unexpected staged Node version: ${nodeVersion}`);
  }
  const piVersion = execFileSync(nodeOut, [cli, "--version"], {
    encoding: "utf8",
    env: { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_OFFLINE: "1" },
  }).trim();
  if (!piVersion.includes(PI_VERSION)) {
    throw new Error(`Staged Pi version mismatch: ${piVersion}`);
  }
  // Resolve the extension's imports (typebox) from the staged tree.
  execFileSync(nodeOut, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(pathToFileURL(extension).href)});`,
  ], { stdio: "inherit" });
  // The settings bridge is a long-running JSONL service, so only syntax-check
  // it here; its Pi import is verified by the runtime tests.
  execFileSync(nodeOut, ["--check", settingsService], { stdio: "inherit" });

  const manifest = {
    schema: 1,
    target,
    nodeVersion,
    piVersion: PI_VERSION,
    node: `node/${spec.exe}`,
    piCli: "pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    extension: "pi/extensions/tradepanel-analysis.mjs",
    systemPrompt: "pi/prompts/analysis.md",
    settingsService: "pi/settings-service.mjs",
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const size = directorySize(out);
  log(`staged ${target}: ${nodeVersion} / pi ${PI_VERSION}, ${(size / 1024 / 1024).toFixed(1)} MiB`);
}

const { targets, clean } = parseArgs(process.argv.slice(2));
if (clean) {
  rmSync(OUTPUT, { recursive: true, force: true });
  rmSync(join(ROOT, "backend/build/ai-staging"), { recursive: true, force: true });
}

log(`Pi ${PI_VERSION} + Node ${NODE_VERSION} for ${targets.join(", ")}`);
mkdirSync(OUTPUT, { recursive: true });
const staging = join(ROOT, "backend/build/ai-staging", "shared");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
const installedPiDir = installPi(staging);

// All Pi dependencies are pure JS/WASM, so one install serves every target;
// only the Node executable differs. Each target gets its own copy because the
// Tauri resource map ships one ai-runtime tree per release.
for (const target of targets) {
  await buildTarget(target, installedPiDir);
}
log("done");
