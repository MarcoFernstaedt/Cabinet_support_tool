// Cabinet Support web Console: a backend-for-frontend (BFF) in front of the
// Cabinet Server API.
//
// The browser never sees an API bearer token. It receives an opaque, HttpOnly,
// SameSite=Strict session cookie; the token lives only in this process. Every
// state-changing request needs the exact Console origin, a JSON body and the
// session's CSRF token. Only an explicit allowlist of Server routes is reachable,
// and the Server stays authoritative for every authorization decision.
import http from "node:http";
import https from "node:https";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoSandbox } from "./demo-sandbox.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const G = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export const LIMITS = Object.freeze({
  requestBodyBytes: 64 * 1024,
  upstreamBodyBytes: 2 * 1024 * 1024,
  upstreamTimeoutMs: 15_000,
  sessionIdleMs: 30 * 60_000,
  sessionAbsoluteMs: 8 * 60 * 60_000,
  refreshBeforeExpiryMs: 2 * 60_000,
  maxSessions: 2000,
  loginAttemptsPerWindow: 10,
  loginWindowMs: 60_000,
  queryParams: 16,
  queryValueLength: 200,
});

// Method + path pattern for every Server route the Console may call.
// `supervisor` routes are refused here for support tiers as defence in depth;
// the Server enforces the same policy independently.
export const ROUTES = [
  ["GET", "/api/auth/me"],
  ["GET", "/api/fleet/health"],
  ["GET", "/api/fleet/sites"],
  ["GET", `/api/fleet/sites/${G}`],
  ["GET", "/api/cabinets"],
  ["GET", `/api/cabinets/${G}`],
  ["GET", `/api/cabinets/${G}/heartbeats`],
  ["GET", `/api/cabinets/${G}/inventory`],
  ["GET", `/api/cabinets/${G}/smart`],
  ["GET", `/api/cabinets/${G}/storage`],
  ["GET", `/api/cabinets/${G}/process-results/latest`],
  ["GET", `/api/cabinets/${G}/process-results/${G}`],
  ["GET", `/api/cabinets/${G}/event-log-results/latest`],
  ["GET", `/api/cabinets/${G}/event-log-results/${G}`],
  ["GET", `/api/connectivity/cabinets/${G}`],
  ["GET", "/api/search/cabinets"],
  ["GET", "/api/search/clients"],
  ["GET", `/api/search/clients/${G}`],
  ["GET", "/api/search/recent"],
  ["GET", "/api/actions/catalog"],
  ["GET", "/api/actions"],
  ["GET", "/api/actions/pending-approval"],
  ["GET", `/api/actions/${G}`],
  ["POST", "/api/actions"],
  ["GET", "/api/event-log-views"],
  ["GET", "/api/connectivity-alerts"],
  ["GET", `/api/connectivity-alerts/site/${G}/summary`],
  ["POST", `/api/connectivity-alerts/${G}/acknowledge`],
  ["POST", `/api/connectivity-alerts/${G}/resolve`],
  ["GET", "/api/audit"],
  ["GET", "/api/registrations/pending", { supervisor: true }],
  ["POST", `/api/registrations/${G}/approve`, { supervisor: true }],
  ["POST", `/api/registrations/${G}/reject`, { supervisor: true }],
  ["GET", "/api/users", { supervisor: true }],
  ["POST", "/api/users", { supervisor: true }],
  ["PATCH", `/api/users/${G}`, { supervisor: true }],
  ["POST", `/api/users/${G}/revoke-sessions`, { supervisor: true }],
  ["PATCH", `/api/cabinets/${G}/name`, { supervisor: true }],
  ["PUT", `/api/cabinets/${G}/role`, { supervisor: true }],
  ["POST", `/api/cabinets/${G}/retire`, { supervisor: true }],
].map(([method, pattern, flags = {}]) => ({ method, regex: new RegExp(`^${pattern}$`), ...flags }));

export function matchRoute(method, path) {
  return ROUTES.find(r => r.method === method && r.regex.test(path)) ?? null;
}

const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

function loadStatic(dir) {
  // Read once at startup into an exact name map, so no request path ever
  // touches the filesystem and traversal is impossible by construction.
  const files = new Map();
  for (const name of readdirSync(dir)) {
    const type = CONTENT_TYPES[extname(name)];
    if (!type || !/^[a-z0-9-]+\.[a-z]+$/.test(name)) continue;
    files.set(`/${name}`, { body: readFileSync(join(dir, name)), type });
  }
  if (!files.has("/index.html")) throw Error("Console static files are missing index.html");
  files.set("/", files.get("/index.html"));
  return files;
}

