import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewServer } from "../server.mjs";

const cabinet = "11111111-1111-4111-8111-111111111111";
const site = "22222222-2222-4222-8222-222222222222";
const otherSite = "33333333-3333-4333-8333-333333333333";
const cabinetRow = (i, overrides = {}) => ({ id: i === 0 ? cabinet : `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`, siteId: site,
  friendlyName: `Cabinet ${i}`, hostname: `test-${i}`, clientName: "Synthetic", siteName: "Lab", role: "Satellite", health: "Unknown",
  isActive: true, lastCheckInUtc: "2026-09-01T01:00:00Z", latestHeartbeatCollectedAtUtc: "2026-08-01T00:00:00Z",
  latestHeartbeatReceivedAtUtc: "2026-09-01T01:00:00Z", ...overrides });
const summary = { totalCabinets: 21, healthy: 0, warning: 0, critical: 0, offline: 0, unknown: 21,
  noMeasurement: 0, staleMeasurement: 21, measurementStaleAfterHours: 24, stale: 0, staleAfterHours: 24,
  generatedUtc: "2026-09-01T02:00:00Z" };
const siteRow = (id, overrides = {}) => ({ id, clientName: "Synthetic", siteName: "Lab", cabinetCount: 21,
  unhealthyCabinetCount: 21, worstHealth: "Unknown", syncCabinetId: null, syncCabinetHealth: null, syncReachability: null, ...overrides });

async function fixture({ healthStatus = 200, sitesStatus = 200, cabinetsStatus = 200, corruptSite = false } = {}) {
  let active = true;
  const calls = [];
  const upstreamFetch = async (url, options) => {
    const target = new URL(url), path = target.pathname, q = target.searchParams;
    calls.push({ path, query: target.search, options });
    if (path === "/api/auth/login") return Response.json({ accessToken: "server-only-token", expiresAtUtc: new Date(Date.now() + 60000).toISOString() });
    if (path === "/api/auth/me") return active ? Response.json({ displayName: "Operator", role: "Tier2", isActive: true }) : new Response("", { status: 401 });
    if (path === "/api/cabinets") {
      if (cabinetsStatus !== 200) return new Response("", { status: cabinetsStatus });
      const page = Number(q.get("Page"));
      return Response.json({ page, pageSize: 20, totalCount: 21, hasMore: page === 1,
        items: page === 1 ? Array.from({ length: 20 }, (_, i) => cabinetRow(i, i === 0 ? { friendlyName: "<svg onload=alert(1)>" } : {})) : [cabinetRow(20)] });
    }
    if (path === "/api/fleet/health") return healthStatus === 200 ? Response.json(summary) : new Response("", { status: healthStatus });
    if (path === "/api/fleet/sites") {
      if (sitesStatus !== 200) return new Response("", { status: sitesStatus });
      const page = Number(q.get("Page"));
      return Response.json({ page, pageSize: 20, totalCount: 21, hasMore: page === 1,
        items: page === 1 ? [siteRow(corruptSite ? "not-a-guid" : site, { siteName: "<img src=x onerror=alert(1)>" }), ...Array.from({ length: 19 }, (_, i) => siteRow(`22222222-2222-4222-8222-${String(i + 1).padStart(12, "0")}`))] : [siteRow(otherSite, { syncCabinetId: cabinet, syncCabinetHealth: "Unknown", syncReachability: { reaching: 0, notReaching: 0, neverProbed: 20, mostRecentProbeUtc: null } })] });
    }
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

test("fleet health shows distinct measurement and contact freshness with stable page navigation", async () => {
  const f = await fixture();
  try {
    const url = "/fleet/health";
    assert.equal((await f.request(url)).status, 303);
    const res = await f.request(url, f.cookie);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /21.*unknown/i);
    assert.match(body, /21.*stale measurement/i);
    assert.match(body, /2026-08-01T00:00:00Z/);
    assert.match(body, /2026-09-01T01:00:00Z/);
    assert.match(body, /&lt;svg onload=alert\(1\)&gt;/);
    assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(body, /<svg|<img|server-only-token|worst sites first/i);
    assert.match(body, /cabinetPage=2/);
    assert.match(body, /sitePage=2/);
    const next = await f.request("/fleet/health?cabinetPage=2&sitePage=2", f.cookie);
    assert.equal(next.status, 200);
    assert.match(await next.text(), /never probed/i);
    assert.equal(f.calls.some(c => c.path === "/api/cabinets" && c.query.includes("IsActive=true") && c.query.includes("PageSize=20") && c.options.headers.Authorization === "Bearer server-only-token"), true);
    f.revoke();
    assert.equal((await f.request(url, f.cookie)).status, 303);
  } finally { await f.close(); }
});

test("fleet health rejects invalid navigation and upstream authorization, not converting it into empty health", async () => {
  const f = await fixture();
  try {
    for (const query of ["?cabinetPage=0", "?sitePage=2&sitePage=1", "?unknown=1", "?cabinetPage=99999"])
      assert.equal((await f.request(`/fleet/health${query}`, f.cookie)).status, 400);
  } finally { await f.close(); }
  for (const [settings, expected] of [[{ healthStatus: 403 }, 403], [{ sitesStatus: 403 }, 403], [{ cabinetsStatus: 404 }, 502], [{ corruptSite: true }, 502]]) {
    const fixtureInstance = await fixture(settings);
    try { assert.equal((await fixtureInstance.request("/fleet/health", fixtureInstance.cookie)).status, expected); }
    finally { await fixtureInstance.close(); }
  }
});
