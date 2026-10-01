import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewServer } from "../server.mjs";

const cabinet = "11111111-1111-4111-8111-111111111111";
const site = "aaaaaaaa-2222-4222-8222-222222222222";
async function fixture() {
  const calls = [];
  let active = true;
  let summaryFails = false;
  let queueStatus = 200;
  let wrongSite = false;
  let wrongPage = false;
  const upstreamFetch = async (url, options) => {
    const path = new URL(url);
    calls.push({ path: path.pathname + path.search, options });
    if (path.pathname === "/api/auth/login") return Response.json({ accessToken: "server-only-token", expiresAtUtc: new Date(Date.now() + 60000).toISOString() });
    if (path.pathname === "/api/auth/me") return active ? Response.json({ displayName: "Operator", role: "Tier2", isActive: true }) : new Response("", { status: 401 });
    if (path.pathname === "/api/cabinets") return Response.json({ items: [{ id: cabinet, hostname: "cabinet<one>", clientName: "Client & Co", siteName: "Site A", siteId: site, health: "Unknown", isActive: true, lastCheckInUtc: null }, ...Array.from({ length: 19 }, (_, i) => ({ id: `11111111-1111-4111-8111-${String(i + 1).padStart(12, "0")}`, hostname: `CAB-${i + 2}`, clientName: "Client & Co", siteName: "Site A", siteId: site, health: "Unknown", isActive: true, lastCheckInUtc: null }))], totalCount: 21, page: wrongPage ? 2 : 1, pageSize: 20, hasMore: true });
    if (path.pathname === `/api/cabinets/${cabinet}`) return Response.json({ cabinet: { id: cabinet, hostname: "cabinet<one>", clientName: "Client & Co", siteName: "Site A", siteId: site, health: "Unknown", isActive: true, lastCheckInUtc: null, role: "Satellite" }, site: { id: site, siteName: "Site A", clientName: "Client & Co", syncCabinetId: "33333333-3333-4333-8333-333333333333", syncCabinetHostname: "SYNC-01" }, syncCabinetLink: { syncCabinetId: "33333333-3333-4333-8333-333333333333", syncCabinetHostname: "SYNC-01", lastSuccessUtc: null } });
    if (path.pathname.startsWith("/api/cabinets/")) return new Response("", { status: 404 });
    if (path.pathname === "/api/connectivity-alerts") return queueStatus !== 200 ? new Response("", { status: queueStatus }) : Response.json({ items: [{ id: "55555555-5555-4555-8555-555555555555", siteId: wrongSite ? "44444444-4444-4444-8444-444444444444" : site, sourceCabinetId: cabinet, targetCabinetId: "33333333-3333-4333-8333-333333333333", sourceName: "cabinet<one>", status: "Open", receivedUtc: "2026-09-01T00:00:00Z", incidentEvidence: null }], totalCount: 1, page: wrongPage ? 2 : 1, pageSize: 20, hasMore: false });
    if (path.pathname === `/api/connectivity-alerts/site/${site}/summary`) return summaryFails ? new Response("", { status: 503 }) : Response.json({ siteId: site, asOfUtc: "2026-09-01T01:00:00Z", open: 1, acknowledged: 2, resolved: 3, total: 6 });
    throw Error(`Unexpected upstream ${path.pathname}`);
  };
  const server = createPreviewServer("127.0.0.1", { enabled: true, upstreamUrl: "https://127.0.0.1:8443/", upstreamFetch });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => fetch(`${origin}${path}`, { redirect: "manual", ...options });
  const login = await request("/signin", { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "username=synthetic&password=synthetic" });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie");
  return { server, origin, request, cookie, calls, failSummary: () => { summaryFails = true; }, denyQueue: () => { queueStatus = 403; }, revokeQueue: () => { queueStatus = 401; }, crossSiteRow: () => { wrongSite = true; }, mismatchPage: () => { wrongPage = true; }, revoke: () => { active = false; }, close: () => new Promise(resolve => server.close(resolve)) };
}

test("mismatched upstream pages do not become misleading navigation", async () => {
  const f = await fixture();
  try {
    f.mismatchPage();
    assert.equal((await f.request("/fleet", { headers: { cookie: f.cookie } })).status, 502);
    assert.equal((await f.request(`/site/${site}/incidents`, { headers: { cookie: f.cookie } })).status, 502);
  } finally { await f.close(); }
});

