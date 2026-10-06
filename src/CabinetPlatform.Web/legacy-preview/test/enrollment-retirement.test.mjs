import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewServer } from "../server.mjs";

const registration = "11111111-1111-4111-8111-111111111111";
const cabinet = "22222222-2222-4222-8222-222222222222";
const machineId = "synthetic-machine";
const pending = () => ({ id: registration, machineId, hostname: "<img src=x onerror=alert(1)>", status: "Pending", firstSeenUtc: "2026-01-01T00:00:00Z", lastSeenUtc: "2026-01-01T00:00:00Z" });
const detail = () => ({ cabinet: { id: cabinet, machineId, hostname: "<script>alert(1)</script>", isActive: true, siteId: "33333333-3333-4333-8333-333333333333", clientName: "Synthetic", siteName: "Test", role: "Satellite" }, site: { id: "33333333-3333-4333-8333-333333333333" } });
async function fixture() {
  const calls = [];
  let role = "Supervisor", active = true, pendingRow = pending(), cabinetDetail = detail(), pendingStatus = 200, cabinetStatus = 200, writeStatus = 204;
  const upstreamFetch = async (url, options = {}) => {
    const target = new URL(url); calls.push({ path: target.pathname + target.search, options });
    if (target.pathname === "/api/auth/login") return Response.json({ accessToken: "private-bearer", expiresAtUtc: new Date(Date.now() + 60000).toISOString() });
    if (target.pathname === "/api/auth/me") return active ? Response.json({ role, isActive: true, displayName: "Synthetic operator" }) : new Response("", { status: 401 });
    if (target.pathname === "/api/registrations/pending") return pendingStatus === 200 ? Response.json({ items: pendingRow ? [pendingRow] : [], page: 1, pageSize: 20, totalCount: pendingRow ? 1 : 0, hasMore: false }) : new Response("", { status: pendingStatus });
    if (target.pathname === `/api/cabinets/${cabinet}` && options.method !== "POST") return cabinetStatus === 200 ? Response.json(cabinetDetail) : new Response("", { status: cabinetStatus });
    if (options.method === "POST") {
      if (target.pathname.endsWith("/approve") && writeStatus === 204) return Response.json({ id: registration, machineId, status: "Approved" });
      return new Response(writeStatus === 204 ? null : "", { status: writeStatus });
    }
    throw Error(`Unexpected upstream ${target.pathname}`);
  };
  const server = createPreviewServer("127.0.0.1", { enabled: true, upstreamUrl: "https://127.0.0.1:8443/", upstreamFetch });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/signin`, { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "username=synthetic&password=synthetic" });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie");
  const request = (path, method = "GET", body = "", headers = {}) => fetch(origin + path, { method, redirect: "manual", headers: { cookie, ...(method === "POST" ? { origin, "content-type": "application/x-www-form-urlencoded" } : {}), ...headers }, ...(method === "POST" ? { body } : {}) });
  const close = () => new Promise(resolve => server.close(resolve));
  return { calls, origin, request, close, setRole: value => { role = value; }, revoke: () => { active = false; }, setPending: value => { pendingRow = value; }, setDetail: value => { cabinetDetail = value; }, setPendingStatus: value => { pendingStatus = value; }, setCabinetStatus: value => { cabinetStatus = value; }, setWriteStatus: value => { writeStatus = value; } };
}
const token = html => { const value = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1]; assert.ok(value); return value; };
const body = (csrf, extra = {}) => new URLSearchParams({ csrf, machineId, reason: "Synthetic test decision", ...extra }).toString();
const approval = (csrf, extra = {}) => body(csrf, { clientName: "Synthetic client", siteName: "Test site", departmentName: "Test department", role: "Satellite", ...extra });
const writes = f => f.calls.filter(c => c.options.method === "POST" && !c.path.startsWith("/api/auth/"));

test("supervisor queue is paged and escaped; confirmation names the target without secrets", async () => {
  const f = await fixture(); try {
    const queue = await f.request("/enrollment"); assert.equal(queue.status, 200);
    const text = await queue.text(); assert.match(text, /&lt;img/); assert.doesNotMatch(text, /<img|private-bearer|deviceKey|enrollmentToken/);
    assert.ok(f.calls.some(c => c.path === "/api/registrations/pending?Page=1&PageSize=20"));
    const confirm = await f.request(`/enrollment/${registration}/approve`); assert.equal(confirm.status, 200);
    const html = await confirm.text(); assert.match(html, /synthetic-machine/); assert.match(html, /&lt;img/); assert.ok(token(html));
  } finally { await f.close(); }
});

test("POST boundary refuses origin, csrf, role and oversized body before a write", async () => {
  const f = await fixture(); try {
    const csrf = token(await (await f.request(`/enrollment/${registration}/reject`)).text());
    for (const [path, payload, headers, expected] of [
      [`/enrollment/${registration}/reject`, body(csrf), { origin: "http://evil.test" }, 403],
      [`/enrollment/${registration}/reject`, body("bad"), {}, 403],
      [`/enrollment/${registration}/reject`, body(csrf, { reason: " " }), {}, 400],
      [`/enrollment/${registration}/approve`, approval(csrf, { role: "Administrator" }), {}, 400],
      [`/enrollment/${registration}/approve`, approval(csrf, { reason: "x".repeat(5000) }), {}, 400],
    ]) assert.equal((await f.request(path, "POST", payload, headers)).status, expected);
    f.setRole("Tier2"); assert.equal((await f.request(`/enrollment/${registration}/reject`, "POST", body(csrf))).status, 403);
    assert.equal((await f.request("/enrollment")).status, 403);
    f.setRole("Supervisor");
    const retireCsrf = token(await (await f.request(`/cabinet/${cabinet}/retire`)).text());
    assert.equal((await f.request(`/cabinet/${cabinet}/retire`, "POST", body(retireCsrf), { origin: "http://evil.test" })).status, 403);
    assert.equal((await f.request(`/cabinet/${cabinet}/retire`, "POST", body("bad"))).status, 403);
    f.setRole("Tier1");
    assert.equal((await f.request(`/cabinet/${cabinet}/retire`, "POST", body(retireCsrf))).status, 403);
    assert.equal(writes(f).length, 0);
  } finally { await f.close(); }
});

test("approval sends exact contract fields after fresh identity check and Server CAS owns decision", async () => {
  const f = await fixture(); try {
    const csrf = token(await (await f.request(`/enrollment/${registration}/approve`)).text());
    const res = await f.request(`/enrollment/${registration}/approve`, "POST", approval(csrf));
    assert.equal(res.status, 303); assert.equal(writes(f).length, 1);
    assert.equal(writes(f)[0].path, `/api/registrations/${registration}/approve`);
    assert.deepEqual(JSON.parse(writes(f)[0].options.body), { clientName: "Synthetic client", siteName: "Test site", departmentName: "Test department", role: "Satellite", approvalReason: "Synthetic test decision" });
    f.setWriteStatus(409); await f.request(`/enrollment/${registration}/approve`);
    assert.equal((await f.request(`/enrollment/${registration}/approve`, "POST", approval(csrf))).status, 409);
    f.setWriteStatus(204); await f.request(`/enrollment/${registration}/approve`);
    f.setPending({ ...pending(), hostname: "different-host" });
    assert.equal((await f.request(`/enrollment/${registration}/approve`, "POST", approval(csrf))).status, 409);
    f.setPending({ ...pending(), machineId: "changed" }); assert.equal((await f.request(`/enrollment/${registration}/approve`, "POST", approval(csrf))).status, 409);
    assert.equal(writes(f).length, 2);
  } finally { await f.close(); }
});

test("rejection and retirement require fresh matching identity; retirement copy does not promise erasure", async () => {
  const f = await fixture(); try {
    const rejectToken = token(await (await f.request(`/enrollment/${registration}/reject`)).text());
    assert.equal((await f.request(`/enrollment/${registration}/reject`, "POST", body(rejectToken))).status, 303);
    assert.deepEqual(JSON.parse(writes(f)[0].options.body), { reason: "Synthetic test decision" });
    const confirm = await f.request(`/cabinet/${cabinet}/retire`); assert.equal(confirm.status, 200);
    const html = await confirm.text(); assert.match(html, /operational access.*blocked/i); assert.match(html, /credential erasure.*unverified/i); assert.doesNotMatch(html, /<script>|private-bearer/);
    const csrf = token(html);
    f.setDetail({ ...detail(), cabinet: { ...detail().cabinet, machineId: "replacement" } });
    assert.equal((await f.request(`/cabinet/${cabinet}/retire`, "POST", body(csrf))).status, 409);
    f.setDetail(detail());
    await f.request(`/cabinet/${cabinet}/retire`);
    assert.equal((await f.request(`/cabinet/${cabinet}/retire`, "POST", body(csrf))).status, 303);
    assert.equal(writes(f)[1].path, `/api/cabinets/${cabinet}/retire`);
    assert.deepEqual(JSON.parse(writes(f)[1].options.body), { reason: "Synthetic test decision" });
  } finally { await f.close(); }
});

test("retirement refuses a site or role change after confirmation", async () => {
  const f = await fixture(); try {
    const csrf = token(await (await f.request(`/cabinet/${cabinet}/retire`)).text());
    const moved = detail(); moved.cabinet.siteId = "44444444-4444-4444-8444-444444444444";
    moved.site.id = moved.cabinet.siteId;
    f.setDetail(moved);
    assert.equal((await f.request(`/cabinet/${cabinet}/retire`, "POST", body(csrf))).status, 409);
    assert.equal(writes(f).length, 0);
    f.setDetail(detail());
    await f.request(`/cabinet/${cabinet}/retire`);
    const changed = detail(); changed.cabinet.role = "Sync";
    f.setDetail(changed);
    assert.equal((await f.request(`/cabinet/${cabinet}/retire`, "POST", body(csrf))).status, 409);
    assert.equal(writes(f).length, 0);
  } finally { await f.close(); }
});

test("valid maximum Unicode reason reaches the Server contract", async () => {
  const f = await fixture(); try {
    const csrf = token(await (await f.request(`/enrollment/${registration}/reject`)).text());
    const reason = "é".repeat(2000);
    assert.equal((await f.request(`/enrollment/${registration}/reject`, "POST", body(csrf, { reason }))).status, 303);
    assert.equal(JSON.parse(writes(f)[0].options.body).reason, reason);
  } finally { await f.close(); }
});

test("404, upstream denial, revocation and unavailable states never mutate", async () => {
  const f = await fixture(); try {
    const csrf = token(await (await f.request(`/enrollment/${registration}/reject`)).text());
    f.setPending(null); assert.equal((await f.request(`/enrollment/${registration}/reject`, "POST", body(csrf))).status, 404);
    f.setPending(pending()); f.setPendingStatus(403); assert.equal((await f.request("/enrollment")).status, 403);
    f.setPendingStatus(500); assert.equal((await f.request("/enrollment")).status, 502);
    f.setCabinetStatus(404); assert.equal((await f.request(`/cabinet/${cabinet}/retire`)).status, 404);
    f.setCabinetStatus(200); f.revoke(); assert.equal((await f.request(`/enrollment/${registration}/reject`, "POST", body(csrf))).status, 401);
    assert.equal(writes(f).length, 0);
    assert.equal((await f.request(`/enrollment/not-a-guid/approve`)).status, 404);
  } finally { await f.close(); }
});
