// Every write to issue_types goes through rules.ts, its owner (F21.R2, decision-log D69): the Admin's create and edit, and a rule that
// maps to a new issue type. What it is given is checked first; a repeated create is refused by name, and an edit that changes nothing
// writes and audits nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { addIssueType, editIssueType } from "../src/services/rules.js";
import { transaction } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
const user = randomUUID();
test.before(async () => {
  db = await createTestDatabase();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'issue.admin', 'Issue Admin', 'admin')", [user]);
});
test.after(async () => { await db?.drop(); });
const inTx = <T>(fn: Parameters<typeof transaction<T>>[1]) => transaction(db.app, fn);
const audits = async (id: string) => (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY seq", [id.toLowerCase()])).rows.map(r => r.action);
const named = async (name: string) => Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM issue_types WHERE name = $1", [name])).rows[0]!.n);

test("a created issue type is audited once; creating the same name again is refused and leaves one", async () => {
  const name = `Printer jam ${randomUUID().slice(0, 6)}`;
  const id = await inTx(c => addIssueType(c, user, { name, severity: "minor", description: "The receipt printer stops." }));
  await assert.rejects(inTx(c => addIssueType(c, user, { name, severity: "major", description: "again" })), (e: { code?: string }) => e.code === "name_taken");
  assert.equal(await named(name), 1);
  assert.deepEqual(await audits(id), ["issue_type.create"]);
});

test("an edit is audited with what it was; the same values again write and audit nothing; a taken name is refused", async () => {
  const a = `Scanner ${randomUUID().slice(0, 6)}`, b = `Badge ${randomUUID().slice(0, 6)}`;
  const id = await inTx(c => addIssueType(c, user, { name: a, severity: "minor", description: "d" }));
  await inTx(c => addIssueType(c, user, { name: b, severity: "minor", description: "d" }));
  const t = { name: `${a} (renamed)`, severity: "major" as const, description: "changed" };
  await inTx(c => editIssueType(c, user, id, t));
  await inTx(c => editIssueType(c, user, id, t));
  assert.deepEqual(await audits(id), ["issue_type.create", "issue_type.update"], "the repeat changed nothing and said nothing");
  const kept = (await db.app.query<{ details: { before: { name: string; severity: string; description: string } } }>("SELECT details FROM audit_log WHERE target_id = $1 AND action = 'issue_type.update'", [id.toLowerCase()])).rows[0]!;
  assert.deepEqual(kept.details.before, { name: a, severity: "minor", description: "d" }, "the audit kept what the issue type was");
  await assert.rejects(inTx(c => editIssueType(c, user, id, { ...t, name: b })), (e: { code?: string }) => e.code === "name_taken");
  await assert.rejects(inTx(c => editIssueType(c, user, randomUUID(), t)), (e: { code?: string }) => e.code === "not_found");
});

test("malformed and hostile issue types are refused before anything is written", async () => {
  const ok = { name: `Valid ${randomUUID().slice(0, 6)}`, severity: "minor", description: "d" };
  const before = Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM issue_types")).rows[0]!.n);
  for (const bad of [{ name: "" }, { name: "   " }, { name: "n".repeat(129) }, { name: null }, { severity: "critical" }, { severity: "minor'; DROP TABLE issue_types; --" },
    { description: "d".repeat(1025) }, { description: null }, { description: 5 }])
    await assert.rejects(inTx(c => addIssueType(c, user, { ...ok, ...bad } as never)), /issue type/, JSON.stringify(bad).slice(0, 80));
  await assert.rejects(inTx(c => addIssueType(c, user, null as never)), /issue type/);
  assert.equal(Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM issue_types")).rows[0]!.n), before, "nothing was written");
});
