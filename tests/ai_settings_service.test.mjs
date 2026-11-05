/**
 * Settings bridge test: provider catalogue, API-key login, auth.json mode and
 * logout, driven through the same JSONL protocol Rust uses. No provider network
 * call is made (an API-key login stores the key locally).
 *
 * Requires the staged runtime (built by `npm run ai:runtime`). The test skips
 * with a clear message when it is absent, like the RPC smoke test.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const REPO = path.resolve(import.meta.dirname, "..");
const TARGET =
  process.platform === "win32"
    ? `win-${process.arch === "arm64" ? "arm64" : "x64"}`
    : process.platform === "darwin"
      ? `darwin-${process.arch === "arm64" ? "arm64" : "x64"}`
      : `linux-${process.arch === "arm64" ? "arm64" : "x64"}`;
const ROOT =
  process.env.TRADEPANEL_AI_RUNTIME ||
  path.join(REPO, "src-tauri", "ai-runtime", TARGET);
const NODE = path.join(ROOT, "node", process.platform === "win32" ? "node.exe" : "node");
const SERVICE = path.join(ROOT, "pi", "settings-service.mjs");

class Service {
  constructor(agentDir) {
    this.agentDir = agentDir;
    this.seq = 0;
    this.pending = new Map();
    this.states = [];
    this.buffer = "";
    this.child = spawn(NODE, [SERVICE], {
      env: {
        PATH: process.env.PATH || "",
        HOME: path.dirname(agentDir),
        PI_CODING_AGENT_DIR: agentDir,
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        PI_OFFLINE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => {
      this.stderr += String(chunk).slice(0, 4000);
    });
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.type === "auth_state") {
          this.states.push(message.session);
          continue;
        }
        if (message.type !== "response") continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        pending(message);
      }
    });
  }

  request(type, extra = {}, timeout = 60_000) {
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out: ${type}`));
      }, timeout);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.ok) resolve(message.data);
        else reject(new Error(message.error));
      });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    });
  }

  async waitFor(sessionId, status, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const session = await this.request("login_get", { sessionId });
      if (session.status === status) return session;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`session ${sessionId} did not reach ${status}`);
  }

  stop() {
    this.child.stdin.end();
    this.child.kill();
  }
}

const available = existsSync(NODE) && existsSync(SERVICE);
test(
  "settings service lists providers and performs an API-key login",
  { skip: !available ? `staged runtime missing at ${ROOT}` : false, timeout: 90_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "tp-auth-test-"));
    const agentDir = path.join(root, "agent");
    const service = new Service(agentDir);
    try {
      const catalogue = await service.request("providers");
      assert.equal(catalogue.ready, true);
      assert.ok(catalogue.providers.length >= 20, "expected Pi's provider catalogue");
      const openai = catalogue.providers.find((provider) => provider.id === "openai");
      assert.ok(openai, "openai provider present");
      assert.ok(openai.methods.some((method) => method.type === "api_key"));
      assert.equal(catalogue.credentials.length, 0);

      const started = await service.request("login_start", { providerId: "openai", authType: "api_key" });
      assert.equal(started.status, "running");
      assert.equal(started.prompt.type, "secret");
      assert.match(started.prompt.message, /API key/i);

      await assert.rejects(
        service.request("login_answer", { sessionId: started.id, promptId: started.prompt.id, value: "   " }),
        /Enter a value/,
      );
      const answered = await service.request("login_answer", {
        sessionId: started.id,
        promptId: started.prompt.id,
        value: "sk-local-test",
      });
      assert.equal(answered.status, "running");
      const settled = await service.waitFor(started.id, "ok");
      assert.equal(settled.status, "ok");

      const authPath = path.join(agentDir, "auth.json");
      assert.ok(existsSync(authPath));
      const stored = JSON.parse(readFileSync(authPath, "utf8"));
      assert.equal(stored.openai.type, "api_key");
      assert.equal(stored.openai.key, "sk-local-test");
      if (process.platform !== "win32") {
        assert.equal(statSync(authPath).mode & 0o777, 0o600, "auth.json must be owner-only");
      }

      const models = await service.request("models");
      assert.ok(models.some((model) => model.provider === "openai"), "models unlocked by the credential");

      const afterLogout = await service.request("logout", { providerId: "openai" });
      assert.equal(afterLogout.credentials.length, 0);
      assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), {});
    } finally {
      service.stop();
      chmodSync(root, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
