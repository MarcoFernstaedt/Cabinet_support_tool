// A cabinet at a glance: machine, Windows, memory and storage from the latest stored reads, each with the time it was read, and the latest
// heartbeat load. Every role can read it. A part never read is null; a malformed stored answer is dropped piece by piece, never shown as a
// wrong figure. Through the real console route on a real SQL Server.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SecretBox } from "../src/auth/secrets.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { ConsoleHarness, ORIGIN, type Account } from "./console-harness.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA_DIR } from "@mashura/cabinet-contracts/load";
import { operations } from "../src/contracts.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);
const call = h.call.bind(h);
let t1: Account;
let siteId: string;
const userId = randomUUID();

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  t1 = await h.account("tier1");
  const clientId = randomUUID();
  siteId = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'reader.summary', 'Reader', 'tier1')", [userId]);
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour')", [clientId]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Pier')", [siteId, clientId]);
});
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

async function cabinet() {
  const id = randomUUID();
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, architecture) VALUES ($1, $2, $3, 'standalone', 'active', 'windows-x64')", [id, siteId, `K ${id.slice(0, 6)}`]);
  return id;
}
/** A contract example answer for an operation (contracts/examples), the shape the agent really sends. */
const example = (operation: string, name = "typical.json") =>
  JSON.parse(readFileSync(join(dirname(SCHEMA_DIR), "examples", "operations", operation, "output", "valid", name), "utf8")) as Record<string, unknown>;
/**
 * A stored answer of `operation`. Every answer is checked against the operation's output contract first, as the server checks an answer
 * when it arrives, so a fixture can never hold a value the agent cannot send (review of #215: `secureBoot: true` hid a wrong read).
 * `damaged` stores it unchecked, for the case under test that is a damaged row.
 */
const stored = (cabinetId: string, operation: string, minutesAgo: number, output: unknown, damaged = false) => {
  if (!damaged) operations[operation as keyof typeof operations]!.output.parse(output);
  return db.app.query(
    `INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result, result_at)
     VALUES ($1, $2, $3, '{}', $4, DATEADD(minute, -$5, SYSUTCDATETIME()), DATEADD(minute, 5 - $5, SYSUTCDATETIME()), 'succeeded', $6, DATEADD(minute, -$5, SYSUTCDATETIME()))`,
    [randomUUID(), cabinetId, operation, userId, minutesAgo, JSON.stringify({ status: "succeeded", output })]);
};
const GB = 1024 ** 3;

