#!/usr/bin/env node
/*
 * Put OpenTrader on a chosen upstream commit and overlay TradePanel's independent extension
 * packs on top of it. This is the only command that writes `opentrader/`; it is generated,
 * never edited by hand.
 *
 *   npm run update:opentrader                 latest release tag
 *   npm run update:opentrader -- --ref main   upstream HEAD
 *   npm run update:opentrader -- --ref v0.4.24
 *   npm run update:opentrader -- --check      also typecheck and run the test suite
 *   npm run update:opentrader -- --full       ...and the Rust tests
 *   npm run update:opentrader -- --dry-run    show the resolved ref and packs, write nothing
 *
 * Flags:
 *   --ref <ref>       tag, branch or commit (default: opentrader.config.json "ref")
 *   --latest          newest vX.Y.Z tag
 *   --main            upstream origin/HEAD
 *   --no-install      do not run npm ci when node_modules is missing or stale
 *   --no-bindings     do not generate src/bindings.ts (a --check run still needs it)
 *   --no-ai           do not stage the AI runtime (a Rust build still needs it)
 *   --check           tsc --noEmit and vitest after assembly
 *   --full            --check plus cargo test --lib
 *   --dry-run         fetch and resolve, but do not touch opentrader/
 *   --locked          use the ref/commit recorded in opentrader.lock.json (npm run setup)
 *   --only a,b        assemble only these packs (dependencies included explicitly)
 *   --without a,b     leave these packs out
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  APP,
  LOCK_FILE,
  NPM,
  ROOT,
  applyExtension,
  appVersion,
  ensureCheckout,
  fail,
  git,
  gitRun,
  isStale,
  log,
  readConfig,
  readExtensions,
  readLock,
  selectExtensions,
  resetCheckout,
  resolveRef,
  rollback,
  run,
  writeLock,
} from "./lib/opentrader.mjs";
import { ensureOpenSslDev } from "./lib/openssl-dev.mjs";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag) => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
};

if (has("--help") || has("-h")) {
  console.log(`Usage: node scripts/update-opentrader.mjs [--ref <ref>|--latest|--main] [--check] [--full] [--dry-run] [--locked] [--only a,b] [--without a,b] [--no-install] [--no-bindings] [--no-ai]`);
  process.exit(0);
}

const options = {
  ref: has("--latest") ? "latest" : has("--main") || has("--head") ? "main" : value("--ref"),
  check: has("--check") || has("--full"),
  full: has("--full"),
  install: !has("--no-install"),
  bindings: !has("--no-bindings"),
  noAi: has("--no-ai"),
  dryRun: has("--dry-run"),
  locked: has("--locked"),
  only: (value("--only") ?? "").split(",").map((id) => id.trim()).filter(Boolean),
  without: (value("--without") ?? "").split(",").map((id) => id.trim()).filter(Boolean),
};

const config = readConfig();
ensureCheckout(config);

log("fetching upstream tags");
gitRun(["fetch", "--tags", "--force", "--prune", "origin"]);

const lock = readLock();
const lockedCommit = options.locked && !options.ref && lock?.commit ? lock.commit : null;
const requested = lockedCommit ?? resolveRef(options.ref ?? config.ref);
const commit = git(["rev-parse", "--verify", `${requested}^{commit}`]);
const lockRef = lockedCommit ? (lock.ref ?? requested) : requested;
const all = readExtensions();
let extensions = selectExtensions(all, { only: options.only, without: options.without });
// A locked setup reproduces the pack set that was assembled, not necessarily every folder now present.
if (options.locked && !options.only.length && !options.without.length && lock?.extensions?.length) {
  const ids = new Set(lock.extensions.map((extension) => extension.id));
  extensions = selectExtensions(
    all.filter((extension) => ids.has(extension.id)),
    {},
  );
}
const stale = isStale(config, extensions);

log(`upstream: ${config.repository}`);
log(`ref:      ${lockRef} (${commit.slice(0, 12)})`);
log(`version:  ${appVersion()} now; packs: ${extensions.map((extension) => extension.id).join(", ") || "none"}`);
if (stale) log(`drift:    ${stale}`);

if (options.dryRun) {
  log("dry run: no files written");
  process.exit(0);
}

try {
  resetCheckout(commit);
  log("assembling extension packs:");
  for (const extension of extensions) applyExtension(extension);
} catch (error) {
  rollback();
  fail(error.message, "The checkout was reset. Rebase the failing extension's core.patch on the new upstream.");
}

function npmDeps() {
  const modules = join(APP, "node_modules");
  const lock = join(APP, "package-lock.json");
  const stamp = join(modules, ".package-lock.json");
  const mtime = (path) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  };
  if (existsSync(join(modules, ".bin")) && mtime(stamp) >= mtime(lock)) return;
  if (!options.install) {
    log("frontend dependencies are missing or stale; skipping npm ci (--no-install)");
    return;
  }
  log("installing frontend dependencies (npm ci)");
  run(NPM, ["ci", "--no-audit", "--no-fund"], { cwd: APP });
}

npmDeps();

/** The Linux development container has runtime libraries but no -dev packages. */
function applyLinuxEnv() {
  if (process.platform !== "linux") return;
  const envFile = join(ROOT, "tmp", "linux-env.sh");
  const probe = spawnSync("pkg-config", ["--exists", "javascriptcoregtk-4.1"], { stdio: "ignore" });
  if (existsSync(envFile) && probe.status !== 0) {
    const sourced = spawnSync("bash", ["-c", 'set -a; . "$1" >&2; env -0', "update-opentrader", envFile], { encoding: "buffer" });
    if (sourced.status === 0) {
      for (const pair of sourced.stdout.toString().split("\0")) {
        const at = pair.indexOf("=");
        if (at > 0) process.env[pair.slice(0, at)] = pair.slice(at + 1);
      }
    }
  }

  // Native-tls needs OpenSSL headers for every cargo invocation, including binding export. The launcher
  // already stages them; use the same helper here so `npm run setup` works without a system libssl-dev.
  const opensslEnv = ensureOpenSslDev({ say: log, fail });
  if (opensslEnv) Object.assign(process.env, opensslEnv);
}

