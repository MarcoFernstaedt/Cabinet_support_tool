// Stored readings, the fleet search over them, and load samples: what is found, what is never found by a trick, and that nothing here
// sends anything to a cabinet.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { enableDemo } from "../src/demo/demo.js";
import { envelopes } from "../src/contracts.js";
import { recordHeartbeat } from "../src/services/cabinets.js";
import { ConsoleHarness, ORIGIN } from "./console-harness.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let owner: string;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);

test.before(async () => {
  db = await createTestDatabase();
  stream = new ResultStream(db.appUrl, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  owner = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, 'demo.owner', 'Demo owner', 'admin', 'x')`, [owner]);
  await enableDemo(db.app, owner);
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

const cab = async (name: string) => (await db.app.query<{ id: string; site_id: string }>("SELECT id, site_id FROM cabinets WHERE name = $1 AND demo_scenario IS NOT NULL", [name])).rows[0]!;
/** A stored answer, as the result of a command the cabinet ran `ageMinutes` ago. */
async function store(cabinetId: string, operation: string, output: unknown, ageMinutes = 5) {
  const id = randomUUID(), at = new Date(Date.now() - ageMinutes * 60_000);
  await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, delivered_at, result, result_at)
                      VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, $6, 'succeeded', $5, $7, $5)`,
    [id, cabinetId, operation, owner, at, new Date(at.getTime() + 300_000), JSON.stringify({ commandId: id, status: "succeeded", startedAt: at.toISOString(), finishedAt: at.toISOString(), output })]);
}
const software = (...names: string[]) => ({ takenAt: "2026-10-16T10:00:00Z", programs: names.map(name => ({ name, version: "1.0", publisher: "Example", installedOn: null })), hotfixes: [{ id: "KB5034441", description: "Security Update", installedOn: null }], truncated: false });
const search = async (who: Awaited<ReturnType<typeof h.account>>, operation: string, q: string, extra = "") =>
  h.call("GET", `/api/readings/search?operation=${operation}&q=${encodeURIComponent(q)}${extra}`, undefined, who);

test("the simulated fleet comes with stored readings for the cabinet that is offline, so its last known state can be shown", async () => {
  const t1 = await h.account("tier1");
  const offline = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE demo_scenario = 'offline' LIMIT 1")).rows[0]!;
  const list = await h.call("GET", `/api/cabinets/${offline.id}/readings`, undefined, t1);
  assert.equal(list.status, 200);
  assert.ok(list.body.readings.some((r: { operation: string }) => r.operation === "power.status"));
  const one = await h.call("GET", `/api/cabinets/${offline.id}/readings/power.status`, undefined, t1);
  assert.equal(one.body.reading.output.plan, "Balanced");
  assert.deepEqual((await h.call("GET", `/api/cabinets/${offline.id}/readings/dns.cache`, undefined, t1)).body, { reading: null }, "never read");
  assert.equal((await h.call("GET", `/api/cabinets/${offline.id}/readings/firewall.setProfile`, undefined, t1)).status, 404, "a write is not a reading");
  // From here the tests store their own readings on a clean slate.
  await db.app.query("DELETE FROM commands WHERE operation = ANY($1::text[])", [["software.list", "startup.list", "power.status", "system.security", "shares.list"]]);
});

test("the search finds the latest stored reading's matches, says how many cabinets were read, and a newer reading replaces an older one", async () => {
  const t1 = await h.account("tier1");
  const [a, b, c] = [await cab("Exam Room 1"), await cab("Exam Room 2"), await cab("Exam Room 3")];
  await store(a.id, "software.list", software("BioScan Client", "Notepad++"));
  await store(b.id, "software.list", software("Other Tool"), 60);
  await store(b.id, "software.list", software("BioScan Client"), 10);   // newer: now has it
  await store(c.id, "software.list", software("BioScan Client"), 120);
  await store(c.id, "software.list", software("Something Else"), 1);    // newer: no longer has it
  const r = await search(t1, "software.list", "bioscan");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.matches.map((m: { name: string }) => m.name).sort(), ["Exam Room 1", "Exam Room 2"]);
  assert.equal(r.body.cabinetsRead, 3);
  assert.ok(r.body.cabinetsInScope > 3, "the cabinets never read are counted so an empty answer is not read as 'none have it'");
  assert.deepEqual(r.body.matches.find((m: { name: string }) => m.name === "Exam Room 1").found, ["BioScan Client 1.0"]);
  assert.equal((await search(t1, "software.list", "KB5034441")).body.matches.length, 3, "update numbers are searched too");
  // Scoped to one site.
  assert.equal((await search(t1, "software.list", "bioscan", `&siteId=${a.site_id}`)).body.matches.length, 2);
  assert.equal((await search(t1, "software.list", "bioscan", `&siteId=${randomUUID()}`)).body.matches.length, 0);
});

