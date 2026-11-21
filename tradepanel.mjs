#!/usr/bin/env node
/*
 * TradePanel — the single entrypoint. One command sets the workspace up and runs the app.
 *
 *   npm start                    set up (clone upstream, apply the packs, install) if needed, then run
 *   ./tradepanel.mjs             the same from a terminal
 *   ./tradepanel.mjs --setup     set up only, do not start the app
 *   ./tradepanel.mjs --update    force a re-assemble of the checkout from opentrader.config.json, then run
 *   ./tradepanel.mjs --no-install   never install dependencies or plugins; report what is missing instead
 *   ./tradepanel.mjs -- --no-watch  everything after -- goes to `tauri dev`
 *
 * `opentrader/` is a generated checkout of upstream OpenTrader, owned by this script: it is reset to the
 * pinned ref, then the independent packs in extensions/ are overlaid on top. Nothing in it is edited by hand.
 *
 * Runs on Node; Rust, the Tauri system libraries and OpenSSL headers are checked and staged where possible,
 * never installed globally.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── Paths and constants ──────────────────────────────────────────────────────
export const ROOT = dirname(fileURLToPath(import.meta.url));
const APP = join(ROOT, "opentrader");
const SRC_TAURI = join(APP, "src-tauri");
const EXTENSIONS_DIR = join(ROOT, "extensions");
const CONFIG_FILE = join(ROOT, "opentrader.config.json");
const LOCK_FILE = join(ROOT, "opentrader.lock.json");
const BROKER_SOURCE = join(ROOT, "plugins", "ccxt-broker");
const WIN = process.platform === "win32";
const NPM = WIN ? "npm.cmd" : "npm";
const GIT = WIN ? "git.exe" : "git";
const PORT = 1420; // vite.config.ts pins it with strictPort, so a busy port is a hard failure later on.
const MIN_NODE = [20, 19];
const RECOMMENDED_NODE = 22;

const log = (message) => console.log(`tradepanel: ${message}`);
const warn = (message) => console.error(`tradepanel: warning: ${message}`);
function fail(message, hint) {
  console.error(`tradepanel: ${message}`);
  if (hint) console.error(`tradepanel: ${hint}`);
  process.exit(1);
}

// ── Process helpers ──────────────────────────────────────────────────────────
/** Run a program and return its trimmed stdout; throws with the command in the message on failure. */
export function output(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: WIN && /\.(cmd|bat)$/i.test(command),
      ...options,
    }).trim();
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
}
function outputOr(command, args, fallback = "", options = {}) {
  try {
    return output(command, args, options);
  } catch {
    return fallback;
  }
}
/** Run a program with its output attached to the terminal. */
export function run(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: "inherit",
    shell: WIN && /\.(cmd|bat)$/i.test(command),
    ...options,
  });
}
const git = (args, options = {}) => output(GIT, args, { cwd: APP, ...options });
const gitOr = (args, fallback = "", options = {}) => outputOr(GIT, args, fallback, { cwd: APP, ...options });
const gitRun = (args, options = {}) => run(GIT, args, { cwd: APP, ...options });

// ── Upstream config and the extension lock ───────────────────────────────────
export function readConfig() {
  if (!existsSync(CONFIG_FILE)) fail(`${relative(ROOT, CONFIG_FILE)} is missing`);
  const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  if (resolve(ROOT, config.directory) !== APP) fail(`${relative(ROOT, CONFIG_FILE)}: "directory" must be "opentrader"`);
  for (const key of ["repository", "directory", "ref"]) {
    if (typeof config[key] !== "string" || !config[key].trim()) fail(`${relative(ROOT, CONFIG_FILE)}: "${key}" is required`);
  }
  return config;
}

export function readLock() {
  if (!existsSync(LOCK_FILE)) return null;
  try {
    return JSON.parse(readFileSync(LOCK_FILE, "utf8"));
  } catch {
    return null;
  }
}

function hashFile(hash, path, name) {
  hash.update(name);
  hash.update("\0");
  hash.update(readFileSync(path));
  hash.update("\0");
}
function walk(hash, dir, base = dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(hash, path, base);
    else if (entry.isFile()) hashFile(hash, path, relative(base, path).split(sep).join("/"));
  }
}

/** A stable fingerprint of an extension: manifest, patch and overlay files. */
export function extensionHash(extension) {
  const hash = createHash("sha256");
  hashFile(hash, join(extension.dir, "extension.json"), "extension.json");
  const patch = join(extension.dir, "core.patch");
  if (existsSync(patch)) hashFile(hash, patch, "core.patch");
  const files = join(extension.dir, "files");
  if (existsSync(files)) walk(hash, files, files);
  for (const key of ["runtime", "tests"]) {
    const dir = join(extension.dir, extension[key] ?? "");
    if (extension[key] && existsSync(dir)) walk(hash, dir, dir);
  }
  return hash.digest("hex");
}

function writeLock({ ref, commit, extensions }) {
  const lock = {
    upstream: readConfig().repository,
    ref,
    commit,
    updatedAt: new Date().toISOString(),
    extensions: extensions.map((extension) => ({
      id: extension.id,
      version: extension.version ?? "1.0.0",
      sha256: extensionHash(extension),
    })),
  };
  const temporary = `${LOCK_FILE}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(lock, null, 2)}\n`);
  renameSync(temporary, LOCK_FILE);
  return lock;
}

