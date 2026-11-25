// The automatic close of a cabinet's alert of one issue type, moved from the network diagnosis into alerts.ts,
// the table's owner (F21.R2, decision-log D92). It closes only that cabinet's unresolved alert of that issue type, audits each close as
// alert.resolve, and checks what it is given before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeIssueAlert } from "../src/services/alerts.js";
import { ISSUE } from "../src/services/rules.js";
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
async function alert(k: string, issueTypeId: string, state: "open" | "claimed" | "resolved" = "open"): Promise<string> {
  return (await db.app.query<{ id: string }>(`DECLARE @o TABLE (id uniqueidentifier);
    INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen, state) OUTPUT inserted.id INTO @o
    VALUES ($1, $2, 'minor', $3, 'T', SYSUTCDATETIME(), SYSUTCDATETIME(), $4); SELECT id FROM @o;`, [k, issueTypeId, `issue:${issueTypeId}:${randomUUID()}`, state])).rows[0]!.id.toLowerCase();
}
const state = async (id: string) => (await db.app.query<{ state: string; resolution: string | null }>("SELECT state, resolution FROM alerts WHERE id = $1", [id])).rows[0]!;
const audits = async (ids: string[]) => (await db.app.query<{ target_id: string; actor_kind: string; actor_id: string; details: Record<string, unknown> }>(
  "SELECT target_id, actor_kind, actor_id, details FROM audit_log WHERE action = 'alert.resolve' AND target_id IN (SELECT value FROM OPENJSON($1))", [JSON.stringify(ids)])).rows;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("closes the cabinet's unresolved alert of that issue type, audited once by the closer, and nothing else", async () => {
  const k = await cabinet(), other = await cabinet();
  const open = await alert(k, ISSUE.networkBaseline), claimed = await alert(other, ISSUE.networkBaseline, "claimed");
  const otherIssue = await alert(k, ISSUE.firewallPolicy), otherCabinet = await alert(other, ISSUE.firewallPolicy), done = await alert(k, ISSUE.networkBaseline, "resolved");
  const closed = await closeIssueAlert(db.app, "network-diagnosis", k, ISSUE.networkBaseline, "A network diagnosis found the settings matching the site baseline.");
  assert.deepEqual(closed.map(c => c.id.toLowerCase()), [open]);
  assert.deepEqual(await state(open), { state: "resolved", resolution: "A network diagnosis found the settings matching the site baseline." });
  for (const id of [claimed, otherIssue, otherCabinet]) assert.notEqual((await state(id)).state, "resolved", "another cabinet's or another issue's alert stays");
  assert.equal((await state(done)).resolution, null, "an alert resolved already is not rewritten");
  const rows = await audits([open, claimed, otherIssue, otherCabinet, done]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.target_id, open); assert.equal(rows[0]!.actor_kind, "system"); assert.equal(rows[0]!.actor_id, "network-diagnosis");
  assert.equal(rows[0]!.details.automatic, true); assert.equal(rows[0]!.details.cabinetId, k.toLowerCase());

  // A claimed alert counts as unresolved, as before; a repeat closes and audits nothing.
  assert.equal((await closeIssueAlert(db.app, "firewall-check", other, ISSUE.networkBaseline, "Gone.")).length, 1);
  assert.equal((await state(claimed)).state, "resolved");
  assert.equal((await closeIssueAlert(db.app, "firewall-check", other, ISSUE.networkBaseline, "Gone.")).length, 0);
  assert.equal((await audits([claimed])).length, 1);
});

test("a close in a transaction that rolls back leaves the alert open and unaudited", async () => {
  const k = await cabinet(), id = await alert(k, ISSUE.firewallPolicy);
  await assert.rejects(db.app.transaction(async tx => {
    await closeIssueAlert(tx, "firewall-check", k, ISSUE.firewallPolicy, "The firewall matches the policy.");
    throw new Error("rolled back");
  }), /rolled back/);
  assert.equal((await state(id)).state, "open");
  assert.equal((await audits([id])).length, 0);
});

test("anything but a closer name, a cabinet id, an issue type id and a plain resolution is refused before the database is touched", async () => {
  const k = await cabinet(), id = await alert(k, ISSUE.networkBaseline), good = ["network-diagnosis", k, ISSUE.networkBaseline, "Gone."] as const;
  const badIds = [undefined, null, "", "not-an-id", `${k}'; DROP TABLE alerts; --`, 42];
  const cases: unknown[][] = [];
  for (const by of [undefined, null, "", "Network", "-x", "a b", "a".repeat(65), "x;y", 7]) cases.push([by, good[1], good[2], good[3]]);
  for (const v of badIds) cases.push([good[0], v, good[2], good[3]], [good[0], good[1], v, good[3]]);
  for (const r of [undefined, null, "", "   ", "a".repeat(501), "line\nfeed", "nul\u0000", 3]) cases.push([good[0], good[1], good[2], r]);
  for (const [by, cab, issue, res] of cases)
    await assert.rejects(closeIssueAlert(untouched, by as never, cab as never, issue as never, res as never),
      (e: Error) => !/reached the database/.test(e.message), JSON.stringify([by, cab, issue, res]));
  assert.equal(cases.length, 29);
  assert.equal((await state(id)).state, "open", "nothing was closed");
});
