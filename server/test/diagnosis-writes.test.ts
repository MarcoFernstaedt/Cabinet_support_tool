// The writes to diagnoses that the network diagnosis made itself, moved with the cabinet diagnosis's own behind diagnose/diagnoses.ts, the
// table's owner (F21.R2, decision-log D90): starting a run, recording its commands, finishing or failing it, recording a batch member that
// never ran, and the retention delete. Each checks what it is given before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { failDiagnosis, finishDiagnosis, recordDiagnosisCommands, recordUnstartedDiagnosis, startDiagnosis } from "../src/diagnose/diagnoses.js";
import type { Queryable } from "../src/db/db.js";
import { transaction } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
let user: string;
test.before(async () => {
  db = await createTestDatabase();
  user = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'diag.test', 'Diag Test', 'tier1')", [user]);
});
test.after(async () => { await db?.drop(); });

async function cabinet(): Promise<string> {
  const client = randomUUID(), site = randomUUID(), k = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'K', 'standalone', 'active')", [k, site]);
  return k;
}
async function batch(k: string): Promise<string> {
  const b = randomUUID();
  await db.app.query("INSERT INTO diagnosis_batches (id, created_by, label, total, cabinet_ids) VALUES ($1, $2, 'B', 1, $3)", [b, user, JSON.stringify([k])]);
  return b;
}
interface Row { id: string; cabinet_id: string; kind: string; run_by: string; state: string; commands: unknown; findings: unknown; readings: unknown; failure: string | null; batch_id: string | null; finished: number }
const row = async (id: string) => (await db.app.query<Row>(
  "SELECT id, cabinet_id, kind, run_by, state, commands, findings, readings, failure, batch_id, CASE WHEN finished_at IS NULL THEN 0 ELSE 1 END AS finished FROM diagnoses WHERE id = $1", [id])).rows[0];
const count = async (k: string) => Number((await db.app.query<{ n: number }>("SELECT count(*) AS n FROM diagnoses WHERE cabinet_id = $1", [k])).rows[0]!.n);
const cmd = (key: string) => ({ key, operation: `${key}.read`, commandId: randomUUID(), label: "dropped", params: { dropped: true } });
const json = (v: unknown): unknown => typeof v === "string" ? JSON.parse(v) : v;
const same = (a: string, b: string) => assert.equal(a.toLowerCase(), b.toLowerCase());
// A connection that fails the test if it is used: a refusal has to come from the check, not from the table after a round trip.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("a run is stored as it goes: started with its first commands, then all of them, then done with findings and readings", async () => {
  const k = await cabinet(), id = randomUUID(), b = await batch(k);
  const first = [cmd("config"), cmd("firewall")];
  await startDiagnosis(db.app, { id, cabinetId: k, kind: "network", runBy: user, commands: first, batchId: b });
  let r = (await row(id))!;
  assert.equal(r.state, "running"); assert.equal(r.kind, "network"); assert.equal(r.finished, 0);
  same(r.cabinet_id, k); same(r.run_by, user); same(r.batch_id!, b);
  // Only the three stored fields are kept, as before: a command's label and params are not written.
  assert.deepEqual(json(r.commands), first.map(c => ({ key: c.key, operation: c.operation, commandId: c.commandId })));
  const all = [...first, cmd("dns"), cmd("trace")];
  await recordDiagnosisCommands(db.app, id, all);
  assert.deepEqual((json((await row(id))!.commands) as { key: string }[]).map((c: { key: string }) => c.key), ["config", "firewall", "dns", "trace"]);
  await finishDiagnosis(db.app, id, [{ id: "dns-failed", severity: "fail" }], { takenAt: "2026-11-15T00:00:00.000Z", adapters: [] });
  r = (await row(id))!;
  assert.equal(r.state, "done"); assert.equal(r.finished, 1);
  assert.deepEqual(json(r.findings), [{ id: "dns-failed", severity: "fail" }]);
  assert.deepEqual(json(r.readings), { takenAt: "2026-11-15T00:00:00.000Z", adapters: [] });

  const c = randomUUID();
  await startDiagnosis(db.app, { id: c, cabinetId: k, kind: "cabinet", runBy: user, commands: [cmd("system")], batchId: null });
  await failDiagnosis(db.app, c, "The diagnosis stopped because of a server error.");
  r = (await row(c))!;
  assert.equal(r.kind, "cabinet"); assert.equal(r.batch_id, null); assert.equal(r.state, "failed"); assert.equal(r.finished, 1);
  assert.equal(r.failure, "The diagnosis stopped because of a server error.");
});

