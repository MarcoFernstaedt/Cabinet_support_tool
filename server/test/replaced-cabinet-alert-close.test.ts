// The close a cabinet replacement made itself, moved into alerts.ts, the table's owner (F21.R2, decision-log D101). It resolves every
// unresolved alert of the replaced cabinet, audits each close as alert.resolve by the user who replaced it, with the alert's issue type
// and the replacing cabinet, and checks what it is given before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeReplacedCabinetAlerts } from "../src/services/alerts.js";
import { ISSUE } from "../src/services/rules.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function cabinets(n: number): Promise<string[]> {
  const client = randomUUID(), site = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = randomUUID();
    await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, $3, 'standalone', 'active')", [k, site, `K${i}`]);
    ids.push(k);
  }
  return ids;
}
async function alert(k: string, issueTypeId: string | null, state: "open" | "claimed" | "resolved" = "open"): Promise<string> {
  return (await db.app.query<{ id: string }>(`DECLARE @o TABLE (id uniqueidentifier);
    INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen, state) OUTPUT inserted.id INTO @o
    VALUES ($1, $2, 'minor', $3, 'T', SYSUTCDATETIME(), SYSUTCDATETIME(), $4); SELECT id FROM @o;`,
    [k, issueTypeId, `replaced-test:${randomUUID()}`, state])).rows[0]!.id.toLowerCase();
}
const row = async (id: string) => (await db.app.query<{ state: string; resolution: string | null }>("SELECT state, resolution FROM alerts WHERE id = $1", [id])).rows[0]!;
const audits = async (ids: string[]) => (await db.app.query<{ target_id: string; actor_kind: string; actor_id: string; details: Record<string, unknown> }>(
  "SELECT target_id, actor_kind, actor_id, details FROM audit_log WHERE action = 'alert.resolve' AND target_id IN (SELECT value FROM OPENJSON($1))", [JSON.stringify(ids)])).rows;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("a close resolves every unresolved alert of the replaced cabinet, audited once each by the user, and nothing else", async () => {
  const user = randomUUID();
  const [old, next, other] = await cabinets(3);
  const withIssue = await alert(old!, ISSUE.drive), noIssue = await alert(old!, null), claimed = await alert(old!, ISSUE.scanner, "claimed");
  const done = await alert(old!, ISSUE.drive, "resolved"), elsewhere = await alert(other!, ISSUE.drive);
  const resolution = "Replaced by FRONT DESK.";
  const closed = await closeReplacedCabinetAlerts(db.app, user, old!, next!, resolution);
  assert.deepEqual(closed.map(c => c.id.toLowerCase()).sort(), [withIssue, noIssue, claimed].sort(), "every unresolved alert, with an issue type or without");
  for (const id of [withIssue, noIssue, claimed]) assert.deepEqual(await row(id), { state: "resolved", resolution });
  assert.equal((await row(done)).resolution, null, "an alert resolved already is not rewritten");
  assert.equal((await row(elsewhere)).state, "open", "another cabinet's alert stays");
  const rows = await audits([withIssue, noIssue, claimed, done, elsewhere]);
  assert.deepEqual(rows.map(r => r.target_id.toLowerCase()).sort(), [withIssue, noIssue, claimed].sort());
  for (const r of rows) {
    assert.equal(r.actor_kind, "user"); assert.equal(r.actor_id, user);
    assert.equal(r.details.resolution, resolution); assert.equal(r.details.automatic, true); assert.equal(r.details.replacedBy, next);
  }
  const issueOf = (id: string) => (rows.find(r => r.target_id.toLowerCase() === id)!.details.issueTypeId as string | null)?.toLowerCase() ?? null;
  assert.deepEqual([issueOf(withIssue), issueOf(noIssue), issueOf(claimed)], [ISSUE.drive.toLowerCase(), null, ISSUE.scanner.toLowerCase()]);
  // A repeat closes and audits nothing more.
  assert.equal((await closeReplacedCabinetAlerts(db.app, user, old!, next!, resolution)).length, 0);
  assert.equal((await audits([withIssue, noIssue, claimed])).length, 3);
});

test("a close in a transaction that rolls back leaves the alerts open and unaudited", async () => {
  const [old, next] = await cabinets(2);
  const id = await alert(old!, ISSUE.drive);
  await assert.rejects(db.app.transaction(async tx => {
    assert.equal((await closeReplacedCabinetAlerts(tx, randomUUID(), old!, next!, "Replaced by K1.")).length, 1);
    throw new Error("rolled back");
  }), /rolled back/);
  assert.equal((await row(id)).state, "open");
  assert.equal((await audits([id])).length, 0);
});

test("anything but a user, two different cabinets and a plain resolution is refused before the database is touched", async () => {
  const [old, next] = await cabinets(2);
  const id = await alert(old!, ISSUE.drive);
  const badIds = [undefined, null, "", "not-an-id", `${old}'; DROP TABLE alerts; --`, 42, ["x"]];
  let refused = 0;
  const refuse = async (p: Promise<unknown>, what: string) => {
    await assert.rejects(p, (e: Error) => !/reached the database/.test(e.message), what); refused++;
  };
  const user = randomUUID();
  for (const v of badIds) await refuse(closeReplacedCabinetAlerts(untouched, v as never, old!, next!, "Replaced."), `user ${String(v)}`);
  for (const v of badIds) await refuse(closeReplacedCabinetAlerts(untouched, user, v as never, next!, "Replaced."), `cabinet ${String(v)}`);
  for (const v of badIds) await refuse(closeReplacedCabinetAlerts(untouched, user, old!, v as never, "Replaced."), `replaced by ${String(v)}`);
  await refuse(closeReplacedCabinetAlerts(untouched, user, old!, old!.toUpperCase(), "Replaced."), "a cabinet replacing itself");
  for (const r of [undefined, null, "", "   ", "a".repeat(501), "tab\tin", "nul\u0000", 3])
    await refuse(closeReplacedCabinetAlerts(untouched, user, old!, next!, r as never), `resolution ${String(r)}`);
  assert.equal(refused, 30);
  assert.equal((await row(id)).state, "open", "nothing was changed");
});