test("the machine, its Windows, memory and storage come from the latest reads, each with its time, and the latest load sample", async () => {
  const k = await cabinet();
  const hardware = example("system.hardware");
  await stored(k, "system.hardware", 90, { ...hardware, model: "Older read" });
  await stored(k, "system.hardware", 30, { ...hardware, manufacturer: "Dell Inc.", model: "OptiPlex 7090", cpu: { model: "Intel Core i5-10500T", logicalCores: 12 },
    memory: { ...(hardware.memory as object), totalBytes: 16 * GB, moduleCount: 2 }, bios: { vendor: "Dell", version: "1.18.0", date: "2023-05-09T00:00:00Z" },
    tpm: { present: true, enabled: true, version: "2.0" }, secureBoot: "on", lastBoot: "2026-11-08T06:00:00Z" });
  await stored(k, "system.info", 20, { ...example("system.info"), osVersion: "Windows 11 IoT Enterprise LTSC 2024", osBuild: "26100.2033", uptimeSeconds: 86_400 * 3 });
  const perf = example("system.performance");
  await stored(k, "system.performance", 10, { ...perf, memory: { ...(perf.memory as object), totalBytes: 16 * GB, availableBytes: 6 * GB },
    volumes: [{ drive: "C:", label: "OS", fileSystem: "NTFS", sizeBytes: 256 * GB, freeBytes: 40 * GB }, { drive: "D:", label: null, fileSystem: "NTFS", sizeBytes: 1024 * GB, freeBytes: 900 * GB }] });
  await db.app.query("INSERT INTO health_samples (cabinet_id, [at], cpu_percent, memory_used_percent, disk_free_percent) VALUES ($1, DATEADD(minute, -2, SYSUTCDATETIME()), 17, 62, 16)", [k]);
  const r = await call("GET", `/api/cabinets/${k}/summary`, undefined, t1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body;
  assert.deepEqual([s.machine.manufacturer, s.machine.model, s.machine.cpu, s.machine.logicalCores, s.machine.memoryBytes, s.machine.memoryModules],
    ["Dell Inc.", "OptiPlex 7090", "Intel Core i5-10500T", 12, 16 * GB, 2], "the newest hardware answer, not the older one");
  assert.deepEqual([s.machine.biosVersion, s.machine.tpm, s.machine.secureBoot], ["1.18.0", { present: true, enabled: true, version: "2.0" }, "on"]);
  assert.deepEqual([s.windows.edition, s.windows.build, s.windows.architecture, s.windows.uptimeSeconds], ["Windows 11 IoT Enterprise LTSC 2024", "26100.2033", "windows-x64", 259_200]);
  assert.deepEqual([s.memory.totalBytes, s.memory.availableBytes], [16 * GB, 6 * GB]);
  assert.deepEqual(s.volumes.map((v: { drive: string; freeBytes: number }) => [v.drive, v.freeBytes]), [["C:", 40 * GB], ["D:", 900 * GB]]);
  assert.deepEqual([s.load.cpuPercent, s.load.memoryUsedPercent, s.load.diskFreePercent], [17, 62, 16]);
  for (const at of [s.machine.readAt, s.windows.readAt, s.memory.readAt, s.volumesReadAt, s.load.at]) assert.ok(!Number.isNaN(Date.parse(at)), "every part carries its time");
});

test("a cabinet never read has nothing to show but its architecture; a malformed answer is dropped piece by piece", async () => {
  const fresh = await cabinet();
  const r = await call("GET", `/api/cabinets/${fresh}/summary`, undefined, t1);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.machine, r.body.memory, r.body.volumes, r.body.volumesReadAt, r.body.load], [null, null, [], null, null]);
  assert.deepEqual([r.body.windows.architecture, r.body.windows.edition, r.body.windows.readAt], ["windows-x64", null, null]);

  const odd = await cabinet();
  await stored(odd, "system.performance", 5, { memory: { totalBytes: "16 GB", availableBytes: null },
    volumes: [{ drive: "C:", sizeBytes: 0, freeBytes: 0 }, { drive: 7, sizeBytes: 10, freeBytes: 5 }, { drive: "E:", sizeBytes: "big", freeBytes: 1 }, "not a volume", { drive: "F:", sizeBytes: 100 * GB, freeBytes: 50 * GB }] }, true);
  await stored(odd, "system.hardware", 5, { manufacturer: "", model: 42, cpu: "fast", tpm: { present: "yes" }, secureBoot: true }, true);
  const o = (await call("GET", `/api/cabinets/${odd}/summary`, undefined, t1)).body;
  assert.equal(o.memory, null, "a memory figure that is not a number is not shown");
  assert.deepEqual(o.volumes.map((v: { drive: string }) => v.drive), ["F:"], "only volumes with a drive and real sizes");
  assert.deepEqual([o.machine.manufacturer, o.machine.model, o.machine.cpu, o.machine.tpm, o.machine.secureBoot], [null, null, null, null, null],
    "a Secure Boot value outside the contract's three is unknown, never on or off");
});

test("Secure Boot is read as the agent reports it: on, off, or not supported on a machine without it", async () => {
  for (const [name, overrides, expected] of [
    ["no-tpm-legacy-bios.json", {}, "unsupported"], ["typical.json", { secureBoot: "off" }, "off"], ["typical.json", { secureBoot: null }, null],
  ] as [string, Record<string, unknown>, string | null][]) {
    const k = await cabinet();
    await stored(k, "system.hardware", 5, { ...example("system.hardware", name), ...overrides });
    const r = (await call("GET", `/api/cabinets/${k}/summary`, undefined, t1)).body;
    assert.equal(r.machine.secureBoot, expected, `${name} ${JSON.stringify(overrides)}`);
  }
});

test("every role may read it once signed in; nobody else; an unknown cabinet is a 404", async () => {
  const k = await cabinet();
  assert.equal((await app.inject({ method: "GET", url: `/api/cabinets/${k}/summary` })).statusCode, 401);
  assert.equal((await call("GET", `/api/cabinets/${randomUUID()}/summary`, undefined, t1)).status, 404);
  assert.equal((await call("GET", "/api/cabinets/not-a-uuid/summary", undefined, t1)).status >= 400, true);
});
