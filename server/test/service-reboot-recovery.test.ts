// A service set to restart the computer when it fails is visible and alertable (F14.R3, decision-log D43). A services.list reading that
// lists one opens one minor alert naming the services; the next reading with none closes it, automatically and audited. Through the real
// command path (issue, take, store) on a real SQL Server.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { issueCommand, storeResult, takeQueuedCommands } from "../src/services/commands.js";
import { rebootTitle, REBOOT_SIGNATURE } from "../src/services/service-recovery.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
let cabinetId: string;
const userId = randomUUID();
test.before(async () => {
  db = await createTestDatabase();
  const clientId = randomUUID(), siteId = randomUUID();
  cabinetId = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'svc.reader', 'Reader', 'tier1')", [userId]);
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour')", [clientId]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Pier')", [siteId, clientId]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES ($1, $2, 'K1', 'standalone', 'active', SYSUTCDATETIME())", [cabinetId, siteId]);
});
test.after(async () => { await db.drop(); });

type Action = "none" | "restart" | "reboot" | "run_program";
const service = (name: string, recovery: [Action, Action, Action] | null) => ({
  name, displayName: name, state: "running", startType: "automatic", account: "LocalSystem", processId: 100, executablePath: `C:\\Windows\\System32\\${name}.exe`,
  description: null, recovery: recovery ? { firstFailure: recovery[0], secondFailure: recovery[1], subsequentFailures: recovery[2], resetPeriodSeconds: 86400 } : null,
});
/** The cabinet answers a services.list the console asked for, through the same path an agent's answer takes. */
async function reading(services: ReturnType<typeof service>[]) {
  await issueCommand(db.app, userId, cabinetId, "services.list", {});
  const [cmd] = await takeQueuedCommands(db.app, cabinetId);
  const now = new Date().toISOString();
  await storeResult(db.app, cabinetId, { commandId: cmd!.commandId, status: "succeeded", startedAt: now, finishedAt: now, output: { services, watched: [] } } as never);
}
const alerts = async () => (await db.app.query<{ state: string; title: string; severity: string; issue_type_id: string }>(
  "SELECT state, title, severity, LOWER(CONVERT(nvarchar(64), issue_type_id)) AS issue_type_id FROM alerts WHERE cabinet_id = $1 AND signature = $2", [cabinetId, REBOOT_SIGNATURE])).rows;

test("a reading with services that restart the computer on failure opens one minor alert naming them; a reading without closes it, audited", async () => {
  await reading([service("Spooler", ["restart", "restart", "none"]), service("W32Time", null)]);
  assert.deepEqual(await alerts(), [], "a restart of the service itself is not this");
  await reading([service("BioScanSvc", ["restart", "reboot", "reboot"]), service("Spooler", ["restart", "restart", "none"]), service("AppSync", ["reboot", "none", "none"])]);
  let a = await alerts();
  assert.equal(a.length, 1);
  assert.deepEqual([a[0]!.state, a[0]!.severity, a[0]!.issue_type_id, a[0]!.title],
    ["open", "minor", "00000000-0000-4000-8000-000000000127", "Set to restart the computer if it fails: AppSync, BioScanSvc"]);
  // The same setting seen again updates the one alert.
  await reading([service("BioScanSvc", ["restart", "reboot", "reboot"])]);
  a = await alerts();
  assert.deepEqual([a.length, a[0]!.title], [1, "Set to restart the computer if it fails: BioScanSvc"]);
  await reading([service("BioScanSvc", ["restart", "restart", "restart"])]);
  assert.deepEqual((await alerts()).map(x => x.state), ["resolved"]);
  const audit = (await db.app.query<{ actor_id: string; details: { automatic: boolean } }>(
    "SELECT actor_id, details FROM audit_log WHERE action = 'alert.resolve' AND actor_kind = 'system' ORDER BY seq DESC")).rows[0]!;
  assert.deepEqual([audit.actor_id, audit.details.automatic], ["service-recovery", true]);
});

test("the title names at most five services, then how many more", () => {
  assert.equal(rebootTitle(["A", "B", "C", "D", "E", "F", "G"]), "Set to restart the computer if it fails: A, B, C, D, E and 2 more");
});
