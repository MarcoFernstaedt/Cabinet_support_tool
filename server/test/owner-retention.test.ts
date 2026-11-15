// Five retention sweeps run by their tables' owners (F21.R2, decision-log D74): boots, configuration changes, diagnoses, health
// transitions and closed incidents. For each: only what is older than the cut-off goes, in one audited batch; a repeat removes nothing;
// a cut-off that is not a time already passed is refused before anything is removed. An open incident is never removed, however old.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pruneOldBoots } from "../src/services/crashes.js";
import { pruneOldConfigChanges } from "../src/services/config-ingest.js";
import { pruneOldDiagnoses } from "../src/diagnose/diagnoses.js";
import { pruneOldHealthTransitions } from "../src/services/cabinet-health.js";
import { pruneClosedIncidents } from "../src/services/incidents.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
const user = randomUUID(), cabinet = randomUUID();
test.before(async () => {
  db = await createTestDatabase();
  const client = randomUUID(), site = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'retain.five', 'Five', 'admin')", [user]);
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Five')", [client]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'K', 'standalone', 'active')", [cabinet, site]);
});
test.after(async () => { await db?.drop(); });
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

type Prune = (db: Queryable, cutoff: Date) => Promise<number>;
const cases: { table: string; prune: Prune; add: (age: number) => Promise<unknown> }[] = [
  { table: "cabinet_boots", prune: pruneOldBoots,
    add: age => db.app.query("INSERT INTO cabinet_boots (cabinet_id, booted_at, source) VALUES ($1, $2, 'heartbeat')", [cabinet, daysAgo(age)]) },
  { table: "config_changes", prune: pruneOldConfigChanges,
    add: age => db.app.query("INSERT INTO config_changes (cabinet_id, version_id, category, item_key, change, fields, observed_at) VALUES ($1, 1, 'services', $2, 'changed', '{}', $3)", [cabinet, randomUUID(), daysAgo(age)]) },
  { table: "diagnoses", prune: pruneOldDiagnoses,
    add: age => db.app.query("INSERT INTO diagnoses (id, cabinet_id, kind, run_by, state, commands, started_at) VALUES ($1, $2, 'network', $3, 'done', '[]', $4)", [randomUUID(), cabinet, user, daysAgo(age)]) },
  { table: "health_transitions", prune: pruneOldHealthTransitions,
    add: age => db.app.query("INSERT INTO health_transitions (cabinet_id, [at], to_state, reasons) VALUES ($1, $2, 'degraded', '[]')", [cabinet, daysAgo(age)]) },
  { table: "incidents", prune: pruneClosedIncidents,
    add: age => db.app.query("INSERT INTO incidents (id, cabinet_id, symptom, opened_by_kind, opened_by, state, closed_at) VALUES ($1, $2, 'x', 'system', 'test', 'resolved', $3)", [randomUUID(), cabinet, daysAgo(age)]) },
];
const count = async (table: string) => Number((await db.app.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE cabinet_id = $1`, [cabinet])).rows[0]!.n);
const batches = async (table: string) => (await db.app.query<{ details: { rows: number } }>(
  "SELECT details FROM audit_log WHERE action = 'retention.batch' AND JSON_VALUE(details, '$.table') = $1", [table])).rows.map(r => r.details.rows);

for (const c of cases) {
  test(`${c.table}: only what is older than the cut-off goes, in one audited batch; a repeat removes nothing; a bad cut-off is refused`, async () => {
    await c.add(500); await c.add(420); await c.add(5);
    const before = await count(c.table);
    for (const bad of [new Date(Date.now() + 60_000), new Date("x"), "2020-01-01", 0, null])
      await assert.rejects(c.prune(db.app, bad as never), /retention cut-off/, `${c.table}: ${String(bad)}`);
    assert.equal(await count(c.table), before, "nothing removed by a refused call");
    assert.equal(await c.prune(db.app, daysAgo(400)), 2);
    assert.equal(await count(c.table), before - 2);
    assert.equal(await c.prune(db.app, daysAgo(400)), 0);
    assert.deepEqual(await batches(c.table), [2]);
  });
}

test("an open incident is never removed, however old", async () => {
  const id = randomUUID();
  await db.app.query("INSERT INTO incidents (id, cabinet_id, symptom, opened_by_kind, opened_by, state, opened_at) VALUES ($1, $2, 'still open', 'system', 'test', 'open', $3)", [id, cabinet, daysAgo(2000)]);
  await pruneClosedIncidents(db.app, daysAgo(1));
  assert.equal((await db.app.query("SELECT 1 AS x FROM incidents WHERE id = $1", [id])).rows.length, 1);
});
