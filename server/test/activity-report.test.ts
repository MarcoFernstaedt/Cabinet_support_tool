// Case notes: a person's own activity as text for a ticket. Only changes, what was checked, alerts and saved fixes; never raw parameters, log
// contents or another person's work; every query is checked against its contract.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { enableDemo } from "../src/demo/demo.js";
import { describeChange } from "../src/services/activity-report.js";
import { ConsoleHarness, ORIGIN } from "./console-harness.js";
import { createTestDatabase, type TestDatabase, startFeed } from "./database.js";
import { tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);
const cab = async (name: string) => (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE name = $1 AND demo_scenario IS NOT NULL", [name])).rows[0]!.id;

test.before(async () => {
  db = await createTestDatabase();
  stream = new ResultStream(await startFeed(db), db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  const owner = randomUUID();
  await db.app.query<any>(`INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, 'demo.owner', 'Demo owner', 'admin', 'x')`, [owner]);
  await enableDemo(db.app, owner);
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

async function issue(user: string, cabinet: string, operation: string, params: object, status = "succeeded", minutesAgo = 5, result: object | null = null) {
  await db.app.query<any>(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result)
                      VALUES ($1, $2, $3, $4, $5, DATEADD(minute, -$6, SYSUTCDATETIME()), DATEADD(hour, 1, SYSUTCDATETIME()), $7, $8)`,
    [randomUUID(), cabinet, operation, JSON.stringify(params), user, minutesAgo, status, result ? JSON.stringify(result) : null]);
}

test("the report lists changes, what was checked, alerts and saved fixes, and nothing else", async () => {
  const me = await h.account("tier1"), them = await h.account("tier2");
  const exam = await cab("Exam Room 1"), other = await cab("Exam Room 2");
  await issue(me.id, exam, "eventlog.query", { log: "System", levels: ["error"] });
  await issue(me.id, exam, "eventlog.query", { log: "Application" });
  await issue(me.id, exam, "network.test", { target: "gateway", method: "ping", count: 20 });
  await issue(me.id, exam, "firewall.applyPolicy", {});
  await issue(me.id, exam, "network.flushDns", {}, "succeeded", 3);
  await issue(me.id, exam, "service.control", { name: "BioScanSvc", action: "restart" }, "failed", 2, { error: { code: "execution_failed" } });
  await issue(them.id, exam, "network.setDns", { interfaceIndex: 12, mode: "static", servers: ["8.8.8.8"] });
  await issue(them.id, other, "time.sync", {});
  const alert = (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM alerts WHERE cabinet_id = $1 AND state <> 'resolved'", [exam])).rows[0];
  if (alert) await db.app.query<any>("UPDATE alerts SET state = 'resolved', resolved_by = $2, resolved_at = SYSUTCDATETIME(), resolution = 'Swapped the patch cable' WHERE id = $1", [alert.id, me.id]);

  const r = await h.call("GET", `/api/reports/activity?cabinetId=${exam}&hours=8`, undefined, me);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const text: string = r.body.text;
  assert.match(text, /Case notes by /);
  assert.match(text, /Exam Room 1 \(.*Midtown Manhattan\)/);
  assert.match(text, /Checked: Event logs, Network tests/, "five reads fold into short names, each once");
  assert.match(text, /Applied the firewall policy: done/);
  assert.match(text, /Flushed the DNS cache: done/);
  assert.match(text, /Restart service BioScanSvc: failed \(execution_failed\)/);
  if (alert) assert.match(text, /Resolved alert: .*Swapped the patch cable/);
  assert.doesNotMatch(text, /8\.8\.8\.8|Exam Room 2|"log"|System|levels/, "no one else's work, no raw parameters or log names");
  assert.equal(r.body.changes, 3);

  // Another person gets only their own work.
  const theirs = (await h.call("GET", "/api/reports/activity?hours=8", undefined, them)).body.text as string;
  assert.match(theirs, /Set DNS servers to 8\.8\.8\.8/);
  assert.match(theirs, /Synced the clock/);
  assert.doesNotMatch(theirs, /firewall policy|DNS cache/);
});

test("an empty period says so, and the window is honoured", async () => {
  const me = await h.account("tier1");
  const exam = await cab("Exam Room 3");
  await issue(me.id, exam, "time.sync", {}, "succeeded", 600);
  assert.match((await h.call("GET", "/api/reports/activity?hours=4", undefined, me)).body.text, /Nothing was done in this period/);
  assert.match((await h.call("GET", "/api/reports/activity?hours=24", undefined, me)).body.text, /Synced the clock/);
});

test("hostile queries are refused, and hostile stored text cannot break the notes", async () => {
  const me = await h.account("tier1"), other = await h.account("tier1");
  const exam = await cab("Exam Room 1");
  for (const bad of ["hours=9999", "hours=8;DROP TABLE commands", "cabinetId=../../etc/passwd", `userId=${other.id}`, "hours=-1", "extra=1"])
    assert.equal((await h.call("GET", `/api/reports/activity?${bad}`, undefined, me)).status, 400, bad);
  assert.equal((await h.call("GET", "/api/reports/activity?hours=8", undefined)).status, 401, "sign-in is required");
  await issue(me.id, exam, "service.control", { name: "Bad\nName\u001b[31mred", action: "restart\r\nINJECT" });
  const text = (await h.call("GET", "/api/reports/activity?hours=8", undefined, me)).body.text as string;
  assert.doesNotMatch(text, /[\u001b\r]/, "control characters are removed");
  assert.equal(text.split("\n").filter(l => l.startsWith("INJECT")).length, 0, "a parameter cannot start a new line of notes");
});

test("every change reads as one plain sentence", () => {
  assert.equal(describeChange("network.setIp", { mode: "static", address: "10.0.0.5", prefixLength: 24, gateway: "10.0.0.1" }), "Set a fixed address 10.0.0.5/24 with gateway 10.0.0.1");
  assert.equal(describeChange("updates.uninstall", { kb: "KB5034123" }), "Rolled back Windows update KB5034123");
  assert.equal(describeChange("package.install", { packageId: "x" }, "Biometric driver 3.1"), "Installed package Biometric driver 3.1");
  assert.equal(describeChange("something.new", {}), "something.new");
});
