// Site installers (F6.R1, decision-log D35): one installer for up to N cabinets of one site (and, when named, one role), for D days.
// It stops at either limit and can be revoked early; every cabinet that uses it still waits for an Admin's approval, and that approval is
// held to the installer's site and role. The confirmation code is bound to the site and the limits. Through the real console routes and
// the real enrollment path on a real SQL Server.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SecretBox } from "../src/auth/secrets.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { reevaluationsSettled } from "../src/console-api/baseline-routes.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { ConsoleHarness, ORIGIN, type Account } from "./console-harness.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);
const call = h.call.bind(h);
let ada: Account, tier2: Account;

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  [ada, tier2] = [await h.account("admin"), await h.account("tier2")];
});
test.after(async () => { await reevaluationsSettled(); await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

async function newSite(): Promise<{ clientId: string; siteId: string; client: string; site: string }> {
  const clientId = randomUUID(), siteId = randomUUID(), tag = randomBytes(3).toString("hex");
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [clientId, `Client ${tag}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [siteId, clientId, `Site ${tag}`]);
  return { clientId, siteId, client: `Client ${tag}`, site: `Site ${tag}` };
}
/** A site installer's token made through the console route, confirmed with a code bound to exactly this site and these limits. */
async function siteToken(site: Record<string, unknown>, who: Account = ada) {
  const body = { site };
  return call("POST", "/api/admin/bootstrap-tokens", { ...body, stepUpToken: await h.codeToken(who, "token.create", "fleet", body) }, who);
}
const enroll = (token: string) => submitEnrollment(db.app, {
  csr: csrFor(ecKey()), bootstrapToken: token,
  fingerprints: { hostname: "CAB-" + randomBytes(2).toString("hex"), serialNumber: "SN-" + randomBytes(3).toString("hex"), macAddresses: [],
    provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 11", agentVersion: "0.3.1" },
}, "10.77.0.9");
async function approve(requestId: string, body: Record<string, unknown>) {
  const stepUpToken = await h.codeToken(ada, "enrollment.approve", requestId, body);
  return call("POST", `/api/admin/enrollments/${requestId}/approve`, { ...body, stepUpToken }, ada);
}

test("a site installer takes as many cabinets as it was made for and no more, each audited, and they arrive with their site and role filled in", async () => {
  const s = await newSite();
  const r = await siteToken({ siteId: s.siteId, role: "standalone", cabinets: 2, days: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cabinets, 2);
  const first = await enroll(r.body.token), second = await enroll(r.body.token);
  await assert.rejects(enroll(r.body.token), /bootstrap token/, "a third cabinet is refused");
  const row = (await db.app.query<{ uses: number; used: boolean }>(
    "SELECT uses, CAST(CASE WHEN used_at IS NULL THEN 0 ELSE 1 END AS bit) AS used FROM bootstrap_tokens WHERE id = $1", [r.body.id])).rows[0]!;
  assert.deepEqual([Number(row.uses), row.used], [2, true], "used up at its last cabinet");
  const submits = (await db.app.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'enrollment.submit' AND target_id IN ($1, $2)", [first, second])).rows;
  assert.ok(submits.length === 2 && submits.every(a => a.details.tokenId === r.body.id && a.details.siteId === s.siteId.toLowerCase()));
  const created = (await db.app.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'token.create' AND target_id = $1", [r.body.id])).rows[0]!;
  assert.deepEqual([created.details.siteId, created.details.role, created.details.cabinets], [s.siteId.toLowerCase(), "standalone", 2]);

  const pending = (await call("GET", "/api/admin/enrollments", undefined, ada)).body as { id: string; intended?: { client: string; site: string; role: string | null } }[];
  assert.deepEqual(pending.find(p => p.id === first)!.intended, { client: s.client, site: s.site, role: "standalone" });
  const listed = ((await call("GET", "/api/admin/bootstrap-tokens", undefined, ada)).body.tokens as { id: string; used: number; cabinets: number }[]).find(t => t.id === r.body.id)!;
  assert.deepEqual([listed.used, listed.cabinets], [2, 2]);
});

test("a cabinet from a site installer is approved at that site and with that role, or not at all", async () => {
  const s = await newSite(), other = await newSite();
  const t = await siteToken({ siteId: s.siteId, role: "satellite", cabinets: 3 });
  const requestId = await enroll(t.body.token);
  const base = { client: s.client, site: s.site, cabinet: "Sat 1", role: "satellite", baseline: { use: "capture" } };
  const elsewhere = await approve(requestId, { ...base, client: other.client, site: other.site });
  assert.equal(elsewhere.status, 409, JSON.stringify(elsewhere.body));
  assert.equal(elsewhere.body.error, "not_this_site");
  const wrongRole = await approve(requestId, { ...base, role: "standalone" });
  assert.equal(wrongRole.status, 409, JSON.stringify(wrongRole.body));
  assert.equal(wrongRole.body.error, "not_this_role");
  assert.equal((await db.app.query<{ status: string }>("SELECT status FROM enrollment_requests WHERE id = $1", [requestId])).rows[0]!.status, "pending", "refusals change nothing");
  const ok = await approve(requestId, base);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // A site installer with no role leaves the role to the approver.
  const anyRole = await siteToken({ siteId: s.siteId });
  assert.equal(anyRole.body.cabinets, 10, "10 cabinets unless the Admin says otherwise");
  const second = await enroll(anyRole.body.token);
  assert.equal((await approve(second, { ...base, cabinet: "Stand 1", role: "standalone" })).status, 200);
});

test("revoked or expired, a site installer enrolls nothing; a one-cabinet token is used once, as before", async () => {
  const s = await newSite();
  const t = await siteToken({ siteId: s.siteId, cabinets: 5 });
  const revoke = async (tokenId: string, who: Account = ada) =>
    call("POST", `/api/admin/bootstrap-tokens/${tokenId}/revoke`, { stepUpToken: await h.codeToken(who, "token.revoke", tokenId, {}) }, who);
  assert.equal((await revoke(t.body.id, tier2)).status, 403, "only an Admin stops one");
  assert.equal((await revoke(t.body.id)).status, 200);
  await assert.rejects(enroll(t.body.token), /bootstrap token/);
  assert.equal((await revoke(t.body.id)).status, 404, "not twice");
  const revoked = (await db.app.query("SELECT 1 AS x FROM audit_log WHERE action = 'token.revoke' AND target_id = $1", [t.body.id])).rows.length;
  assert.equal(revoked, 1);

  const old = await siteToken({ siteId: s.siteId, cabinets: 5, days: 2 });
  await db.app.query("UPDATE bootstrap_tokens SET expires_at = DATEADD(minute, -1, SYSUTCDATETIME()) WHERE id = $1", [old.body.id]);
  await assert.rejects(enroll(old.body.token), /bootstrap token/);

  const single = await createBootstrapToken(db.app, ada.id);
  await enroll(single.token);
  await assert.rejects(enroll(single.token), /bootstrap token/, "a one-cabinet token is still used once");
  assert.equal((await revoke(single.id)).status, 404, "a one-cabinet token is not a site installer to revoke");
});

test("the confirmation covers the site and the limits it was given; hostile or impossible requests make nothing", async () => {
  const s = await newSite();
  const count = async () => Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM bootstrap_tokens")).rows[0]!.n);
  const before = await count();
  // A code confirmed for 2 cabinets does not make one for 50.
  const confirmed = await h.codeToken(ada, "token.create", "fleet", { site: { siteId: s.siteId, cabinets: 2 } });
  const widened = await call("POST", "/api/admin/bootstrap-tokens", { site: { siteId: s.siteId, cabinets: 50 }, stepUpToken: confirmed }, ada);
  assert.equal(widened.status, 403, JSON.stringify(widened.body));
  for (const site of [{ siteId: s.siteId, cabinets: 0 }, { siteId: s.siteId, cabinets: 101 }, { siteId: s.siteId, days: 31 }, { siteId: s.siteId, cabinets: 2.5 },
    { siteId: s.siteId, role: "kiosk" }, { siteId: "North; DROP TABLE sites" }, { siteId: s.siteId, uses: 5 }])
    assert.equal((await siteToken(site)).status, 400, JSON.stringify(site));
  assert.equal((await siteToken({ siteId: randomUUID() })).status, 404, "a site that does not exist");
  assert.equal((await siteToken({ siteId: s.siteId }, tier2)).status, 403, "only an Admin makes one");
  assert.equal(await count(), before, "nothing was made");
  // The database holds the limits too, whatever writes to it.
  await assert.rejects(db.app.query("INSERT INTO bootstrap_tokens (id, token_hash, created_by, expires_at, site_id, max_uses) VALUES ($1, $2, $3, SYSUTCDATETIME(), $4, 500)",
    [randomUUID(), randomBytes(32), ada.id, s.siteId]));
  await assert.rejects(db.app.query("INSERT INTO bootstrap_tokens (id, token_hash, created_by, expires_at, max_uses) VALUES ($1, $2, $3, SYSUTCDATETIME(), 5)",
    [randomUUID(), randomBytes(32), ada.id]), "only a site installer is for more than one cabinet");
});
