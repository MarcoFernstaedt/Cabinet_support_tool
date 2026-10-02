import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewServer } from "../server.mjs";

const cabinetId = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const sample = { cabinetId, asOfUtc: "2026-10-02T04:00:00+00:00", heartbeat: {
  collectedAtUtc: "2026-09-30T00:00:00+00:00", receivedUtc: "2026-10-01T00:00:00+00:00", diskFreePercent: 12, worstDiskHealth: "Watch" },
volumes: [], smart: [] };

async function fixture({ result = sample, status = 200 } = {}) {
  let active = true;
  const calls = [];
  const upstreamFetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, options });
    if (path === "/api/auth/login") return Response.json({ accessToken: "server-only-token", expiresAtUtc: new Date(Date.now() + 60000).toISOString() });
    if (path === "/api/auth/me") return active ? Response.json({ displayName: "Operator", role: "Tier2", isActive: true }) : new Response("", { status: 401 });
    if (path === `/api/cabinets/${cabinetId}/storage`) return status === 200 ? Response.json(result) : new Response("", { status });
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

test("cabinet storage evidence is scoped, time-labeled and does not claim current health", async () => {
  const f = await fixture();
  try {
    const url = `/cabinet/${cabinetId}/storage`;
    assert.equal((await f.request(url)).status, 303);
    const res = await f.request(url, f.cookie);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /2026-09-30T00:00:00\+00:00/);
    assert.match(html, /2026-10-01T00:00:00\+00:00/);
    assert.match(html, /Watch/);
    assert.match(html, /unverified|historical/i);
    assert.match(html, /No volume observations|No volume/i);
    assert.match(html, /SMART.*unavailable|No SMART/i);
    assert.doesNotMatch(html, /server-only-token|serial number/i);
    assert.equal(f.calls.some(call => call.path === `/api/cabinets/${cabinetId}/storage` && call.options.headers.Authorization === "Bearer server-only-token"), true);
    f.revoke();
    assert.equal((await f.request(url, f.cookie)).status, 303);
  } finally { await f.close(); }
});

test("typed volume and SMART projection preserves null, zero, old timestamps and aggregate provenance", async () => {
  const result = { ...sample, volumes: [{ freePercent: 0, observationFirstUtc: "2026-09-01T00:00:00+00:00", observationLastUtc: "2026-10-01T00:00:00+00:00", embeddedValuesMeasuredAtUtc: "2026-09-01T00:00:00+00:00" }],
    smart: [{ observedUtc: "2026-09-01T00:00:00+00:00", health: "Failing", source: "FailurePredictData", temperatureCelsius: null,
      powerOnHours: 0, wearPercent: 110, reallocatedSectors: null, pendingSectors: 2, aggregated: true }] };
  const f = await fixture({ result });
  try {
    const response = await f.request(`/cabinet/${cabinetId}/storage`, f.cookie);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Free space 0%/);
    assert.match(html, /2026-09-01T00:00:00\+00:00/);
    assert.match(html, /version observed.*2026-10-01T00:00:00\+00:00/);
    assert.match(html, /daily worst-value aggregate/);
    assert.match(html, /rated endurance consumed 110%/);
    assert.match(html, /reallocated sectors Unknown/);
    assert.match(html, /server receipt time not retained/);
    assert.doesNotMatch(html, /serial|private-patient/i);
  } finally { await f.close(); }
});

test("storage rejects cross-cabinet data, malformed observations and denied reads", async () => {
  for (const [settings, expected] of [
    [{ result: { ...sample, cabinetId: other } }, 502], [{ status: 401 }, 303], [{ status: 403 }, 403], [{ status: 404 }, 404],
    [{ result: { ...sample, smart: [{ serial: "patient-sensitive" }] } }, 502],
  ]) {
    const f = await fixture(settings);
    try { assert.equal((await f.request(`/cabinet/${cabinetId}/storage`, f.cookie)).status, expected); }
    finally { await f.close(); }
  }
  const f = await fixture();
  try {
    assert.equal((await f.request(`/cabinet/${cabinetId}/storage?serial=secret`, f.cookie)).status, 400);
    assert.equal((await f.request("/cabinet/no/storage", f.cookie)).status, 404);
  } finally { await f.close(); }
});
