// Migration 0010 against a real SQL Server: the objects the code already used but no migration created (audit of 2026-10-26, S7 and F2).
// Each part is driven through the code that needs it, not just looked up in the catalog: the audit check notices that the newest entries
// were deleted, a client's file-facts paths are stored and read back, the three issue types the rules raise are there to raise, and a
// cabinet whose agent accepts unsigned upgrades is marked.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";
import { audit, auditChainHeadAnchor, transaction } from "../src/db/db.js";
import { verifyChainAndAlert } from "../src/services/maintenance.js";
import { ALLOWLIST_SET_ACTION, normalizeEntries, readLevel, setAllowlist } from "../src/services/filefacts-allowlist.js";
import { APP_VERSION_ISSUE } from "../src/services/filefacts-ingest.js";
import { usbIssueCatalogParams, usbIssueCatalogSql } from "../src/services/usb-sql.js";
import { USB_ISSUE_KEYS } from "../src/services/usb-policy.js";
import { recordHeartbeat } from "../src/services/cabinets.js";
import { cabinet } from "../src/services/fleet.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import { paramsHash } from "../src/auth/canonical.js";

let db: TestDatabase;
const admin = { userId: randomUUID(), role: "admin" };

test("migration 0010: the audit anchor, the file-facts paths and the missing issue types", async t => {
  db = await createTestDatabase();
  t.after(async () => { await db.drop(); });
  await db.app.query(`INSERT INTO users ([id],[username],[name],[role]) VALUES ($1,'m10.admin','M10 Admin','admin')`, [admin.userId]);

  // The anchor is readable by the application's role through audit_head only, and follows every append.
  for (let i = 0; i < 3; i++) await transaction(db.app, c => audit(c, { actorKind: "user", actorId: admin.userId, action: "test.entry", outcome: "succeeded", details: { i } }));
  const anchor = await auditChainHeadAnchor(db.app);
  assert.ok(anchor, "audit_head answers");
  const last = (await db.app.query<{ seq: string; hash: string }>("SELECT TOP (1) [seq], [hash] FROM audit_log ORDER BY [seq] DESC")).rows[0]!;
  assert.deepEqual(anchor, { seq: Number(last.seq), hash: last.hash });
  await assert.rejects(db.app.query("SELECT [seq] FROM audit_chain_head"), "the table itself stays closed to the application's role");
  assert.equal((await verifyChainAndAlert(db.app, "weekly")).ok, true);

  // Someone with the owner's rights removes the newest entries: the chain that is left is still internally valid, but it ends before the
  // anchor, so the check fails and raises the security alert.
  await asOwner(db, async c => {
    await c.query("DISABLE TRIGGER audit_log_immutable ON audit_log");
    await c.query("DELETE FROM audit_log WHERE [seq] > (SELECT MAX([seq]) - 2 FROM audit_log)");
    await c.query("ENABLE TRIGGER audit_log_immutable ON audit_log");
  });
  const cut = await verifyChainAndAlert(db.app, "weekly");
  assert.equal(cut.ok, false);
  assert.equal(cut.behindHead, true);
  const alert = (await db.app.query<{ title: string }>("SELECT TOP (1) title FROM security_alerts WHERE kind = 'audit_chain' ORDER BY last_seen DESC")).rows[0];
  assert.match(alert?.title ?? "", /ends before the entry the append path last wrote/);

  // The file-facts paths: stored on the client and read back through the same service the console uses.
  const clientId = randomUUID();
  await db.app.query("INSERT INTO clients ([id],[name]) VALUES ($1,'M10 client')", [clientId]);
  const raw = [{ key: "app:dispenser", root: "C:\\Program Files\\Dispenser", name: "dispenser.exe", includeSha256: false }];
  const list = normalizeEntries(raw);
  assert.ok(list.ok);
  const token = await issueStepUpToken(db.app, admin.userId, ALLOWLIST_SET_ACTION.client, clientId, paramsHash({ level: "client", id: clientId, entries: list.entries }));
  await setAllowlist(db.app, admin, "client", clientId, raw, token);
  assert.deepEqual((await readLevel(db.app, "client", clientId))?.entries.map(e => e.key), ["app:dispenser"]);
  // The column's own check holds at most 32 entries, as the approved programs' does.
  const tooMany = JSON.stringify({ entries: Array.from({ length: 33 }, (_, i) => ({ key: `app:${i}` })) });
  await assert.rejects(asOwner(db, c => c.query("UPDATE clients SET filefacts_paths = $1 WHERE id = $2", [tooMany, clientId])));

  // The issue types: the app-version alert's id, and all three USB rules' keys.
  assert.equal((await db.app.query("SELECT [key] FROM issue_types WHERE id = $1", [APP_VERSION_ISSUE])).rows[0]?.key, "app_version");
  const usb = (await db.app.query<{ key: string }>(usbIssueCatalogSql, [...usbIssueCatalogParams()])).rows.map(r => r.key).sort();
  assert.deepEqual(usb, Object.values(USB_ISSUE_KEYS).sort());

  // A development build says it accepts unsigned upgrades; the cabinet's row says so until a production build stops saying it.
  const siteId = randomUUID(), cabinetId = randomUUID();
  await db.app.query("INSERT INTO sites ([id],[client_id],[name]) VALUES ($1,$2,'M10 site')", [siteId, clientId]);
  await db.app.query("INSERT INTO cabinets ([id],[site_id],[name],[role],[status]) VALUES ($1,$2,'M10 cabinet','standalone','active')", [cabinetId, siteId]);
  assert.equal((await cabinet(db.app, cabinetId))?.unsignedUpgrades, false);
  await recordHeartbeat(db.app, cabinetId, { agentVersion: "0.3.0-dev", uptimeSeconds: 10, readOnlyMode: false, unsignedUpgrades: true });
  assert.equal((await cabinet(db.app, cabinetId))?.unsignedUpgrades, true);
  await recordHeartbeat(db.app, cabinetId, { agentVersion: "0.3.0", uptimeSeconds: 20, readOnlyMode: false });
  assert.equal((await cabinet(db.app, cabinetId))?.unsignedUpgrades, false);
});
