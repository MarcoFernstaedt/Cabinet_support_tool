import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewServer } from "../server.mjs";
import { storageWindow, validStorageWindow } from "../storage-investigation-page.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const from = "2026-09-25T04:00:00+00:00", to = "2026-10-02T04:00:00+00:00";
const selector = "Opaque_123-ABC";
const point = { observedUtc: "2026-09-30T00:00:00.0000001Z", receivedUtc: null, health: "Watch", source: "FailurePredictData", temperatureCelsius: 0, powerOnHours: null, wearPercent: 110, reallocatedSectors: 2, pendingSectors: 0, aggregated: true };
const smart = { driveSelector: selector, observedUtc: point.observedUtc, health: point.health, source: point.source, temperatureCelsius: point.temperatureCelsius, powerOnHours: point.powerOnHours, wearPercent: point.wearPercent, reallocatedSectors: point.reallocatedSectors, pendingSectors: point.pendingSectors, aggregated: point.aggregated };
const snapshot = { cabinetId: id, asOfUtc: to, heartbeat: null, volumes: [], smart: [smart] };
const page = { cabinetId: id, fromUtc: from, toUtc: to, asOfUtc: to, items: [point], nextCursor: "Next_cursor-123" };
const url = `/cabinet/${id}/storage/trends?${new URLSearchParams({ driveSelector: selector, from, to })}`;

test("UTC bounds preserve seven fractional digits and exact ninety-day limit", () => {
  assert.deepEqual(storageWindow("2026-10-02T04:00:00.1234567+00:00"), { from: "2026-09-25T04:00:00.1234567+00:00", to: "2026-10-02T04:00:00.1234567+00:00" });
  assert.equal(validStorageWindow("2026-01-01T00:00:00.0000001Z", "2026-04-01T00:00:00.0000002Z"), false);
  assert.equal(validStorageWindow("2026-01-01T00:00:00.0000001Z", "2026-04-01T00:00:00.0000001+00:00"), true);
  assert.equal(validStorageWindow("9999-12-01T00:00:00Z", "9999-12-30T00:00:00Z"), true);
});