test("a batch member that never ran is stored finished, offline or failed, in its batch", async () => {
  const k = await cabinet(), b = await batch(k);
  const off = await recordUnstartedDiagnosis(db.app, { cabinetId: k, runBy: user, state: "offline", failure: "Offline: not heard from in the last 5 minutes.", batchId: b });
  const bad = await recordUnstartedDiagnosis(db.app, { cabinetId: k, runBy: user, state: "failed", failure: "The diagnosis could not be started.", batchId: b });
  for (const [id, state] of [[off, "offline"], [bad, "failed"]] as const) {
    const r = (await row(id))!;
    assert.equal(r.state, state); assert.equal(r.kind, "network"); assert.equal(r.finished, 1); same(r.batch_id!, b);
  }
  assert.notEqual(off, bad);
});

test("a start whose transaction rolls back leaves nothing stored", async () => {
  const k = await cabinet();
  await assert.rejects(transaction(db.app, async c => {
    await startDiagnosis(c, { id: randomUUID(), cabinetId: k, kind: "network", runBy: user, commands: [cmd("config")], batchId: null });
    throw new Error("rolled back");
  }), /rolled back/);
  assert.equal(await count(k), 0);
});

test("anything but ids, a known kind and state, a bounded command list, findings and a plain failure sentence is refused before the database is touched", async () => {
  const k = await cabinet(), b = await batch(k), good = { id: randomUUID(), cabinetId: k, kind: "network" as const, runBy: user, commands: [cmd("config")], batchId: null };
  const badIds = [undefined, null, "", "not-an-id", "00000000-0000-0000-0000-00000000000", `${randomUUID()}'; DROP TABLE diagnoses; --`, 42];
  const badCommands = [undefined, null, "[]", {}, [null], [{ key: "", operation: "x", commandId: randomUUID() }], [{ key: "k", operation: "x", commandId: "nope" }],
    [{ key: "k".repeat(65), operation: "x", commandId: randomUUID() }], Array.from({ length: 201 }, () => cmd("k"))];
  const badFailures = [undefined, null, "", "   ", "a".repeat(1001), "line\u0000nul", "bell\u0007", 7];
  const refusals: Promise<unknown>[] = [];
  for (const v of badIds) {
    refusals.push(startDiagnosis(untouched, { ...good, id: v as never }), startDiagnosis(untouched, { ...good, cabinetId: v as never }),
      startDiagnosis(untouched, { ...good, runBy: v as never }), recordDiagnosisCommands(untouched, v as never, [cmd("x")]),
      finishDiagnosis(untouched, v as never, [], {}), failDiagnosis(untouched, v as never, "x"),
      recordUnstartedDiagnosis(untouched, { cabinetId: k, runBy: user, state: "offline", failure: "x", batchId: v as never }));
    if (v !== null) refusals.push(startDiagnosis(untouched, { ...good, batchId: v as never }));
  }
  for (const kind of [undefined, "", "Network", "network ", "cabinet'--", 1]) refusals.push(startDiagnosis(untouched, { ...good, kind: kind as never }));
  for (const c of badCommands) refusals.push(startDiagnosis(untouched, { ...good, commands: c as never }), recordDiagnosisCommands(untouched, good.id, c as never));
  for (const f of [undefined, null, "[]", {}, 3]) refusals.push(finishDiagnosis(untouched, good.id, f, {}));
  refusals.push(finishDiagnosis(untouched, good.id, [], undefined), startDiagnosis(untouched, null as never), recordUnstartedDiagnosis(untouched, null as never));
  for (const f of badFailures) refusals.push(failDiagnosis(untouched, good.id, f as never),
    recordUnstartedDiagnosis(untouched, { cabinetId: k, runBy: user, state: "offline", failure: f as never, batchId: b }));
  for (const s of [undefined, "running", "done", "Offline", ""]) refusals.push(recordUnstartedDiagnosis(untouched, { cabinetId: k, runBy: user, state: s as never, failure: "x", batchId: b }));
  for (const p of refusals) await assert.rejects(p, (e: Error) => !/reached the database/.test(e.message) && !(e instanceof TypeError));
  assert.equal(await count(k), 0, "nothing was stored");
});
