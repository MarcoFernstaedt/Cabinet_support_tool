import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewServer } from "../server.mjs";

const cabinet = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const action = "33333333-3333-4333-8333-333333333333";
const nextAction = "44444444-4444-4444-8444-444444444444";
const display = { observedAtUtc: "2026-10-02T05:00:00+00:00", modeStatus: "Observed", modes: [
  { displayIndex: 0, widthPixels: 1920, heightPixels: 1080, refreshHz: 60 }], modesTruncated: false,
  scalingStatus: "NotCollected", scalingPercent: null, magnifierStatus: "NotCollected", appZoomStatus: "NotCollected" };
const saved = { cabinetId: cabinet, actionId: action, state: "complete", requestedAtUtc: "2026-10-02T04:59:00+00:00", completedAtUtc: "2026-10-02T05:01:00+00:00", display };
async function fixture({ result = saved, status = 200, pinnedResult = saved, pinnedStatus = 200 } = {}) {
  let active = true;
  const calls = [];
  const upstreamFetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, options });
    if (path === "/api/auth/login") return Response.json({ accessToken: "server-only-token", expiresAtUtc: new Date(Date.now() + 60000).toISOString() });
    if (path === "/api/auth/me") return active ? Response.json({ displayName: "Operator", role: "Tier2", isActive: true }) : new Response("", { status: 401 });
    if (path === `/api/cabinets/${cabinet}/display-results/latest`) return status === 200 ? Response.json(result) : new Response("", { status });
    if (path === `/api/cabinets/${cabinet}/display-results/${action}`) return pinnedStatus === 200 ? Response.json(pinnedResult) : new Response("", { status: pinnedStatus });
    if (path.startsWith(`/api/cabinets/${cabinet}/display-results/`)) return new Response("", { status: 404 });
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

test("display page reports OS mode, separately unknown session facts and pinned action", async () => {
  const f = await fixture({ result: { ...saved, display: { ...display, modes: [{ ...display.modes[0], widthPixels: 2560 }] } } });
  try {
    const url = `/cabinet/${cabinet}/display`;
    assert.equal((await f.request(url)).status, 303);
    const res = await f.request(url, f.cookie);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /2560.*1080/);
    assert.match(html, /Scaling<\/dt><dd>Not collected; no reliable user scaling measurement\./i);
    assert.match(html, /Magnifier<\/dt><dd>Not collected; state unknown\./i);
    assert.match(html, /app zoom/i);
    assert.match(html, new RegExp(action));
    const pinned = await f.request(`/cabinet/${cabinet}/display/${action}`, f.cookie);
    assert.equal(pinned.status, 200);
    assert.match(await pinned.text(), /1920.*1080/);
    assert.equal(f.calls.some(c => c.path === `/api/cabinets/${cabinet}/display-results/${action}` && c.options.headers.Authorization === "Bearer server-only-token"), true);
    assert.doesNotMatch(html, /server-only-token|correct display|remote control/i);
    f.revoke();
    assert.equal((await f.request(url, f.cookie)).status, 303);
  } finally { await f.close(); }
});

test("older saved inaccessible-session statuses remain readable", async () => {
  const earlier = { ...saved, display: { ...display,
    scalingStatus: "InteractiveSessionInaccessible", magnifierStatus: "InteractiveSessionInaccessible" } };
  const f = await fixture({ result: earlier });
  try {
    const res = await f.request(`/cabinet/${cabinet}/display`, f.cookie);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Scaling<\/dt><dd>Interactive session inaccessible/);
    assert.match(html, /Magnifier<\/dt><dd>Interactive session inaccessible/);
  } finally { await f.close(); }
});

test("display result refuses foreign identities, injected fields, and distinguishes pending, denied and missing", async () => {
  for (const [settings, expected] of [
    [{ result: { ...saved, cabinetId: other } }, 502],
    [{ result: { ...saved, display: { ...display, modes: [{ ...display.modes[0], monitorPath: "patient" }] } } }, 502],
    [{ result: { ...saved, state: "pending", completedAtUtc: null, display: null } }, 200],
    [{ status: 401 }, 303], [{ status: 403 }, 403], [{ status: 404 }, 200],
    [{ pinnedStatus: 404 }, 404],
  ]) {
    const f = await fixture(settings);
    try {
      const path = settings.pinnedStatus ? `/cabinet/${cabinet}/display/${action}` : `/cabinet/${cabinet}/display`;
      const response = await f.request(path, f.cookie);
      assert.equal(response.status, expected);
      if (settings.status === 404) assert.match(await response.text(), /No saved display observation/);
      if (settings.result?.state === "pending") assert.match(await response.text(), /pending/i);
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    assert.equal((await f.request(`/cabinet/${cabinet}/display?bad=1`, f.cookie)).status, 400);
    assert.equal((await f.request(`/cabinet/${cabinet}/display/${nextAction}`, f.cookie)).status, 404);
    assert.equal((await f.request("/cabinet/no/display", f.cookie)).status, 404);
  } finally { await f.close(); }
});