async function fixture({ snapshotResult = snapshot, trendResult = page, trendStatus = 200, trendResponse } = {}) {
  const calls = [];
  const upstreamFetch = async (target, options) => {
    const u = new URL(target);
    calls.push({ path: u.pathname, query: u.searchParams, options });
    if (u.pathname === "/api/auth/login") return Response.json({ accessToken: "server-only-token", expiresAtUtc: new Date(Date.now() + 60000).toISOString() });
    if (u.pathname === "/api/auth/me") return Response.json({ displayName: "Operator", role: "Tier2", isActive: true });
    if (u.pathname === `/api/cabinets/${id}/storage`) return Response.json(snapshotResult);
    if (u.pathname === `/api/cabinets/${id}/storage/trends`) return trendResponse ?? (trendStatus === 200 ? Response.json(trendResult) : new Response("private upstream error", { status: trendStatus }));
    throw Error("Unexpected upstream");
  };
  const server = createPreviewServer("127.0.0.1", { enabled: true, upstreamUrl: "https://127.0.0.1:8443/", upstreamFetch });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, cookie) => fetch(`${origin}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const login = await fetch(`${origin}/signin`, { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "username=synthetic&password=synthetic" });
  assert.equal(login.status, 303);
  return { request, cookie: login.headers.get("set-cookie"), calls, close: () => new Promise(resolve => server.close(resolve)) };
}

test("snapshot links typed selector to exact seven-day UTC window; trend pages retain binding", async () => {
  const f = await fixture();
  try {
    const snapshotHtml = await (await f.request(`/cabinet/${id}/storage`, f.cookie)).text();
    const href = snapshotHtml.match(/href="([^"]*\/storage\/trends\?[^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
    assert.ok(href);
    assert.doesNotMatch(snapshotHtml.replace(href.replaceAll("&", "&amp;"), ""), /Opaque_123-ABC/);
    const target = new URL(href, "http://127.0.0.1");
    assert.equal(target.searchParams.get("from"), from);
    assert.equal(target.searchParams.get("to"), to);
    const first = await f.request(target.pathname + target.search, f.cookie);
    assert.equal(first.status, 200);
    const html = await first.text();
    assert.match(html, /daily.*aggregate/i);
    assert.match(html, /receipt.*unknown/i);
    assert.match(html, /2026-09-30T00:00:00.0000001Z/);
    assert.doesNotMatch(html.replace(/href="[^"]+"/g, ""), /Opaque_123-ABC|Next_cursor-123|server-only-token|serial|model|raw error/i);
    const next = html.match(/href="([^"]*\/storage\/trends\?[^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
    assert.ok(next);
    const nextQuery = new URL(next, "http://127.0.0.1").searchParams;
    assert.equal(nextQuery.get("cursor"), page.nextCursor);
    assert.equal(nextQuery.get("driveSelector"), selector);
    assert.equal(nextQuery.get("from"), from);
    assert.equal(nextQuery.get("to"), to);
    assert.equal((await f.request(next, f.cookie)).status, 200);
    const call = f.calls.find(c => c.path.endsWith("/storage/trends"));
    assert.equal(call.query.get("pageSize"), "20");
    assert.equal(call.options.headers.Authorization, "Bearer server-only-token");
  } finally { await f.close(); }
});

test("trend query refuses malformed, duplicate, overlong tokens and invalid exact windows before upstream fetch", async () => {
  const f = await fixture();
  try {
    const badQuery = changes => { const target = new URL(url, "http://127.0.0.1"); for (const [key, value] of Object.entries(changes)) target.searchParams.set(key, value); return target.pathname + target.search; };
    for (const bad of [url + "&serial=secret", url + "&driveSelector=duplicate", url + "&cursor=bad%3D", badQuery({ driveSelector: "A".repeat(2049) }), badQuery({ from: to }), badQuery({ from: "2026-09-25T04:00:00+01:00" }), badQuery({ from: "2026-02-25T04:00:00Z" }), badQuery({ from: "2026-09-25T04:00:00.0000002Z", to: "2026-09-25T04:00:00.0000001Z" }), badQuery({ from: "2026-01-01T00:00:00.0000001Z", to: "2026-04-01T00:00:00.0000002Z" })]) {
      assert.equal((await f.request(bad, f.cookie)).status, 400, bad.slice(0, 100));
    }
    assert.equal(f.calls.some(c => c.path.endsWith("/storage/trends")), false);
  } finally { await f.close(); }
});

test("trend refuses mismatched identity, bounds, malformed rows, excess rows and unsafe continuation", async () => {
  for (const trendResult of [
    { ...page, cabinetId: "22222222-2222-4222-8222-222222222222" },
    { ...page, serial: "private" },
    { ...page, fromUtc: "2026-09-24T04:00:00Z" },
    { ...page, nextCursor: "bad=" },
    { ...page, items: [] },
    { ...page, items: Array(21).fill(point) },
    { ...page, items: [{ ...point, serial: "private" }] },
    { ...page, items: [{ ...point, health: "<script>" }] },
    { ...page, items: [{ ...point, observedUtc: to }] },
  ]) {
    const f = await fixture({ trendResult });
    try { assert.equal((await f.request(url, f.cookie)).status, 502); }
    finally { await f.close(); }
  }
});

test("trend honors upstream denial, missing drive, invalid cursor and size ceiling", async () => {
  for (const [status, expected] of [[401, 303], [403, 403], [404, 404], [400, 400]]) {
    const f = await fixture({ trendStatus: status });
    try { assert.equal((await f.request(url, f.cookie)).status, expected); }
    finally { await f.close(); }
  }
  const f = await fixture({ trendResponse: new Response("x".repeat(33000), { status: 200 }) });
  try { assert.equal((await f.request(url, f.cookie)).status, 502); }
  finally { await f.close(); }
});
