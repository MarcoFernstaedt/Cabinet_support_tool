import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit, transaction, verifyAuditChain } from "../src/db/db.js";
import { createPool, placeholders } from "../src/db/db.js";
import { connectOwner, migrate, MIGRATIONS_DIR, readMigrations } from "../src/db/migrate.js";
import { JSON_COLUMNS } from "../src/db/json-columns.js";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db.drop(); });

test("migrations run once and refuse to run an edited migration", async () => {
  const owner = await connectOwner(db.ownerUrl);
  try {
    assert.deepEqual(await migrate(owner), [], "already applied");
    const dir = mkdtempSync(join(tmpdir(), "migrations-"));
    for (const f of readdirSync(MIGRATIONS_DIR)) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    writeFileSync(join(dir, "0001_baseline.sql"), "-- edited\n", { flag: "a" });
    await assert.rejects(migrate(owner, readMigrations(dir)), /changed after it was applied/);
  } finally { await owner.close(); }
});

test("audit entries chain, and the chain verifies", async () => {
  await transaction(db.app, async c => {
    await audit(c, { actorKind: "system", actorId: "test", action: "test.one", outcome: "succeeded", details: { a: 1 } });
    await audit(c, { actorKind: "user", actorId: "u1", action: "test.two", targetKind: "cabinet", targetId: "c1", outcome: "refused", details: { why: "x\u0000y \"quoted\"" } });
  });
  const check = await verifyAuditChain(db.app);
  assert.equal(check.ok, true);
  assert.ok(check.entries >= 2);
});

test("an audit entry rolls back with its action", async () => {
  const before = (await verifyAuditChain(db.app)).entries;
  await assert.rejects(transaction(db.app, async c => {
    await audit(c, { actorKind: "system", actorId: "test", action: "test.rolled-back", outcome: "succeeded" });
    throw new Error("the action failed");
  }));
  assert.equal((await verifyAuditChain(db.app)).entries, before);
});

test("the server's account cannot write, change or delete audit entries directly", async () => {
  for (const sql of [
    "INSERT INTO audit_log VALUES (999, SYSUTCDATETIME(), 'system', 'x', 'x', null, null, 'x', '{}', 'x', 'x')",
    "UPDATE audit_log SET outcome = 'succeeded'",
    "DELETE FROM audit_log",
    "TRUNCATE TABLE audit_log",
    "UPDATE audit_chain_head SET seq = 0",
    "SELECT * FROM audit_chain_head",
  ]) await assert.rejects(db.app.query(sql), /permission was denied|permission denied|do not have permission/i, sql);
});

test("even the audit table's owner cannot change or delete an entry", async () => {
  await asOwner(db, async c => {
    await assert.rejects(c.query("UPDATE audit_log SET outcome = 'x'"), /append-only/);
    await assert.rejects(c.query("DELETE FROM audit_log"), /append-only/);
  });
});

test("the list of JSON columns is exactly the columns the schema checks as JSON", async () => {
  const rows = await asOwner(db, c => c.query<{ name: string }>(
    "SELECT DISTINCT col.name AS name FROM sys.check_constraints cc JOIN sys.columns col ON col.object_id = cc.parent_object_id AND col.column_id = cc.parent_column_id WHERE cc.definition LIKE '%isjson%'"));
  assert.deepEqual([...JSON_COLUMNS].sort(), rows.rows.map(r => r.name).sort());
});

test("every table has a primary key, and the foreign keys, unique rules and indexes are in place", async () => {
  const q = async (sql: string) => (await asOwner(db, c => c.query<{ n: number }>(sql))).rows[0]!.n;
  assert.equal(await q("SELECT COUNT(*) AS n FROM sys.tables t WHERE NOT EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = t.object_id AND i.is_primary_key = 1)"), 0, "tables without a primary key");
  assert.ok(await q("SELECT COUNT(*) AS n FROM sys.foreign_keys") >= 60, "foreign keys");
  assert.ok(await q("SELECT COUNT(*) AS n FROM sys.indexes WHERE is_unique_constraint = 1 OR (is_unique = 1 AND is_primary_key = 0)") >= 15, "unique rules");
  // A settings value may be any JSON value, not only an object.
  for (const v of ["true", "12", '"unset"', "{}"]) await asOwner(db, c => c.query("INSERT INTO settings ([key], [value]) VALUES ($1, $2)", ["test." + v.length + v, v]));
  await assert.rejects(asOwner(db, c => c.query("INSERT INTO settings ([key], [value]) VALUES ('bad', 'not json')")), /CHECK/i);
});

