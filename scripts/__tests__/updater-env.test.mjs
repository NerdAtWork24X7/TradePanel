import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensurePartialCloneConfig } from "../lib/opentrader.mjs";

const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" });

function tempRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "tradepanel-updater-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(git(dir, ["init", "-q"]).status, 0);
  return dir;
}

test("restores partial-clone config when the promisor packs outlive it", (t) => {
  const dir = tempRepo(t);
  mkdirSync(join(dir, ".git", "objects", "pack"), { recursive: true });
  writeFileSync(join(dir, ".git", "objects", "pack", "pack-legacy.promisor"), "");

  ensurePartialCloneConfig(dir);

  assert.equal(git(dir, ["config", "--bool", "--get", "remote.origin.promisor"]).stdout.trim(), "true");
  assert.equal(git(dir, ["config", "--get", "remote.origin.partialCloneFilter"]).stdout.trim(), "blob:none");
});

test("leaves full checkouts and configured partial clones alone", (t) => {
  const full = tempRepo(t);
  ensurePartialCloneConfig(full);
  assert.equal(existsSync(join(full, ".git", "objects", "pack", "pack-legacy.promisor")), false);
  assert.notEqual(git(full, ["config", "--get", "remote.origin.promisor"]).status, 0);

  const partial = tempRepo(t);
  mkdirSync(join(partial, ".git", "objects", "pack"), { recursive: true });
  writeFileSync(join(partial, ".git", "objects", "pack", "pack-legacy.promisor"), "");
  assert.equal(git(partial, ["config", "remote.origin.promisor", "true"]).status, 0);
  assert.equal(git(partial, ["config", "remote.origin.partialCloneFilter", "tree:0"]).status, 0);

  ensurePartialCloneConfig(partial);

  assert.equal(git(partial, ["config", "--get", "remote.origin.partialCloneFilter"]).stdout.trim(), "tree:0");

  const custom = tempRepo(t);
  mkdirSync(join(custom, ".git", "objects", "pack"), { recursive: true });
  writeFileSync(join(custom, ".git", "objects", "pack", "pack-legacy.promisor"), "");
  assert.equal(git(custom, ["config", "remote.origin.partialCloneFilter", "tree:0"]).status, 0);

  ensurePartialCloneConfig(custom);

  assert.equal(git(custom, ["config", "--bool", "--get", "remote.origin.promisor"]).stdout.trim(), "true");
  assert.equal(git(custom, ["config", "--get", "remote.origin.partialCloneFilter"]).stdout.trim(), "tree:0");
});