export function validateUpstream(value) {
  let url;
  try { url = new URL(value); } catch { throw Error("CONSOLE_UPSTREAM must be an absolute URL"); }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    throw Error("CONSOLE_UPSTREAM must be a bare origin such as https://server.example");
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
  throw Error("CONSOLE_UPSTREAM must use HTTPS unless the Server is on this machine's loopback interface");
}

export function validatePublicOrigin(value) {
  const url = new URL(value);
  if (url.origin !== value.replace(/\/$/, "")) throw Error("CONSOLE_PUBLIC_ORIGIN must be a bare origin");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)))
    throw Error("CONSOLE_PUBLIC_ORIGIN must be HTTPS unless it is a loopback address");
  return url.origin;
}

const digest = key => createHash("sha256").update(key).digest("hex");
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const token = () => randomBytes(32).toString("base64url");

export class SessionStore {
  constructor(clock = () => Date.now()) { this.clock = clock; this.items = new Map(); }
  sweep() {
    const now = this.clock();
    for (const [k, s] of this.items) if (this.expired(s, now)) this.items.delete(k);
  }
  expired(s, now) { return now >= s.absoluteExpires || now - s.lastSeen >= LIMITS.sessionIdleMs || now >= s.refreshExpires; }
  create(data) {
    this.sweep();
    if (this.items.size >= LIMITS.maxSessions) return null;
    const key = token(), now = this.clock();
    this.items.set(digest(key), { ...data, csrf: token(), created: now, lastSeen: now, absoluteExpires: now + LIMITS.sessionAbsoluteMs });
    return key;
  }
  get(key) {
    if (typeof key !== "string" || key.length !== 43) return null;
    const id = digest(key), s = this.items.get(id), now = this.clock();
    if (!s) return null;
    if (this.expired(s, now)) { this.items.delete(id); return null; }
    s.lastSeen = now;
    return s;
  }
  remove(key) { if (typeof key === "string") this.items.delete(digest(key)); }
}

class RateLimiter {
  constructor(limit, windowMs, clock) { Object.assign(this, { limit, windowMs, clock, hits: new Map() }); }
  allow(key) {
    const now = this.clock(), entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(key, { start: now, count: 1 });
      return true;
    }
    return ++entry.count <= this.limit;
  }
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function readBody(req) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > LIMITS.requestBodyBytes) throw Object.assign(Error("Request too large"), { status: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMITS.requestBodyBytes) throw Object.assign(Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(Error("Invalid JSON"), { status: 400 }); }
}

async function readBounded(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.upstreamBodyBytes) throw Error("Upstream response too large");
      chunks.push(value);
    }
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  return Buffer.concat(chunks).toString("utf8");
}

const clip = (v, n = 500) => typeof v === "string" ? v.slice(0, n) : undefined;

// Forward only the human-readable parts of an upstream error.
function problemFrom(status, text) {
  let p = {};
  try { p = JSON.parse(text); } catch { /* not JSON */ }
  const out = { status, title: clip(p.title) ?? http.STATUS_CODES[status] ?? "Error", detail: clip(p.detail, 1000) };
  if (p.errors && typeof p.errors === "object" && !Array.isArray(p.errors)) {
    out.errors = {};
    for (const [k, v] of Object.entries(p.errors).slice(0, 20))
      out.errors[clip(k, 100)] = (Array.isArray(v) ? v : [v]).slice(0, 5).map(x => clip(String(x)));
  }
  return out;
}

