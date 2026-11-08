// Last known healthy has one definition (F8.R1, decision-log D41): the health evaluation's, the one "changed since healthy" compares
// against. The cabinet's own page and its configuration health say the same thing, whatever alerts or contact the cabinet has; with no
// time to give, the reason is said instead (not judged yet, no configuration, no baseline, never healthy). Through the real console
// routes on a real SQL Server.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SecretBox } from "../src/auth/secrets.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { evaluateHealth } from "../src/services/cabinet-health.js";
import { ConsoleHarness, ORIGIN, type Account } from "./console-harness.js";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);
const call = h.call.bind(h);
let t1: Account;
let siteId: string;

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  t1 = await h.account("tier1");
  const clientId = randomUUID();
  siteId = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour')", [clientId]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Pier')", [siteId, clientId]);
});
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

async function newCabinet(heartbeatMinutesAgo = 0) {
  const id = randomUUID();
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES ($1, $2, $3, 'standalone', 'active', DATEADD(minute, -$4, SYSUTCDATETIME()))",
    [id, siteId, `K ${id.slice(0, 6)}`, heartbeatMinutesAgo]);
  return id;
}
/** The health the evaluation stored, set directly: what is under test is that every reader takes it from there. */
const judged = (id: string, state: string, lastHealthyHoursAgo: number | null, reasons: { code: string; text: string }[] = []) => db.app.query(
  `INSERT INTO cabinet_health (cabinet_id, state, evaluated_at, since, reasons, last_healthy_at)
   VALUES ($1, $2, SYSUTCDATETIME(), SYSUTCDATETIME(), $3, CASE WHEN $4 IS NULL THEN NULL ELSE DATEADD(hour, -CAST($4 AS int), SYSUTCDATETIME()) END)`,
  [id, state, JSON.stringify(reasons), lastHealthyHoursAgo]);
async function both(id: string) {
  const page = await call("GET", `/api/fleet/cabinets/${id}`, undefined, t1);
  const condition = await call("GET", `/api/cabinets/${id}/condition`, undefined, t1);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(condition.status, 200, JSON.stringify(condition.body));
  return { page: page.body, condition: condition.body };
}
const hoursAgo = (iso: string) => (Date.now() - Date.parse(iso)) / 3_600_000;

test("the cabinet's page gives the health evaluation's last known healthy, whatever its alerts or contact say", async () => {
  // Judged healthy, with an open minor alert from three hours ago: healthy now on the page as on the health tab.
  const fine = await newCabinet();
  await judged(fine, "healthy", 0);
  await asOwner(db, c => c.query(`INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen)
    SELECT $1, id, 'minor', 'issue:lkh', 'x', DATEADD(hour, -3, SYSUTCDATETIME()), SYSUTCDATETIME() FROM issue_types WHERE id = '00000000-0000-4000-8000-000000000109'`, [fine]));
  let r = await both(fine);
  assert.deepEqual([r.page.lastHealthy.now, r.condition.state], [true, "healthy"]);
  // Degraded since being healthy 5 hours ago, though online with nothing open: 5 hours ago on both.
  const sick = await newCabinet();
  await judged(sick, "degraded", 5, [{ code: "required_item", text: "service:Spooler is not as the baseline requires." }]);
  r = await both(sick);
  assert.equal(r.page.lastHealthy.now, false);
  assert.equal(r.page.lastHealthy.at, r.condition.lastHealthyAt, "one value");
  assert.ok(Math.abs(hoursAgo(r.page.lastHealthy.at) - 5) < 0.1);
  assert.equal(r.page.lastHealthyAt, r.page.lastHealthy.at);
  // Offline for two hours, last healthy a day ago: a day ago, not when it was last heard from.
  const gone = await newCabinet(120);
  await judged(gone, "offline", 24, [{ code: "no_contact", text: "Not heard from." }]);
  r = await both(gone);
  assert.ok(Math.abs(hoursAgo(r.page.lastHealthy.at) - 24) < 0.1);
});

test("with no time to give, the page says why: not judged yet, no configuration, no baseline, or never healthy", async () => {
  const fresh = await newCabinet();
  assert.deepEqual((await both(fresh)).page.lastHealthy, { now: false, at: null, reason: "not_evaluated" }, "online and clear is not the same as judged healthy");
  // The real evaluation of a cabinet that has reported nothing.
  await evaluateHealth(db.app, fresh);
  assert.deepEqual((await both(fresh)).page.lastHealthy, { now: false, at: null, reason: "no_configuration" });
  const noBaseline = await newCabinet();
  await judged(noBaseline, "unknown", null, [{ code: "no_baseline", text: "No approved baseline applies." }]);
  assert.equal((await both(noBaseline)).page.lastHealthy.reason, "no_baseline");
  const never = await newCabinet();
  await judged(never, "degraded", null, [{ code: "critical_alert", text: "Drive failing" }]);
  assert.equal((await both(never)).page.lastHealthy.reason, "never_healthy");
});