test("site incident denies revoked or cross-site queue responses", async () => {
  const denied = await fixture();
  try {
    denied.denyQueue();
    const res = await denied.request(`/site/${site}/incidents`, { headers: { cookie: denied.cookie } });
    assert.equal(res.status, 403);
    assert.doesNotMatch(await res.text(), /cabinet&lt;one&gt;/);
  } finally { await denied.close(); }
  const revoked = await fixture();
  try {
    revoked.revokeQueue();
    const res = await revoked.request(`/site/${site}/incidents`, { headers: { cookie: revoked.cookie } });
    assert.equal(res.status, 303);
    assert.equal((await revoked.request("/", { headers: { cookie: revoked.cookie } })).status, 303);
  } finally { await revoked.close(); }
  const mixed = await fixture();
  try {
    mixed.crossSiteRow();
    const res = await mixed.request(`/site/${site}/incidents`, { headers: { cookie: mixed.cookie } });
    assert.equal(res.status, 502);
    assert.doesNotMatch(await res.text(), /cabinet&lt;one&gt;/);
  } finally { await mixed.close(); }
});

test("site incident queue keeps historical evidence and optional summary failures distinct", async () => {
  const f = await fixture();
  try {
    const path = `/site/${site}/incidents`;
    assert.equal((await f.request(path)).status, 303);
    const response = await f.request(path, { headers: { cookie: f.cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /1 open, 2 acknowledged, 3 resolved/);
    assert.match(html, /2026-09-01T01:00:00Z/);
    assert.match(html, /Accepted interval evidence unavailable/);
    assert.match(html, /cabinet&lt;one&gt;/);
    assert.doesNotMatch(html, /server-only-token|cabinet<one>/);
    assert.ok(f.calls.some(c => c.path.startsWith(`/api/connectivity-alerts?SiteId=${site}`) && c.options.headers.Authorization === "Bearer server-only-token"));
    f.failSummary();
    const failed = await f.request(path, { headers: { cookie: f.cookie } });
    assert.equal(failed.status, 200);
    assert.match(await failed.text(), /Counts unavailable/);
    assert.equal((await f.request("/site/not-an-id/incidents", { headers: { cookie: f.cookie } })).status, 404);
    assert.equal((await f.request(path.toUpperCase().replace("/SITE/", "/site/").replace("/INCIDENTS", "/incidents"), { headers: { cookie: f.cookie } })).status, 200);
  } finally { await f.close(); }
});

test("cabinet detail uses exact identity and distinguishes missing from unavailable", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request(`/cabinet/${cabinet}`)).status, 303);
    const response = await f.request(`/cabinet/${cabinet}`, { headers: { cookie: f.cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /cabinet&lt;one&gt;/);
    assert.match(html, /<dt>Last check-in<\/dt><dd>Unknown<\/dd>/);
    assert.match(html, /SYNC-01/);
    assert.match(html, new RegExp(`/site/${site}/incidents`));
    assert.doesNotMatch(html, /server-only-token|cabinet<one>/);
    assert.equal((await f.request("/cabinet/invalid", { headers: { cookie: f.cookie } })).status, 404);
    assert.equal((await f.request("/cabinet/44444444-4444-4444-8444-444444444444", { headers: { cookie: f.cookie } })).status, 404);
    assert.ok(f.calls.some(c => c.path === `/api/cabinets/${cabinet}` && c.options.headers.Authorization === "Bearer server-only-token"));
  } finally { await f.close(); }
});

test("fleet finder is server-authenticated, bounded, escaped and paginated", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/fleet")).status, 303);
    const response = await f.request("/fleet?search=cabinet%3Cone%3E&page=1", { headers: { cookie: f.cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /cabinet&lt;one&gt;/);
    assert.match(html, /Client &amp; Co/);
    assert.match(html, new RegExp(`/cabinet/${cabinet}`));
    assert.match(html, /Next page/);
    assert.doesNotMatch(html, /server-only-token|cabinet<one>/);
    const call = f.calls.find(c => c.path.startsWith("/api/cabinets?"));
    assert.ok(call);
    assert.match(call.path, /PageSize=20|pageSize=20/);
    assert.equal(call.options.headers.Authorization, "Bearer server-only-token");
    assert.equal((await f.request("/fleet?page=999999999", { headers: { cookie: f.cookie } })).status, 400);
    f.revoke();
    assert.equal((await f.request("/fleet", { headers: { cookie: f.cookie } })).status, 303);
  } finally { await f.close(); }
});
