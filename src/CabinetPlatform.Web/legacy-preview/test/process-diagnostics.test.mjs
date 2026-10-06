import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewServer } from "../server.mjs";

const cabinet = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const action = "33333333-3333-4333-8333-333333333333";
const newer = "44444444-4444-4444-8444-444444444444";
const sample = {
  cabinetId: cabinet, actionId: action, state: "complete", requestedAtUtc: "2026-09-01T00:00:00Z",
  completedAtUtc: "2026-09-01T00:01:00Z", truncated: false,
  processes: [{ name: "<svg onload=alert(1)>.exe", pid: 42, cpuPercent: null,
    workingSetBytes: 1024, threadCount: 2, handleCount: 4 }],
};
const detail = {
  cabinet: { id: cabinet, siteId: other, friendlyName: "Test" }, site: { id: other },
  currentInventory: { firstObservedUtc: "2026-08-01T00:00:00Z", lastObservedUtc: "2026-09-01T00:00:00Z",
    services: [{ name: "<img src=x onerror=alert(1)>", displayName: "Synthetic Service", state: "Running", startType: "Automatic", processId: 42, runAsAccount: "LocalSystem" }] },
};
async function fixture({ result = sample, inventory = detail, processStatus = 200 } = {}) {
  let active = true, current = result;
  const calls = [];
  const upstreamFetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, options });
    if (path === "/api/auth/login") return Response.json({ accessToken: "server-only-token", expiresAtUtc: new Date(Date.now() + 60000).toISOString() });
    if (path === "/api/auth/me") return active ? Response.json({ displayName: "Operator", role: "Tier2", isActive: true }) : new Response("", { status: 401 });
    if (path === `/api/cabinets/${cabinet}`) return Response.json(inventory);
    if (path === `/api/cabinets/${cabinet}/process-results/latest`) return processStatus === 200 ? Response.json(current) : new Response("", { status: processStatus });
    if (path === `/api/cabinets/${cabinet}/process-results/${action}`) return Response.json(result);
    if (path.startsWith("/api/cabinets/")) return new Response("", { status: 404 });
    throw Error(`Unexpected upstream ${path}`);
  };
  const server = createPreviewServer("127.0.0.1", { enabled: true, upstreamUrl: "https://127.0.0.1:8443/", upstreamFetch });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, cookie) => fetch(`${origin}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const login = await fetch(`${origin}/signin`, { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "username=synthetic&password=synthetic" });
  assert.equal(login.status, 303);
  return { request, cookie: login.headers.get("set-cookie"), calls, change: value => { current = value; }, revoke: () => { active = false; }, close: () => new Promise(resolve => server.close(resolve)) };
}

test("process and service observations are scoped, escaped, dated and read-only", async () => {
  const f = await fixture();
  try {
    const url = `/cabinet/${cabinet}/processes`;
    assert.equal((await f.request(url)).status, 303);
    const response = await f.request(url, f.cookie);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /&lt;svg onload=alert\(1\)&gt;\.exe/);
    assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(body, /2026-08-01T00:00:00Z/);
    assert.match(body, /2026-09-01T00:00:00Z/);
    assert.match(body, /not a live process sample|not live process state/i);
    assert.match(body, /PID.*not.*current|PID.*first observation/i);
    assert.match(body, new RegExp(`/cabinet/${cabinet}/processes/${action}`));
    assert.doesNotMatch(body, /<script>|<img|server-only-token|runAsAccount|LocalSystem|Stop service|Kill process/);
    assert.equal(f.calls.some(c => c.path === `/api/cabinets/${cabinet}/process-results/latest` && c.options.headers.Authorization === "Bearer server-only-token"), true);
    assert.equal(f.calls.some(c => c.path.includes("/api/actions") || c.options.method === "POST" && c.path !== "/api/auth/login"), false);
    assert.equal((await f.request(`/cabinet/${other}/processes`, f.cookie)).status, 404);
    assert.equal((await f.request(`/cabinet/no/processes`, f.cookie)).status, 404);
    f.revoke();
    assert.equal((await f.request(url, f.cookie)).status, 303);
  } finally { await f.close(); }
});

test("pinned process observation survives a newer latest action", async () => {
  const f = await fixture();
  try {
    await f.request(`/cabinet/${cabinet}/processes`, f.cookie);
    f.change({ ...sample, actionId: newer, processes: [{ ...sample.processes[0], name: "New.exe" }] });
    const old = await f.request(`/cabinet/${cabinet}/processes/${action}`, f.cookie);
    assert.equal(old.status, 200);
    assert.match(await old.text(), /alert\(1\)/);
    assert.equal(f.calls.some(c => c.path === `/api/cabinets/${cabinet}/process-results/${action}`), true);
  } finally { await f.close(); }
});

test("missing process result keeps service inventory available; invalid identities fail closed", async () => {
  for (const [settings, status] of [
    [{ processStatus: 404 }, 200],
    [{ processStatus: 403 }, 403],
    [{ result: { ...sample, state: "pending", completedAtUtc: null, processes: [] } }, 200],
    [{ result: { ...sample, cabinetId: other } }, 502],
    [{ result: { ...sample, processes: [{ ...sample.processes[0], executablePath: "C:\\secret" }] } }, 502],
    [{ result: { ...sample, processes: [{ ...sample.processes[0], name: "C:\\secret.exe" }] } }, 502],
    [{ result: { ...sample, processes: [{ ...sample.processes[0], pid: -1 }] } }, 502],
    [{ inventory: { ...detail, currentInventory: { ...detail.currentInventory, services: null } } }, 200],
  ]) {
    const f = await fixture(settings);
    try {
      const response = await f.request(`/cabinet/${cabinet}/processes`, f.cookie);
      assert.equal(response.status, status);
      if (settings.processStatus === 404) assert.match(await response.text(), /No saved process observation/);
    } finally { await f.close(); }
  }
});