test("tampering with an entry is detected at the entry that changed", async () => {
  await transaction(db.app, async c => {
    for (let i = 0; i < 3; i++) await audit(c, { actorKind: "system", actorId: "test", action: `test.tamper.${i}`, outcome: "succeeded" });
  });
  const target = Number((await db.app.query<{ seq: string }>("SELECT seq FROM audit_log WHERE action = 'test.tamper.1'")).rows[0]!.seq);
  await asOwner(db, async c => {
    // Only the database owner switching the trigger off can do this; the chain still catches it.
    await c.query("DISABLE TRIGGER audit_log_immutable ON audit_log");
    await c.query("UPDATE audit_log SET outcome = 'failed' WHERE seq = $1", [target]);
    await c.query("ENABLE TRIGGER audit_log_immutable ON audit_log");
  });
  const check = await verifyAuditChain(db.app);
  assert.equal(check.ok, false);
  assert.equal(check.firstBadSeq, target);
  assert.deepEqual(check.badSeqs, [target], "only the changed entry is reported, and the check went on past it");
});

test("a single statement is retried after a deadlock; a batch is not", async () => {
  const { singleStatement } = await import("../src/db/db.js");
  assert.equal(singleStatement("UPDATE x SET a = 1 WHERE b = 'x;y';"), true);
  assert.equal(singleStatement("DECLARE @o TABLE (id int); INSERT INTO t OUTPUT inserted.id INTO @o VALUES (1); SELECT id FROM @o"), false);
});

test("text that looks like a GUID is kept as stored, and an audit entry with one still verifies; real GUID columns come back in lower case", async () => {
  const look = "ABCDEF12-ABCD-ABCD-ABCD-ABCDEF123456";
  await transaction(db.app, c => audit(c, { actorKind: "agent", actorId: look, action: "test.guid-looking", targetId: look, outcome: "refused" }));
  // (An earlier test in this file breaks the chain on purpose; the new entry must not be reported as broken.)
  const seq = Number((await db.app.query<{ seq: string }>("SELECT seq FROM audit_log WHERE action = 'test.guid-looking'")).rows[0]!.seq);
  assert.ok(!(await verifyAuditChain(db.app)).badSeqs?.includes(seq), "the entry verifies");
  const row = (await db.app.query<{ actor_id: string; id: string }>("SELECT TOP (1) actor_id, CAST($1 AS uniqueidentifier) AS id FROM audit_log WHERE action = 'test.guid-looking'", [look])).rows[0]!;
  assert.equal(row.actor_id, look, "a text column is returned as stored");
  assert.equal(row.id, look.toLowerCase(), "a uniqueidentifier column is lower case");
});

test("placeholders: $n becomes @pn outside strings and comments; an apostrophe in a comment is not a string", () => {
  assert.equal(placeholders("SELECT $1, '$2' -- the cabinet's $3\nWHERE x = $4"), "SELECT @p1, '$2' -- the cabinet's $3\nWHERE x = @p4");
  assert.equal(placeholders("SELECT 'a--b', $1"), "SELECT 'a--b', @p1");
});

test("the pool reports how long requests wait for a connection, not just how many wait", async () => {
  const one = await createPool(db.appUrl, { max: 1, min: 1 });
  try {
    assert.ok(one.waitMs < 200, "nothing waits on an idle pool");
    const holding = one.query("WAITFOR DELAY '00:00:01.500'");
    await new Promise(r => setTimeout(r, 100));
    const waiting = one.query("SELECT 1 AS x");
    await new Promise(r => setTimeout(r, 1_100));
    assert.ok(one.waitMs >= 1_000, `the waiting request is seen while it waits (${one.waitMs} ms)`);
    await Promise.all([holding, waiting]);
    assert.ok(one.waitMs >= 1_000, "and the finished wait is remembered for a second");
  } finally { await one.end(); }
});
