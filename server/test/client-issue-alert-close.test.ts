// The close the scanner switch-off made itself, moved into alerts.ts, the table's owner (F21.R2, decision-log D100). It resolves the
// unresolved alerts of one issue type on every cabinet of one client, audits each close as alert.resolve by the user whose choice closed
// them, and checks what it is given before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeClientIssueAlerts } from "../src/services/alerts.js";
import { ISSUE } from "../src/services/rules.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

const NOT_USED = "The client does not use a fingerprint scanner.";

/** A client with two sites of one cabinet each; returns the client and its cabinets. */
async function client(): Promise<{ client: string; cabinets: string[] }> {
  const c = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [c, `C ${c.slice(0, 6)}`]);
  const cabinets: string[] = [];
  for (const n of [1, 2]) {
    const s = randomUUID(), k = randomUUID();
    await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [s, c, `S${n}`]);
    await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'K', 'standalone', 'active')", [k, s]);
    cabinets.push(k);
  }
  return { client: c, cabinets };
}
async function alert(k: string, issueTypeId: string, state: "open" | "claimed" | "resolved" = "open"): Promise<string> {
  return (await db.app.query<{ id: string }>(`DECLARE @o TABLE (id uniqueidentifier);
    INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen, state) OUTPUT inserted.id INTO @o
    VALUES ($1, $2, 'minor', $3, 'T', SYSUTCDATETIME(), SYSUTCDATETIME(), $4); SELECT id FROM @o;`,
    [k, issueTypeId, `client-issue-test:${randomUUID()}`, state])).rows[0]!.id.toLowerCase();
}
const row = async (id: string) => (await db.app.query<{ state: string; resolution: string | null }>("SELECT state, resolution FROM alerts WHERE id = $1", [id])).rows[0]!;
const audits = async (ids: string[]) => (await db.app.query<{ target_id: string; actor_kind: string; actor_id: string; details: Record<string, unknown> }>(
  "SELECT target_id, actor_kind, actor_id, details FROM audit_log WHERE action = 'alert.resolve' AND target_id IN (SELECT value FROM OPENJSON($1))", [JSON.stringify(ids)])).rows;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("a close resolves the issue's unresolved alerts on every cabinet of the client, audited once each by the user, and nothing else", async () => {
  const user = randomUUID();
  const mine = await client(), other = await client();
  const a = await alert(mine.cabinets[0]!, ISSUE.scanner), b = await alert(mine.cabinets[1]!, ISSUE.scanner, "claimed");
  const otherIssue = await alert(mine.cabinets[0]!, ISSUE.drive), otherClient = await alert(other.cabinets[0]!, ISSUE.scanner);
  const done = await alert(mine.cabinets[1]!, ISSUE.scanner, "resolved");
  const closed = await closeClientIssueAlerts(db.app, user, mine.client, ISSUE.scanner, NOT_USED);
  assert.deepEqual(closed.map(c => c.id.toLowerCase()).sort(), [a, b].sort(), "both sites' cabinets, a claimed alert included");
  for (const id of [a, b]) assert.deepEqual(await row(id), { state: "resolved", resolution: NOT_USED });
  assert.equal((await row(otherIssue)).state, "open", "another issue's alert stays");
  assert.equal((await row(otherClient)).state, "open", "another client's alert stays");
  assert.equal((await row(done)).resolution, null, "an alert resolved already is not rewritten");
  const rows = await audits([a, b, otherIssue, otherClient, done]);
  assert.deepEqual(rows.map(r => r.target_id).sort(), [a, b].sort());
  for (const r of rows) {
    assert.equal(r.actor_kind, "user"); assert.equal(r.actor_id, user);
    assert.deepEqual(r.details, { issueTypeId: ISSUE.scanner, resolution: NOT_USED, automatic: true });
  }
  // A repeat closes and audits nothing more.
  assert.equal((await closeClientIssueAlerts(db.app, user, mine.client, ISSUE.scanner, NOT_USED)).length, 0);
  assert.equal((await audits([a, b])).length, 2);
});

test("a close in a transaction that rolls back leaves the alerts open and unaudited", async () => {
  const mine = await client();
  const id = await alert(mine.cabinets[0]!, ISSUE.scanner);
  await assert.rejects(db.app.transaction(async tx => {
    assert.equal((await closeClientIssueAlerts(tx, randomUUID(), mine.client, ISSUE.scanner, NOT_USED)).length, 1);
    throw new Error("rolled back");
  }), /rolled back/);
  assert.equal((await row(id)).state, "open");
  assert.equal((await audits([id])).length, 0);
});

test("anything but a user id, a client id, an issue type id and a plain resolution is refused before the database is touched", async () => {
  const mine = await client();
  const id = await alert(mine.cabinets[0]!, ISSUE.scanner);
  const badIds = [undefined, null, "", "not-an-id", `${mine.client}'; DROP TABLE alerts; --`, 42, ["x"]];
  let refused = 0;
  const refuse = async (p: Promise<unknown>, what: string) => {
    await assert.rejects(p, (e: Error) => !/reached the database/.test(e.message), what); refused++;
  };
  const user = randomUUID();
  for (const v of badIds) await refuse(closeClientIssueAlerts(untouched, v as never, mine.client, ISSUE.scanner, NOT_USED), `user ${String(v)}`);
  for (const v of badIds) await refuse(closeClientIssueAlerts(untouched, user, v as never, ISSUE.scanner, NOT_USED), `client ${String(v)}`);
  for (const v of badIds) await refuse(closeClientIssueAlerts(untouched, user, mine.client, v as never, NOT_USED), `issue ${String(v)}`);
  for (const r of [undefined, null, "", "   ", "a".repeat(501), "tab\tin", "nul\u0000", 3])
    await refuse(closeClientIssueAlerts(untouched, user, mine.client, ISSUE.scanner, r as never), `resolution ${String(r)}`);
  assert.equal(refused, 29);
  assert.equal((await row(id)).state, "open", "nothing was changed");
});