export function createConsoleServer({
  upstream,
  publicOrigin,
  extraHosts = [],
  fetchImpl = globalThis.fetch,
  clock = () => Date.now(),
  staticDir = join(here, "public"),
  tls = null,
  demoEnabled = true,
  agentServerUrl = null,
  log = () => {},
} = {}) {
  // The HTTPS address Windows Agents use to reach the Server. Not a secret;
  // shown to administrators in Settings to make agent installs copy-paste.
  if (agentServerUrl !== null && !/^https:\/\/[^/?#@\s]+\/?$/.test(agentServerUrl))
    throw Error("CONSOLE_AGENT_SERVER_URL must be a bare https:// origin");
  const api = validateUpstream(upstream);
  const origin = validatePublicOrigin(publicOrigin);
  const secure = origin.startsWith("https:");
  const canonicalHost = new URL(origin).host.toLowerCase();
  const aliasHosts = new Set(extraHosts.map(h => h.toLowerCase()));
  const cookieName = secure ? "__Host-cabinet-console" : "cabinet-console";
  const files = loadStatic(staticDir);
  const sessions = new SessionStore(clock);
  const loginLimiter = new RateLimiter(LIMITS.loginAttemptsPerWindow, LIMITS.loginWindowMs, clock);

  const setCookie = (res, value, clear = false) => res.setHeader("Set-Cookie",
    `${cookieName}=${clear ? "" : value}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}${clear ? "; Max-Age=0" : ""}`);

  function headers(res) {
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    res.setHeader("Cache-Control", "no-store");
    if (secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }

  const send = (res, status, body) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

  async function upstreamCall(method, path, { bearer, body, query } = {}) {
    const url = new URL(path, api);
    if (query) for (const [k, v] of query) url.searchParams.append(k, v);
    const init = { method, redirect: "manual", signal: AbortSignal.timeout(LIMITS.upstreamTimeoutMs), headers: { Accept: "application/json" } };
    if (bearer) init.headers.Authorization = `Bearer ${bearer}`;
    if (body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
    const response = await fetchImpl(url, init);
    return { status: response.status, text: await readBounded(response) };
  }

  function sessionFromLogin(data, username) {
    const accessExpires = Date.parse(data?.expiresAtUtc), refreshExpires = Date.parse(data?.refreshTokenExpiresAtUtc);
    if (typeof data?.accessToken !== "string" || !data.accessToken || !Number.isFinite(accessExpires) ||
        !["Tier1", "Tier2", "Supervisor"].includes(data.role)) return null;
    return {
      accessToken: data.accessToken, accessExpires,
      refreshToken: typeof data.refreshToken === "string" ? data.refreshToken : null,
      refreshExpires: Number.isFinite(refreshExpires) ? refreshExpires : accessExpires,
      user: { id: String(data.userId), username, displayName: String(data.displayName ?? username).slice(0, 200), role: data.role, mustChangePassword: data.mustChangePassword === true },
    };
  }

  const publicSession = s => ({
    user: s.user, csrfToken: s.csrf, mode: s.mode ?? "live", demoAvailable: demoEnabled,
    agentServerUrl: s.user.role === "Supervisor" ? agentServerUrl : null,
    expiresAt: new Date(Math.min(s.absoluteExpires, s.refreshExpires)).toISOString(),
  });

  async function ensureFresh(s) {
    if (s.accessExpires - clock() > LIMITS.refreshBeforeExpiryMs) return true;
    if (!s.refreshToken) return clock() < s.accessExpires;
    s.refreshing ??= (async () => {
      try {
        const r = await upstreamCall("POST", "/api/auth/refresh", { body: { refreshToken: s.refreshToken } });
        if (r.status !== 200) return false;
        const fresh = sessionFromLogin(JSON.parse(r.text), s.user.username);
        if (!fresh || fresh.user.id !== s.user.id) return false;
        Object.assign(s, { accessToken: fresh.accessToken, accessExpires: fresh.accessExpires, refreshToken: fresh.refreshToken, refreshExpires: fresh.refreshExpires });
        s.user.role = fresh.user.role;
        s.user.mustChangePassword = fresh.user.mustChangePassword;
        return true;
      } catch { return false; } finally { s.refreshing = null; }
    })();
    return s.refreshing;
  }

  // Origin is mandatory on every state change. Browsers always send it on
  // POST/PUT/PATCH/DELETE; its absence means a non-browser or a stripped header.
  const sameOrigin = req => req.headers.origin === origin &&
    (req.headers["sec-fetch-site"] === undefined || req.headers["sec-fetch-site"] === "same-origin");
  const isJson = req => /^application\/json(\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "");

  async function login(req, res) {
    const ip = req.socket.remoteAddress ?? "unknown";
    if (!loginLimiter.allow(ip)) return send(res, 429, { title: "Too many sign-in attempts. Wait a minute and try again." });
    const body = await readBody(req);
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (username.length < 1 || username.length > 64 || password.length < 1 || password.length > 256)
      return send(res, 400, { title: "Enter a username and password." });
    const r = await upstreamCall("POST", "/api/auth/login", { body: { username, password } });
    if (r.status === 429) return send(res, 429, { title: "Too many sign-in attempts. Wait a minute and try again." });
    if (r.status !== 200) return send(res, 401, { title: "Sign-in failed. Check your username and password, or ask an administrator to unlock the account." });
    const data = sessionFromLogin(JSON.parse(r.text), username);
    if (!data) return send(res, 502, { title: "The support server returned an unexpected sign-in response." });
    const old = parseCookies(req.headers.cookie)[cookieName];
    if (old) sessions.remove(old);
    const key = sessions.create(data);
    if (!key) return send(res, 503, { title: "The Console is at its session limit. Try again shortly." });
    setCookie(res, key);
    log(`login ${username} role=${data.user.role}`);
    return send(res, 200, publicSession(sessions.get(key)));
  }

  async function changePassword(req, res, s, key) {
    const body = await readBody(req);
    const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
    if (!currentPassword || !newPassword || newPassword.length > 256) return send(res, 400, { title: "Enter your current and new password." });
    if (!(await ensureFresh(s))) { sessions.remove(key); setCookie(res, "", true); return send(res, 401, { title: "Your session has ended. Sign in again." }); }
    const r = await upstreamCall("POST", "/api/auth/change-password", { bearer: s.accessToken, body: { currentPassword, newPassword } });
    if (r.status !== 204 && r.status !== 200) return send(res, r.status === 401 ? 401 : 400, problemFrom(r.status, r.text));
    // The Server rotates the account's security stamp, which ends this token.
    // Sign in again with the new password and rotate the Console session too.
    sessions.remove(key);
    const again = await upstreamCall("POST", "/api/auth/login", { body: { username: s.user.username, password: newPassword } });
    const data = again.status === 200 ? sessionFromLogin(JSON.parse(again.text), s.user.username) : null;
    if (!data) { setCookie(res, "", true); return send(res, 401, { title: "Password changed. Sign in with your new password." }); }
    const next = sessions.create(data);
    setCookie(res, next);
    return send(res, 200, publicSession(sessions.get(next)));
  }

  async function proxy(req, res, url, s, key) {
    const route = matchRoute(req.method, url.pathname);
    if (!route) return send(res, 404, { title: "Not found" });
    if (s.user.mustChangePassword && url.pathname !== "/api/auth/me") return send(res, 403, { title: "Change your password to continue." });
    if (route.supervisor && s.user.role !== "Supervisor") return send(res, 403, { title: "Administrator access is required." });
    const query = [...url.searchParams];
    if (query.length > LIMITS.queryParams || query.some(([k, v]) => !/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(k) || v.length > LIMITS.queryValueLength))
      return send(res, 400, { title: "Invalid query." });
    const body = req.method === "GET" ? undefined : (await readBody(req)) ?? {};
    if (s.mode === "demo") {
      // Demo data never touches the Server. Same route allowlist and role
      // checks as live mode have already run above.
      const [status, data] = s.sandbox.handle(req.method, url.pathname, url.searchParams, body);
      return send(res, status === 204 ? 200 : status, data ?? {});
    }
    if (!(await ensureFresh(s))) { sessions.remove(key); setCookie(res, "", true); return send(res, 401, { title: "Your session has ended. Sign in again." }); }
    const r = await upstreamCall(req.method, url.pathname, { bearer: s.accessToken, body, query });
    if (r.status === 401) { sessions.remove(key); setCookie(res, "", true); return send(res, 401, { title: "Your session has ended. Sign in again." }); }
    if (r.status >= 200 && r.status < 300) {
      if (!r.text) return send(res, r.status === 204 ? 200 : r.status, {});
      try { return send(res, r.status, JSON.parse(r.text)); } catch { return send(res, 502, { title: "Unexpected response from the support server." }); }
    }
    if (r.status >= 300 && r.status < 400) return send(res, 502, { title: "Unexpected response from the support server." });
    return send(res, r.status, problemFrom(r.status, r.text));
  }

  async function handle(req, res) {
    headers(res);
    const host = String(req.headers.host ?? "").toLowerCase();
    if (host !== canonicalHost) {
      // Aliases (e.g. localhost for 127.0.0.1) only redirect to the canonical
      // origin, so cookies and the Origin check always see one exact origin.
      if (aliasHosts.has(host) && req.method === "GET") {
        res.statusCode = 302;
        res.setHeader("Location", origin + "/");
        return res.end();
      }
      return send(res, 421, { title: "Unknown host" });
    }
    let url;
    try { url = new URL(req.url, origin); } catch { return send(res, 400, { title: "Bad request" }); }
    if (url.pathname.includes("..") || url.pathname.includes("//")) return send(res, 400, { title: "Bad request" });

    if (req.method === "GET" || req.method === "HEAD") {
      const file = files.get(url.pathname);
      if (file) {
        res.statusCode = 200;
        res.setHeader("Content-Type", file.type);
        return res.end(req.method === "HEAD" ? undefined : file.body);
      }
    }
    if (url.pathname === "/healthz" && req.method === "GET") return send(res, 200, { status: "ok" });
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/auth/")) return send(res, 404, { title: "Not found" });

    const mutating = !["GET", "HEAD"].includes(req.method);
    if (mutating && (!sameOrigin(req) || !isJson(req))) return send(res, 403, { title: "Request refused." });

    if (url.pathname === "/auth/login" && req.method === "POST") return login(req, res);

    const key = parseCookies(req.headers.cookie)[cookieName];
    const s = key ? sessions.get(key) : null;

    if (url.pathname === "/auth/session" && req.method === "GET")
      return s ? send(res, 200, publicSession(s)) : send(res, 401, { title: "Not signed in." });

    if (!s) {
      if (key) setCookie(res, "", true);
      return send(res, 401, { title: "Your session has ended. Sign in again." });
    }
    if (mutating && !safeEqual(req.headers["x-csrf-token"] ?? "", s.csrf)) return send(res, 403, { title: "Request refused." });

    if (url.pathname === "/auth/logout" && req.method === "POST") {
      sessions.remove(key);
      setCookie(res, "", true);
      return send(res, 200, {});
    }
    if (url.pathname === "/auth/change-password" && req.method === "POST") return changePassword(req, res, s, key);
    if (url.pathname === "/auth/mode" && req.method === "POST") {
      const body = await readBody(req);
      const mode = body?.mode;
      if (mode !== "live" && mode !== "demo") return send(res, 400, { title: "Mode must be live or demo." });
      if (mode === "demo" && !demoEnabled) return send(res, 403, { title: "Demo mode is disabled on this Console." });
      if (s.user.mustChangePassword) return send(res, 403, { title: "Change your password to continue." });
      if (mode === "demo") s.sandbox ??= createDemoSandbox({ user: s.user, clock });
      s.mode = mode;
      log(`mode ${s.user.username} -> ${mode}`);
      return send(res, 200, publicSession(s));
    }
    if (url.pathname.startsWith("/api/")) return proxy(req, res, url, s, key);
    return send(res, 404, { title: "Not found" });
  }

  const listener = (req, res) => handle(req, res).catch(error => {
    if (res.headersSent) return res.destroy();
    const status = error?.status ?? (error?.name === "TimeoutError" ? 504 : 502);
    log(`error ${req.method} ${req.url?.split("?")[0]}: ${error?.message}`);
    send(res, status, { title: status === 504 ? "The support server did not respond in time." : status >= 500 ? "The support server is unavailable." : error.message });
  });
  const server = tls ? https.createServer({ ...tls, minVersion: "TLSv1.2" }, listener) : http.createServer(listener);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return { server, sessions, origin };
}

// --- CLI -------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = process.env;
  const host = env.CONSOLE_HOST ?? "127.0.0.1";
  const port = Number(env.CONSOLE_PORT ?? 4180);
  const tls = env.CONSOLE_TLS_CERT && env.CONSOLE_TLS_KEY
    ? { cert: readFileSync(env.CONSOLE_TLS_CERT), key: readFileSync(env.CONSOLE_TLS_KEY) } : null;
  if (!LOOPBACK_HOSTS.has(host) && !tls) {
    console.error("Refusing to listen on a non-loopback address without TLS. Set CONSOLE_TLS_CERT and CONSOLE_TLS_KEY, or bind to 127.0.0.1 behind an HTTPS reverse proxy.");
    process.exit(1);
  }
  const publicOrigin = env.CONSOLE_PUBLIC_ORIGIN ?? `${tls ? "https" : "http"}://${host === "::1" ? "[::1]" : host}:${port}`;
  if (!env.CONSOLE_UPSTREAM) { console.error("Set CONSOLE_UPSTREAM to the Cabinet Server origin."); process.exit(1); }
  const extraHosts = publicOrigin.startsWith("http://127.0.0.1:") ? [`localhost:${port}`] : [];
  const demoEnabled = (env.CONSOLE_DEMO ?? "enabled").toLowerCase() !== "disabled";
  const { server, origin } = createConsoleServer({
    upstream: env.CONSOLE_UPSTREAM, publicOrigin, extraHosts, tls, demoEnabled,
    agentServerUrl: env.CONSOLE_AGENT_SERVER_URL || null,
    log: line => console.log(`[console] ${new Date().toISOString()} ${line}`),
  });
  server.listen(port, host, () => console.log(`[console] Cabinet Support Console on ${origin} -> ${env.CONSOLE_UPSTREAM}`));
}
