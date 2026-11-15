// The operations checks resolve an alert whose condition has gone through security.ts, the alerts' owner (F21.R2, decision-log D88): the
// open alert of that signature is resolved and audited as security_alert.auto_resolve, in the caller's transaction. The signature and the
// actor are checked before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { autoResolveSecurityAlert, raiseSecurityAlert } from "../src/services/security.js";
import { transaction } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

const state = async (signature: string) => (await db.app.query<{ state: string }>("SELECT state FROM security_alerts WHERE signature = $1", [signature])).rows.map(r => r.state);
const resolvedAudits = async (id: string) => (await db.app.query<{ actor_id: string; details: { kind?: string } }>(
  "SELECT actor_id, details FROM audit_log WHERE action = 'security_alert.auto_resolve' AND target_id = $1", [id])).rows;

test("the open alert of a signature is resolved and audited, other signatures stay open, and a repeat resolves nothing", async () => {
  const disk = await transaction(db.app, c => raiseSecurityAlert(c, { kind: "ops_disk", signature: "ops_disk", title: "Disk low", detail: {} }));
  await transaction(db.app, c => raiseSecurityAlert(c, { kind: "ops_backup", signature: "ops_backup", title: "Backup old", detail: {} }));
  const ids = await transaction(db.app, c => autoResolveSecurityAlert(c, "ops_disk", { actorId: "ops-check", details: { kind: "ops_disk" } }));
  assert.deepEqual(ids, [disk.id]);
  assert.deepEqual(await state("ops_disk"), ["resolved"]);
  assert.deepEqual(await state("ops_backup"), ["open"], "another signature is left open");
  const audits = await resolvedAudits(disk.id);
  assert.deepEqual(audits.map(a => [a.actor_id, a.details.kind]), [["ops-check", "ops_disk"]]);
  assert.deepEqual(await transaction(db.app, c => autoResolveSecurityAlert(c, "ops_disk", { actorId: "ops-check" })), [], "nothing left open to resolve");
  assert.equal((await resolvedAudits(disk.id)).length, 1, "and nothing more audited");
});

test("a resolve that rolls back with its transaction leaves the alert open and unaudited", async () => {
  const ca = await transaction(db.app, c => raiseSecurityAlert(c, { kind: "ops_ca", signature: "ops_ca", title: "CA expires", detail: {} }));
  await assert.rejects(transaction(db.app, async c => { await autoResolveSecurityAlert(c, "ops_ca", { actorId: "ops-check" }); throw new Error("stop"); }), /stop/);
  assert.deepEqual(await state("ops_ca"), ["open"]);
  assert.equal((await resolvedAudits(ca.id)).length, 0);
});

test("anything but a real signature and a system actor is refused before the database is touched", async () => {
  await transaction(db.app, c => raiseSecurityAlert(c, { kind: "ops_database", signature: "ops_database", title: "DB large", detail: {} }));
  for (const sig of [undefined, null, "", "x".repeat(257), "ops_database\u0000", "ops\ndatabase", 42, {}])
    await assert.rejects(autoResolveSecurityAlert(db.app, sig as never, { actorId: "ops-check" }), /signature/, JSON.stringify(sig));
  for (const by of [undefined, null, {}, { actorId: "" }, { actorId: "x".repeat(65) }, { actorId: 7 }])
    await assert.rejects(autoResolveSecurityAlert(db.app, "ops_database", by as never), /actor/, JSON.stringify(by));
  assert.deepEqual(await state("ops_database"), ["open"], "nothing was resolved");
});
