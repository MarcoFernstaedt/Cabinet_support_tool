import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit, transaction, verifyAuditChain } from "../src/db/db.js";
import { migrate, MIGRATIONS_DIR, readMigrations } from "../src/db/migrate.js";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db.drop(); });

test("migrations run once and refuse to run an edited migration", async () => {
  await asOwner(db, async c => {
    assert.deepEqual(await migrate(c), [], "already applied");
    const dir = mkdtempSync(join(tmpdir(), "migrations-"));
    for (const f of readdirSync(MIGRATIONS_DIR)) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    writeFileSync(join(dir, "0001_initial.sql"), "-- edited\n", { flag: "a" });
    await assert.rejects(migrate(c, readMigrations(dir)), /changed after it was applied/);
  });
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
    "INSERT INTO audit_log VALUES (999, now(), 'system', 'x', 'x', null, null, 'x', '{}', 'x', 'x')",
    "UPDATE audit_log SET outcome = 'succeeded'",
    "DELETE FROM audit_log",
    "TRUNCATE audit_log",
    "UPDATE audit_chain_head SET seq = 0",
  ]) await assert.rejects(db.app.query(sql), /permission denied/, sql);
});

test("even the audit table's owner cannot change or delete an entry", async () => {
  await asOwner(db, async c => {
    await c.query("SET ROLE cabinet_audit_writer");
    await assert.rejects(c.query("UPDATE audit_log SET outcome = 'x'"), /append-only|permission denied/);
    await assert.rejects(c.query("DELETE FROM audit_log"), /append-only|permission denied/);
  });
});

test("tampering with an entry is detected at the entry that changed", async () => {
  await transaction(db.app, async c => {
    for (let i = 0; i < 3; i++) await audit(c, { actorKind: "system", actorId: "test", action: `test.tamper.${i}`, outcome: "succeeded" });
  });
  const target = Number((await db.app.query<{ seq: string }>("SELECT seq FROM audit_log WHERE action = 'test.tamper.1'")).rows[0]!.seq);
  await asOwner(db, async c => {
    // Only a database superuser bypassing the triggers can do this; the chain still catches it.
    await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable");
    await c.query("UPDATE audit_log SET outcome = 'failed' WHERE seq = $1", [target]);
    await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable");
  });
  const check = await verifyAuditChain(db.app);
  assert.equal(check.ok, false);
  assert.equal(check.firstBadSeq, target);
});
