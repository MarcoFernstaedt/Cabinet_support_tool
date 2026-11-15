// The writes to cabinet_certificates that enrollment and replacement made themselves, moved behind cabinets.ts, the table's owner (F21.R2,
// decision-log D87): recording the certificate issued at enrollment, and revoking every certificate a cabinet has when it is replaced. Each
// checks what it is given before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { authenticate, CERTIFICATE_SERIAL, recordIssuedCertificate, revokeCabinetCertificates } from "../src/services/cabinets.js";
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
const serial = () => randomBytes(16).toString("hex").toUpperCase();
const inAYear = () => new Date(Date.now() + 365 * 86_400_000);
const certs = async (k: string) => (await db.app.query<{ serial: string; revoked: boolean }>(
  "SELECT serial, CAST(CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END AS bit) AS revoked FROM cabinet_certificates WHERE cabinet_id = $1 ORDER BY serial", [k])).rows;

test("the certificate issued at enrollment is recorded for its cabinet", async () => {
  const k = await cabinet(), s = serial(), notAfter = inAYear();
  await recordIssuedCertificate(db.app, k, s, notAfter);
  const row = (await db.app.query<{ serial: string; not_after: Date }>("SELECT serial, not_after FROM cabinet_certificates WHERE cabinet_id = $1", [k])).rows;
  assert.deepEqual(row.map(r => r.serial), [s]);
  assert.ok(Math.abs(row[0]!.not_after.getTime() - notAfter.getTime()) < 1000);
});

test("revoking a cabinet's certificates revokes each one it still has, and no other cabinet's; a repeat revokes nothing", async () => {
  const k = await cabinet(), other = await cabinet();
  for (let i = 0; i < 3; i++) await recordIssuedCertificate(db.app, k, serial(), inAYear());
  await recordIssuedCertificate(db.app, other, serial(), inAYear());
  assert.equal(await revokeCabinetCertificates(db.app, k), 3);
  assert.ok((await certs(k)).every(c => c.revoked));
  assert.ok((await certs(other)).every(c => !c.revoked), "another cabinet keeps its certificate");
  assert.equal(await revokeCabinetCertificates(db.app, k), 0);
});

test("anything but a cabinet id, an upper-case hex serial and a real expiry is refused before the database is touched", async () => {
  const k = await cabinet();
  const badIds: unknown[] = [undefined, null, "", "not-an-id", "' OR 1=1 --", `${k}; DELETE FROM cabinet_certificates`, 42, {}];
  for (const id of badIds) {
    await assert.rejects(recordIssuedCertificate(db.app, id as never, serial(), inAYear()), /cabinet id/, String(id));
    await assert.rejects(revokeCabinetCertificates(db.app, id as never), /cabinet id/, String(id));
  }
  for (const s of [undefined, null, "", "A", "abcdef", "0G", "AB CD", "A".repeat(65), "AB'; DROP TABLE cabinet_certificates; --", 1234])
    await assert.rejects(recordIssuedCertificate(db.app, k, s as never, inAYear()), /serial/, String(s));
  for (const when of [undefined, null, "2030-01-01", Date.now(), new Date(Number.NaN)])
    await assert.rejects(recordIssuedCertificate(db.app, k, serial(), when as never), /expiry/, String(when));
  assert.deepEqual(await certs(k), [], "nothing was recorded");
});

test("recording and authenticating apply one serial rule: what one accepts the other does, at both ends of the range (D89)", async () => {
  // recordIssuedCertificate allowed 1 to 40 digits while authenticate and the table's check allow 2 to 64: a 41-digit serial the rest of
  // the platform accepts was refused, and a one-digit one reached the database. Both now use CERTIFICATE_SERIAL.
  for (const digits of [2, 32, 41, 64]) {
    const k = await cabinet(), s = "A".repeat(digits);
    assert.equal(CERTIFICATE_SERIAL.test(s), true, String(digits));
    await recordIssuedCertificate(db.app, k, s, inAYear());
    assert.equal((await authenticate(db.app, s, k))?.id.toLowerCase(), k.toLowerCase(), `a ${digits}-digit serial that is recorded authenticates`);
  }
  // The refusal has to come from the rule, not from the table after a round trip: with the check disabled a one-digit serial
  // reaches the INSERT and the constraint refuses it, so a rejection matched on the message alone passes without the fix.
  const untouched: Queryable = { query: async () => { throw new Error("a serial the rule refuses reached the database"); } };
  for (const s of ["A", "A".repeat(65)]) {
    const k = await cabinet();
    assert.equal(CERTIFICATE_SERIAL.test(s), false);
    await assert.rejects(recordIssuedCertificate(db.app, k, s, inAYear()), /serial/, `${s.length} digits are not recorded`);
    await assert.rejects(recordIssuedCertificate(untouched, k, s, inAYear()), (e: Error) => /serial/.test(e.message) && !/reached the database/.test(e.message), `${s.length} digits are refused before the database is touched`);
    assert.equal(await authenticate(db.app, s, k), null, `${s.length} digits do not authenticate`);
  }
});
