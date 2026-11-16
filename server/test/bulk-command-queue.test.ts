// The insert a fleet job and a bulk firewall change made themselves, moved into commands.ts, the table's owner (F21.R2, decision-log
// D102). It queues one command of a bulk change in the caller's transaction, after checking what it is given as issueCommand checks a
// single command: a catalog write, parameters that match the operation's schema, uuids, and an expiry after the issue time.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { queueBulkCommand, type BulkCommand } from "../src/services/commands.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function cabinetAndUser(): Promise<{ cabinet: string; user: string }> {
  const client = randomUUID(), site = randomUUID(), cabinet = randomUUID(), user = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'K', 'standalone', 'active')", [cabinet, site]);
  await db.app.query("INSERT INTO users (id, username, name, role, status, password_hash) VALUES ($1, $2, 'U', 'admin', 'active', 'x')", [user, `u-${user.slice(0, 8)}`]);
  return { cabinet, user };
}
const PARAMS = { profiles: { domain: true, private: true, public: false } };
function command(cabinet: string, user: string, over: Partial<BulkCommand> = {}): BulkCommand {
  const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  return { commandId: randomUUID(), cabinetId: cabinet, operation: "firewall.applyPolicy", params: PARAMS, issuedBy: user, issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 600_000), bulkId: randomUUID(), ...over };
}
const stored = async (id: string) => (await db.app.query<{ cabinet_id: string; operation: string; params: unknown; issued_by: string; status: string; bulk_id: string; issued_at: Date; expires_at: Date }>(
  "SELECT cabinet_id, operation, params, issued_by, status, bulk_id, issued_at, expires_at FROM commands WHERE id = $1", [id])).rows[0];
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("a bulk command is queued with what it was given: queued, in its bulk, by its issuer, with its parameters", async () => {
  const { cabinet, user } = await cabinetAndUser();
  const cmd = command(cabinet, user);
  await queueBulkCommand(db.app, cmd);
  const r = await stored(cmd.commandId);
  assert.ok(r, "the command was stored");
  assert.deepEqual([r.cabinet_id.toLowerCase(), r.operation, r.issued_by.toLowerCase(), r.status, r.bulk_id.toLowerCase()],
    [cabinet, "firewall.applyPolicy", user, "queued", cmd.bulkId]);
  assert.deepEqual(r.params, PARAMS);
  assert.deepEqual([r.issued_at.getTime(), r.expires_at.getTime()], [cmd.issuedAt.getTime(), cmd.expiresAt.getTime()]);
});

test("a bulk command queued in a transaction that rolls back is not stored", async () => {
  const { cabinet, user } = await cabinetAndUser();
  const cmd = command(cabinet, user);
  await assert.rejects(db.app.transaction(async tx => { await queueBulkCommand(tx, cmd); throw new Error("rolled back"); }), /rolled back/);
  assert.equal(await stored(cmd.commandId), undefined);
});

test("anything but a catalog write with matching parameters, uuids and a later expiry is refused before the database is touched", async () => {
  const { cabinet, user } = await cabinetAndUser();
  const good = command(cabinet, user);
  const badIds = [undefined, null, "", "not-an-id", `${cabinet}'; DROP TABLE commands; --`, 42];
  let refused = 0;
  // Each refusal must be the check's own, named by its reason: a value that only fails further on (a TypeError, another check) does not count.
  const refuse = async (over: Record<string, unknown>, why: RegExp, what: string) => {
    await assert.rejects(queueBulkCommand(untouched, { ...good, ...over } as BulkCommand), (e: Error) => why.test(e.message), what); refused++;
  };
  for (const k of ["commandId", "cabinetId", "issuedBy", "bulkId"]) for (const v of badIds) await refuse({ [k]: v }, new RegExp(`${k} must be a uuid`), `${k} ${String(v)}`);
  // Not in the catalog, or a shell-like name: a bulk change only ever queues catalog operations.
  for (const op of [undefined, "", "shell.run", "process.start; whoami", "FIREWALL.APPLYPOLICY", 7]) await refuse({ operation: op }, /must be a catalog operation/, `operation ${String(op)}`);
  // A read, with parameters its schema accepts, so only the write check can refuse it.
  await refuse({ operation: "system.info", params: {} }, /is a write/, "a read operation");
  for (const p of [undefined, null, {}, { profiles: { domain: "yes" } }, { profiles: PARAMS.profiles, extra: 1 }, "{}", []]) await refuse({ params: p }, /do not match the operation's schema/, `params ${JSON.stringify(p)}`);
  const at = good.issuedAt;
  for (const [i, e] of [[at, at], [at, new Date(at.getTime() - 1)], [new Date(Number.NaN), at], [at, new Date(Number.NaN)], [at.toISOString(), good.expiresAt], [at, good.expiresAt.toISOString()]])
    await refuse({ issuedAt: i, expiresAt: e }, /expires after it is issued/, `times ${String(i)} ${String(e)}`);
  await assert.rejects(queueBulkCommand(untouched, null as never), /a bulk command is required/); refused++;
  assert.equal(refused, 45);
  assert.equal(await stored(good.commandId), undefined, "nothing was stored");
});
