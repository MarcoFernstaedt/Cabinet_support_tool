// A rising unrecognised error is an alert, not only a mark on the trends page (F17, decision-log D50). After the nightly trends, each
// unrecognised error group marked rising opens one minor fleet pattern while any cabinet still has its alert open, even at one site; the
// minute sweep then counts it up and resolves it with the rest. Through the real nightly trend run and the real sweep on a real SQL Server.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unrecognizedSignature } from "../src/services/alerts.js";
import { runErrorTrends } from "../src/services/error-trends.js";
import { sweepFleetPatterns } from "../src/services/fleet-patterns.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
let clientId: string;
let cabinetId: string;
const DAY = 86_400_000;
const today = Math.floor(Date.now() / DAY) * DAY;
const day = (ago: number) => new Date(today - ago * DAY);

test.before(async () => {
  db = await createTestDatabase();
  clientId = randomUUID();
  const siteId = randomUUID();
  cabinetId = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour')", [clientId]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Pier')", [siteId, clientId]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES ($1, $2, 'K1', 'standalone', 'active', SYSUTCDATETIME())", [cabinetId, siteId]);
  // The trends are computed through yesterday, so the run below recomputes nothing and reads what is seeded here.
  await db.app.query("UPDATE trend_state SET computed_through = $1, computed_at = SYSUTCDATETIME() WHERE id = 1", [day(1)]);
});
test.after(async () => { await db.drop(); });

const sig = (source: string, eventId: number) => unrecognizedSignature({ kind: "error", source: { log: "System", source, eventId } } as never);
/** A group's daily counts, oldest first, ending yesterday. */
async function series(source: string, eventId: number, perDay: number[]) {
  for (let i = 0; i < perDay.length; i++)
    if (perDay[i]! > 0)
      await db.app.query("INSERT INTO error_daily ([day], client_id, [log], [source], event_id, issue_type_id, cabinets, [events], [sample]) VALUES ($1, $2, 'System', $3, $4, NULL, 1, $5, 'sample')",
        [day(perDay.length - i), clientId, source, eventId, perDay[i]]);
}
const openAlert = (source: string, eventId: number) => db.app.query(
  "INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen) VALUES ($1, NULL, 'minor', $2, $3, DATEADD(day, -6, SYSUTCDATETIME()), SYSUTCDATETIME())",
  [cabinetId, sig(source, eventId), `Unrecognised: ${source} ${eventId}`]);
const patterns = async (source: string, eventId: number) => (await db.app.query<{ title: string; severity: string; resolved_at: Date | null; sites: number }>(
  "SELECT title, severity, resolved_at, sites FROM fleet_patterns WHERE pattern_key = $1", [sig(source, eventId)])).rows;

test("an unrecognised error that is rising opens one minor fleet pattern at one site; the next night does not open a second", async () => {
  // 1 event in the week before, 3 a day this week: more than double, and at least 5.
  await series("Disk", 153, [0, 0, 0, 0, 0, 0, 1, 3, 3, 3, 3, 3, 3, 3]);
  await openAlert("Disk", 153);
  await runErrorTrends(db.app);
  const [p] = await patterns("Disk", 153);
  assert.ok(p, "a pattern opened");
  assert.equal(p.severity, "minor");
  assert.match(p.title, /^Fleet pattern: Rising: Disk event 153 \(System\), 21 events in the last 7 days, 1 the 7 before$/);
  assert.equal(Number(p.sites), 1, "one site is enough when it is rising");
  const audited = (await db.app.query<{ details: { rising?: { last7: number; prev7: number } } }>(
    "SELECT details FROM audit_log WHERE action = 'fleet_pattern.open' ORDER BY seq DESC")).rows[0]!;
  assert.deepEqual(audited.details.rising, { last7: 21, prev7: 1 });
  await runErrorTrends(db.app);
  assert.equal((await patterns("Disk", 153)).length, 1, "not opened twice");
});

test("a steady error, or a rising one nobody has open any more, opens nothing; the sweep resolves a rising pattern once its alerts close", async () => {
  await series("Steady", 7, [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
  await openAlert("Steady", 7);
  await series("Closed", 9, [0, 0, 0, 0, 0, 0, 0, 4, 4, 4, 4, 4, 4, 4]);
  await runErrorTrends(db.app);
  assert.deepEqual(await patterns("Steady", 7), [], "not rising");
  assert.deepEqual(await patterns("Closed", 9), [], "rising, but no alert of it is open");
  await db.app.query("UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME() WHERE signature = $1", [sig("Disk", 153)]);
  await sweepFleetPatterns(db.app);
  assert.ok((await patterns("Disk", 153))[0]!.resolved_at, "resolved with its alerts");
});