/** The Tauri build reads `src-tauri/ai-runtime` as a resource, even for `cargo test`: stage it
 *  when a fresh checkout has none. The runtime is a build artifact and survives updates. */
function stageAiRuntime() {
  if (options.noAi) return;
  const host = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
  const manifest = join(APP, "src-tauri", "ai-runtime", host, "manifest.json");
  if (existsSync(manifest)) return;
  log("staging the AI runtime (Node + Pi)");
  run(process.execPath, [join(ROOT, "scripts", "build-ai-runtime.mjs")], { cwd: ROOT });
}

function bindings() {
  if (!options.bindings) return;
  stageAiRuntime();
  log("generating src/bindings.ts (cargo test --lib export_bindings)");
  applyLinuxEnv();
  run("cargo", ["test", "--lib", "export_bindings"], { cwd: join(APP, "src-tauri") });
}

function i18nCatalog() {
  if (!existsSync(join(APP, "node_modules"))) {
    log("skipping i18n catalog: frontend dependencies are not installed");
    return;
  }
  log("regenerating the i18n catalog");
  run(process.execPath, [join(APP, "scripts", "i18n.mjs"), "extract"], { cwd: APP });
}

function typecheck() {
  const binary = join(APP, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  if (!existsSync(binary)) fail("TypeScript is not installed: run the update without --no-install");
  log("typechecking (tsc --noEmit)");
  run(binary, ["--noEmit", "-p", "tsconfig.json"], { cwd: APP });
}

function tests() {
  log("running the frontend tests (vitest)");
  run(NPM, ["test"], { cwd: APP });
}

function rustTests() {
  log("running the Rust tests (cargo test --lib)");
  applyLinuxEnv();
  run("cargo", ["test", "--lib"], { cwd: join(APP, "src-tauri") });
}

bindings();
i18nCatalog();
if (options.check) {
  typecheck();
  tests();
}
if (options.full) rustTests();

const written = writeLock({ ref: lockRef, commit, extensions });
log(`assembled TradePanel ${appVersion()} on OpenTrader ${lockRef} (${commit.slice(0, 12)})`);
log(`lock written: ${LOCK_FILE.replace(`${ROOT}/`, "")} (${written.extensions.length} packs)`);
if (!options.check) log("run `npm run update:opentrader -- --check` before building or releasing");
