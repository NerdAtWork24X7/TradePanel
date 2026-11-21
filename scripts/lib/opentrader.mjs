/*
 * Shared plumbing for the TradePanel × OpenTrader layout.
 *
 * `opentrader/` is a checkout of upstream OpenTrader, owned by `scripts/update-opentrader.mjs`:
 * it is reset to a tag, then the independent packs in `extensions/` are overlaid on top. Nothing
 * in this file writes outside that checkout (or the lock file at the repo root).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const APP = join(ROOT, "opentrader");
export const EXTENSIONS_DIR = join(ROOT, "extensions");
export const CONFIG_FILE = join(ROOT, "opentrader.config.json");
export const LOCK_FILE = join(ROOT, "opentrader.lock.json");
export const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
export const GIT = process.platform === "win32" ? "git.exe" : "git";

export function log(message) {
  console.log(`tradepanel: ${message}`);
}

export function warn(message) {
  console.error(`tradepanel: warning: ${message}`);
}

export function fail(message, hint) {
  console.error(`tradepanel: ${message}`);
  if (hint) console.error(`tradepanel: ${hint}`);
  process.exit(1);
}

/** Run a program and return its stdout; throws with the command in the message on failure. */
export function output(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
      ...options,
    }).trim();
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
}

/** Run a program with its output attached to the terminal. */
export function run(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
    ...options,
  });
}

export function outputOr(command, args, fallback = "", options = {}) {
  try {
    return output(command, args, options);
  } catch {
    return fallback;
  }
}

export function git(args, options = {}) {
  return output(GIT, args, { cwd: APP, ...options });
}

export function gitOr(args, fallback = "", options = {}) {
  return outputOr(GIT, args, fallback, { cwd: APP, ...options });
}

export function gitRun(args, options = {}) {
  return run(GIT, args, { cwd: APP, ...options });
}

export function readConfig() {
  if (!existsSync(CONFIG_FILE)) fail(`${relative(ROOT, CONFIG_FILE)} is missing`);
  const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  if (resolve(ROOT, config.directory) !== APP) fail(`${relative(ROOT, CONFIG_FILE)}: "directory" must be "opentrader"`);
  for (const key of ["repository", "directory", "ref"]) {
    if (typeof config[key] !== "string" || !config[key].trim()) fail(`${relative(ROOT, CONFIG_FILE)}: "${key}" is required`);
  }
  return config;
}

/** The newest upstream release tag, falling back to origin/HEAD. */
export function latestRef() {
  const tags = git(["tag", "--list", "v*", "--sort=-v:refname"])
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  if (tags.length) return tags[0];
  const head = gitOr(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return head || "origin/HEAD";
}

export function resolveRef(ref) {
  if (!ref || ref === "latest") return latestRef();
  if (ref === "main" || ref === "head") return "origin/HEAD";
  return ref;
}

/** A checkout cloned with --filter=blob:none keeps .promisor packs that document its
 *  missing blobs. If the matching remote config is lost, git negotiates with objects it
 *  cannot read and the next fetch dies with "pack has N unresolved delta". */
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

export function ensureCheckout(config) {
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
      "Move it aside (it is generated) or run the update from a clean workspace; the updater never deletes a folder it did not clone.",
    );
  }
  log(`cloning ${config.repository}`);
  mkdirSync(dirname(APP), { recursive: true });
  run(GIT, ["clone", config.repository, config.directory], { cwd: ROOT });
  ensurePartialCloneConfig();
}

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
    if (entry.isDirectory()) {
      copied += overlay(from, to);
    } else if (entry.isSymbolicLink()) {
      throw new Error(`extension file is a symlink: ${from}`);
    } else if (entry.isFile()) {
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
  "clean",
  "-fd",
  "--quiet",
  "-e",
  "src-tauri/ai-runtime",
  "-e",
  "src-tauri/standalone",
  "-e",
  "dist",
  "-e",
  "dist-web",
  "-e",
  "src/bindings.ts",
  "-e",
  ".env",
];

export function resetCheckout(ref) {
  gitRun(["reset", "--hard", "--quiet"]);
  gitRun(cleanArgs);
  gitRun(["checkout", "--detach", "--force", ref, "--quiet"]);
  gitRun(["reset", "--hard", "--quiet", ref]);
  gitRun(cleanArgs);
}

export function rollback() {
  try {
    gitRun(["reset", "--hard", "--quiet"]);
    gitRun(cleanArgs);
  } catch {
    warn("could not reset the checkout; inspect opentrader/ by hand");
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

export function writeLock({ ref, commit, extensions }) {
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

export function readLock() {
  if (!existsSync(LOCK_FILE)) return null;
  try {
    return JSON.parse(readFileSync(LOCK_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function isStale(config, extensions) {
  const lock = readLock();
  if (!lock) return "no lock file";
  if (lock.upstream !== config.repository) return "upstream changed";
  if (lock.extensions?.length !== extensions.length) return "extension set changed";
  for (const extension of extensions) {
    const entry = lock.extensions.find((item) => item.id === extension.id);
    if (!entry || entry.sha256 !== extensionHash(extension)) return `extension ${extension.id} changed`;
  }
  return null;
}

export function appVersion() {
  try {
    return JSON.parse(readFileSync(join(APP, "src-tauri", "tauri.conf.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}
