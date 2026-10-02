import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewServer } from "../server.mjs";

const source = "11111111-1111-4111-8111-111111111111";
const target = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const first = "44444444-4444-4444-8444-444444444444";
const config = "55555555-5555-4555-8555-555555555555";
const from = "2026-09-01T00:00:00Z", to = "2026-09-02T00:00:00Z";
const row = { id: first, sourceCabinetId: source, targetCabinetId: target, configurationId: config,
  firstObservedUtc: "2026-09-01T00:00:00Z", lastObservedUtc: "2026-09-01T00:02:00Z", receivedUtc: "2026-09-01T02:00:00Z",
  successCount: 0, failureCount: 2, errorCount: 1, lastSuccessUtc: null, lastFailureUtc: "2026-09-01T00:02:00Z" };
const page = { sourceCabinetId: source, targetCabinetId: target, asOfUtc: "2026-09-02T01:00:00Z", fromUtc: from, toUtc: to,
  items: [row], nextCursor: "cursor-one" };
async function fixture({ result = page, status = 200, second = { ...page, items: [{ ...row, id: "11111111-1111-4111-8111-111111111110", successCount: 1, failureCount: 0, errorCount: 0, lastSuccessUtc: "2026-09-01T00:01:00Z", lastFailureUtc: null }], nextCursor: null } } = {}) {
  let active = true;
  const calls = [];
  const upstreamFetch = async (url, options) => {
    const targetUrl = new URL(url), path = targetUrl.pathname;
    calls.push({ path, query: targetUrl.searchParams, options });
    if (path === "/api/auth/login") return Response.json({ accessToken: "server-only-token", expiresAtUtc: new Date(Date.now() + 60000).toISOString() });
    if (path === "/api/auth/me") return active ? Response.json({ displayName: "Operator", role: "Tier2", isActive: true }) : new Response("", { status: 401 });
    if (path === `/api/connectivity/cabinets/${source}/history`) return status === 200 ? Response.json(targetUrl.searchParams.get("nextCursor") ? second : result) : new Response("", { status });
    if (path.startsWith("/api/connectivity/cabinets/")) return new Response("", { status: 404 });
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

test("bounded network history preserves observed/received times and honest reply and gap language", async () => {
  const f = await fixture();
  try {
    const url = `/cabinet/${source}/network-history?target=${target}`;
    assert.equal((await f.request(url)).status, 303);
    const res = await f.request(url, f.cookie);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /2 nonreplies/);
    assert.match(html, /1 local probe error/);
    assert.match(html, /2026-09-01T00:02:00Z/);
    assert.match(html, /2026-09-01T02:00:00Z/);
    assert.match(html, /coverage unknown|gaps.*unknown/i);
    assert.match(html, /cursor=cursor-one/);
    assert.doesNotMatch(html, /server-only-token|restored at|outage lasted|firewall caused/i);
    const next = await f.request(`/cabinet/${source}/network-history?target=${target}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&cursor=cursor-one`, f.cookie);
    assert.equal(next.status, 200);
    assert.match(await next.text(), /reply confirmed/i);
    assert.equal(f.calls.some(c => c.path === `/api/connectivity/cabinets/${source}/history` && c.query.get("nextCursor") === "cursor-one" && c.query.get("from") === from && c.query.get("to") === to), true);
    assert.equal(f.calls.some(c => c.path === `/api/connectivity/cabinets/${source}/history` && c.query.get("targetId") === target && c.options.headers.Authorization === "Bearer server-only-token"), true);
    f.revoke();
    assert.equal((await f.request(url, f.cookie)).status, 303);
  } finally { await f.close(); }
});

test("sub-millisecond order and .NET UTC offset survive both history pages", async () => {
  const serverFrom = "2026-09-01T00:00:00+00:00", serverTo = "2026-09-02T00:00:00+00:00";
  const newer = { ...row, lastObservedUtc: "2026-09-01T00:02:00.0000002+00:00" };
  const older = { ...row, id: "66666666-6666-4666-8666-666666666666", lastObservedUtc: "2026-09-01T00:02:00.0000001+00:00" };
  const result = { ...page, fromUtc: serverFrom, toUtc: serverTo, items: [newer, older] };
  const f = await fixture({ result, second: { ...result, items: [], nextCursor: null } });
  try {
    const firstPage = await f.request(`/cabinet/${source}/network-history?target=${target}`, f.cookie);
    assert.equal(firstPage.status, 200);
    const markup = await firstPage.text();
    assert.match(markup, /0000002\+00:00/);
    assert.match(markup, /0000001\+00:00/);
    const href = /<a href="([^"]+)">Older retained intervals<\/a>/.exec(markup)?.[1];
    assert.ok(href);
    const nextPage = await f.request(href.replaceAll("&amp;", "&"), f.cookie);
    assert.equal(nextPage.status, 200);
    assert.equal(f.calls.some(c => c.query.get("from") === serverFrom && c.query.get("to") === serverTo && c.query.get("nextCursor") === "cursor-one"), true);
  } finally { await f.close(); }
});

test("history navigation and response identities fail closed, with denial and empty retained history distinct", async () => {
  for (const [settings, expected] of [
    [{ status: 403 }, 403], [{ status: 401 }, 303], [{ status: 404 }, 404],
    [{ result: { ...page, items: [{ ...row, sourceCabinetId: other }] } }, 502],
    [{ result: { ...page, items: [], nextCursor: null } }, 200],
    [{ result: { ...page, items: [{ ...row, successCount: null, failureCount: null, errorCount: null, lastFailureUtc: null, evidenceUnavailable: true }], nextCursor: null } }, 200],
  ]) {
    const f = await fixture(settings);
    try {
      const res = await f.request(`/cabinet/${source}/network-history?target=${target}`, f.cookie);
      assert.equal(res.status, expected);
      if (settings.result?.items?.length === 0) assert.match(await res.text(), /No retained intervals/);
      if (settings.result?.items?.[0]?.evidenceUnavailable) assert.match(await res.text(), /Counts and outcome unknown/);
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    for (const url of [`/cabinet/no/network-history`, `/cabinet/${source}/network-history?target=no`, `/cabinet/${source}/network-history?cursor=..`, `/cabinet/${source}/network-history?bad=1`, `/cabinet/${source}/network-history?target=${target}&target=${target}`])
      assert.equal((await f.request(url, f.cookie)).status, url.includes("/no/") ? 404 : 400);
  } finally { await f.close(); }
});
