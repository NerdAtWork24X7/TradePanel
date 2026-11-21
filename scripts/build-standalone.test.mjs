/* The standalone build puts the app and everything it runs in one folder. The two things that
 * can go wrong silently are the layout (the app looks for its resources in a place that
 * depends on the platform) and the Python that comes with it (the parts no plugin uses are
 * removed, the interpreter must stay). */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { layout, prunePython, selectTargets } from "./build-standalone.mjs";

test("the resources sit where the app looks for them on each platform", () => {
  // Tauri reads them from <exe>/../lib/<productName> on Linux (where a deb installs them),
  // from the executable's folder on Windows.
  assert.deepEqual(layout("linux", "OpenTrader"), {
    binary: "bin/opentrader",
    resources: "lib/OpenTrader",
  });
  assert.deepEqual(layout("win32", "OpenTrader"), { binary: "opentrader.exe", resources: "." });
});

test("the platform and architecture flags select the right build targets", () => {
  assert.deepEqual(selectTargets("linux", "x64"), ["linux-x64"]);
  assert.deepEqual(selectTargets("win32", "x64"), ["win-x64"]);
  assert.deepEqual(selectTargets("linux", "arm64"), ["linux-arm64"]);
  assert.deepEqual(selectTargets("all", "x64").sort(), ["linux-x64", "win-x64"]);
});

test("the Python keeps its interpreter and loses what no plugin uses", () => {
  const dir = mkdtempSync(join(tmpdir(), "standalone-python-"));
  try {
    mkdirSync(join(dir, "include"), { recursive: true });
    mkdirSync(join(dir, "share", "man"), { recursive: true });
    mkdirSync(join(dir, "bin"), { recursive: true });
    mkdirSync(join(dir, "lib", "python3.12", "site-packages"), { recursive: true });
    mkdirSync(join(dir, "lib", "python3.12", "idlelib"), { recursive: true });
    mkdirSync(join(dir, "lib", "python3.12", "ensurepip"), { recursive: true });
    writeFileSync(join(dir, "bin", "python3"), "interpreter");
    writeFileSync(join(dir, "lib", "python3.12", "site-packages", "ccxt.py"), "ccxt");
    writeFileSync(join(dir, "lib", "python3.12", "site-packages", "pip.py"), "pip");

    prunePython(dir);

    assert.ok(existsSync(join(dir, "bin", "python3")), "the interpreter stays");
    assert.ok(existsSync(join(dir, "lib", "python3.12", "site-packages", "ccxt.py")), "the packages stay");
    assert.ok(!existsSync(join(dir, "lib", "python3.12", "site-packages", "pip.py")), "pip goes");
    assert.ok(!existsSync(join(dir, "include")), "the headers go");
    assert.ok(!existsSync(join(dir, "share")), "the manuals go");
    assert.ok(!existsSync(join(dir, "lib", "python3.12", "idlelib")), "the IDLE goes");
    assert.ok(!existsSync(join(dir, "lib", "python3.12", "ensurepip")), "ensurepip goes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
