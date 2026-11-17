#!/usr/bin/env node
/**
 * Stage the standalone AI runtime used by the Analyze chart panel.
 *
 *   npm run ai:runtime                 # host target, pinned Node + Pi
 *   npm run ai:runtime:dev             # host target, the Node running the script (development)
 *   node scripts/build-ai-runtime.mjs --target linux-x64 --target win-x64
 *
 * The output (opentrader/src-tauri/ai-runtime) is a build artifact and is git-ignored:
 *
 *   node/node                     Node.js executable (pinned, or the dev one)
 *   npm/bin/npm-cli.js            npm CLI from the same Node distribution
 *   pi/node_modules/...           pinned @earendil-works/pi-coding-agent + deps
 *   pi/extensions/*.mjs           read-only analysis tools
 *   pi/prompts/analysis.md        analysis system prompt
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SOURCE = join(ROOT, "extensions", "analyst", "runtime");
const OUTPUT = join(ROOT, "opentrader", "src-tauri", "ai-runtime");
const CACHE = join(ROOT, "opentrader", "node_modules", ".cache", "ai-runtime");

/** Keep in lockstep with extensions/analyst/runtime/package.json. */
const NODE_VERSION = process.env.OPENTRADER_NODE_VERSION || "22.23.4";
const PI_VERSION = "1.5.0";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_CLI = `node_modules/${PI_PACKAGE}/dist/bundle/cli.js`;
const NPM_CLI = "npm/bin/npm-cli.js";

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
  let dev = false;
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
    } else if (arg === "--dev") {
      dev = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/build-ai-runtime.mjs [--target <id>]... [--dev] [--clean]");
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
  return { targets: [...new Set(targets)], clean, dev };
}

function log(message) {
  console.log(`[ai-runtime] ${message}`);
}

function run(command, args, options = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
    ...options,
  });
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

/** npm ships inside the Node distribution (or the running Node in dev). */
function npmSource(staging, base, dev) {
  if (dev) {
    const root = execFileSync(npmCommand(), ["root", "-g"], { encoding: "utf8" }).trim();
    const source = join(root, "npm");
    if (!existsSync(join(source, "bin", "npm-cli.js"))) throw new Error(`Global npm CLI missing: ${source}`);
    return source;
  }
  for (const source of [join(staging, base, "lib", "node_modules", "npm"), join(staging, base, "node_modules", "npm")]) {
    if (existsSync(join(source, "bin", "npm-cli.js"))) return source;
  }
  throw new Error(`The Node archive has no npm CLI: ${base}`);
}

function stageNpm(source, out) {
  const destination = join(out, "npm");
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  // The updater needs the CLI and its dependencies, not npm's manual.
  for (const name of ["docs", "man"]) rmSync(join(destination, name), { recursive: true, force: true });
  removeMaps(destination);
  if (!existsSync(join(destination, "bin", "npm-cli.js"))) throw new Error(`npm CLI missing after staging: ${destination}`);
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

async function buildTarget(target, installedPiDir, dev) {
  const spec = TARGETS[target];
  const out = join(OUTPUT, target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "node"), { recursive: true });
  const nodeOut = join(out, "node", spec.exe);
  let npmDir;

  if (dev) {
    // Development: the Node running this script, so no download is needed.
    if (process.platform === "win32") copyFileSync(process.execPath, nodeOut);
    else {
      try {
        symlinkSync(process.execPath, nodeOut);
      } catch {
        copyFileSync(process.execPath, nodeOut);
        chmodSync(nodeOut, 0o755);
      }
    }
  } else {
    const { archivePath, base } = await ensureNodeArchive(target);
    const staging = join(CACHE, "staging", target);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    extract(archivePath, staging);
    const nodeBinary = join(staging, base, spec.binary);
    if (!existsSync(nodeBinary)) throw new Error(`Node binary missing after extraction: ${nodeBinary}`);
    copyFileSync(nodeBinary, nodeOut);
    if (spec.exe !== "node.exe") chmodSync(nodeOut, 0o755);
    npmDir = npmSource(staging, base, false);
  }

  cpSync(installedPiDir, join(out, "pi"), { recursive: true });
  // npm's bin links point into the build cache. The runtime calls the CLI by
  // path, and Tauri must not ship symlinks that break when that cache is gone.
  rmSync(join(out, "pi", "node_modules", ".bin"), { recursive: true, force: true });
  stageNpm(dev ? npmSource("", "", dev) : npmDir, out);

  // Verify the staged runtime actually runs before it is shipped.
  const piDir = join(out, "pi");
  const cli = join(piDir, PI_CLI);
  const npmCli = join(out, NPM_CLI);
  const prompt = join(piDir, "prompts", "analysis.md");
  const extension = join(piDir, "extensions", "tradepanel-analysis.mjs");
  for (const required of [nodeOut, cli, npmCli, prompt, extension]) {
    if (!existsSync(required)) throw new Error(`Staged runtime file missing: ${required}`);
  }
  const nodeVersion = execFileSync(nodeOut, ["--version"], { encoding: "utf8" }).trim();
  if (!dev && !nodeVersion.startsWith("v22.")) {
    throw new Error(`Unexpected staged Node version: ${nodeVersion}`);
  }
  const piVersion = execFileSync(nodeOut, [cli, "--version"], {
    encoding: "utf8",
    env: { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_OFFLINE: "1" },
  }).trim();
  const npmVersion = execFileSync(nodeOut, [npmCli, "--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  log(`bundled npm ${npmVersion}`);
  if (!piVersion.includes(PI_VERSION)) {
    throw new Error(`Staged Pi version mismatch: ${piVersion}`);
  }
  // Resolve the extension's imports (typebox) from the staged tree.
  execFileSync(nodeOut, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(extension).href)});`], { stdio: "inherit" });

  const manifest = {
    schema: 1,
    target,
    nodeVersion,
    piVersion: PI_VERSION,
    node: `node/${spec.exe}`,
    piCli: `pi/${PI_CLI}`,
    npmCli: NPM_CLI,
    extension: "pi/extensions/tradepanel-analysis.mjs",
    systemPrompt: "pi/prompts/analysis.md",
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const size = directorySize(out);
  log(`staged ${target}${dev ? " (dev)" : ""}: ${nodeVersion} / pi ${PI_VERSION}, ${(size / 1024 / 1024).toFixed(1)} MiB`);
}

const { targets, clean, dev } = parseArgs(process.argv.slice(2));
if (clean) {
  rmSync(OUTPUT, { recursive: true, force: true });
  rmSync(join(CACHE, "staging"), { recursive: true, force: true });
}

log(`Pi ${PI_VERSION} + ${dev ? `dev Node ${process.version}` : `Node ${NODE_VERSION}`} for ${targets.join(", ")}`);
mkdirSync(OUTPUT, { recursive: true });
const staging = join(CACHE, "staging", "shared");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
const installedPiDir = installPi(staging);

// All Pi dependencies are pure JS/WASM, so one install serves every target;
// only the Node executable differs. Each target gets its own copy because the
// Tauri resource map ships one ai-runtime tree per release.
for (const target of targets) {
  await buildTarget(target, installedPiDir, dev);
}
log("done");
