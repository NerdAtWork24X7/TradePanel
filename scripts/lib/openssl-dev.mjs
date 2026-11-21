// OpenSSL development headers are a build-time dependency of native-tls. Desktop sessions often have the
// runtime library but not the headers, and `cargo` fails deep in openssl-sys with an opaque pkg-config error.
// On Debian/Ubuntu we can stage the matching -dev package under the user's data dir without sudo; the launcher
// points OPENSSL_* at that prefix so the build is reproducible without touching the system installation.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const command = (name, args, cwd) =>
  spawnSync(name, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

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
      if (existsSync(source) && !existsSync(join(target, versioned))) {
        copyFileSync(source, join(target, versioned));
      }
    }
  }
}

function envFor(prefix) {
  return {
    OPENSSL_DIR: prefix,
    OPENSSL_INCLUDE_DIR: join(prefix, "include"),
    OPENSSL_LIB_DIR: join(prefix, "lib"),
    PKG_CONFIG_PATH: [join(prefix, "lib", "pkgconfig"), process.env.PKG_CONFIG_PATH].filter(Boolean).join(":"),
  };
}

// Returns environment overrides when it staged headers, null when there was nothing to do (system headers
// present, or a platform we cannot stage on). `fail` is the launcher's error reporter.
export function ensureOpenSslDev({ say, fail }) {
  if (hasOpenSslDev()) return null;
  if (process.platform !== "linux" || !existsSync("/etc/debian_version")) return null;

  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const prefix = join(dataHome, "tradepanel", "openssl-dev", `${process.platform}-${process.arch}`);
  if (validPrefix(prefix)) {
    say(`using OpenSSL development headers in ${prefix}`);
    return envFor(prefix);
  }

  const stage = mkdtempSync(join(tmpdir(), "tradepanel-openssl-"));
  let error;
  try {
    say("staging OpenSSL development headers (no sudo needed)");
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

    say(`OpenSSL development headers ready in ${prefix}`);
    return envFor(prefix);
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
