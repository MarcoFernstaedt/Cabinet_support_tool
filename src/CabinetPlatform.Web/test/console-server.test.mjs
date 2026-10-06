import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createConsoleServer, matchRoute, validateUpstream, validatePublicOrigin } from "../console/console-server.mjs";

const UPSTREAM = "https://server.example";
const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const freePort = () => new Promise(resolve => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function loginBody(overrides = {}) {
  return {
    accessToken: "access-1", expiresAtUtc: new Date(Date.now() + 3600_000).toISOString(),
    refreshToken: "refresh-1", refreshTokenExpiresAtUtc: new Date(Date.now() + 8 * 3600_000).toISOString(),
    userId: ID, displayName: "Ada Admin", role: "Supervisor", hasElevatedSql: false, mustChangePassword: false, ...overrides,
  };
}

// A fake Cabinet Server that records every request it receives.
function fakeUpstream(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url: new URL(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const [status, body] = await handler(call);
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

async function start(handler, options = {}) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const upstream = fakeUpstream(handler);
  const { server, sessions } = createConsoleServer({ upstream: UPSTREAM, publicOrigin: origin, extraHosts: [`localhost:${port}`], fetchImpl: upstream.fetchImpl, ...options });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const jar = {};
  const req = async (method, path, { body, headers = {}, cookie = true } = {}) => {
    const h = { ...headers };
    if (cookie && jar.cookie) h.cookie = jar.cookie;
    if (body !== undefined) { h["content-type"] ??= "application/json"; h.origin ??= origin; }
    const res = await fetch(origin + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) jar.cookie = setCookie.split(";")[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, text, json, setCookie };
  };
  const login = async (overrides) => {
    const r = await req("POST", "/auth/login", { body: { username: "ada", password: "pw" } });
    jar.csrf = r.json?.csrfToken;
    return r;
  };
  return { origin, server, sessions, calls: upstream.calls, req, login, jar, close: () => new Promise(r => server.close(r)) };
}

const okLogin = role => call => call.url.pathname === "/api/auth/login" ? [200, loginBody(role ? { role } : {})] : [200, { ok: true, path: call.url.pathname }];

test("static shell is served with a strict security header set", async t => {
  const s = await start(okLogin());
  t.after(s.close);
  const r = await s.req("GET", "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  const csp = r.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal((await s.req("GET", "/console.js")).status, 200);
  assert.equal((await s.req("GET", "/package.json")).status, 404);
  assert.equal((await s.req("GET", "/..%2fconsole-server.mjs")).status, 400);
  assert.equal((await s.req("GET", "/console-server.mjs")).status, 404);
  assert.equal(s.calls.length, 0);
});

test("unknown Host headers are refused and loopback aliases only redirect", async t => {
  const s = await start(okLogin());
  t.after(s.close);
  const port = new URL(s.origin).port;
  const bad = await new Promise(resolve => {
    const r = net.connect(port, "127.0.0.1", () => r.write("GET / HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n"));
    let data = ""; r.on("data", d => (data += d)); r.on("end", () => resolve(data));
  });
  assert.match(bad, /^HTTP\/1\.1 421/);
  const alias = await new Promise(resolve => {
    const r = net.connect(port, "127.0.0.1", () => r.write(`POST /auth/login HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`));
    let data = ""; r.on("data", d => (data += d)); r.on("end", () => resolve(data));
  });
  assert.match(alias, /^HTTP\/1\.1 421/, "aliases never accept state changes");
});

test("login sets an opaque HttpOnly SameSite=Strict cookie and never exposes the bearer", async t => {
  const s = await start(okLogin());
  t.after(s.close);
  const r = await s.login();
  assert.equal(r.status, 200);
  assert.match(r.setCookie, /^cabinet-console=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.doesNotMatch(r.text, /access-1|refresh-1/);
  assert.equal(r.json.user.role, "Supervisor");
  assert.equal(typeof r.json.csrfToken, "string");
  assert.deepEqual(s.calls[0].body, { username: "ada", password: "pw" });
});

test("state changes require the exact Origin and a JSON body", async t => {
  const s = await start(okLogin());
  t.after(s.close);
  assert.equal((await s.req("POST", "/auth/login", { body: { username: "a", password: "b" }, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await s.req("POST", "/auth/login", { body: "username=a&password=b", headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 403);
  const noOrigin = await fetch(`${s.origin}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(noOrigin.status, 403);
  assert.equal(s.calls.length, 0);
});

test("failed sign-in returns a generic message without upstream detail", async t => {
  const s = await start(() => [403, { title: "Forbidden", detail: "Account locked until 10:42; 5 failed attempts" }]);
  t.after(s.close);
  const r = await s.req("POST", "/auth/login", { body: { username: "ada", password: "nope" } });
  assert.equal(r.status, 401);
  assert.doesNotMatch(r.text, /locked until|attempts/);
  assert.equal(r.setCookie, null);
});

test("API calls need a session, and mutations need the CSRF token", async t => {
  const s = await start(okLogin());
  t.after(s.close);
  assert.equal((await s.req("GET", "/api/fleet/health")).status, 401);
  await s.login();
  const read = await s.req("GET", "/api/fleet/health?staleAfterHours=24");
  assert.equal(read.status, 200);
  const last = s.calls.at(-1);
  assert.equal(last.headers.Authorization, "Bearer access-1");
  assert.equal(last.url.search, "?staleAfterHours=24");
  assert.equal(last.headers.cookie, undefined);

  const before = s.calls.length;
  assert.equal((await s.req("POST", "/api/users", { body: {} })).status, 403, "missing CSRF");
  assert.equal((await s.req("POST", "/api/users", { body: {}, headers: { "x-csrf-token": "wrong" } })).status, 403, "wrong CSRF");
  assert.equal(s.calls.length, before);
  const ok = await s.req("POST", "/api/users", { body: { username: "sam" }, headers: { "x-csrf-token": s.jar.csrf } });
  assert.equal(ok.status, 200);
  assert.deepEqual(s.calls.at(-1).body, { username: "sam" });
});

test("only allowlisted Server routes are reachable", async t => {
  const s = await start(okLogin());
  t.after(s.close);
  await s.login();
  const before = s.calls.length;
  for (const [method, path] of [
    ["GET", `/api/users/${ID}/elevated-sql`], ["POST", `/api/users/${ID}/hardware-actuation`], ["POST", "/api/agent/register"],
    ["GET", "/api/cabinets/not-a-guid"], ["POST", "/api/batches"], ["DELETE", `/api/users/${ID}/cabinet-read-grants/${ID}`], ["GET", "/swagger/index.html"],
  ]) {
    const r = await s.req(method, path, method === "GET" ? {} : { body: {}, headers: { "x-csrf-token": s.jar.csrf } });
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  assert.equal(s.calls.length, before);
  assert.ok(matchRoute("GET", `/api/cabinets/${ID}/heartbeats`));
  assert.equal(matchRoute("DELETE", `/api/cabinets/${ID}`), null);
});

test("administrator routes are refused for support tiers before reaching the Server", async t => {
  const s = await start(okLogin("Tier1"));
  t.after(s.close);
  await s.login();
  const before = s.calls.length;
  assert.equal((await s.req("GET", "/api/users")).status, 403);
  assert.equal((await s.req("GET", "/api/registrations/pending")).status, 403);
  assert.equal((await s.req("POST", `/api/registrations/${ID}/approve`, { body: {}, headers: { "x-csrf-token": s.jar.csrf } })).status, 403);
  assert.equal(s.calls.length, before);
  assert.equal((await s.req("GET", "/api/cabinets")).status, 200, "support views stay available");
});

test("administrators reach every support route too", async t => {
  const s = await start(okLogin("Supervisor"));
  t.after(s.close);
  await s.login();
  for (const path of ["/api/cabinets", `/api/cabinets/${ID}`, "/api/fleet/health", "/api/audit", "/api/connectivity-alerts", "/api/actions", "/api/users", "/api/registrations/pending"])
    assert.equal((await s.req("GET", path)).status, 200, path);
});

test("a must-change-password session can only change its password", async t => {
  let call = 0;
  const s = await start(c => {
    if (c.url.pathname === "/api/auth/login") return [200, loginBody({ mustChangePassword: ++call === 1, accessToken: `access-${call}` })];
    if (c.url.pathname === "/api/auth/change-password") return [204];
    return [200, {}];
  });
  t.after(s.close);
  const first = await s.login();
  const firstCookie = s.jar.cookie;
  assert.equal(first.json.user.mustChangePassword, true);
  assert.equal((await s.req("GET", "/api/cabinets")).status, 403);
  const changed = await s.req("POST", "/auth/change-password", { body: { currentPassword: "old", newPassword: "new-Pass-1234!" }, headers: { "x-csrf-token": s.jar.csrf } });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.user.mustChangePassword, false);
  assert.notEqual(s.jar.cookie, firstCookie, "session id rotates after a password change");
  assert.deepEqual(s.calls.at(-1).body, { username: "ada", password: "new-Pass-1234!" });
  assert.equal((await s.req("GET", "/auth/session", { cookie: false, headers: { cookie: firstCookie } })).status, 401, "old session is gone");
  assert.equal((await s.req("GET", "/api/cabinets")).status, 200);
});

test("an upstream 401 ends the Console session", async t => {
  const s = await start(c => c.url.pathname === "/api/auth/login" ? [200, loginBody()] : [401, {}]);
  t.after(s.close);
  await s.login();
  assert.equal((await s.req("GET", "/api/cabinets")).status, 401);
  assert.equal((await s.req("GET", "/auth/session")).status, 401);
});

test("upstream errors forward only bounded human-readable fields", async t => {
  const s = await start(c => c.url.pathname === "/api/auth/login" ? [200, loginBody()]
    : [400, { title: "Bad", detail: "Password does not meet policy", traceId: "secret-trace", stack: "at Foo()", errors: { Username: ["Required"] } }]);
  t.after(s.close);
  await s.login();
  const r = await s.req("POST", "/api/users", { body: {}, headers: { "x-csrf-token": s.jar.csrf } });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { status: 400, title: "Bad", detail: "Password does not meet policy", errors: { Username: ["Required"] } });
});

test("query strings and bodies are bounded", async t => {
  const s = await start(okLogin());
  t.after(s.close);
  await s.login();
  assert.equal((await s.req("GET", `/api/cabinets?search=${"x".repeat(300)}`)).status, 400);
  assert.equal((await s.req("GET", "/api/cabinets?bad-key=1")).status, 400);
  const big = await s.req("POST", "/api/users", { body: { blob: "x".repeat(70 * 1024) }, headers: { "x-csrf-token": s.jar.csrf } });
  assert.equal(big.status, 413);
  const notJson = await s.req("POST", "/api/users", { body: "{nope", headers: { "x-csrf-token": s.jar.csrf } });
  assert.equal(notJson.status, 400);
});

test("access tokens are refreshed server-side before they expire", async t => {
  const s = await start(c => {
    if (c.url.pathname === "/api/auth/login") return [200, loginBody({ expiresAtUtc: new Date(Date.now() + 30_000).toISOString() })];
    if (c.url.pathname === "/api/auth/refresh") return [200, loginBody({ accessToken: "access-2", refreshToken: "refresh-2" })];
    return [200, {}];
  });
  t.after(s.close);
  await s.login();
  await s.req("GET", "/api/cabinets");
  const refresh = s.calls.find(c => c.url.pathname === "/api/auth/refresh");
  assert.deepEqual(refresh.body, { refreshToken: "refresh-1" });
  assert.equal(s.calls.at(-1).headers.Authorization, "Bearer access-2");
});

test("logout removes the session", async t => {
  const s = await start(okLogin());
  t.after(s.close);
  await s.login();
  const cookie = s.jar.cookie;
  assert.equal((await s.req("POST", "/auth/logout", { body: {}, headers: { "x-csrf-token": s.jar.csrf } })).status, 200);
  assert.equal((await s.req("GET", "/api/cabinets", { cookie: false, headers: { cookie } })).status, 401);
});

test("sign-in attempts are rate limited per client", async t => {
  const s = await start(() => [403, {}]);
  t.after(s.close);
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await s.req("POST", "/auth/login", { body: { username: "a", password: "b" } })).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.equal(statuses.at(-1), 429);
});

test("configuration refuses plaintext to remote hosts", () => {
  assert.equal(validateUpstream("https://api.example.com"), "https://api.example.com");
  assert.equal(validateUpstream("http://127.0.0.1:5009"), "http://127.0.0.1:5009");
  assert.throws(() => validateUpstream("http://api.example.com"));
  assert.throws(() => validateUpstream("https://user:pw@api.example.com"));
  assert.throws(() => validateUpstream("https://api.example.com/base"));
  assert.throws(() => validatePublicOrigin("http://console.example.com"));
  assert.equal(validatePublicOrigin("https://console.example.com"), "https://console.example.com");
});

test("HTTPS origins use a __Host- Secure cookie and HSTS", async t => {
  const port = await freePort();
  const upstream = fakeUpstream(okLogin());
  const { server } = createConsoleServer({ upstream: UPSTREAM, publicOrigin: "https://console.example", fetchImpl: upstream.fetchImpl });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  t.after(() => new Promise(r => server.close(r)));
  const raw = await new Promise(resolve => {
    const body = JSON.stringify({ username: "ada", password: "pw" });
    const r = net.connect(port, "127.0.0.1", () => r.write(`POST /auth/login HTTP/1.1\r\nHost: console.example\r\nOrigin: https://console.example\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`));
    let data = ""; r.on("data", d => (data += d)); r.on("end", () => resolve(data));
  });
  assert.match(raw, /Set-Cookie: __Host-cabinet-console=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure/i);
  assert.match(raw, /Strict-Transport-Security: max-age=31536000/i);
});
