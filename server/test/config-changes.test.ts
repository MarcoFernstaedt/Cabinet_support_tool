// The one write to config_changes from outside its owner, moved behind it (F21.R2, decision-log D66): a cabinet's recent changes are
// marked as violating its baseline from the drift as it stands. The cabinet id is checked first, and a repeat changes nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { markBaselineViolations } from "../src/services/config-ingest.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function cabinet(): Promise<string> {
  const client = randomUUID(), site = randomUUID(), k = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'K', 'standalone', 'active')", [k, site]);
  return k;
}
const change = (k: string, item: string, daysAgo: number) => db.app.query(
  "INSERT INTO config_changes (cabinet_id, version_id, category, item_key, change, fields, observed_at) VALUES ($1, 1, 'services', $2, 'changed', '{}', DATEADD(day, -$3, SYSUTCDATETIME()))",
  [k, item, daysAgo]);
const drift = (k: string, item: string) => db.app.query(
  "INSERT INTO cabinet_drift (cabinet_id, category, item_key, field, mode, origin, severity, first_seen, last_seen) VALUES ($1, 'services', $2, 'start', 'match', '{}', 'major', SYSUTCDATETIME(), SYSUTCDATETIME())",
  [k, item]);
const flags = async (k: string) => Object.fromEntries((await db.app.query<{ item_key: string; v: boolean | null }>(
  "SELECT item_key, violates_baseline AS v FROM config_changes WHERE cabinet_id = $1", [k])).rows.map(r => [r.item_key, r.v]));

test("a cabinet's recent changes are marked from its drift as it stands; a repeat changes nothing; older changes and other cabinets are left alone", async () => {
  const [k, other] = [await cabinet(), await cabinet()];
  await change(k, "Spooler", 1);       // against its baseline now
  await change(k, "W32Time", 2);       // matches
  await change(k, "Old", 40);          // older than 30 days: left as it was
  await change(other, "Spooler", 1);   // another cabinet's: not this one's drift
  await drift(k, "Spooler");
  await drift(k, "Old");
  await markBaselineViolations(db.app, k);
  const once = await flags(k);
  assert.equal(once.Spooler, true);
  assert.equal(once.W32Time, false);
  assert.notEqual(once.Old, true, "a change older than 30 days is not re-marked");
  assert.notEqual((await flags(other)).Spooler, true);
  await markBaselineViolations(db.app, k);
  assert.deepEqual(await flags(k), once, "calling it again changes nothing");
  // The drift cleared: the next mark says so.
  await db.app.query("DELETE FROM cabinet_drift WHERE cabinet_id = $1", [k]);
  await markBaselineViolations(db.app, k);
  assert.equal((await flags(k)).Spooler, false);
});

test("anything but a cabinet id is refused before the database is touched", async () => {
  for (const bad of ["", "not-an-id", "' OR 1=1 --", `${randomUUID()}; DELETE FROM config_changes`, null, undefined, 42, {}])
    await assert.rejects(markBaselineViolations(db.app, bad as never), /cabinet id/, String(bad));
});
