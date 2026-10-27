// Site policies with fleet → client → site inheritance (docs/spec/05-server-spec.md "Site policies"), through the real console routes on
// a real SQL Server: the firewall policy's site level (what a cabinet is held to, the drift alert, who may set it), the time zone's client
// and fleet defaults (the wrong-zone alert and the fleet operation follow the zone that applies), and a new site's policies confirmed with
// its first approval (pre-filled from what it would inherit; refused for an existing site).
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SecretBox } from "../src/auth/secrets.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { recordHeartbeat } from "../src/services/cabinets.js";
import { approveEnrollment, createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { cabinetPolicy } from "../src/services/firewall-policy.js";
import { plan } from "../src/services/fleet-jobs.js";
import { ISSUE } from "../src/services/rules.js";
import { cabinetTime } from "../src/services/time.js";
import { ConsoleHarness, ORIGIN, type Account } from "./console-harness.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
let key: Awaited<ReturnType<typeof developmentIssuingKey>>;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);
const call = h.call.bind(h);
let ada: Account, tier2: Account, tier1: Account;

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  key = await developmentIssuingKey(tempDir());
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  [ada, tier2, tier1] = [await h.account("admin"), await h.account("tier2"), await h.account("tier1")];
});
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

async function pending(): Promise<string> {
  const { token } = await createBootstrapToken(db.app, ada.id);
  return submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: { hostname: "CAB-" + randomBytes(2).toString("hex"),
    serialNumber: null, macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 11", agentVersion: "0.3.1" } }, "10.0.0.9");
}
/** A client with one site and one online cabinet; returns the ids. */
async function place(clientName: string) {
  const r = await approveEnrollment(db.app, key, await pending(), { clientName, siteName: "North", cabinetName: "ICU 1", role: "standalone" }, ada.id);
  return { cabinet: r.cabinetId, site: r.siteId, client: (await db.app.query<{ c: string }>("SELECT client_id AS c FROM sites WHERE id = $1", [r.siteId])).rows[0]!.c };
}
const beat = (cabinetId: string, extra: Record<string, unknown>) => recordHeartbeat(db.app, cabinetId, { agentVersion: "0.3.1", uptimeSeconds: 100, readOnlyMode: false, ...extra } as never);
const put = async (url: string, action: string, target: string, body: Record<string, unknown>, who: Account = ada) =>
  call("PUT", url, { ...body, stepUpToken: await h.codeToken(who, action, target, body) }, who);
const openAlert = async (cabinetId: string, issue: string) => Number((await db.app.query<{ n: number }>(
  "SELECT COUNT(*) AS n FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved'", [cabinetId, issue])).rows[0]!.n);
const ON = { domain: "on", private: "on", public: "on" }, OFF = { domain: "off", private: "off", public: "off" };
const PUBLIC_ONLY = { domain: "off", private: "off", public: "on" };

test("the firewall policy applies site, else client, else fleet, and the drift alert follows the one that applies", async () => {
  const p = await place("Firewall Health");
  await beat(p.cabinet, { firewallProfiles: { domain: false, private: false, public: false } });
  assert.equal((await cabinetPolicy(db.app, p.cabinet)).source, "fleet");
  assert.equal(await openAlert(p.cabinet, ISSUE.firewallPolicy), 0, "all off, like the fleet default");

  assert.equal((await put(`/api/clients/${p.client}/firewall-policy`, "client.firewall_policy", p.client, { policy: ON })).status, 200);
  assert.equal((await cabinetPolicy(db.app, p.cabinet)).source, "client");
  assert.equal(await openAlert(p.cabinet, ISSUE.firewallPolicy), 1, "the client says on: the cabinet differs");

  // The site's own policy wins over the client's, and the alert closes when the cabinet matches it.
  const set = await put(`/api/sites/${p.site}/firewall-policy`, "site.firewall_policy", p.site, { policy: OFF });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const read = await call("GET", `/api/sites/${p.site}/firewall-policy`, undefined, tier1);
  assert.deepEqual([read.body.own, read.body.client, read.body.source], [OFF, ON, "site"]);
  assert.deepEqual((await cabinetPolicy(db.app, p.cabinet)).policy, OFF);
  assert.equal(await openAlert(p.cabinet, ISSUE.firewallPolicy), 0, "the site's own policy is all off, which the cabinet matches");

  // Removing the site's own sends it back to the client's.
  assert.equal((await put(`/api/sites/${p.site}/firewall-policy`, "site.firewall_policy", p.site, { policy: null })).status, 200);
  assert.equal((await cabinetPolicy(db.app, p.cabinet)).source, "client");
  assert.equal(await openAlert(p.cabinet, ISSUE.firewallPolicy), 1);
  const audited = (await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'site.firewall_policy' AND target_id = $1", [p.site])).rows[0]!.n;
  assert.equal(Number(audited), 2);
});

test("only an Admin with a code bound to the exact policy sets a site's; hostile bodies are refused", async () => {
  const p = await place("Guarded Health");
  for (const who of [tier1, tier2]) {
    const r = await put(`/api/sites/${p.site}/firewall-policy`, "site.firewall_policy", p.site, { policy: ON }, who);
    assert.equal(r.status, 403, JSON.stringify(r.body));
  }
  // A code confirmed for "all off" does not set "all on".
  const forOff = await h.codeToken(ada, "site.firewall_policy", p.site, { policy: OFF });
  assert.equal((await call("PUT", `/api/sites/${p.site}/firewall-policy`, { policy: ON, stepUpToken: forOff }, ada)).status, 403);
  for (const policy of [{ domain: "on" }, { domain: true, private: false, public: false }, { ...ON, extra: "on" }, "on", { domain: "ON", private: "on", public: "on" }]) {
    const r = await call("PUT", `/api/sites/${p.site}/firewall-policy`, { policy, stepUpToken: "A".repeat(43) }, ada);
    assert.equal(r.status, 400, `${JSON.stringify(policy)} → ${JSON.stringify(r.body)}`);
  }
  const missing = randomUUID();
  assert.equal((await put(`/api/sites/${missing}/firewall-policy`, "site.firewall_policy", missing, { policy: ON })).status, 404);
  assert.equal((await db.app.query<{ p: string | null }>("SELECT firewall_policy AS p FROM sites WHERE id = $1", [p.site])).rows[0]!.p, null, "nothing was written");
});

test("the time zone applies site, else client, else fleet: the alert, the cabinet's time facts and the fleet operation agree", async () => {
  const p = await place("Zone Health");
  await beat(p.cabinet, { timeZoneId: "Eastern Standard Time", clockSkewSeconds: 0 });
  assert.equal((await cabinetTime(db.app, p.cabinet))!.siteTimeZone, null, "no zone anywhere: none is checked");

  // The fleet default: the cabinet is in another zone, so it is wrong, and the fleet operation would set it.
  assert.equal((await call("PUT", "/api/settings/time-zone", { timeZone: "Pacific Standard Time" }, ada)).status, 200);
  assert.equal(await openAlert(p.cabinet, ISSUE.timeZone), 1);
  assert.deepEqual((await plan(db.app, "time.setZone", [p.cabinet]))[0]!.params, { timeZoneId: "Pacific Standard Time" });
  let site = (await call("GET", `/api/fleet/sites/${p.site}`, undefined, tier1)).body;
  assert.deepEqual(site.timeZoneApplies, { zone: "Pacific Standard Time", source: "fleet" });

  // The client's default wins over the fleet's: Eastern, which the cabinet uses, so the alert closes.
  assert.equal((await call("PUT", `/api/clients/${p.client}/time-zone`, { timeZone: "Eastern Standard Time" }, tier2)).status, 200);
  assert.equal(await openAlert(p.cabinet, ISSUE.timeZone), 0);
  assert.equal((await plan(db.app, "time.setZone", [p.cabinet]))[0]!.skip, "Already in its site's time zone.");
  site = (await call("GET", `/api/fleet/sites/${p.site}`, undefined, tier1)).body;
  assert.deepEqual(site.timeZoneApplies, { zone: "Eastern Standard Time", source: "client" });
  assert.equal((await call("GET", `/api/fleet/clients/${p.client}`, undefined, tier1)).body.timeZone.own, "Eastern Standard Time");

  // The site's own wins over both.
  assert.equal((await call("PUT", `/api/sites/${p.site}/time-zone`, { timeZone: "Central Standard Time" }, tier2)).status, 200);
  assert.equal(await openAlert(p.cabinet, ISSUE.timeZone), 1);
  assert.equal((await cabinetTime(db.app, p.cabinet))!.siteTimeZone, "Central Standard Time");

  // Clearing the site's and the client's: back to the fleet default.
  await call("PUT", `/api/sites/${p.site}/time-zone`, { timeZone: null }, tier2);
  await call("PUT", `/api/clients/${p.client}/time-zone`, { timeZone: null }, tier2);
  assert.equal((await cabinetTime(db.app, p.cabinet))!.siteTimeZone, "Pacific Standard Time");
  assert.equal((await call("PUT", "/api/settings/time-zone", { timeZone: null }, ada)).status, 200);
  assert.equal(await openAlert(p.cabinet, ISSUE.timeZone), 0, "no zone set anywhere: nothing is wrong");
  const audited = (await db.app.query<{ action: string }>("SELECT DISTINCT action FROM audit_log WHERE action IN ('client.time_zone', 'fleet.time_zone')")).rows.map(r => r.action).sort();
  assert.deepEqual(audited, ["client.time_zone", "fleet.time_zone"]);
});

test("who sets which zone, and hostile zones are refused", async () => {
  const p = await place("Zone Guard Health");
  assert.equal((await call("PUT", `/api/clients/${p.client}/time-zone`, { timeZone: "Eastern Standard Time" }, tier1)).status, 403);
  assert.equal((await call("PUT", "/api/settings/time-zone", { timeZone: "Eastern Standard Time" }, tier2)).status, 403, "the fleet default is an Admin's");
  for (const timeZone of ["UTC", "Eastern Standard Time; Set-TimeZone UTC", "", 5, ["Eastern Standard Time"]]) {
    assert.equal((await call("PUT", `/api/clients/${p.client}/time-zone`, { timeZone }, tier2)).status, 400, JSON.stringify(timeZone));
    assert.equal((await call("PUT", "/api/settings/time-zone", { timeZone }, ada)).status, 400, JSON.stringify(timeZone));
  }
  assert.equal((await call("PUT", `/api/clients/${randomUUID()}/time-zone`, { timeZone: null }, tier2)).status, 404);
});

test("a new site's policies are confirmed with its first approval; an existing site's are refused", async () => {
  const requestId = await pending();
  // What the new site would inherit, for the approval to pre-fill.
  const preview = await call("GET", `/api/admin/enrollments/${requestId}/site-policies?client=Policy%20Health&site=East`, undefined, ada);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body, { siteExists: false, firewall: { policy: OFF, source: "fleet" }, timeZone: { zone: null, source: null } });
  assert.equal((await call("GET", `/api/admin/enrollments/${requestId}/site-policies?client=A&site=B`, undefined, tier2)).status, 403);

  const body = { client: "Policy Health", site: "East", cabinet: "ICU 1", role: "standalone", baseline: { use: "capture" },
    sitePolicies: { firewall: PUBLIC_ONLY, timeZone: "Mountain Standard Time" } };
  const ok = await call("POST", `/api/admin/enrollments/${requestId}/approve`, { ...body, stepUpToken: await h.codeToken(ada, "enrollment.approve", requestId, body) }, ada);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const site = (await db.app.query<{ p: string; z: string }>("SELECT firewall_policy AS p, time_zone AS z FROM sites WHERE id = $1", [ok.body.siteId])).rows[0]!;
  assert.deepEqual([JSON.parse(site.p), site.z], [PUBLIC_ONLY, "Mountain Standard Time"]);
  const actions = (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY seq", [ok.body.siteId])).rows.map(r => r.action);
  assert.deepEqual(actions, ["site.firewall_policy", "site.time_zone"], "each policy is audited as its own change");

  // The same site again: it exists, so its policies are its page's, not an approval's. Nothing is approved.
  const again = await pending();
  const second = { ...body, cabinet: "ICU 2" };
  const refused = await call("POST", `/api/admin/enrollments/${again}/approve`, { ...second, stepUpToken: await h.codeToken(ada, "enrollment.approve", again, second) }, ada);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "site_policies_for_existing_site");
  assert.equal((await db.app.query<{ s: string }>("SELECT status AS s FROM enrollment_requests WHERE id = $1", [again])).rows[0]!.s, "pending");
  const existing = await call("GET", `/api/admin/enrollments/${again}/site-policies?client=Policy%20Health&site=East`, undefined, ada);
  assert.equal(existing.body.siteExists, true);

  // Leaving the policies out (or null) inherits: nothing is written on the site.
  const third = await pending();
  const inherit = { client: "Policy Health", site: "West", cabinet: "ICU 1", role: "standalone", baseline: { use: "capture" }, sitePolicies: { firewall: null, timeZone: null } };
  const r = await call("POST", `/api/admin/enrollments/${third}/approve`, { ...inherit, stepUpToken: await h.codeToken(ada, "enrollment.approve", third, inherit) }, ada);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const west = (await db.app.query<{ p: string | null; z: string | null }>("SELECT firewall_policy AS p, time_zone AS z FROM sites WHERE id = $1", [r.body.siteId])).rows[0]!;
  assert.deepEqual([west.p, west.z], [null, null]);
});

test("hostile site policies in an approval are refused before anything else runs", async () => {
  const requestId = await pending();
  const base = { client: "Hostile Health", site: "North", cabinet: "ICU 1", role: "standalone", baseline: { use: "capture" } };
  for (const sitePolicies of [{ timeZone: "UTC" }, { firewall: { domain: "off" } }, { firewall: { domain: true, private: true, public: true } }, { networkBaseline: {} },
    { timeZone: "Pacific Standard Time'; DROP TABLE sites;--" }, "default", [], { firewall: ON, extra: 1 }]) {
    const r = await call("POST", `/api/admin/enrollments/${requestId}/approve`, { ...base, sitePolicies, stepUpToken: "A".repeat(43) }, ada);
    assert.equal(r.status, 400, `${JSON.stringify(sitePolicies)} → ${JSON.stringify(r.body)}`);
  }
  assert.equal((await db.app.query("SELECT 1 AS x FROM clients WHERE name = 'Hostile Health'")).rows.length, 0, "nothing was created");
});
