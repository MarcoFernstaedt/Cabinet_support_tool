// Reviewer: export TEST_DATABASE_ADMIN_URL, npm --prefix server run build,
// node --test server/dist/test/session-shell-sql.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { insertSessionRecord, sessionRecord } from "../src/services/session-records.js";
import { grantPermission } from "../src/services/user-permissions.js";
import { SessionShell } from "../src/services/session-shell.js";
import { verifyAuditChain } from "../src/db/db.js";

let db: TestDatabase;
const operator = randomUUID(), cabinet = randomUUID();
test.before(async () => {
  db = await createTestDatabase();
  const client = randomUUID(), site = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'shell-review', 'Shell reviewer', 'tier2')", [operator]);
  await db.app.transaction(tx => grantPermission(tx, operator, operator, "session.open", "fleet", null));
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Shell client')", [client]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Shell site')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'Shell cabinet', 'standalone', 'active')", [cabinet, site]);
});
test.after(async () => { await db?.drop(); });

test("separate workers deliver named shell input/output with durable command and audit history after process death", async () => {
  const id = await db.app.transaction(tx => insertSessionRecord(tx, { cabinetId: cabinet, operatorId: operator, kind: "shell", reason: "Shell acceptance" }));
  const consoleWorker = new SessionShell(db.app), agentWorker = new SessionShell(db.app);
  const first = { kind: "shell.in", data: Buffer.from("who").toString("base64") };
  await consoleWorker.exchange(cabinet, id, "console", first, operator);
  let commands = (await db.app.query<{ input_data: string; complete: boolean }>("SELECT input_data, complete FROM session_shell_commands WHERE session_id = $1", [id])).rows;
  assert.equal(Buffer.from(commands[0]!.input_data, "base64").toString(), "who");
  assert.equal(!!commands[0]!.complete, false);
  assert.deepEqual(await agentWorker.exchange(cabinet, id, "agent", { data: "" }), first);
  const second = { kind: "shell.in", data: Buffer.from("ami\r").toString("base64") };
  await consoleWorker.exchange(cabinet, id, "console", second, operator);
  assert.deepEqual(await agentWorker.exchange(cabinet, id, "agent", { kind: "shell.out", data: Buffer.from("DEVICEB\\operator").toString("base64") }), second);
  await agentWorker.exchange(cabinet, id, "agent", { kind: "shell.exit", code: 7 });
  assert.ok((await sessionRecord(db.app, id))!.closed_at);
  commands = (await db.app.query<{ input_data: string; complete: boolean }>("SELECT input_data, complete FROM session_shell_commands WHERE session_id = $1", [id])).rows;
  assert.equal(commands.length, 1);
  assert.equal(Buffer.from(commands[0]!.input_data, "base64").toString(), "whoami\r");
  assert.equal(!!commands[0]!.complete, true);
  const actions = (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE JSON_VALUE(details, '$.sessionId') = $1 ORDER BY seq", [id])).rows.map(r => r.action);
  assert.deepEqual(actions, ["session.open", "shell.in", "shell.command", "shell.in", "shell.out", "shell.exit", "session.end"]);
  assert.equal((await verifyAuditChain(db.app)).ok, true);
  await assert.rejects(db.app.query("DELETE FROM session_shell_commands WHERE session_id = $1", [id]));
  await assert.rejects(db.app.query("DELETE FROM session_shell_frames WHERE session_id = $1", [id]));
});

test("diagnostic sessions and another operator cannot receive shell input", async () => {
  const id = await db.app.transaction(tx => insertSessionRecord(tx, { cabinetId: cabinet, operatorId: operator, kind: "diagnostic", reason: "Diagnostic only" }));
  const shell = new SessionShell(db.app);
  await assert.rejects(shell.exchange(cabinet, id, "console", { kind: "shell.in", data: "YQ==" }, operator), /no such shell/);
  assert.equal((await db.app.query("SELECT seq FROM session_shell_frames WHERE session_id = $1", [id])).rows.length, 0);
});
