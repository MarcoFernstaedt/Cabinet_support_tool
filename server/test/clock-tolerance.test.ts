// The clock tolerance, adjustable site by site (decision-log D109, 05-server-spec.md "Site policies"), through the real console routes on a
// real SQL Server: the site's own, else the client's, else the fleet's, else 120 seconds; the clock alert, the heartbeat, the cabinet's
// time facts, a fleet sync's verification and the diagnosis all follow the one that applies; who may set each level; every change audited
// with what it replaced and read back; and hostile values refused before anything is written.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SecretBox } from "../src/auth/secrets.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { transaction, type Pool } from "../src/db/db.js";
import { cabinetFindings, type CabinetEvidence } from "../src/diagnose/cabinet-findings.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { recordHeartbeat } from "../src/services/cabinets.js";
import { approveEnrollment, createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { verified } from "../src/services/fleet-jobs.js";
import { ISSUE } from "../src/services/rules.js";
import { upsertSetting } from "../src/services/settings.js";
import { cabinetTime, evaluateTime, setClockTolerance } from "../src/services/time.js";
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
/** A client with one site and one cabinet, with names no other test uses; returns the ids. */
async function place() {
  const tag = randomBytes(3).toString("hex");
  const r = await approveEnrollment(db.app, key, await pending(), { clientName: `Clock ${tag}`, siteName: "North", cabinetName: "ICU 1", role: "standalone" }, ada.id);
  return { cabinet: r.cabinetId, site: r.siteId, client: (await db.app.query<{ c: string }>("SELECT client_id AS c FROM sites WHERE id = $1", [r.siteId])).rows[0]!.c };
}
/** A heartbeat as the agent server takes it: recorded, then the time check it asks for (agent-api/server.ts). Returns whether it asked. */
async function beat(cabinetId: string, clockSkewSeconds: number): Promise<boolean> {
  const r = await recordHeartbeat(db.app, cabinetId, { agentVersion: "0.3.1", uptimeSeconds: 100, readOnlyMode: false, clockSkewSeconds } as never);
  if (r.timeCheck) await evaluateTime(db.app, { cabinetId });
  return r.timeCheck;
}
const clockAlerts = async (cabinetId: string) => Number((await db.app.query<{ n: number }>(
  "SELECT COUNT(*) AS n FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved'", [cabinetId, ISSUE.clock])).rows[0]!.n);
const siteTolerance = async (siteId: string) => ((await call("GET", `/api/fleet/sites/${siteId}`, undefined, tier1)).body as { clockTolerance: unknown }).clockTolerance;
const audits = async (action: string) => (await db.app.query<{ details: unknown }>(
  "SELECT details FROM audit_log WHERE action = $1 ORDER BY seq", [action])).rows.map(r => detailsOf(r.details));
/** An audit entry's details, whichever form the driver gives them in. */
const detailsOf = (d: unknown) => (typeof d === "string" ? JSON.parse(d) : d) as Record<string, unknown>;
const clearFleet = () => db.app.query("DELETE FROM settings WHERE [key] = 'time.clockTolerance'");

test("the tolerance applies site, else client, else fleet, else 120 seconds, and the clock alert follows it at once", async () => {
  await clearFleet();
  const p = await place();
  await beat(p.cabinet, 45);
  assert.deepEqual(await siteTolerance(p.site), { own: null, client: null, seconds: 120, source: "default" });
  assert.equal(await clockAlerts(p.cabinet), 0, "45 seconds is within the built-in 120");

  const fleet = await call("PUT", "/api/settings/clock-tolerance", { seconds: 90 }, ada);
  assert.equal(fleet.status, 200);
  assert.deepEqual(fleet.body, { seconds: 90 }, "the answer is read back");
  assert.deepEqual(await siteTolerance(p.site), { own: null, client: null, seconds: 90, source: "fleet" });

  const client = await call("PUT", `/api/clients/${p.client}/clock-tolerance`, { seconds: 60 }, tier2);
  assert.equal(client.status, 200);
  assert.deepEqual(client.body, { seconds: 60 });
  assert.equal(await clockAlerts(p.cabinet), 0, "45 seconds is within the client's 60");

  // The site's own is tighter: the alert opens with the write, without waiting for a heartbeat.
  const site = await call("PUT", `/api/sites/${p.site}/clock-tolerance`, { seconds: 30 }, tier2);
  assert.equal(site.status, 200);
  assert.deepEqual(site.body, { own: 30, client: 60, fleet: 90, seconds: 30, source: "site" }, "what applies, read back after the write");
  assert.equal(await clockAlerts(p.cabinet), 1, "45 seconds is outside the site's 30");
  const facts = (await cabinetTime(db.app, p.cabinet))!;
  assert.equal(facts.clockOff, true);
  assert.equal(facts.clockToleranceSeconds, 30);

  // Clearing the site's own goes back to the client's 60, and the alert closes, audited as the time check's.
  const cleared = await call("PUT", `/api/sites/${p.site}/clock-tolerance`, { seconds: null }, tier2);
  assert.deepEqual(cleared.body, { own: null, client: 60, fleet: 90, seconds: 60, source: "client" });
  assert.equal(await clockAlerts(p.cabinet), 0);
  assert.equal((await cabinetTime(db.app, p.cabinet))!.clockOff, false);
  await clearFleet();
});

test("a heartbeat judges the clock against its site's tolerance, not the built-in one", async () => {
  await clearFleet();
  const p = await place();
  await beat(p.cabinet, 0);
  await call("PUT", `/api/sites/${p.site}/clock-tolerance`, { seconds: 20 }, tier2);
  assert.equal(await beat(p.cabinet, 50), true, "the heartbeat asks for the time check");
  assert.equal(await clockAlerts(p.cabinet), 1, "50 seconds off at a site that allows 20");
  await beat(p.cabinet, 5);
  assert.equal(await clockAlerts(p.cabinet), 0, "back within 20, the next heartbeat closes it");
});

test("a fleet sync is verified against the same tolerance as the alert, and the diagnosis says so in seconds", async () => {
  await clearFleet();
  const p = await place();
  await call("PUT", `/api/sites/${p.site}/clock-tolerance`, { seconds: 30 }, tier2);
  const at = new Date(Date.now() - 60_000);
  await beat(p.cabinet, 50);
  const creator = { userId: tier2.id, role: "tier2" as const };
  assert.equal(await verified(db.app, "time.sync", { cabinet_id: p.cabinet, params: {}, at }, creator), false, "50 seconds is not within the site's 30");
  await beat(p.cabinet, 10);
  assert.equal(await verified(db.app, "time.sync", { cabinet_id: p.cabinet, params: {}, at }, creator), true);

  const now = Date.parse("2026-10-19T12:00:00Z");
  const time = { ok: true as const, output: { timeZoneId: "Eastern Standard Time", timeZoneName: "Eastern", utcOffsetMinutes: -300, daylightSavingNow: true,
    localTime: "x", utcTime: "2026-10-19T12:00:45Z", timeService: "running" as const, sync: { state: "synced" as const, source: null, lastSuccessfulSync: "2026-10-19T08:00:00Z" },
    policyManaged: false } };
  const e = (clockToleranceSeconds?: number): CabinetEvidence => ({ cabinet: { id: p.cabinet, name: "ICU 1", role: "standalone" }, siteTimeZone: "Eastern Standard Time",
    now, time, ...(clockToleranceSeconds === undefined ? {} : { clockToleranceSeconds }) });
  const skew = (x: CabinetEvidence) => cabinetFindings(x).findings.find(f => f.id === "time-skew");
  assert.equal(skew(e()), undefined, "45 seconds is within the built-in 120");
  assert.equal(skew(e(30))?.title, "The clock is 45 seconds ahead of the server");
});

test("a site's and a client's are Tier 2 and up, the fleet's is Admin, and a refusal writes nothing", async () => {
  await clearFleet();
  const p = await place();
  for (const [url, who, status] of [
    [`/api/sites/${p.site}/clock-tolerance`, tier1, 403], [`/api/clients/${p.client}/clock-tolerance`, tier1, 403],
    ["/api/settings/clock-tolerance", tier2, 403], ["/api/settings/clock-tolerance", tier1, 403],
    [`/api/sites/${p.site}/clock-tolerance`, undefined, 401], ["/api/settings/clock-tolerance", undefined, 401],
  ] as const) assert.equal((await call("PUT", url, { seconds: 30 }, who)).status, status, `${url} as ${who?.role ?? "nobody"}`);
  assert.deepEqual(await siteTolerance(p.site), { own: null, client: null, seconds: 120, source: "default" });
  assert.equal((await db.app.query("SELECT 1 FROM settings WHERE [key] = 'time.clockTolerance'")).rows.length, 0);
});

test("every change is audited with what it replaced", async () => {
  await clearFleet();
  const p = await place();
  await call("PUT", `/api/sites/${p.site}/clock-tolerance`, { seconds: 40 }, tier2);
  await call("PUT", `/api/sites/${p.site}/clock-tolerance`, { seconds: 50 }, tier2);
  await call("PUT", `/api/clients/${p.client}/clock-tolerance`, { seconds: 70 }, tier2);
  await call("PUT", "/api/settings/clock-tolerance", { seconds: 100 }, ada);
  await call("PUT", "/api/settings/clock-tolerance", { seconds: null }, ada);
  const site = (await db.app.query<{ details: unknown; actor_id: string }>(
    "SELECT details, actor_id FROM audit_log WHERE action = 'site.clock_tolerance' AND target_id = $1 ORDER BY seq", [p.site])).rows;
  assert.deepEqual(site.map(r => detailsOf(r.details)), [{ before: null, seconds: 40 }, { before: 40, seconds: 50 }]);
  assert.equal(site[0]!.actor_id.toLowerCase(), tier2.id.toLowerCase());
  const client = (await db.app.query<{ details: unknown }>("SELECT details FROM audit_log WHERE action = 'client.clock_tolerance' AND target_id = $1 ORDER BY seq", [p.client])).rows;
  assert.deepEqual(client.map(r => detailsOf(r.details)), [{ before: null, seconds: 70 }]);
  assert.deepEqual((await audits("fleet.clock_tolerance")).slice(-2), [{ before: null, seconds: 100 }, { before: 100, seconds: null }]);
});

test("hostile values are refused by the contract and by the service before anything is written", async () => {
  await clearFleet();
  const p = await place();
  const bodies: unknown[] = [{ seconds: 9 }, { seconds: 121 }, { seconds: 0 }, { seconds: -30 }, { seconds: 30.5 }, { seconds: "30" }, { seconds: 1e9 },
    { seconds: [30] }, { seconds: { n: 30 } }, { seconds: true }, {}, { seconds: 30, extra: 1 }, [], "30", null];
  for (const url of [`/api/sites/${p.site}/clock-tolerance`, `/api/clients/${p.client}/clock-tolerance`, "/api/settings/clock-tolerance"])
    for (const body of bodies) assert.equal((await call("PUT", url, body, ada)).status, 400, `${url} ${JSON.stringify(body)}`);
  for (const bad of [randomUUID(), "not-a-site", "1' OR '1'='1"])
    assert.equal((await call("PUT", `/api/sites/${encodeURIComponent(bad)}/clock-tolerance`, { seconds: 30 }, ada)).status, 404, bad);
  assert.deepEqual(await siteTolerance(p.site), { own: null, client: null, seconds: 120, source: "default" });
  const n = Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('site.clock_tolerance', 'client.clock_tolerance') AND target_id IN ($1, $2)",
    [p.site, p.client])).rows[0]!.n);
  assert.equal(n, 0, "nothing refused was audited");

  // The service checks the value itself, before it reaches the database.
  const untouched = new Proxy({}, { get() { throw new Error("reached the database"); } }) as Pool;
  for (const v of [9, 121, 30.5, NaN, Infinity, "30", undefined, {}])
    await assert.rejects(setClockTolerance(untouched, ada.id, { siteId: p.site }, v as never), (err: Error) => /a clock tolerance is a whole number of seconds/.test(err.message), String(v));
});

test("the column checks are the backstop, and a fleet value edited outside the platform is ignored", async () => {
  await clearFleet();
  const p = await place();
  for (const v of [9, 121, -1]) await assert.rejects(db.app.query("UPDATE sites SET clock_tolerance_seconds = $2 WHERE id = $1", [p.site, v]), String(v));
  for (const v of [9, 0]) await assert.rejects(db.app.query("UPDATE clients SET clock_tolerance_seconds = $2 WHERE id = $1", [p.client, v]), String(v));
  for (const stored of [{ seconds: 5 }, { seconds: 500 }, { seconds: "x" }, { seconds: [60] }, { other: 60 }]) {
    await transaction(db.app, c => upsertSetting(c, "time.clockTolerance", stored, ada.id));
    assert.deepEqual(await siteTolerance(p.site), { own: null, client: null, seconds: 120, source: "default" }, JSON.stringify(stored));
    assert.deepEqual((await call("GET", "/api/settings/clock-tolerance", undefined, tier1)).body, { seconds: null });
  }
  await clearFleet();
});
