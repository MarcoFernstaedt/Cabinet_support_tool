// The support actions through the console API: who may run each, what each confirmation must be bound to, and that hostile or malformed
// parameters are refused before anything is sent to a cabinet.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { SecretBox } from "../src/auth/secrets.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { enableDemo } from "../src/demo/demo.js";
import { ConsoleHarness, ORIGIN } from "./console-harness.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  const owner = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, 'demo.owner', 'Demo owner', 'admin', 'x')`, [owner]);
  await enableDemo(db.app, owner);
});
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

const cabinet = async () => (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE name = 'Exam Room 1' AND demo_scenario IS NOT NULL")).rows[0]!.id;
const send = async (id: string, operation: string, params: unknown, who: Awaited<ReturnType<typeof h.account>>, token?: string) =>
  h.call("POST", `/api/cabinets/${id}/commands`, { operation, params, ...(token ? { stepUpToken: token } : {}) }, who);

test("restart needs Tier 2 and a code bound to its parameters; shutting down needs an Admin", async () => {
  const [t1, t2, boss] = [await h.account("tier1"), await h.account("tier2"), await h.account("admin")];
  const id = await cabinet();
  const restart = { mode: "restart", delaySeconds: 300, message: "Restarting to finish updates." };
  assert.equal((await send(id, "system.restart", restart, t1)).status, 403, "Tier 1 may not restart");
  assert.notEqual((await send(id, "system.restart", restart, t2)).status, 202, "no code, no restart");
  const token = await h.codeToken(t2, "system.restart", id, restart);
  const ok = await send(id, "system.restart", restart, t2, token);
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  // The same token cannot be used for a different delay.
  const other = await send(id, "system.restart", { ...restart, delaySeconds: 0 }, t2, await h.codeToken(t2, "system.restart", id, restart));
  assert.notEqual(other.status, 202);
  // Shutdown: refused to Tier 2 even with a code, allowed to an Admin.
  const shutdown = { mode: "shutdown", delaySeconds: 600 };
  const refused = await send(id, "system.restart", shutdown, t2, await h.codeToken(t2, "system.restart", id, shutdown));
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  const allowed = await send(id, "system.restart", shutdown, boss, await h.codeToken(boss, "system.restart", id, shutdown));
  assert.equal(allowed.status, 202, JSON.stringify(allowed.body));
});

test("hostile or malformed parameters are refused before any command is made", async () => {
  const t2 = await h.account("tier2");
  const id = await cabinet();
  const bad: [string, unknown][] = [
    ["system.restart", { mode: "restart", message: "line one\nline two" }], ["system.restart", { mode: "restart", delaySeconds: 86_400 }], ["system.restart", { mode: "restart", delaySeconds: -1 }],
    ["system.restart", { mode: "restart", force: true }], ["system.restart", { mode: "cancel", delaySeconds: 60 }], ["system.restart", { mode: "hibernate" }], ["system.restart", { mode: "restart", message: "x".repeat(201) }],
    ["process.end", { processId: 0, name: "x.exe" }], ["process.end", { processId: "4821", name: "x.exe" }], ["process.end", { processId: 4821 }], ["process.end", { processId: 4821, name: "a\nb", tree: true }],
    ["power.set", { setting: "hibernate", enabled: true }], ["power.set", { setting: "fast_startup" }], ["power.set", { setting: "fast_startup", enabled: "no" }],
    ["network.renewLease", { interfaceIndex: 7, release: "yes" }], ["network.setIp", { interfaceIndex: 7, mode: "static", prefixLength: 24 }],
  ];
  for (const [op, params] of bad) {
    const token = await h.codeToken(t2, op, id, params).catch(() => undefined);
    const r = await send(id, op, params, t2, token);
    assert.equal(r.status, 400, `${op} ${JSON.stringify(params)} → ${r.status} ${JSON.stringify(r.body)}`);
  }
});

test("power settings need only Tier 1 and a click; ending a process needs Tier 2 and a code", async () => {
  const [t1, t2] = [await h.account("tier1"), await h.account("tier2")];
  const id = await cabinet();
  const power = { setting: "usb_selective_suspend", enabled: false };
  const ok = await send(id, "power.set", power, t1);
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  // The cabinet's own last process list: the scanner service (on the demo client's approved list) and an unapproved program.
  await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result, result_at)
                      VALUES ($1, $2, 'processes.list', '{}', $3, SYSUTCDATETIME(), DATEADD(minute, 5, SYSUTCDATETIME()), 'succeeded', $4, SYSUTCDATETIME())`,
    [randomUUID(), id, t2.id, JSON.stringify({ output: { processes: [
      { processId: 4821, name: "BioScanSvc.exe", executablePath: "C:\\Program Files\\BioScan\\BioScanSvc.exe" },
      { processId: 4822, name: "notepad.exe", executablePath: "C:\\Windows\\System32\\notepad.exe" }] } })]);
  const end = { processId: 4821, name: "BioScanSvc.exe" };
  assert.equal((await send(id, "process.end", end, t1)).status, 403);
  const unapproved = { processId: 4822, name: "notepad.exe" };
  assert.equal((await send(id, "process.end", unapproved, t2, await h.codeToken(t2, "process.end", id, unapproved))).body.error, "control_process_not_approved");
  assert.equal((await send(id, "process.end", end, t2, await h.codeToken(t2, "process.end", id, end))).status, 202);
});

test("a static address with no gateway and a lease release are accepted", async () => {
  const t2 = await h.account("tier2");
  const id = await cabinet();
  const fixed = { interfaceIndex: 7, mode: "static", address: "172.20.1.10", prefixLength: 24 };
  assert.equal((await send(id, "network.setIp", fixed, t2, await h.codeToken(t2, "network.setIp", id, fixed))).status, 202);
  assert.equal((await send(id, "network.renewLease", { interfaceIndex: 7, release: true }, t2)).status, 202);
});
