// The retitle and the close by signature that service recovery, peer differences and firmware drift made themselves, moved into alerts.ts,
// the table's owner (F21.R2, decision-log D94). The retitle follows the latest reading's title; the close resolves only that cabinet's
// unresolved alert of that signature and audits each close as alert.resolve. Both check what they are given before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeSignatureAlert, retitleAlert } from "../src/services/alerts.js";
import type { Queryable } from "../src/db/db.js";
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
async function alert(k: string, signature: string, state: "open" | "claimed" | "resolved" = "open", title = "First title"): Promise<string> {
  return (await db.app.query<{ id: string }>(`DECLARE @o TABLE (id uniqueidentifier);
    INSERT INTO alerts (cabinet_id, severity, signature, title, first_seen, last_seen, state) OUTPUT inserted.id INTO @o
    VALUES ($1, 'minor', $2, $3, SYSUTCDATETIME(), SYSUTCDATETIME(), $4); SELECT id FROM @o;`, [k, signature, title, state])).rows[0]!.id.toLowerCase();
}
const row = async (id: string) => (await db.app.query<{ state: string; title: string; resolution: string | null }>("SELECT state, title, resolution FROM alerts WHERE id = $1", [id])).rows[0]!;
const audits = async (ids: string[]) => (await db.app.query<{ target_id: string; actor_kind: string; actor_id: string; details: Record<string, unknown> }>(
  "SELECT target_id, actor_kind, actor_id, details FROM audit_log WHERE action = 'alert.resolve' AND target_id IN (SELECT value FROM OPENJSON($1))", [JSON.stringify(ids)])).rows;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("a retitle sets that alert's title to the latest reading's and touches no other alert", async () => {
  const k = await cabinet(), id = await alert(k, "peer-difference"), other = await alert(k, "firmware-drift");
  await retitleAlert(db.app, id, "Differs from the other 3 standalone cabinets at S: time zone");
  assert.equal((await row(id)).title, "Differs from the other 3 standalone cabinets at S: time zone");
  assert.equal((await row(other)).title, "First title");
  await retitleAlert(db.app, id, "Differs from the other 3 standalone cabinets at S: time zone");
  assert.equal((await row(id)).title, "Differs from the other 3 standalone cabinets at S: time zone", "the same title again changes nothing");
});

test("a close resolves the cabinet's unresolved alert of that signature, audited once by the closer, and nothing else", async () => {
  const k = await cabinet(), other = await cabinet();
  const open = await alert(k, "service-reboot-recovery"), claimed = await alert(other, "service-reboot-recovery", "claimed");
  const otherSignature = await alert(k, "firmware-drift"), done = await alert(k, "service-reboot-recovery", "resolved");
  const closed = await closeSignatureAlert(db.app, "service-recovery", k, "service-reboot-recovery", "No service is set to restart the computer any more.");
  assert.deepEqual(closed.map(c => c.id.toLowerCase()), [open]);
  assert.equal((await row(open)).state, "resolved");
  assert.equal((await row(open)).resolution, "No service is set to restart the computer any more.");
  assert.notEqual((await row(claimed)).state, "resolved", "another cabinet's alert stays");
  assert.notEqual((await row(otherSignature)).state, "resolved", "another signature's alert stays");
  assert.equal((await row(done)).resolution, null, "an alert resolved already is not rewritten");
  const rows = await audits([open, claimed, otherSignature, done]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.target_id, open); assert.equal(rows[0]!.actor_kind, "system"); assert.equal(rows[0]!.actor_id, "service-recovery");
  assert.equal(rows[0]!.details.automatic, true); assert.equal(rows[0]!.details.cabinetId, k.toLowerCase());
  // A claimed alert counts as unresolved; a repeat closes and audits nothing.
  assert.equal((await closeSignatureAlert(db.app, "peer-difference", other, "service-reboot-recovery", "Gone.")).length, 1);
  assert.equal((await closeSignatureAlert(db.app, "peer-difference", other, "service-reboot-recovery", "Gone.")).length, 0);
  assert.equal((await audits([claimed])).length, 1);
});

test("a close in a transaction that rolls back leaves the alert open and unaudited", async () => {
  const k = await cabinet(), id = await alert(k, "firmware-drift");
  await assert.rejects(db.app.transaction(async tx => {
    await closeSignatureAlert(tx, "firmware-drift", k, "firmware-drift", "The firmware matches again.");
    throw new Error("rolled back");
  }), /rolled back/);
  assert.equal((await row(id)).state, "open");
  assert.equal((await audits([id])).length, 0);
});

test("anything but an alert id and a title, or a closer, a cabinet id, a signature and a plain resolution, is refused before the database is touched", async () => {
  const k = await cabinet(), id = await alert(k, "peer-difference");
  const badIds = [undefined, null, "", "not-an-id", `${k}'; DROP TABLE alerts; --`, 42];
  let refused = 0;
  const refuse = async (p: Promise<unknown>, what: string) => {
    await assert.rejects(p, (e: Error) => !/reached the database/.test(e.message), what); refused++;
  };
  for (const v of badIds) await refuse(retitleAlert(untouched, v as never, "T"), `retitle id ${String(v)}`);
  for (const t of [undefined, null, "", "   ", 5]) await refuse(retitleAlert(untouched, id, t as never), `retitle title ${String(t)}`);
  const good = ["peer-difference", k, "peer-difference", "Gone."] as const;
  for (const by of [undefined, null, "", "Peer", "-x", "a b", "a".repeat(65), 7]) await refuse(closeSignatureAlert(untouched, by as never, good[1], good[2], good[3]), `closer ${String(by)}`);
  for (const v of badIds) await refuse(closeSignatureAlert(untouched, good[0], v as never, good[2], good[3]), `cabinet ${String(v)}`);
  for (const s of [undefined, null, "", "   ", "a".repeat(451), "line\nfeed", "nul\u0000", 9]) await refuse(closeSignatureAlert(untouched, good[0], good[1], s as never, good[3]), `signature ${String(s)}`);
  for (const r of [undefined, null, "", "   ", "a".repeat(501), "tab\tin", "nul\u0000", 3]) await refuse(closeSignatureAlert(untouched, good[0], good[1], good[2], r as never), `resolution ${String(r)}`);
  assert.equal(refused, 41);
  const r = await row(id);
  assert.equal(r.state, "open"); assert.equal(r.title, "First title", "nothing was changed");
});
