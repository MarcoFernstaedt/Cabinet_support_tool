// A fix closes its alert on a verified read, with the before and after in the audit trail (F18.R1, decision-log D47). The alert is closed
// by the cabinet's own next reading, as before; the close now names the platform write it verifies (who, when, which operation) with
// that write's before and after as the cabinet reported them, or null when nothing the platform did since the alert opened explains it.
// Through the real time check on a real SQL Server.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_DIR } from "@mashura/cabinet-contracts/load";
import { BEFORE_AFTER_PAIRS, beforeAfter, fixingOperations } from "../src/services/automatic-close.js";
import { ISSUE } from "../src/services/rules.js";
import { evaluateTime } from "../src/services/time.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
let siteId: string;
const userId = randomUUID();
test.before(async () => {
  db = await createTestDatabase();
  const clientId = randomUUID();
  siteId = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'fix.person', 'Fix Person', 'tier1')", [userId]);
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour')", [clientId]);
  await db.app.query("INSERT INTO sites (id, client_id, name, time_zone) VALUES ($1, $2, 'Pier', 'Eastern Standard Time')", [siteId, clientId]);
});
test.after(async () => { await db.drop(); });

async function cabinetInWrongZone() {
  const id = randomUUID();
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at, time_zone_id) VALUES ($1, $2, $3, 'standalone', 'active', SYSUTCDATETIME(), 'Pacific Standard Time')",
    [id, siteId, `K ${id.slice(0, 6)}`]);
  await evaluateTime(db.app, { cabinetId: id });
  return id;
}
/** A time.setZone the platform ran on the cabinet, answered with the before and after the agent reports. */
const setZoneRan = (cabinetId: string, minutesAgo: number) => db.app.query(
  `INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result, result_at)
   VALUES ($1, $2, 'time.setZone', '{"timeZoneId":"Eastern Standard Time"}', $3, DATEADD(minute, -$4, SYSUTCDATETIME()), DATEADD(minute, 2 - $4, SYSUTCDATETIME()), 'succeeded', $5, DATEADD(minute, -$4, SYSUTCDATETIME()))`,
  [randomUUID(), cabinetId, userId, minutesAgo, JSON.stringify({ status: "succeeded", output: { before: "Pacific Standard Time", after: "Eastern Standard Time" } })]);
const closeAudit = async (cabinetId: string) => (await db.app.query<{ details: { verifiedFix: { operation: string; by: string; before: unknown; after: unknown } | null; automatic: boolean } }>(
  `SELECT l.details FROM audit_log l JOIN alerts a ON LOWER(CONVERT(nvarchar(64), a.id)) = l.target_id
    WHERE l.action = 'alert.resolve' AND a.cabinet_id = $1 AND a.issue_type_id = $2`, [cabinetId, ISSUE.timeZone])).rows;

test("a zone fix the platform made is named in the close the cabinet's next reading verifies, with its before and after", async () => {
  const k = await cabinetInWrongZone();
  assert.equal(Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2 AND state = 'open'", [k, ISSUE.timeZone])).rows[0]!.n), 1);
  await setZoneRan(k, 0);
  // The cabinet's next report shows the site's zone: the reading verifies the fix and closes the alert.
  await db.app.query("UPDATE cabinets SET time_zone_id = 'Eastern Standard Time' WHERE id = $1", [k]);
  await evaluateTime(db.app, { cabinetId: k });
  const [a] = await closeAudit(k);
  assert.equal(a!.details.automatic, true);
  assert.deepEqual([a!.details.verifiedFix?.operation, a!.details.verifiedFix?.by, a!.details.verifiedFix?.before, a!.details.verifiedFix?.after],
    ["time.setZone", "Fix Person", "Pacific Standard Time", "Eastern Standard Time"]);
});

test("a close nothing the platform did explains says so (null), and a fix from before the alert opened is not credited", async () => {
  const fixedItself = await cabinetInWrongZone();
  await db.app.query("UPDATE cabinets SET time_zone_id = 'Eastern Standard Time' WHERE id = $1", [fixedItself]);
  await evaluateTime(db.app, { cabinetId: fixedItself });
  assert.equal((await closeAudit(fixedItself))[0]!.details.verifiedFix, null);

  const older = randomUUID();
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at, time_zone_id) VALUES ($1, $2, $3, 'standalone', 'active', SYSUTCDATETIME(), 'Pacific Standard Time')",
    [older, siteId, `K ${older.slice(0, 6)}`]);
  await setZoneRan(older, 60);
  await evaluateTime(db.app, { cabinetId: older });
  await db.app.query("UPDATE cabinets SET time_zone_id = 'Eastern Standard Time' WHERE id = $1", [older]);
  await evaluateTime(db.app, { cabinetId: older });
  assert.equal((await closeAudit(older))[0]!.details.verifiedFix, null, "a write from before the alert opened did not fix it");
});

test("every operation credited as a fix reports a before and after the close can carry (review of #201: renewLease names its pair addressBefore/addressAfter)", () => {
  const operations = [...new Set(Object.values(fixingOperations()).flat())];
  for (const op of operations) {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "operations", `${op}.schema.json`), "utf8")) as { $defs: { output: { required?: string[] } } };
    const required = schema.$defs.output.required ?? [];
    assert.ok(BEFORE_AFTER_PAIRS.some(([b, a]) => required.includes(b) && required.includes(a)), `${op} returns none of the before/after pairs: ${required.join(", ")}`);
  }
  assert.deepEqual(beforeAfter({ interfaceIndex: 12, result: "renewed", message: "ok", addressBefore: "10.40.0.20", addressAfter: "10.40.0.21" }),
    { before: "10.40.0.20", after: "10.40.0.21" });
  assert.deepEqual(beforeAfter({ result: "synced", message: "ok", lastSuccessfulSyncBefore: "2026-11-08T09:00:00Z", lastSuccessfulSyncAfter: "2026-11-08T10:00:00Z" }),
    { before: "2026-11-08T09:00:00Z", after: "2026-11-08T10:00:00Z" });
});
