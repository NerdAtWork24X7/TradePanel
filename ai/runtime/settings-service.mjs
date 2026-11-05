#!/usr/bin/env node
/**
 * settings-service.mjs — Pi's own provider/auth runtime, exposed to TradePanel.
 *
 * This is the same architecture Pi Scope uses for Settings → Authentication:
 * the bundled `@earendil-works/pi-coding-agent` exports `ModelRuntime`, which
 * already knows every provider, which login methods it supports, how to run an
 * OAuth device/browser flow, and which models a credential unlocks. TradePanel
 * does not duplicate that catalogue (or its env-var table) in Rust. It spawns
 * this small helper with the *bundled* Node binary, pins PI_CODING_AGENT_DIR to
 * TradePanel's own agent dir, and speaks one JSON object per line:
 *
 *   → {"id":"1","type":"providers"}
 *   → {"id":"2","type":"models"}
 *   → {"id":"3","type":"login_start","providerId":"anthropic","authType":"oauth"}
 *   → {"id":"4","type":"login_answer","sessionId":"…","promptId":1,"value":"…"}
 *   → {"id":"5","type":"login_cancel","sessionId":"…"}
 *   → {"id":"6","type":"login_get","sessionId":"…"}
 *   → {"id":"7","type":"logout","providerId":"…"}
 *   ← {"type":"ready","node":"…","pi":"…"}
 *   ← {"type":"response","id":"1","ok":true,"data":{…}}
 *   ← {"type":"auth_state","session":{…}}
 *
 * Credentials land in <agent dir>/auth.json (mode 0600), exactly where Pi looks
 * for them, so the analysis process started by Rust needs no key in its
 * environment. This helper never receives trading credentials: Rust strips its
 * environment down to OS essentials + the AI agent dir, and it has no shell or
 * filesystem tools. It writes nothing except auth.json and device-id.
 */
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
const AGENT_DIR = (process.env.PI_CODING_AGENT_DIR || "").trim();
if (!AGENT_DIR) {
  process.stderr.write("settings-service: PI_CODING_AGENT_DIR is required\n");
  process.exit(2);
}
const AUTH_JSON = path.join(AGENT_DIR, "auth.json");
const SESSION_TTL_MS = 30 * 60_000;
const DONE_TTL_MS = 5 * 60_000;
const MAX_VALUE = 8192;

/** Write a frame. Never include credentials in errors/log lines. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(id, error) {
  send({ type: "response", id: id ?? null, ok: false, error: String(error || "unknown error").slice(0, 2000) });
}

// ─── Runtime ────────────────────────────────────────────────────────────────

let runtimePromise = null;

async function runtime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const mod = await import(pathToFileURL(PKG).href);
      if (typeof mod?.ModelRuntime?.create !== "function") {
        throw new Error("the bundled Pi runtime does not expose ModelRuntime");
      }
      // modelsPath:null keeps Pi from rewriting models-store.json while the
      // user is only signing in. The analysis process still uses its own store.
      const rt = await mod.ModelRuntime.create({ authPath: AUTH_JSON, modelsPath: null });
      try { fs.chmodSync(AUTH_JSON, 0o600); } catch { /* created later by login */ }
      return rt;
    })();
    runtimePromise.catch(() => { runtimePromise = null; });
  }
  return runtimePromise;
}

async function ensureAgentFiles() {
  fs.mkdirSync(AGENT_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(AGENT_DIR, 0o700); } catch { /* best effort on odd filesystems */ }
  // Restrict an existing auth file too; login creates it 0600 already.
  try { fs.chmodSync(AUTH_JSON, 0o600); } catch { /* absent */ }
}

/** Stable per-installation id used by some OAuth device flows. */
function deviceId() {
  const file = path.join(AGENT_DIR, "device-id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch { /* first use */ }
  const id = crypto.randomUUID();
  try { fs.writeFileSync(file, id, { mode: 0o600 }); } catch { /* best effort */ }
  return id;
}

// ─── Login sessions ─────────────────────────────────────────────────────────

/** @type {Map<string, any>} */
const sessions = new Map();

function prune() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    const ttl = s.status === "running" ? SESSION_TTL_MS : DONE_TTL_MS;
    if (now - s.startedAt <= ttl) continue;
    if (s.status === "running") {
      try { s.controller.abort(); } catch { /* already gone */ }
    }
    sessions.delete(id);
  }
}

function view(s) {
  return {
    id: s.id,
    providerId: s.providerId,
    providerName: s.providerName,
    type: s.type,
    status: s.status,
    prompt: s.prompt,
    events: s.events,
    error: s.error,
    startedAt: s.startedAt,
  };
}

function publish(s) {
  send({ type: "auth_state", session: view(s) });
}

function eventOf(raw) {
  if (raw?.type === "auth_url") {
    return { type: "auth_url", url: String(raw.url || ""), instructions: raw.instructions };
  }
  if (raw?.type === "device_code") {
    return {
      type: "device_code",
      userCode: String(raw.userCode || ""),
      verificationUri: String(raw.verificationUri || ""),
    };
  }
  if (raw?.type === "info") {
    const links = Array.isArray(raw.links)
      ? raw.links
          .filter((link) => link && typeof link.url === "string")
          .slice(0, 8)
          .map((link) => ({ url: link.url, label: typeof link.label === "string" ? link.label : undefined }))
      : undefined;
    return { type: "info", message: String(raw.message || ""), links };
  }
  return { type: "progress", message: String(raw?.message || "") };
}

