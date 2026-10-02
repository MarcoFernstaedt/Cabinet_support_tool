import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewServer } from "../server.mjs";

const cabinet = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const result = {
  cabinetId: cabinet, actionId: "33333333-3333-4333-8333-333333333333", viewId: "44444444-4444-4444-8444-444444444444",
  state: "complete", viewDisplayName: "Application evidence", requestedAtUtc: "2026-09-01T00:00:00Z",
  completedAtUtc: "2026-09-01T00:02:00Z", requestedChannels: ["Application", "System"],
  requestedProviders: [], truncated: false,
  channelReads: [
    { channelName: "Application", outcome: "readable", recordsRead: 2, truncated: false },
    { channelName: "System", outcome: "readable", recordsRead: 1, truncated: false },
  ],
  entries: [
    { channel: "Application", provider: "Application Error", level: "error", eventId: 1000, occurredAt: "2026-09-01T00:01:00Z", message: "Patient <script>alert(1)</script>" },
    { channel: "Application", provider: "Windows Error Reporting", level: "information", eventId: 1001, occurredAt: "2026-09-01T00:01:10Z", message: "private path" },
    { channel: "System", provider: "Application Error", level: "error", eventId: 1000, occurredAt: "2026-09-01T00:01:11Z", message: "Unrelated" },
  ],
};
async function fixture(data = result, status = 200) {
  let active = true;
  let latest = data;
  const calls = [];
  const upstreamFetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, options });
    if (path === "/api/auth/login") return Response.json({ accessToken: "server-only-token", expiresAtUtc: new Date(Date.now() + 60000).toISOString() });
    if (path === "/api/auth/me") return active ? Response.json({ displayName: "Test rep", role: "Tier2", isActive: true }) : new Response("", { status: 401 });
    if (path === `/api/cabinets/${cabinet}/event-log-results/latest`) return status === 200 ? Response.json(latest) : new Response("", { status });
    if (path === `/api/cabinets/${cabinet}/event-log-results/${data.actionId}`) return Response.json(data);
    return new Response("", { status: 404 });
  };
  const server = createPreviewServer("127.0.0.1", { enabled: true, upstreamUrl: "https://127.0.0.1:8443/", upstreamFetch });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, cookie) => fetch(`${origin}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const login = await fetch(`${origin}/signin`, { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "username=synthetic&password=synthetic" });
  assert.equal(login.status, 303);
  return { request, cookie: login.headers.get("set-cookie"), calls, newer: value => { latest = value; }, revoke: () => { active = false; }, close: () => new Promise(resolve => server.close(resolve)) };
}

test("crash clues link exact saved Application records without leaking messages or claiming cause", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request(`/cabinet/${cabinet}/crashes`)).status, 303);
    const response = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Application Error/);
    assert.match(html, /Windows Error Reporting event/);
    assert.match(html, /cause unknown/i);
    assert.match(html, /Structured WER report unavailable/);
    assert.match(html, /Historical process evidence unavailable/);
    assert.match(html, new RegExp(`/cabinet/${cabinet}/events/${result.actionId}\\?entry=0`));
    assert.match(html, new RegExp(`/cabinet/${cabinet}/events/${result.actionId}\\?entry=1`));
    assert.doesNotMatch(html, /events\\?entry=2|Patient|private path|Unrelated|server-only-token|<script>/);
    assert.equal(f.calls.find(c => c.path.endsWith("/latest")).options.headers.Authorization, "Bearer server-only-token");
    assert.equal((await f.request(`/cabinet/${other}/crashes`, f.cookie)).status, 404);
    f.revoke();
    assert.equal((await f.request(`/cabinet/${cabinet}/crashes`, f.cookie)).status, 303);
  } finally { await f.close(); }
});

test("a newer collection cannot change the exact event opened from a crash clue", async () => {
  const f = await fixture();
  try {
    const list = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
    assert.equal(list.status, 200);
    assert.match(await list.text(), new RegExp(`/cabinet/${cabinet}/events/${result.actionId}\\?entry=0`));
    const newer = { ...result, actionId: "55555555-5555-4555-8555-555555555555", entries: [{ ...result.entries[0], provider: "Different later event", eventId: 7, message: "Different message" }] };
    f.newer(newer);
    const pinned = await f.request(`/cabinet/${cabinet}/events/${result.actionId}?entry=0`, f.cookie);
    assert.equal(pinned.status, 200);
    const html = await pinned.text();
    assert.match(html, /Application Error · 1000/);
    assert.doesNotMatch(html, /Different later event|Different message/);
    const call = f.calls.find(c => c.path === `/api/cabinets/${cabinet}/event-log-results/${result.actionId}`);
    assert.equal(call.options.headers.Authorization, "Bearer server-only-token");
    assert.equal((await f.request(`/cabinet/${cabinet}/events/${newer.actionId}?entry=0`, f.cookie)).status, 404);
  } finally { await f.close(); }
});

test("unknown coverage does not become a clean bill of health", async () => {
  for (const data of [
    { ...result, state: "pending", entries: [], channelReads: [], completedAtUtc: null },
    { ...result, state: "failed", entries: [], channelReads: [] },
    { ...result, requestedChannels: ["System"], channelReads: [result.channelReads[1]], entries: [result.entries[2]] },
    { ...result, channelReads: [{ ...result.channelReads[0], outcome: "accessDenied", recordsRead: 0 }, result.channelReads[1]], entries: [result.entries[2]], state: "partial" },
  ]) {
    const f = await fixture(data);
    try {
      const response = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /coverage unavailable|pending|failed|accessDenied/i);
    } finally { await f.close(); }
  }
});

test("cross cabinet evidence and upstream denials fail closed", async () => {
  for (const [data, status, expected] of [[result, 403, 403], [result, 401, 303], [result, 404, 404], [{ ...result, cabinetId: other }, 200, 502], [{ ...result, entries: [{ ...result.entries[0], channel: "Other" }] }, 200, 502]]) {
    const f = await fixture(data, status);
    try { assert.equal((await f.request(`/cabinet/${cabinet}/crashes`, f.cookie)).status, expected); }
    finally { await f.close(); }
  }
});