export function appVersion() {
  try {
    return JSON.parse(readFileSync(join(SRC_TAURI, "tauri.conf.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

// ── Extension packs ──────────────────────────────────────────────────────────
/** Every `extensions/<id>/extension.json`, ordered by `order` then id. */
export function readExtensions() {
  if (!existsSync(EXTENSIONS_DIR)) return [];
  const found = [];
  for (const entry of readdirSync(EXTENSIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(EXTENSIONS_DIR, entry.name, "extension.json");
    if (!existsSync(manifest)) continue;
    const descriptor = JSON.parse(readFileSync(manifest, "utf8"));
    descriptor.dir = join(EXTENSIONS_DIR, entry.name);
    descriptor.id ??= entry.name;
    descriptor.order ??= 1000;
    descriptor.dependsOn ??= [];
    descriptor.remove ??= [];
    if (!/^[a-z][a-z0-9-]*$/.test(descriptor.id)) fail(`extension ${entry.name}: invalid id "${descriptor.id}"`);
    if (descriptor.id !== entry.name) fail(`extension ${entry.name}: id "${descriptor.id}" does not match its folder`);
    found.push(descriptor);
  }
  found.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const byId = new Map(found.map((e) => [e.id, e]));
  for (const extension of found) {
    for (const dep of extension.dependsOn) {
      if (!byId.has(dep)) fail(`extension ${extension.id} needs ${dep}, which is not installed`);
      if (byId.get(dep).order >= extension.order) fail(`extension ${extension.id} must come after ${dep} (order)`);
    }
  }
  return found;
}

/** Filter a validated pack list; a selected pack may not lose a dependency. */
export function selectExtensions(extensions, { only = [], without = [] } = {}) {
  const known = new Set(extensions.map((extension) => extension.id));
  for (const id of [...only, ...without]) if (!known.has(id)) fail(`unknown extension "${id}"`);
  const selected = extensions.filter(
    (extension) => (!only.length || only.includes(extension.id)) && !without.includes(extension.id),
  );
  const ids = new Set(selected.map((extension) => extension.id));
  for (const extension of selected) {
    for (const dependency of extension.dependsOn) {
      if (!ids.has(dependency)) fail(`extension ${extension.id} needs ${dependency}, which is disabled`);
    }
  }
  return selected;
}

/** Why the checkout must be re-assembled, or null when the recorded state still matches. */
export function assemblyNeeded(config) {
  if (!existsSync(join(APP, ".git"))) return "checkout missing";
  const lock = readLock();
  if (!lock) return "no lock file";
  if (lock.upstream !== config.repository) return "upstream changed";
  const extensions = readExtensions();
  if (lock.extensions?.length !== extensions.length) return "extension set changed";
  for (const extension of extensions) {
    const entry = lock.extensions.find((item) => item.id === extension.id);
    if (!entry || entry.sha256 !== extensionHash(extension)) return `extension ${extension.id} changed`;
  }
  return null;
}

// ── Assembly: clone, reset, overlay, patch ───────────────────────────────────
function within(base, path) {
  const target = resolve(base, path);
  const rel = relative(base, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return target;
  throw new Error(`refusing to write outside ${base}: ${path}`);
}

/** Copy `source/` over `destination/`, preserving the tree. */
function overlay(source, destination) {
  if (!existsSync(source)) return 0;
  let copied = 0;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = within(destination, relative(source, from));
    if (entry.isDirectory()) copied += overlay(from, to);
    else if (entry.isSymbolicLink()) throw new Error(`extension file is a symlink: ${from}`);
    else if (entry.isFile()) {
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
      copied += 1;
    }
  }
  return copied;
}

function removePath(relativePath) {
  const target = within(APP, relativePath);
  if (!existsSync(target)) return false;
  rmSync(target, { recursive: true, force: true });
  return true;
}

/** Overlay one extension on the checkout and apply its patch. */
export function applyExtension(extension) {
  const files = overlay(join(extension.dir, "files"), APP);
  let removed = 0;
  for (const path of extension.remove) removed += removePath(path) ? 1 : 0;
  const patch = join(extension.dir, "core.patch");
  let patched = false;
  if (existsSync(patch)) {
    try {
      gitRun(["apply", "--3way", "--whitespace=nowarn", patch]);
      patched = true;
    } catch {
      try {
        gitRun(["apply", "--whitespace=nowarn", patch]);
        patched = true;
      } catch (error) {
        throw new Error(`extension ${extension.id} does not apply to this upstream version:\n${error.message}`);
      }
    }
  }
  log(`  ${extension.id}: ${files} files${removed ? `, ${removed} removed` : ""}${patched ? ", patch applied" : ""}`);
}

/** Put the checkout back on the resolved ref, discarding overlays from an earlier run. */
const cleanArgs = [
  "clean", "-fd", "--quiet",
  "-e", "src-tauri/ai-runtime",
  "-e", "src-tauri/standalone",
  "-e", "dist",
  "-e", "dist-web",
  "-e", "src/bindings.ts",
  "-e", ".env",
];

export function resetCheckout(ref) {
  gitRun(["reset", "--hard", "--quiet"]);
  gitRun(cleanArgs);
  gitRun(["checkout", "--detach", "--force", ref, "--quiet"]);
  gitRun(["reset", "--hard", "--quiet", ref]);
  gitRun(cleanArgs);
}

function rollback() {
  try {
    gitRun(["reset", "--hard", "--quiet"]);
    gitRun(cleanArgs);
  } catch {
    warn("could not reset the checkout; inspect opentrader/ by hand");
  }
}

/** A checkout cloned with --filter=blob:none keeps .promisor packs that document its missing blobs. If the
 *  matching remote config is lost, git negotiates with objects it cannot read and the next fetch dies with
 *  "pack has N unresolved delta". Restore the config that matches the packs on disk. */
export function ensurePartialCloneConfig(cwd = APP) {
  const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd });
  const packDir = join(gitDir, "objects", "pack");
  if (!existsSync(packDir) || !readdirSync(packDir).some((name) => name.endsWith(".promisor"))) return;
  const promisor = gitOr(["config", "--bool", "--get", "remote.origin.promisor"], "", { cwd });
  if (promisor.toLowerCase() === "true") return;
  log("restoring partial-clone config for the OpenTrader checkout");
  gitRun(["config", "remote.origin.promisor", "true"], { cwd });
  if (!gitOr(["config", "--get", "remote.origin.partialCloneFilter"], "", { cwd })) {
    gitRun(["config", "remote.origin.partialCloneFilter", "blob:none"], { cwd });
  }
}

function ensureCheckout(config) {
  if (existsSync(join(APP, ".git"))) {
    const origin = gitOr(["remote", "get-url", "origin"]);
    if (origin !== config.repository) {
      log(`setting upstream origin to ${config.repository}`);
      gitRun(["remote", "set-url", "origin", config.repository]);
    }
    ensurePartialCloneConfig();
    return;
  }
  if (existsSync(APP) && readdirSync(APP).length) {
    fail(
      `${relative(ROOT, APP)} exists but is not a git checkout`,
      "Move it aside (it is generated); this script never deletes a folder it did not clone.",
    );
  }
  log(`cloning ${config.repository}`);
  mkdirSync(dirname(APP), { recursive: true });
  run(GIT, ["clone", config.repository, config.directory], { cwd: ROOT });
  ensurePartialCloneConfig();
}

/** The newest upstream release tag, falling back to origin/HEAD. */
export function latestRef() {
  const tags = git(["tag", "--list", "v*", "--sort=-v:refname"])
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  if (tags.length) return tags[0];
  return gitOr(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) || "origin/HEAD";
}

export function resolveRef(ref) {
  if (!ref) return "origin/HEAD";
  if (ref === "latest") return latestRef();
  return ref;
}

function assemble(config) {
  log("assembling the extension packs");
  gitRun(["fetch", "--tags", "--force", "--prune", "origin"]);
  const requested = resolveRef(config.ref);
  const commit = git(["rev-parse", "--verify", `${requested}^{commit}`]);
  const extensions = selectExtensions(readExtensions());
  log(`upstream: ${config.repository}`);
  log(`ref:      ${config.ref} (${commit.slice(0, 12)})`);
  log(`version:  ${appVersion()} now; packs: ${extensions.map((e) => e.id).join(", ") || "none"}`);
  try {
    resetCheckout(commit);
    for (const extension of extensions) applyExtension(extension);
  } catch (error) {
    // A failed assembly must not leave a bare upstream checkout: that silently removes the TradePanel UI.
    const lock = readLock();
    let restored = false;
    if (lock?.commit) {
      try {
        log(`restoring the previous checkout (${lock.ref ?? lock.commit.slice(0, 12)})`);
        resetCheckout(lock.commit);
        const ids = new Set((lock.extensions ?? []).map((e) => e.id));
        for (const extension of readExtensions().filter((e) => ids.has(e.id))) applyExtension(extension);
        restored = true;
      } catch (restoreError) {
        warn(`could not restore the previous checkout: ${restoreError.message}`);
      }
    }
    if (!restored) rollback();
    fail(
      error.message,
      restored
        ? "The previous checkout was restored. Rebase the failing extension's core.patch."
        : "Rebase the failing extension's core.patch and run this again.",
    );
  }
  writeLock({ ref: config.ref, commit, extensions });
  log(`assembled TradePanel ${appVersion()} on OpenTrader ${config.ref} (${commit.slice(0, 12)})`);
}

// ── Toolchain ────────────────────────────────────────────────────────────────
const runs = (command, args = ["--version"]) => spawnSync(command, args, { stdio: "ignore", shell: WIN }).status === 0;

function checkNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    fail(
      `Node.js ${process.versions.node} is too old (Vite needs ${MIN_NODE.join(".")}+, ${RECOMMENDED_NODE}+ recommended).`,
      "Install a current Node.js from https://nodejs.org and run this again.",
    );
  }
  if (major < RECOMMENDED_NODE) warn(`Node.js ${process.versions.node} works, but TradePanel is tested on ${RECOMMENDED_NODE}+.`);
}

function ensureCargoPath() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const cargoBin = join(process.env.CARGO_HOME ?? join(home, ".cargo"), "bin");
  if (existsSync(cargoBin) && !(process.env.PATH ?? "").split(WIN ? ";" : ":").includes(cargoBin)) {
    process.env.PATH = `${cargoBin}${WIN ? ";" : ":"}${process.env.PATH ?? ""}`;
  }
}

const webkitHeaders = () =>
  process.platform === "linux" &&
  runs("pkg-config") &&
  !runs("pkg-config", ["--exists", "webkit2gtk-4.1"]) &&
  !runs("pkg-config", ["--exists", "webkit2gtk-4.0"]);

// ── OpenSSL development headers (native-tls build dependency) ────────────────
// Desktop sessions often have the runtime library but not the headers, and `cargo` fails deep in
// openssl-sys with an opaque pkg-config error. On Debian/Ubuntu stage the matching -dev package under
// the user's data dir without sudo; point OPENSSL_* at that prefix so the build is reproducible.
const command = (name, args, cwd) => spawnSync(name, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
// The -dev package ships libssl.so as a symlink to libssl.so.3, which lives in the runtime package. Such a
// symlink is "missing" to existsSync until the versioned library is copied in, so check the directory entry.
const present = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
function validPrefix(prefix) {
  if (!prefix) return false;
  return (
    existsSync(join(prefix, "include", "openssl", "opensslv.h")) &&
    existsSync(join(prefix, "include", "openssl", "opensslconf.h")) &&
    present(join(prefix, "lib", "libssl.so")) &&
    present(join(prefix, "lib", "libcrypto.so"))
  );
}
export function hasOpenSslDev() {
  const env = process.env;
  if (validPrefix(env.OPENSSL_DIR)) return true;
  if (
    env.OPENSSL_INCLUDE_DIR &&
    env.OPENSSL_LIB_DIR &&
    existsSync(join(env.OPENSSL_INCLUDE_DIR, "openssl", "opensslv.h")) &&
    present(join(env.OPENSSL_LIB_DIR, "libssl.so"))
  ) {
    return true;
  }
  return command("pkg-config", ["--exists", "openssl"]).status === 0;
}
function checked(name, args, cwd, description) {
  const result = command(name, args, cwd);
  if (result.status !== 0) {
    const detail = (result.stderr ?? result.stdout ?? "").trim().split("\n").slice(-3).join(" ");
    throw new Error(`${description} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}
function findLibDir(extract) {
  const root = join(extract, "usr", "lib");
  if (!existsSync(root)) return null;
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .find((dir) => present(join(dir, "libssl.so")));
}
function findArchInclude(extract) {
  const root = join(extract, "usr", "include");
  if (!existsSync(root)) return null;
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, "openssl"))
    .find((dir) => existsSync(join(dir, "opensslconf.h")));
}
// The dev package's libssl.so points at libssl.so.3, which the runtime package owns. Copy that versioned
// library into the staged lib dir so the symlink resolves for the linker.
function copyRuntimeLibs(libDir, target) {
  const multiarch = basename(libDir);
  for (const systemLib of [join("/usr", "lib", multiarch), join("/lib", multiarch)]) {
    if (!existsSync(systemLib)) continue;
    for (const name of ["libssl.so", "libcrypto.so"]) {
      const link = join(libDir, name);
      if (!present(link)) continue;
      let versioned;
      try {
        versioned = basename(readlinkSync(link));
      } catch {
        continue; // A real library file, not a symlink: cpSync already copied it.
      }
      const source = join(systemLib, versioned);
      if (existsSync(source) && !existsSync(join(target, versioned))) copyFileSync(source, join(target, versioned));
    }
  }
}
function opensslEnvFor(prefix) {
  return {
    OPENSSL_DIR: prefix,
    OPENSSL_INCLUDE_DIR: join(prefix, "include"),
    OPENSSL_LIB_DIR: join(prefix, "lib"),
    PKG_CONFIG_PATH: [join(prefix, "lib", "pkgconfig"), process.env.PKG_CONFIG_PATH].filter(Boolean).join(":"),
  };
}
/** Returns environment overrides when it staged headers, null when there was nothing to do. */
export function ensureOpenSslDev() {
  if (hasOpenSslDev()) return null;
  if (process.platform !== "linux" || !existsSync("/etc/debian_version")) return null;

  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const prefix = join(dataHome, "tradepanel", "openssl-dev", `${process.platform}-${process.arch}`);
  if (validPrefix(prefix)) {
    log(`using OpenSSL development headers in ${prefix}`);
    return opensslEnvFor(prefix);
  }

  const stage = mkdtempSync(join(tmpdir(), "tradepanel-openssl-"));
  let error;
  try {
    log("staging OpenSSL development headers (no sudo needed)");
    checked("apt-get", ["download", "libssl-dev"], stage, "apt-get download libssl-dev");
    const deb = readdirSync(stage).find((name) => name.endsWith(".deb"));
    if (!deb) throw new Error("apt-get produced no libssl-dev package");

    const extract = join(stage, "root");
    mkdirSync(extract);
    checked("dpkg-deb", ["-x", join(stage, deb), extract], stage, "dpkg-deb -x libssl-dev");

    const includeRoot = join(extract, "usr", "include");
    const archInclude = findArchInclude(extract);
    const libDir = findLibDir(extract);
    if (!archInclude || !libDir) throw new Error("the libssl-dev package has an unexpected layout");

    const parent = dirname(prefix);
    mkdirSync(parent, { recursive: true });
    const next = join(parent, `.${basename(prefix)}.next-${process.pid}`);
    rmSync(next, { recursive: true, force: true });
    mkdirSync(join(next, "include"), { recursive: true });
    mkdirSync(join(next, "lib"), { recursive: true });
    cpSync(includeRoot, join(next, "include"), { recursive: true });
    // Debian keeps generated headers (opensslconf.h, configuration.h) in a multiarch directory. openssl-sys
    // only accepts one include path, so merge them into the main tree.
    cpSync(archInclude, join(next, "include", "openssl"), { recursive: true });
    cpSync(libDir, join(next, "lib"), { recursive: true });
    copyRuntimeLibs(libDir, join(next, "lib"));
    writeFileSync(join(next, "source"), `${deb}\n`);
    if (!validPrefix(next)) throw new Error("the staged headers are incomplete");

    const backup = join(parent, `${basename(prefix)}.old`);
    rmSync(backup, { recursive: true, force: true });
    if (existsSync(prefix)) renameSync(prefix, backup);
    renameSync(next, prefix);
    rmSync(backup, { recursive: true, force: true });

    log(`OpenSSL development headers ready in ${prefix}`);
    return opensslEnvFor(prefix);
  } catch (caught) {
    error = caught;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  fail(
    `could not stage the OpenSSL development headers: ${error instanceof Error ? error.message : String(error)}`,
    "Install libssl-dev with sudo, or set OPENSSL_DIR to an OpenSSL installation and run this again.",
  );
}

/** Source TRADEPANEL_ENV (or tmp/linux-env.sh) and make sure every build-time dependency is present. */
function buildEnvironment() {
  // WebKitGTK and libsoup headers: the Rust build cannot link the window without them. Distributions install
  // them with the -dev packages; checkouts and containers that carry the runtime libraries only ship a shell
  // snippet that points PKG_CONFIG_PATH (and the linkers) at them.
  let envFile = process.env.TRADEPANEL_ENV;
  if (!envFile && webkitHeaders()) {
    const local = join(ROOT, "tmp", "linux-env.sh");
    if (existsSync(local)) envFile = local;
  }
  if (envFile) {
    let file = resolve(envFile);
    if (!existsSync(file)) file = resolve(ROOT, envFile);
    if (!existsSync(file)) fail(`TRADEPANEL_ENV points at ${envFile}, which does not exist.`);
    if (WIN) warn(`ignoring ${file}: it is a shell snippet, and Windows does not source it.`);
    else {
      const shown = file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file;
      log(`applying ${shown} as the build environment`);
      const sourced = spawnSync("bash", ["-c", 'set -a; . "$1" >&2; env -0', "tradepanel", file], { encoding: "buffer" });
      if (sourced.status !== 0) {
        warn(`could not apply ${shown}${sourced.error ? `: ${sourced.error.message}` : ""}; continuing without it.`);
      } else {
        for (const pair of sourced.stdout.toString().split("\0")) {
          const split = pair.indexOf("=");
          if (split > 0) process.env[pair.slice(0, split)] = pair.slice(split + 1);
        }
      }
    }
  }

  if (!runs("cargo")) {
    fail("Rust is not installed (cargo was not found).", "Install Rust stable from https://rustup.rs, reopen the terminal and run this again.");
  }

  const opensslEnv = ensureOpenSslDev();
  if (opensslEnv) Object.assign(process.env, opensslEnv);
  else if (!hasOpenSslDev()) {
    fail(
      "the OpenSSL development headers were not found, and the Rust build cannot link native TLS without them.",
      [
        "Debian/Ubuntu: sudo apt install libssl-dev",
        "macOS: brew install openssl@3",
        "Other systems: install the OpenSSL development package, or set OPENSSL_DIR to an OpenSSL installation.",
      ].join("\ntradepanel: "),
    );
  }

  if (webkitHeaders()) {
    fail(
      "the WebKitGTK 4.1 development headers were not found, and the Rust build cannot link the window without them.",
      [
        "Debian/Ubuntu: sudo apt install build-essential libwebkit2gtk-4.1-dev libgtk-3-dev " +
          "libayatana-appindicator3-dev librsvg2-dev patchelf",
        "Runtime libraries only: point TRADEPANEL_ENV at a shell snippet that sets PKG_CONFIG_PATH and the linker paths.",
      ].join("\ntradepanel: "),
    );
  } else if (process.platform === "darwin" && !runs("xcode-select", ["-p"])) {
    warn("the Xcode command line tools are missing; run: xcode-select --install");
  }
}

// ── Frontend dependencies, bindings, catalog ─────────────────────────────────
function installDeps(noInstall) {
  const modules = join(APP, "node_modules");
  const tauriCli = join(modules, "@tauri-apps", "cli", "tauri.js");
  const lock = join(APP, "package-lock.json");
  const stamp = join(modules, ".package-lock.json");
  const mtime = (path) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  };
  const stale = !existsSync(tauriCli) || !existsSync(join(modules, "vite")) || mtime(stamp) < mtime(lock);
  if (!stale) return;
  if (noInstall) {
    fail("opentrader/node_modules is missing or out of date and installing was disabled.", `Run "npm ci" in ${APP} first, or drop --no-install.`);
  }
  log("installing frontend dependencies in opentrader/ (npm ci)");
  const install = spawnSync(NPM, ["ci", "--no-audit", "--no-fund"], { cwd: APP, stdio: "inherit", shell: WIN });
  if (install.error) fail(`could not run npm: ${install.error.message}`, "Is npm on PATH?");
  if (install.status !== 0) fail("npm ci failed; fix the error above and run this again.");
  if (!existsSync(tauriCli)) fail("npm ci finished but the Tauri CLI is still missing.");
}

function ensureDrawingCore() {
  if (!existsSync(join(ROOT, "lightweight-charts-drawing", "src", "core"))) {
    fail(
      "the drawing core is missing: lightweight-charts-drawing/ must sit next to opentrader/.",
      "Clone https://github.com/deepentropy/lightweight-charts-drawing into the repository root.",
    );
  }
}

function generateBindings() {
  // src/bindings.ts is generated from the Rust commands and git-ignored; a fresh clone needs it before Vite.
  if (existsSync(join(APP, "src", "bindings.ts"))) return;
  log("generating src/bindings.ts (cargo test --lib export_bindings; the first Rust build takes a while)");
  const bindings = spawnSync("cargo", ["test", "--lib", "export_bindings"], { cwd: SRC_TAURI, stdio: "inherit", shell: WIN });
  if (bindings.error) fail(`could not run cargo: ${bindings.error.message}`);
  if (bindings.status !== 0) fail("generating src/bindings.ts failed; fix the error above and run this again.");
}

function regenCatalog() {
  const i18n = join(APP, "scripts", "i18n.mjs");
  if (!existsSync(i18n) || !existsSync(join(APP, "node_modules"))) return;
  log("regenerating the i18n catalog");
  run(process.execPath, [i18n, "extract"], { cwd: APP });
}

// ── AI runtime (Node + Pi) ───────────────────────────────────────────────────
// The Tauri build reads `src-tauri/ai-runtime` as a resource, even for `cargo test`: stage the host target
// when a fresh checkout has none. The runtime is a build artifact and survives updates.
const NODE_VERSION = process.env.OPENTRADER_NODE_VERSION || "22.23.4";
const PI_VERSION = "1.5.0";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_CLI = `node_modules/${PI_PACKAGE}/dist/bundle/cli.js`;
const NPM_CLI = "npm/bin/npm-cli.js";
const AI_SOURCE = join(ROOT, "extensions", "analyst", "runtime");
const AI_OUTPUT = join(SRC_TAURI, "ai-runtime");
const AI_CACHE = join(APP, "node_modules", ".cache", "ai-runtime");
const NODE_TARGETS = {
  "linux-x64": { platform: "linux", arch: "x64", nodeDir: "linux-x64", archive: "tar.xz", binary: "bin/node", exe: "node" },
  "linux-arm64": { platform: "linux", arch: "arm64", nodeDir: "linux-arm64", archive: "tar.xz", binary: "bin/node", exe: "node" },
  "darwin-x64": { platform: "darwin", arch: "x64", nodeDir: "darwin-x64", archive: "tar.gz", binary: "bin/node", exe: "node" },
  "darwin-arm64": { platform: "darwin", arch: "arm64", nodeDir: "darwin-arm64", archive: "tar.gz", binary: "bin/node", exe: "node" },
  "win-x64": { platform: "win32", arch: "x64", nodeDir: "win-x64", archive: "zip", binary: "node.exe", exe: "node.exe" },
  "win-arm64": { platform: "win32", arch: "arm64", nodeDir: "win-arm64", archive: "zip", binary: "node.exe", exe: "node.exe" },
};
const hostTarget = () => `${WIN ? "win" : process.platform}-${process.arch}`;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
async function download(url, destination) {
  log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  await pipeline(response.body, createWriteStream(destination));
}
async function ensureNodeArchive(target) {
  const spec = NODE_TARGETS[target];
  const base = `node-v${NODE_VERSION}-${spec.nodeDir}`;
  const fileName = `${base}.${spec.archive}`;
  const archivePath = join(AI_CACHE, fileName);
  mkdirSync(AI_CACHE, { recursive: true });
  if (existsSync(archivePath)) return { archivePath, base, spec };

  const sumsPath = join(AI_CACHE, `SHASUMS256-v${NODE_VERSION}.txt`);
  if (!existsSync(sumsPath)) await download(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`, sumsPath);
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
function extractArchive(archivePath, destination) {
  mkdirSync(destination, { recursive: true });
  if (archivePath.endsWith(".zip") && !WIN) run("unzip", ["-q", "-o", archivePath, "-d", destination]);
  else run("tar", ["-xf", archivePath, "-C", destination]);
}
function npmSource(staging, base) {
  for (const source of [join(staging, base, "lib", "node_modules", "npm"), join(staging, base, "node_modules", "npm")]) {
    if (existsSync(join(source, "bin", "npm-cli.js"))) return source;
  }
  throw new Error(`The Node archive has no npm CLI: ${base}`);
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
function stageNpm(source, out) {
  const destination = join(out, "npm");
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  for (const name of ["docs", "man"]) rmSync(join(destination, name), { recursive: true, force: true });
  removeMaps(destination);
  if (!existsSync(join(destination, "bin", "npm-cli.js"))) throw new Error(`npm CLI missing after staging: ${destination}`);
}
function installPi(staging) {
  const prefix = join(staging, "pi");
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(prefix, { recursive: true });
  copyFileSync(join(AI_SOURCE, "package.json"), join(prefix, "package.json"));
  const lock = join(AI_SOURCE, "package-lock.json");
  const env = { ...process.env, npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false" };
  if (existsSync(lock)) {
    copyFileSync(lock, join(prefix, "package-lock.json"));
    run(NPM, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix], { env });
  } else {
    run(NPM, ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix], { env });
  }
  const installed = JSON.parse(readFileSync(join(prefix, "node_modules", PI_PACKAGE, "package.json"), "utf8"));
  if (installed.version !== PI_VERSION) throw new Error(`Installed Pi ${installed.version}, expected ${PI_VERSION}`);
  mkdirSync(join(prefix, "extensions"), { recursive: true });
  cpSync(join(AI_SOURCE, "extensions"), join(prefix, "extensions"), { recursive: true });
  cpSync(join(AI_SOURCE, "prompts"), join(prefix, "prompts"), { recursive: true });
  for (const entry of readdirSync(join(prefix, "node_modules"), { withFileTypes: true })) {
    if (entry.isDirectory()) removeMaps(join(prefix, "node_modules", entry.name));
  }
  return prefix;
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
async function stageAiRuntime() {
  const target = hostTarget();
  const out = join(AI_OUTPUT, target);
  if (existsSync(join(out, "manifest.json"))) return;
  if (!NODE_TARGETS[target]) throw new Error(`Unsupported host platform: ${target}`);
  log(`staging the AI runtime (Node ${NODE_VERSION} + Pi ${PI_VERSION})`);

  const staging = join(AI_CACHE, "staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const installedPiDir = installPi(staging);

  const { archivePath, base, spec } = await ensureNodeArchive(target);
  const extractDir = join(AI_CACHE, "extract");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  extractArchive(archivePath, extractDir);
  const nodeBinary = join(extractDir, base, spec.binary);
  if (!existsSync(nodeBinary)) throw new Error(`Node binary missing after extraction: ${nodeBinary}`);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "node"), { recursive: true });
  const nodeOut = join(out, "node", spec.exe);
  copyFileSync(nodeBinary, nodeOut);
  if (spec.exe !== "node.exe") chmodSync(nodeOut, 0o755);
  cpSync(installedPiDir, join(out, "pi"), { recursive: true });
  // npm's bin links point into the build cache. The runtime calls the CLI by path, and Tauri must not ship
  // symlinks that break when that cache is gone.
  rmSync(join(out, "pi", "node_modules", ".bin"), { recursive: true, force: true });
  stageNpm(npmSource(extractDir, base), out);

  const piDir = join(out, "pi");
  const required = [
    nodeOut,
    join(piDir, PI_CLI),
    join(out, NPM_CLI),
    join(piDir, "prompts", "analysis.md"),
    join(piDir, "extensions", "tradepanel-analysis.mjs"),
  ];
  for (const file of required) if (!existsSync(file)) throw new Error(`Staged runtime file missing: ${file}`);
  const nodeVersion = execFileSync(nodeOut, ["--version"], { encoding: "utf8" }).trim();
  if (!nodeVersion.startsWith("v22.")) throw new Error(`Unexpected staged Node version: ${nodeVersion}`);
  const piVersion = execFileSync(nodeOut, [join(piDir, PI_CLI), "--version"], {
    encoding: "utf8",
    env: { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_OFFLINE: "1" },
  }).trim();
  if (!piVersion.includes(PI_VERSION)) throw new Error(`Staged Pi version mismatch: ${piVersion}`);
  // Resolve the extension's imports (typebox) from the staged tree.
  execFileSync(nodeOut, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(join(piDir, "extensions", "tradepanel-analysis.mjs")).href)});`], { stdio: "inherit" });

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
  log(`staged ${target}: ${nodeVersion} / pi ${PI_VERSION}, ${(directorySize(out) / 1024 / 1024).toFixed(1)} MiB`);
}

// ── Bundled plugins ──────────────────────────────────────────────────────────
const PLUGIN_SKIP = new Set([".venv", "__pycache__", "tests", "dist", ".pytest_cache"]);

export function appIdentifier() {
  try {
    return JSON.parse(readFileSync(join(SRC_TAURI, "tauri.conf.json"), "utf8")).identifier;
  } catch {
    return "com.opentrader.app";
  }
}

/** The app's data and config folders, as Tauri resolves them (`identifier` in tauri.conf.json). */
export function appDirs({ platform = process.platform, env = process.env, home = homedir(), identifier = appIdentifier() } = {}) {
  if (platform === "win32") {
    const roaming = env.APPDATA || win32.join(home, "AppData", "Roaming");
    return { data: win32.join(roaming, identifier), config: win32.join(roaming, identifier) };
  }
  if (platform === "darwin") {
    const support = posix.join(home, "Library", "Application Support");
    return { data: posix.join(support, identifier), config: posix.join(support, identifier) };
  }
  return {
    data: posix.join(env.XDG_DATA_HOME || posix.join(home, ".local", "share"), identifier),
    config: posix.join(env.XDG_CONFIG_HOME || posix.join(home, ".config"), identifier),
  };
}

/** Enable one plugin in `plugins.json`; every other plugin and preference is kept. */
export function pluginConfig(config, id, token) {
  const next = { ...config };
  next.port ??= 47822;
  next.plugins ??= {};
  next.active_broker ??= null;
  next.trading_enabled ??= false;
  const previous = next.plugins[id] ?? {};
  next.plugins[id] = {
    ...previous,
    enabled: true,
    token: previous.token || token,
    settings: previous.settings ?? {},
    secretKeys: previous.secretKeys ?? [],
    copied: previous.copied ?? [],
    // The installer writes unsigned files, whatever the previous package's signature was.
    verified: false,
    symbolMap: previous.symbolMap ?? {},
  };
  return next;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function copyPluginDir(source, target, skip = PLUGIN_SKIP) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true, filter: (src) => !src.split(/[\\/]/).some((part) => skip.has(part)) });
}

function manifestVersion(path) {
  return readJson(path)?.version ?? null;
}

function writePluginsConfig(configDir, mutate) {
  mkdirSync(configDir, { recursive: true });
  const file = join(configDir, "plugins.json");
  const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(file, `${JSON.stringify(mutate(current), null, 2)}\n`);
  return file;
}

const token = () => createHash("sha256").update(String(Date.now()) + String(Math.random())).digest("hex").slice(0, 48);

/** Install the bundled crypto plugin: package + a `.venv` with ccxt and the Hyperliquid SDK. */
function installCryptoPlugin({ data, config }) {
  const source = join(ROOT, "plugins", "crypto");
  const target = join(data, "plugins", "crypto");
  const expected = manifestVersion(join(source, "opentrader-plugin.json"));
  const configFile = join(config, "plugins.json");
  const enabled = readJson(configFile)?.plugins?.crypto?.enabled === true;
  if (existsSync(join(target, "plugin.py")) && enabled && existsSync(join(target, ".venv")) &&
      expected && manifestVersion(join(target, "opentrader-plugin.json")) === expected) {
    log("crypto plugin already installed; skipping");
    return;
  }
  copyPluginDir(source, target);
  makeVenv(target, ["ccxt", "Hyperliquid SDK"]);
  const file = writePluginsConfig(config, (current) => pluginConfig(current, "crypto", token()));
  log(`installed the crypto plugin into ${target}; enabled it in ${file}`);
}

/** Install the bundled NSE data plugin: pure standard library, no virtualenv. */
function installNsePlugin({ data, config }) {
  const source = join(ROOT, "plugins", "nse");
  const target = join(data, "plugins", "nse");
  const expected = manifestVersion(join(source, "opentrader-plugin.json"));
  const enabled = readJson(join(config, "plugins.json"))?.plugins?.nse?.enabled === true;
  if (existsSync(join(target, "plugin.py")) && enabled &&
      expected && manifestVersion(join(target, "opentrader-plugin.json")) === expected) {
    log("NSE plugin already installed; skipping");
    return;
  }
  copyPluginDir(source, target);
  const file = writePluginsConfig(config, (current) => pluginConfig(current, "nse", token()));
  log(`installed the NSE plugin into ${target}; enabled it in ${file}`);
}

/** The generated manifests (one per venue), keyed by plugin id. */
export function manifests(dir = BROKER_SOURCE) {
  return JSON.parse(readFileSync(join(dir, "manifests.json"), "utf8"));
}

/** The manifest of one venue, or a clear refusal for a name the catalog does not carry. */
export function manifestFor(id, all = manifests()) {
  const manifest = all[id];
  if (!manifest) throw new Error(`Unknown venue ${JSON.stringify(id)}; expected one of ${Object.keys(all).join(", ")}`);
  return manifest;
}

/** `plugins.json` with every named venue in it: `enabled` true or false for all of them, or `null` to leave a
 *  venue's switch as it is and install a new one off. Other plugins, settings and the active broker are kept. */
export function mergeBrokerConfig(config, ids, tokens, all = manifests(), enabled = true) {
  const next = { ...config };
  next.port ??= 47822;
  next.plugins ??= {};
  next.active_broker ??= null;
  next.trading_enabled ??= false;
  for (const id of ids) {
    manifestFor(id, all);
    const previous = next.plugins[id] ?? {};
    next.plugins[id] = {
      ...previous,
      enabled: enabled === null ? (previous.enabled ?? false) : enabled,
      token: previous.token || tokens[id] || token(),
      settings: previous.settings ?? {},
      secretKeys: previous.secretKeys ?? [],
      copied: previous.copied ?? [],
      verified: false,
      symbolMap: previous.symbolMap ?? {},
    };
  }
  return next;
}

/** The interpreter of a venv, when it has one. */
export function venvPython(venv, platform = process.platform) {
  return join(venv, platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "python.exe" : "python");
}

/** `venv` can import ccxt (the probe prints its version, so a stub that runs nothing does not pass). */
export function canImportCcxt(venv, runProbe = spawnSync) {
  const python = venvPython(venv);
  if (!existsSync(python)) return false;
  const probe = runProbe(python, ["-c", "import ccxt; print(ccxt.__version__)"], { encoding: "utf8" });
  return probe.status === 0 && /\d+\.\d+/.test(probe.stdout ?? "");
}

const pythonCommand = () => (WIN ? "python" : "python3");

/** One ccxt install for every broker plugin; each folder links to it. Reuse the crypto plugin's venv when it
 *  already carries ccxt, so a laptop does not build a second environment. */
function sharedVenv(pluginsDir) {
  for (const venv of [join(pluginsDir, ".ccxt-broker-venv"), join(pluginsDir, "crypto", ".venv")]) {
    if (canImportCcxt(venv)) {
      log(`reusing ${venv} for the broker plugins`);
      return venv;
    }
  }
  const venv = join(pluginsDir, ".ccxt-broker-venv");
  log(`creating the shared broker venv ${venv} (${pythonCommand()})`);
  const created = spawnSync(pythonCommand(), ["-m", "venv", venv], { stdio: "inherit" });
  if (created.status !== 0) throw new Error(`${pythonCommand()} -m venv failed. Install Python 3.10+ and run again.`);
  const pip = WIN ? join(venv, "Scripts", "pip.exe") : join(venv, "bin", "pip");
  log("installing ccxt for the broker plugins");
  if (spawnSync(pip, ["install", "--disable-pip-version-check", "-r", join(BROKER_SOURCE, "requirements.txt")], { stdio: "inherit" }).status !== 0) {
    throw new Error("pip install failed");
  }
  return venv;
}

/** The plugin's own `.venv`: a link to the shared one, unless the user already put one there. */
function linkVenv(target, venv) {
  const link = join(target, ".venv");
  if (existsSync(venvPython(link))) return;
  try {
    rmSync(link, { recursive: true, force: true });
    symlinkSync(venv, link, WIN ? "junction" : "dir");
  } catch (error) {
    warn(`could not link ${link}: ${error.message}. The plugin will use the system Python; install ccxt there.`);
  }
}

/** Install one broker plugin per venue, off: every venue is a card in the Exchanges tab and the broker picker,
 *  and enabling the one the user trades starts its process. */
function installBrokerPlugins({ data, config }) {
  const all = manifests();
  const ids = Object.keys(all);
  const pluginsDir = join(data, "plugins");
  const targets = ids.map((id) => join(pluginsDir, id));
  if (targets.every((target) => existsSync(join(target, "plugin.py")) && existsSync(join(target, "opentrader-plugin.json")))) {
    log("broker plugins already installed; skipping");
    return;
  }
  const venv = sharedVenv(pluginsDir);
  for (const id of ids) {
    const target = join(pluginsDir, id);
    copyPluginDir(BROKER_SOURCE, target, new Set([...PLUGIN_SKIP, "build.py", "manifests.py"]));
    writeFileSync(join(target, "opentrader-plugin.json"), `${JSON.stringify(manifestFor(id, all), null, 2)}\n`);
    linkVenv(target, venv);
  }
  const file = writePluginsConfig(config, (current) => mergeBrokerConfig(current, ids, {}, all, null));
  log(`installed ${ids.length} broker plugins (new venues off) in ${file}`);
}

function installPlugins() {
  const dirs = appDirs();
  const jobs = [
    ["crypto", installCryptoPlugin],
    ["nse", installNsePlugin],
    ["brokers", installBrokerPlugins],
  ];
  for (const [name, job] of jobs) {
    try {
      job(dirs);
    } catch (error) {
      warn(`${name} plugin install failed: ${error.message}`);
    }
  }
}

// ── Run the app ──────────────────────────────────────────────────────────────
const PID_FILE = join(ROOT, "tmp", "tradepanel.pid");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitUntil(condition, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(200);
  }
  return false;
}
function readPidFile() {
  try {
    const pid = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function commandOf(pid) {
  if (WIN) {
    const result = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : "";
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}
function cwdOf(pid) {
  if (WIN) return "";
  if (process.platform === "linux") {
    try {
      return realpathSync(`/proc/${pid}/cwd`);
    } catch {
      return "";
    }
  }
  const result = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
  return result.stdout.match(/^n(.+)$/m)?.[1] ?? "";
}
function isOurLauncher(pid) {
  const command = commandOf(pid);
  // `npm start` uses a relative script path, so check the working directory as well.
  const ours = command.includes("tradepanel.mjs");
  return ours && (command.includes(ROOT) || cwdOf(pid) === ROOT);
}
function portInUse() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: PORT });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(400, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
function portOwners() {
  const lsof = spawnSync("lsof", ["-nP", "-t", `-iTCP:${PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (lsof.status === 0) return [...new Set(lsof.stdout.split(/\s+/).filter(Boolean))];
  const ss = spawnSync("ss", ["-H", "-ltnp", `( sport = :${PORT} )`], { encoding: "utf8" });
  return [...new Set([...ss.stdout.matchAll(/pid=(\d+)/g)].map((match) => match[1]))];
}

/** Stop the previous TradePanel started from this repo, then free the port for `tauri dev`. */
async function preparePort() {
  const previous = readPidFile();
  let stoppedPrevious = false;
  // The desktop icon is often clicked twice: a pid file gives us the real owner (killing by port used to take
  // down the app's WebKit network process, which is a *client* of the Vite port too).
  if (previous && previous !== process.pid && processAlive(previous)) {
    if (isOurLauncher(previous)) {
      log(`stopping the previous TradePanel (pid ${previous})`);
      if (WIN) spawnSync("taskkill", ["/PID", String(previous), "/T", "/F"], { stdio: "ignore", shell: true });
      else {
        try {
          process.kill(previous, "SIGTERM");
        } catch (error) {
          warn(`could not signal pid ${previous}: ${error.message}`);
        }
      }
      if (!(await waitUntil(() => !processAlive(previous), 8000))) {
        try {
          process.kill(previous, "SIGKILL");
        } catch {
          // It exited between the checks; nothing left to do.
        }
        await waitUntil(() => !processAlive(previous), 2000);
      }
      if (processAlive(previous)) fail(`the previous TradePanel (pid ${previous}) did not stop.`, "Check that process manually, then run this again.");
      stoppedPrevious = true;
    } else {
      warn(`ignoring ${PID_FILE}: pid ${previous} is not this TradePanel launcher.`);
    }
  }
  if (stoppedPrevious && (await portInUse())) await waitUntil(async () => !(await portInUse()), 5000);
  if (await portInUse()) {
    const owners = portOwners();
    const owner = owners.length ? ` (pid ${owners.join(", ")})` : "";
    fail(
      `port ${PORT} is still in use${owner}, and the Vite dev server needs it.`,
      "Stop that process manually and run this again. This script never kills unknown processes on this port.",
    );
  }
}

function runApp(passthrough) {
  const tauriCli = join(APP, "node_modules", "@tauri-apps", "cli", "tauri.js");
  log("starting TradePanel (tauri dev; the first Rust build takes several minutes)");
  // A separate process group lets SIGTERM take down tauri dev, Vite and the WebView together. `tauri dev` owns
  // grandchildren that would otherwise survive us and keep port 1420 busy on the next launch.
  const child = spawn(process.execPath, [tauriCli, "dev", ...passthrough], { cwd: APP, stdio: "inherit", env: process.env, detached: !WIN });
  const removePidFile = () => {
    try {
      // A newer launcher may already own the file when we exit; never delete its pid.
      if (readPidFile() === process.pid) unlinkSync(PID_FILE);
    } catch {
      // The file is best-effort; a stale entry is recognized and ignored on the next launch.
    }
  };
  try {
    mkdirSync(dirname(PID_FILE), { recursive: true });
    writeFileSync(PID_FILE, String(process.pid));
  } catch (error) {
    warn(`could not write ${PID_FILE}: ${error.message}; a second launch cannot stop this one cleanly.`);
  }
  process.on("exit", removePidFile);

  let stopping = false;
  const stopChild = (signal) => {
    if (stopping || !child.pid) return;
    stopping = true;
    if (WIN) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: true });
    else {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // It exited between the checks.
        }
      }
    }
    const force = setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 5000);
    force.unref();
  };
  process.on("SIGTERM", () => stopChild("SIGTERM"));
  process.on("SIGINT", () => stopChild("SIGINT"));

  child.on("error", (error) => fail(`could not start the app: ${error.message}`));
  child.on("exit", (code, signal) => {
    removePidFile();
    if (signal) {
      log(`the app was stopped by ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function usage() {
  console.log(`TradePanel — set up the workspace and run the app.

  tradepanel.mjs [flags] [-- <tauri dev args>]

Flags:
  -h, --help     this help
  --setup        clone, apply the packs and install, but do not start the app
  --update       re-assemble the checkout even when nothing changed
  --ref <ref>    assemble at this tag, branch or commit (use with --update)
  --latest       assemble at the newest vX.Y.Z release tag (use with --update)
  --no-install   do not run "npm ci" or install the plugins; report what is missing instead
  -- <args>      pass the rest to "tauri dev", e.g. -- --no-watch

The checkout, the packs and the dependencies are set up automatically on the first run and whenever a
pack or the lock changes. ./update is this script with --update --setup: it moves the pin and installs
without starting the app. Requirements: Node.js ${RECOMMENDED_NODE}+, Rust stable (https://rustup.rs) and
the Tauri system libraries (https://v2.tauri.app/start/prerequisites/).

Environment:
  TRADEPANEL_NO_INSTALL=1   same as --no-install
  TRADEPANEL_ENV=<file>     shell snippet sourced before the build (PKG_CONFIG_PATH and linker paths)
  OPENSSL_DIR=<dir>         OpenSSL headers and libs; Debian/Ubuntu stage libssl-dev automatically`);
}

function parseArgs(argv) {
  const options = {
    help: false,
    setup: false,
    update: false,
    noInstall: /^(1|true|yes|on)$/i.test(process.env.TRADEPANEL_NO_INSTALL ?? ""),
    ref: undefined,
    latest: false,
    passthrough: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      options.passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--setup") options.setup = true;
    else if (arg === "--update") options.update = true;
    else if (arg === "--no-install") options.noInstall = true;
    else if (arg === "--latest") options.latest = true;
    else if (arg === "--ref") {
      options.ref = argv[++i];
      if (!options.ref) fail("--ref needs a tag, branch or commit");
    } else options.passthrough.push(arg);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();

  checkNode();
  ensureCargoPath();
  buildEnvironment();

  const config = readConfig();
  // --ref / --latest move the pin for this run and record it in opentrader.lock.json.
  const ref = options.latest ? "latest" : (options.ref ?? config.ref);
  const effective = { ...config, ref };
  ensureCheckout(effective);

  const reason = assemblyNeeded(effective);
  if (options.update || reason) {
    log(reason ? `assembling the checkout (${reason})` : "assembling the checkout (--update)");
    assemble(effective);
  }

  installDeps(options.noInstall);
  ensureDrawingCore();
  if (!options.noInstall) await stageAiRuntime();
  generateBindings();
  regenCatalog();
  if (!options.noInstall) installPlugins();

  if (options.setup) {
    log("setup complete; run this again without --setup to start the app");
    return;
  }

  await preparePort();
  runApp(options.passthrough);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