function promptOf(raw, id) {
  const type = ["text", "secret", "select", "manual_code"].includes(raw?.type) ? raw.type : "text";
  const options = Array.isArray(raw?.options)
    ? raw.options
        .filter((option) => option && typeof option.id === "string")
        .slice(0, 64)
        .map((option) => ({
          id: option.id,
          label: String(option.label || option.id),
          description: typeof option.description === "string" ? option.description : undefined,
        }))
    : undefined;
  return {
    id,
    type,
    message: String(raw?.message || ""),
    placeholder: typeof raw?.placeholder === "string" ? raw.placeholder : undefined,
    options,
  };
}

function description(rt, provider) {
  const status = rt.getProviderAuthStatus(provider.id) || { configured: false };
  const usingOAuth = rt.isUsingOAuth(provider.id);
  if (!status.configured) {
    return { configured: false, usingOAuth: false, statusLabel: "" };
  }
  let label = "configured";
  if (usingOAuth) label = "OAuth";
  else if (status.source === "environment") label = status.label || "environment";
  else if (status.source === "stored") label = "stored credential";
  else if (status.source === "runtime") label = "session key";
  else if (status.label) label = status.label;
  return { configured: true, usingOAuth, statusLabel: label };
}

function methodsOf(provider) {
  const methods = [];
  const auth = provider.auth || {};
  if (auth.oauth) {
    methods.push({
      type: "oauth",
      label: auth.oauth.loginLabel || "Sign in with an account",
      canLogin: typeof auth.oauth.login === "function",
    });
  }
  if (auth.apiKey) {
    methods.push({
      type: "api_key",
      label: auth.apiKey.name || "API key",
      canLogin: typeof auth.apiKey.login === "function",
    });
  }
  return methods;
}

