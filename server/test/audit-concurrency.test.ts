// The audit chain under concurrent appends made outside any transaction (straight on the pool), as several routes do.
// Each call must take the next sequence number under the chain lock and leave the head at the log's last entry: no duplicate
// sequence numbers, no entry the head does not cover, and a chain that verifies from the first entry to the head.
import test from "node:test";
import assert from "node:assert/strict";
import { audit, auditChainHeadAnchor, auditMany, transaction, verifyAuditChain } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db.drop(); });

const entry = (i: number) => ({ actorKind: "system" as const, actorId: "test", action: "concurrency.check", outcome: "succeeded" as const, details: { i } });

test("concurrent single and batched appends outside a transaction keep the chain whole and the head at its end", async () => {
  // Rounds of 30 calls at once, single and batched mixed, over the pool's 10 connections.
  let expected = 0;
  const failures: string[] = [];
  for (let round = 0; round < 10; round++) {
    const calls = Array.from({ length: 30 }, (_, i) => {
      const n = round * 30 + i;
      if (i % 3 === 0) { expected += 3; return auditMany(db.app, [entry(n), entry(n), entry(n)]); }
      expected += 1; return audit(db.app, entry(n));
    });
    for (const r of await Promise.allSettled(calls)) if (r.status === "rejected") failures.push(String((r.reason as Error).message).slice(0, 200));
  }
  assert.deepEqual(failures, [], `appends that failed: ${failures.length}`);
  const rows = (await db.app.query<{ n: number; top: string }>("SELECT COUNT(*) AS n, MAX([seq]) AS [top] FROM audit_log")).rows[0]!;
  assert.equal(Number(rows.n), expected, "every append left exactly its entries");
  assert.equal(Number(rows.top), expected, "sequence numbers run 1 to the count with no gaps");
  const head = await auditChainHeadAnchor(db.app);
  assert.equal(head?.seq, expected, "the head is at the log's last entry");
  const check = await verifyAuditChain(db.app, 10_000, undefined, { head });
  assert.equal(check.ok, true, JSON.stringify(check));
  // The chain is still usable afterwards: one more append takes the next number.
  assert.equal(await audit(db.app, entry(-1)), expected + 1);
});

test("inside a caller's transaction an append still commits or rolls back with that transaction", async () => {
  const before = (await auditChainHeadAnchor(db.app))!.seq;
  await assert.rejects(transaction(db.app, async tx => { await audit(tx, entry(-2)); throw new Error("caller gives up"); }), /caller gives up/);
  assert.equal((await auditChainHeadAnchor(db.app))!.seq, before, "a rolled-back caller leaves neither the entry nor the head moved");
  assert.equal((await db.app.query("SELECT 1 FROM audit_log WHERE [seq] > $1", [before])).rowCount, 0);
  const seq = await transaction(db.app, tx => audit(tx, entry(-3)));
  assert.equal(seq, before + 1);
  assert.equal((await auditChainHeadAnchor(db.app))!.seq, before + 1);
  // A refused batch (not a JSON array) opens no transaction and changes nothing.
  await assert.rejects(db.app.query("DECLARE @f bigint, @l bigint; EXEC audit_append_many $1, @f OUTPUT, @l OUTPUT;", ["{\"not\":\"an array\"}"]), /JSON array/);
  assert.equal((await auditChainHeadAnchor(db.app))!.seq, before + 1);
  assert.equal((await verifyAuditChain(db.app, 10_000, undefined, { head: await auditChainHeadAnchor(db.app) })).ok, true);
});
