// Event-driven security alerts close on their own after 14 days with no recurrence (product test 2026-11-02, finding 3; the owner chose
// this over manual-only). A broken audit chain and the self-settling ops_* kinds are left alone, and a recurrence opens a fresh alert.
import test from "node:test";
import assert from "node:assert/strict";
import { closeStaleSecurityAlerts, raiseSecurityAlert, STALE_SECURITY_DAYS } from "../src/services/security.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db.drop(); });

const raise = async (kind: Parameters<typeof raiseSecurityAlert>[1]["kind"], signature: string, daysAgo: number) => {
  const { id } = await raiseSecurityAlert(db.app, { kind, signature, title: `${kind} ${signature}` });
  await db.app.query("UPDATE security_alerts SET last_seen = DATEADD(day, -$2, SYSUTCDATETIME()) WHERE id = $1", [id, daysAgo]);
  return id;
};
const state = async (id: string) => (await db.app.query<{ state: string; resolution: string | null; resolved_by: string | null }>(
  "SELECT state, resolution, resolved_by FROM security_alerts WHERE id = $1", [id])).rows[0]!;

test("one-off security alerts not seen for 14 days close themselves, with an audit entry; recent ones, a broken chain and ops alerts stay open", async () => {
  const oldCert = await raise("certificate", "cert:revoked:old", STALE_SECURITY_DAYS + 1);
  const oldDevice = await raise("new_device", "device:admin:old", 30);
  const recentDevice = await raise("new_device", "device:admin:recent", STALE_SECURITY_DAYS - 1);
  const oldChain = await raise("audit_chain", "chain:broken", 40);
  const oldBackup = await raise("ops_backup", "ops:backup", 40);

  assert.equal(await closeStaleSecurityAlerts(db.app), 2);
  for (const id of [oldCert, oldDevice]) {
    const s = await state(id);
    assert.equal(s.state, "resolved");
    assert.equal(s.resolved_by, null, "closed by the platform, not by a person");
    assert.match(s.resolution ?? "", /14 days/);
    assert.equal((await db.app.query("SELECT 1 FROM audit_log WHERE action = 'security_alert.resolve' AND target_id = $1 AND JSON_VALUE(details, '$.automatic') = 'true'", [id])).rowCount, 1);
  }
  for (const id of [recentDevice, oldChain, oldBackup]) assert.equal((await state(id)).state, "open");
  assert.equal(await closeStaleSecurityAlerts(db.app), 0, "running it again closes nothing more");

  // The same thing happening again is a new alert, not a reopened old one.
  const again = await raiseSecurityAlert(db.app, { kind: "certificate", signature: "cert:revoked:old", title: "certificate again" });
  assert.equal(again.created, true);
  assert.notEqual(again.id, oldCert);
});
