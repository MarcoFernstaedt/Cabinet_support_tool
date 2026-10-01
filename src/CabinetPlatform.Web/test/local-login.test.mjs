import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewServer } from "../server.mjs";

async function fixture() {
  const calls = [];
  let active = true;
  const upstreamFetch = async (url, options) => {
    calls.push({ url: String(url), ...options });
    if (String(url).endsWith("/api/auth/login")) {
      const body = JSON.parse(options.body);
      if (body.username !== "tester" || body.password !== "test-only-password") return new Response("", { status: 403 });
      return Response.json({ accessToken: "private-token", expiresAtUtc: new Date(Date.now() + 60000).toISOString(), mustChangePassword: false });
    }
    if (String(url).endsWith("/api/auth/me")) return active
      ? Response.json({ displayName: "Test Operator", role: "Tier2", isActive: true, mustChangePassword: false })
      : new Response("", { status: 401 });
    throw Error("Unexpected upstream request");
  };
  const server = createPreviewServer("127.0.0.1", { enabled: true, upstreamUrl: "https://127.0.0.1:8443/", upstreamFetch });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => fetch(`${origin}${path}`, { redirect: "manual", ...options });
  return { server, origin, request, calls, revoke: () => { active = false; }, close: () => new Promise(resolve => server.close(resolve)) };
}

test("login is explicitly local-only and requires HTTPS upstream", () => {
  assert.throws(() => createPreviewServer("0.0.0.0", { enabled: true, upstreamUrl: "https://example.test/" }), /loopback/);
  assert.throws(() => createPreviewServer("127.0.0.1", { enabled: true, upstreamUrl: "https://example.test/" }), /loopback upstream/);
  assert.throws(() => createPreviewServer("127.0.0.1", { enabled: true, upstreamUrl: "http://example.test/" }), /HTTPS/);
  assert.throws(() => createPreviewServer("127.0.0.1", { upstreamUrl: "https://example.test/" }), /opt-in/);
});

test("unauthenticated preview is gated, credentials stay on server, and revocation closes session", async () => {
  const f = await fixture();
  try {
    const blocked = await f.request("/");
    assert.equal(blocked.status, 303);
    assert.equal(blocked.headers.get("location"), "/signin");
    assert.equal((await f.request("/bootstrap.mjs")).status, 303);
    assert.equal((await f.request("/signin")).status, 200);
    const login = await f.request("/signin", { method: "POST", headers: { origin: f.origin, "content-type": "application/x-www-form-urlencoded" }, body: "username=tester&password=test-only-password" });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /private-token|test-only-password/);
    const home = await f.request("/", { headers: { cookie } });
    assert.equal(home.status, 200);
    assert.match(await home.text(), /SYNTHETIC DATA PREVIEW/);
    assert.equal((await f.request("/app.mjs", { headers: { cookie } })).status, 200);
    assert.ok(f.calls.some(x => x.url.endsWith("/api/auth/me") && x.headers.Authorization === "Bearer private-token"));
    f.revoke();
    assert.equal((await f.request("/", { headers: { cookie } })).status, 303);
  } finally { await f.close(); }
});

test("expired abandoned sessions release local capacity for a new sign-in", async () => {
  const f = await fixture();
  const now = Date.now;
  try {
    const options = { method: "POST", headers: { origin: f.origin, "content-type": "application/x-www-form-urlencoded" }, body: "username=tester&password=test-only-password" };
    for (let i = 0; i < 100; i++) assert.equal((await f.request("/signin", options)).status, 303);
    Date.now = () => now() + 120000;
    assert.equal((await f.request("/signin", options)).status, 303);
  } finally { Date.now = now; await f.close(); }
});

test("login refuses cross-origin requests, failure leaks no token, and logout needs CSRF", async () => {
  const f = await fixture();
  try {
    const body = "username=tester&password=test-only-password";
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    assert.equal((await f.request("/signin", { method: "POST", headers: { ...headers, origin: "https://evil.test" }, body })).status, 403);
    assert.equal((await f.request("/signin", { method: "POST", headers, body })).status, 403);
    assert.equal(f.calls.length, 0);
    const denied = await f.request("/signin", { method: "POST", headers: { ...headers, origin: f.origin }, body: "username=tester&password=wrong" });
    assert.equal(denied.status, 403);
    assert.doesNotMatch(await denied.text(), /private-token|wrong/);
    const login = await f.request("/signin", { method: "POST", headers: { ...headers, origin: f.origin }, body });
    const cookie = login.headers.get("set-cookie");
    assert.equal((await f.request("/signout", { method: "POST", headers: { origin: f.origin, cookie, ...headers }, body: "csrf=invalid" })).status, 403);
    const home = await (await f.request("/", { headers: { cookie } })).text();
    const csrf = home.match(/name="csrf" value="([^"]+)"/)?.[1];
    assert.ok(csrf);
    assert.equal((await f.request("/signout", { method: "POST", headers: { origin: f.origin, cookie, ...headers }, body: `csrf=${csrf}` })).status, 303);
    assert.equal((await f.request("/", { headers: { cookie } })).status, 303);
  } finally { await f.close(); }
});