test("state searches use fixed keywords", async () => {
  const t1 = await h.account("tier1");
  const a = await cab("Reception"), b = await cab("Waiting Room");
  await store(a.id, "power.status", { takenAt: "2026-10-16T10:00:00Z", plan: "Balanced", fastStartup: true, hibernate: true, usbSelectiveSuspend: { pluggedIn: true, onBattery: true } });
  await store(b.id, "power.status", { takenAt: "2026-10-16T10:00:00Z", plan: "Balanced", fastStartup: false, hibernate: true, usbSelectiveSuspend: { pluggedIn: false, onBattery: false } });
  assert.deepEqual((await search(t1, "power.status", "usb_suspend")).body.matches.map((m: { name: string }) => m.name), ["Reception"]);
  assert.equal((await search(t1, "power.status", "anything else")).status, 400, "not a keyword");
  await store(a.id, "system.security", { takenAt: "2026-10-16T10:00:00Z", pendingReboot: { pending: true, reasons: ["Windows Update"] }, defender: { enabled: false, realTimeProtection: false, signatureAgeDays: 40, lastQuickScan: null, lastFullScan: null, threats: [] }, bitlocker: [{ volume: "C:", protection: "off", percentEncrypted: null }], activation: null, certificates: [] });
  for (const key of ["pending_restart", "defender_off", "bitlocker_off"]) {
    const r = await search(t1, "system.security", key);
    assert.deepEqual(r.body.matches.map((m: { name: string }) => m.name), ["Reception"], key);
  }
  assert.equal((await search(t1, "system.security", "cert_expiring")).body.matches.length, 0);
});

test("hostile or malformed searches find nothing by a trick and are refused before the database", async () => {
  const t1 = await h.account("tier1");
  for (const q of ["%", "_", "' OR '1'='1", "\"; DROP TABLE commands; --", ".*", "[a-z]+", "\\"]) {
    const r = await search(t1, "software.list", q);
    assert.equal(r.status, 200, q);
    assert.equal(r.body.matches.length, 0, `${JSON.stringify(q)} is plain text, not a pattern`);
  }
  for (const [op, q] of [["processes.list", "x"], ["software.list", ""], ["software.list", "a\nb"], ["software.list", "x".repeat(81)], ["files.list", "x"]] as const)
    assert.equal((await search(t1, op, q)).status, 400, `${op} ${JSON.stringify(q)}`);
  assert.equal((await h.call("GET", "/api/readings/search?operation=software.list&q=x&sql=1", undefined, t1)).status, 400);
  assert.equal((await h.call("GET", "/api/readings/search?operation=software.list&q=x", undefined)).status, 401, "signing in is required");
});

test("searches are audited", async () => {
  assert.ok(((await db.app.query("SELECT 1 FROM audit_log WHERE action = 'readings.search'")).rowCount ?? 0) > 0);
});

test("a heartbeat's load sample is stored at most every five minutes, kept in range, and read back as a history", async () => {
  const t1 = await h.account("tier1");
  const k = await cab("Surgery").catch(() => cab("Check-in"));
  const hb = (cpu: number) => ({ agentVersion: "1.4.2", uptimeSeconds: 100, readOnlyMode: false, health: { cpuPercent: cpu, memoryUsedPercent: 50, diskFreePercent: 40 } });
  await db.app.query("DELETE FROM health_samples WHERE cabinet_id = $1", [k.id]);
  await recordHeartbeat(db.app, k.id, hb(10));
  await recordHeartbeat(db.app, k.id, hb(90));   // within five minutes: not stored
  const history = await h.call("GET", `/api/cabinets/${k.id}/health?hours=6`, undefined, t1);
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.points.map((p: { cpu: number }) => p.cpu), [10]);
  assert.equal((await h.call("GET", `/api/cabinets/${k.id}/health?hours=9999`, undefined, t1)).status, 400);
  // The envelope refuses out-of-range or partial samples before anything is stored.
  for (const bad of [{ cpuPercent: 101, memoryUsedPercent: 5, diskFreePercent: 5 }, { cpuPercent: -1, memoryUsedPercent: 5, diskFreePercent: 5 }, { cpuPercent: 1, memoryUsedPercent: 5 }, { cpuPercent: 1.5, memoryUsedPercent: 5, diskFreePercent: 5 }])
    assert.throws(() => envelopes.heartbeat.parse({ agentVersion: "1.4.2", uptimeSeconds: 1, readOnlyMode: false, health: bad }), JSON.stringify(bad));
  // The simulated fleet has a day of history already.
  const demo = await h.call("GET", `/api/cabinets/${(await cab("Midtown Sync")).id}/health?hours=24`, undefined, t1);
  assert.ok(demo.body.points.length > 100);
});