async function providerSnapshot() {
  const rt = await runtime();
  const providers = [];
  for (const provider of rt.getProviders()) {
    const methods = methodsOf(provider);
    if (!methods.length) continue;
    providers.push({
      id: provider.id,
      name: provider.name,
      methods,
      ...description(rt, provider),
    });
  }
  providers.sort((a, b) => a.name.localeCompare(b.name));
  let credentials = [];
  try {
    credentials = (await rt.listCredentials({ signal: AbortSignal.timeout(15_000) }))
      .map((credential) => ({
        providerId: credential.providerId,
        name: rt.getProvider(credential.providerId)?.name || credential.providerId,
        type: credential.type,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    process.stderr.write(`settings-service: listCredentials failed: ${String(error?.message || error)}\n`);
  }
  return { ready: true, providers, credentials };
}

function levelsOf(model) {
  const map = model?.thinkingLevelMap;
  if (Array.isArray(map)) return map.filter((level) => typeof level === "string");
  if (map && typeof map === "object") {
    const keys = Object.keys(map).filter((key) => map[key] !== null && map[key] !== undefined);
    return keys.length ? keys : null;
  }
  return null;
}

async function modelSnapshot() {
  const rt = await runtime();
  const models = await rt.getAvailable(undefined, { signal: AbortSignal.timeout(45_000) });
  return models
    .filter((model) => model && typeof model.id === "string" && typeof model.provider === "string")
    .filter((model) => !model.type || model.type === "chat")
    .filter((model) => !Array.isArray(model.input) || model.input.includes("text"))
    .map((model) => ({
      id: model.id,
      name: typeof model.name === "string" && model.name.trim() ? model.name : model.id,
      provider: model.provider,
      contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : null,
      maxTokens: Number.isFinite(model.maxTokens) ? model.maxTokens : null,
      reasoning: Boolean(model.reasoning),
      input: Array.isArray(model.input) ? model.input.filter((item) => typeof item === "string") : ["text"],
      thinkingLevels: levelsOf(model),
      cost: model.cost && typeof model.cost === "object" ? model.cost : null,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}

function startLogin(providerId, authType) {
  return (async () => {
    const rt = await runtime();
    const provider = rt.getProvider(providerId);
    if (!provider) throw new Error(`unknown provider: ${providerId}`);
    if (authType !== "oauth" && authType !== "api_key") throw new Error(`invalid auth type: ${authType}`);
    const method = authType === "oauth" ? provider.auth?.oauth : provider.auth?.apiKey;
    if (!method) {
      throw new Error(`${provider.name} does not offer ${authType === "oauth" ? "an account sign-in" : "an API key login"}.`);
    }
    if (typeof method.login !== "function") {
      throw new Error(`${provider.name} is configured outside Pi (${method.name || "ambient credentials"}).`);
    }
    prune();
    const session = {
      id: crypto.randomUUID(),
      providerId: provider.id,
      providerName: provider.name,
      type: authType,
      status: "running",
      prompt: null,
      events: [],
      startedAt: Date.now(),
      controller: new AbortController(),
      promptSeq: 0,
      resolvePrompt: null,
      rejectPrompt: null,
    };
    sessions.set(session.id, session);

    const notify = (raw) => {
      const event = eventOf(raw);
      session.events.push(event);
      if (session.events.length > 80) session.events.shift();
      publish(session);
    };

    const prompt = (raw) =>
      new Promise((resolve, reject) => {
        if (session.controller.signal.aborted) {
          reject(new Error("Login cancelled"));
          return;
        }
        const promptId = ++session.promptSeq;
        session.prompt = promptOf(raw, promptId);
        const clear = () => {
          if (session.prompt?.id === promptId) session.prompt = null;
        };
        session.resolvePrompt = (value) => {
          clear();
          resolve(value);
        };
        session.rejectPrompt = (error) => {
          clear();
          reject(error);
        };
        publish(session);
        // Pi aborts a prompt's own signal when an out-of-band event (e.g. the
        // OAuth callback) resolves the step first.
        raw?.signal?.addEventListener(
          "abort",
          () => {
            clear();
            reject(new Error("Login cancelled"));
          },
          { once: true },
        );
      });

    void (async () => {
      try {
        await rt.login(providerId, authType, { signal: session.controller.signal, prompt, notify }, { getDeviceId: deviceId });
        session.status = "ok";
      } catch (error) {
        if (session.controller.signal.aborted) session.status = "cancelled";
        else {
          session.status = "error";
          session.error = String(error?.message || error).slice(0, 2000);
        }
      } finally {
        session.prompt = null;
        session.resolvePrompt = null;
        session.rejectPrompt = null;
        try { fs.chmodSync(AUTH_JSON, 0o600); } catch { /* not created for a failed login */ }
        publish(session);
      }
    })();

    // Give the provider a moment to emit its first prompt/event so the initial
    // response already contains something useful (Pi does this synchronously).
    await new Promise((resolve) => setTimeout(resolve, 20));
    return view(session);
  })();
}

function answerLogin(sessionId, promptId, value) {
  const session = sessions.get(sessionId);
  if (!session || session.status !== "running") throw new Error("login is not running");
  if (!session.prompt || session.prompt.id !== promptId || !session.resolvePrompt) {
    throw new Error("that prompt is no longer active");
  }
  if (typeof value !== "string" || value.length > MAX_VALUE) throw new Error("invalid value");
  if (session.prompt.type !== "select" && !value.trim()) throw new Error("Enter a value");
  const resolve = session.resolvePrompt;
  session.resolvePrompt = null;
  session.rejectPrompt = null;
  session.prompt = null;
  resolve(value);
  publish(session);
  return view(session);
}

function cancelLogin(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("unknown login session");
  if (session.status === "running") {
    session.status = "cancelled";
    try { session.rejectPrompt?.(new Error("Login cancelled")); } catch { /* ignore */ }
    session.resolvePrompt = null;
    session.rejectPrompt = null;
    session.prompt = null;
    try { session.controller.abort(); } catch { /* already gone */ }
    publish(session);
  }
  return view(session);
}

function getLogin(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("unknown login session");
  return view(session);
}

async function logout(providerId) {
  const rt = await runtime();
  if (!rt.getProvider(providerId)) throw new Error(`unknown provider: ${providerId}`);
  await rt.logout(providerId);
  try { fs.chmodSync(AUTH_JSON, 0o600); } catch { /* absent */ }
  return providerSnapshot();
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

/** Commands run one at a time. A slow model refresh must not interleave with
 *  a login answer, and a rejected command must never take the service down. */
let chain = Promise.resolve();

function handle(message, respond) {
  chain = chain.then(async () => {
    try {
      switch (message.type) {
        case "providers":
          return respond(await providerSnapshot());
        case "models":
          return respond(await modelSnapshot());
        case "login_start":
          return respond(await startLogin(String(message.providerId || ""), String(message.authType || "")));
        case "login_answer":
          return respond(answerLogin(String(message.sessionId || ""), Number(message.promptId), String(message.value ?? "")));
        case "login_cancel":
          return respond(cancelLogin(String(message.sessionId || "")));
        case "login_get":
          return respond(getLogin(String(message.sessionId || "")));
        case "logout":
          return respond(await logout(String(message.providerId || "")));
        case "ping":
          return respond({ ok: true });
        default:
          throw new Error(`unknown command: ${String(message.type)}`);
      }
    } catch (error) {
      fail(message.id, error?.message || error);
    }
  });
}

async function boot() {
  await ensureAgentFiles();
  const rt = await runtime();
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"));
  send({ type: "ready", node: process.version, pi: pkg.version, providers: rt.getProviders().length });
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(null, "invalid JSON");
    return;
  }
  if (!message || typeof message !== "object") {
    fail(null, "invalid request");
    return;
  }
  if (message.type === "shutdown") {
    input.close();
    process.exit(0);
  }
  const id = message.id;
  handle(message, (data) => send({ type: "response", id, ok: true, data }));
});

input.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

boot().catch((error) => {
  process.stderr.write(`settings-service: boot failed: ${String(error?.message || error)}\n`);
  process.exit(1);
});
