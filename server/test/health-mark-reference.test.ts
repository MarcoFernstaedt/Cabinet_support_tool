// The healthy mark a cabinet's health points at is never pruned (F8.R2, decision-log D40). The prune keeps 30 days and always the
// newest 10, within a cap of 60; the mark in use is kept whatever its age or rank, and the database refuses to delete it by any
// other path. Removing the cabinet still removes both. On a real SQL Server.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { transaction } from "../src/db/db.js";
import { KEEP_MARKS, MAX_MARKS, pruneMarks } from "../src/services/cabinet-health.js";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db.drop(); });

async function cabinetWithMarks(count: number, daysOld: (i: number) => number): Promise<{ cabinetId: string; ids: number[] }> {
  const clientId = randomUUID(), siteId = randomUUID(), cabinetId = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [clientId, `C ${cabinetId.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [siteId, clientId]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'K', 'standalone', 'active')", [cabinetId, siteId]);
  const ids: number[] = [];
  for (let i = 0; i < count; i++)
    ids.push(Number((await db.app.query<{ id: string }>(
      "INSERT INTO healthy_marks (cabinet_id, marked_at, versions) OUTPUT inserted.id VALUES ($1, DATEADD(day, -$2, SYSUTCDATETIME()), '{}')", [cabinetId, daysOld(i)])).rows[0]!.id));
  return { cabinetId, ids };
}
const pointAt = (cabinetId: string, markId: number) => db.app.query(
  "INSERT INTO cabinet_health (cabinet_id, state, evaluated_at, since, reasons, last_healthy_at, last_mark_id) VALUES ($1, 'degraded', SYSUTCDATETIME(), SYSUTCDATETIME(), '[]', DATEADD(day, -40, SYSUTCDATETIME()), $2)",
  [cabinetId, markId]);
const marksOf = async (cabinetId: string) => (await db.app.query<{ id: string }>("SELECT id FROM healthy_marks WHERE cabinet_id = $1 ORDER BY id", [cabinetId])).rows.map(r => Number(r.id));

test("the prune keeps the newest marks and the one the cabinet's health points at, however old", async () => {
  // 70 marks, the oldest first, all older than 30 days: only the newest 10 would be kept, and the cabinet points at the third.
  const { cabinetId, ids } = await cabinetWithMarks(70, i => 100 - i);
  await pointAt(cabinetId, ids[2]!);
  const removed = await transaction(db.app, c => pruneMarks(c, cabinetId));
  assert.equal(removed, 70 - KEEP_MARKS - 1);
  const left = await marksOf(cabinetId);
  assert.deepEqual(left, [ids[2]!, ...ids.slice(-KEEP_MARKS)], "the newest ten and the one in use");
  // Within 30 days, up to the cap: the referenced mark is kept beyond the cap too.
  const recent = await cabinetWithMarks(MAX_MARKS + 5, () => 1);
  await pointAt(recent.cabinetId, recent.ids[0]!);
  await transaction(db.app, c => pruneMarks(c, recent.cabinetId));
  const kept = await marksOf(recent.cabinetId);
  assert.equal(kept.length, MAX_MARKS + 1);
  assert.ok(kept.includes(recent.ids[0]!));
  // The cabinet's comparison still finds its mark.
  const found = (await db.app.query("SELECT m.id FROM healthy_marks m JOIN cabinet_health h ON h.last_mark_id = m.id WHERE h.cabinet_id = $1", [cabinetId])).rows;
  assert.equal(found.length, 1);
});

test("the database refuses to delete the mark in use by any path, and to point at a mark that does not exist; removing the cabinet removes both", async () => {
  const { cabinetId, ids } = await cabinetWithMarks(3, () => 1);
  await pointAt(cabinetId, ids[0]!);
  await assert.rejects(db.app.query("DELETE FROM healthy_marks WHERE id = $1", [ids[0]]), "the mark in use cannot be deleted");
  await db.app.query("DELETE FROM healthy_marks WHERE id = $1", [ids[1]]);
  await assert.rejects(db.app.query("UPDATE cabinet_health SET last_mark_id = $2 WHERE cabinet_id = $1", [cabinetId, 999_999_999]), "nor point at nothing");
  await asOwner(db, c => c.query("DELETE FROM cabinets WHERE id = $1", [cabinetId]));
  assert.deepEqual(await marksOf(cabinetId), []);
  assert.equal((await db.app.query("SELECT 1 AS x FROM cabinet_health WHERE cabinet_id = $1", [cabinetId])).rows.length, 0);
});
