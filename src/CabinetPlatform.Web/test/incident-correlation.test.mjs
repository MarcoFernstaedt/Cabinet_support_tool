import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewServer } from "../server.mjs";

const alert = "11111111-1111-4111-8111-111111111111";
const source = "22222222-2222-4222-8222-222222222222";
const target = "33333333-3333-4333-8333-333333333333";
const site = "44444444-4444-4444-8444-444444444444";
const evidence = "55555555-5555-4555-8555-555555555555";
const base = {
  alertId: alert, siteId: site, sourceCabinetId: source, targetCabinetId: target,
  status: "Resolved", evidenceId: evidence, currentSyncCabinetId: target, targetIsCurrentSync: true,
  interval: { firstObservedUtc: "2026-08-01T00:00:00Z", lastObservedUtc: "2026-08-01T00:02:00Z",
    receivedUtc: "2026-09-01T00:00:00Z", successCount: 0, failureCount: 3, errorCount: 0,
    sourceFirewallCheck: { observedUtc: "2026-08-01T00:01:00Z", status: "Partial", hasOutboundProfileBlockClue: null } },
  source: { cabinetId: source, lastCheckInUtc: "2026-09-01T01:00:00Z", latestHeartbeatCollectedAtUtc: "2026-07-31T23:00:00Z", latestHeartbeatReceivedAtUtc: "2026-09-01T01:00:00Z" },
  target: { cabinetId: target, lastCheckInUtc: null, latestHeartbeatCollectedAtUtc: null, latestHeartbeatReceivedAtUtc: null },
};
async function fixture(result = base, status = 200) {
  let active = true;
  const calls = [];
  const upstreamFetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, options });
    if (path === "/api/auth/login") return Response.json({ accessToken: "server-only-token", expiresAtUtc: new Date(Date.now() + 60000).toISOString() });
    if (path === "/api/auth/me") return active ? Response.json({ displayName: "Operator", role: "Tier2", isActive: true }) : new Response("", { status: 401 });
    if (path === `/api/connectivity-alerts/${alert}/correlation`) return status === 200 ? Response.json(result) : new Response("", { status });
    if (path.startsWith("/api/connectivity-alerts/")) return new Response("", { status: 404 });
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

test("pinned incident correlation separates interval, later contact, topology and unknown cause", async () => {
  const f = await fixture();
  try {
    const path = `/incident/${alert}/correlation`;
    assert.equal((await f.request(path)).status, 303);
    const response = await f.request(path, f.cookie);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /2026-08-01T00:02:00Z/);
    assert.match(body, /2026-09-01T01:00:00Z/);
    assert.match(body, /3 nonreplies/);
    assert.match(body, /application-port evidence not collected/i);
    assert.match(body, /not.*proof.*firewall|firewall.*not.*confirmed/i);
    assert.match(body, /Resolved.*not.*measured recovery/i);
    assert.match(body, /current.*sync/i);
    assert.doesNotMatch(body, /server-only-token|caused by firewall|synced successfully/i);
    assert.equal(f.calls.some(c => c.path === `/api/connectivity-alerts/${alert}/correlation` && c.options.headers.Authorization === "Bearer server-only-token"), true);
    assert.equal((await f.request(`/incident/no/correlation`, f.cookie)).status, 404);
    f.revoke();
    assert.equal((await f.request(path, f.cookie)).status, 303);
  } finally { await f.close(); }
});

test("incident correlation fails closed on unrelated evidence and distinguishes missing, denied and partial", async () => {
  for (const [data, status, expected] of [
    [base, 404, 404], [base, 403, 403], [base, 401, 303],
    [{ ...base, targetCabinetId: source }, 200, 502],
    [{ ...base, interval: null }, 200, 200],
    [{ ...base, interval: { ...base.interval, sourceFirewallCheck: { observedUtc: "2026-08-01T00:00:00Z", status: "Read", hasOutboundProfileBlockClue: false } } }, 200, 200],
  ]) {
    const f = await fixture(data, status);
    try {
      const response = await f.request(`/incident/${alert}/correlation`, f.cookie);
      assert.equal(response.status, expected);
      if (data.interval === null && status === 200) assert.match(await response.text(), /retained interval unavailable/i);
    } finally { await f.close(); }
  }
});
