import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewServer } from "../server.mjs";

const cabinet = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const action = "33333333-3333-4333-8333-333333333333";
const view = "44444444-4444-4444-8444-444444444444";
const base = {
  cabinetId: cabinet, actionId: action, state: "partial", viewId: view,
  viewDisplayName: "System & App", requestedAtUtc: "2026-09-01T00:00:00Z",
  completedAtUtc: "2026-09-01T00:01:00Z", requestedChannels: ["System", "Application"],
  requestedProviders: ["Service Control Manager"], truncated: false,
  channelReads: [
    { channelName: "System", outcome: "readable", recordsRead: 1, truncated: false },
    { channelName: "Application", outcome: "accessDenied", recordsRead: 0, truncated: false },
  ],
  entries: [{ channel: "System", provider: "<svg/onload=alert(1)>", level: "Error", eventId: 7,
    occurredAt: "2026-09-01T00:00:30Z", message: "A & B <script>alert(1)</script>" }],
};
async function fixture(result = base, status = 200) {
  let active = true;
  const calls = [];
  const upstreamFetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, options });
    if (path === "/api/auth/login") return Response.json({ accessToken: "server-only-token", expiresAtUtc: new Date(Date.now() + 60000).toISOString() });
    if (path === "/api/auth/me") return active ? Response.json({ displayName: "Operator", role: "Tier2", isActive: true }) : new Response("", { status: 401 });
    if (path === `/api/cabinets/${cabinet}/event-log-results/latest`) return status === 200 ? Response.json(result) : new Response("", { status });
    if (path.startsWith("/api/cabinets/") && path.endsWith("/event-log-results/latest")) return new Response("", { status: 404 });
    throw Error(`Unexpected upstream ${path}`);
  };
  const server = createPreviewServer("127.0.0.1", { enabled: true, upstreamUrl: "https://127.0.0.1:8443/", upstreamFetch });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, cookie) => fetch(`${origin}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const login = await fetch(`${origin}/signin`, { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "username=synthetic&password=synthetic" });
  assert.equal(login.status, 303);
  return { request, cookie: login.headers.get("set-cookie"), calls, revoke: () => { active = false; }, close: () => new Promise(resolve => server.close(resolve)) };
}

test("connected event result is scoped, escaped, navigable and honestly partial", async () => {
  const f = await fixture();
  try {
    const url = `/cabinet/${cabinet}/events`;
    assert.equal((await f.request(url)).status, 303);
    const res = await f.request(url, f.cookie);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /System &amp; App/);
    assert.match(html, /accessDenied/);
    assert.match(html, /partial/i);
    assert.match(html, /2026-09-01T00:01:00Z/);
    assert.match(html, /&lt;svg\/onload=alert\(1\)&gt;/);
    assert.match(html, new RegExp(`href="/cabinet/${cabinet}/events/${action}\\?entry=0"`));
    assert.match(html, new RegExp(`href="/cabinet/${cabinet}/events/${action}\\?channel=System"`));
    assert.doesNotMatch(html, /server-only-token|<script>alert/);
    const detail = await f.request(`${url}?entry=0`, f.cookie);
    assert.match(await detail.text(), /A &amp; B &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    const filtered = await f.request(`${url}?channel=Application`, f.cookie);
    assert.equal(filtered.status, 200);
    assert.doesNotMatch(await filtered.text(), /href="[^\"]*entry=0/);
    assert.equal((await f.request(`${url}?channel=Application&entry=0`, f.cookie)).status, 400);
    assert.equal((await f.request(`${url}?entry=0&entry=1`, f.cookie)).status, 400);
    const call = f.calls.find(c => c.path.endsWith("/event-log-results/latest"));
    assert.equal(call.path, `/api/cabinets/${cabinet}/event-log-results/latest`);
    assert.equal(call.options.headers.Authorization, "Bearer server-only-token");
    assert.equal((await f.request(`/cabinet/${other}/events`, f.cookie)).status, 404);
    assert.equal((await f.request(`/cabinet/no/events`, f.cookie)).status, 404);
    f.revoke();
    assert.equal((await f.request(url, f.cookie)).status, 303);
  } finally { await f.close(); }
});

test("legacy nullable provider and message remain inspectable without invented provider navigation", async () => {
  const legacy = { ...base, state: "partial", channelReads: [], entries: [{ ...base.entries[0], channel: "system", provider: null, message: null }] };
  const f = await fixture(legacy);
  try {
    const response = await f.request(`/cabinet/${cabinet}/events?entry=0`, f.cookie);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Unknown provider/);
    assert.match(html, /No message was collected/);
    assert.match(html, /Provider unknown; provider filtering unavailable/);
    assert.doesNotMatch(html, /provider=null/);
  } finally { await f.close(); }
});

test("valid Server projection boundaries remain visible in the web page", async () => {
  const channel = "A".repeat(512);
  const providers = Array.from({ length: 50 }, (_, i) => `P${String(i).padStart(2, "0")}${"x".repeat(252)}`);
  const result = { ...base, state: "complete", requestedChannels: [channel], requestedProviders: providers,
    channelReads: [{ channelName: channel, outcome: "readable", recordsRead: 1, truncated: false }],
    entries: [{ ...base.entries[0], channel, provider: providers[0], level: "error" }] };
  const f = await fixture(result);
  try {
    const response = await f.request(`/cabinet/${cabinet}/events?entry=0`, f.cookie);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Collected message/);
    assert.match(html, new RegExp(providers[0]));
    assert.match(html, /readable/);
  } finally { await f.close(); }
});

test("connected result distinguishes unavailable, denial, no result, pending and malformed identity", async () => {
  for (const [result, status, expected] of [[base, 403, 403], [base, 401, 303], [base, 404, 404], [{ ...base, state: "pending", entries: [], channelReads: [] }, 200, 200], [{ ...base, cabinetId: other }, 200, 502], [{ ...base, entries: [{ ...base.entries[0], channel: "Security" }] }, 200, 502]]) {
    const f = await fixture(result, status);
    try {
      const response = await f.request(`/cabinet/${cabinet}/events`, f.cookie);
      assert.equal(response.status, expected);
      if (result.state === "pending" && status === 200) assert.match(await response.text(), /pending/i);
    } finally { await f.close(); }
  }
});
