// Stored readings, the fleet search over them, and load samples: what is found, what is never found by a trick, and that nothing here
// sends anything to a cabinet.
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
import { envelopes } from "../src/contracts.js";
import { recordHeartbeat } from "../src/services/cabinets.js";
import { storeResult } from "../src/services/commands.js";
import { searchableByName } from "../src/services/readings.js";
import { SEARCHED_BY_NAME, searchText } from "../src/services/reading-search-text.js";
import { ConsoleHarness, ORIGIN } from "./console-harness.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// dist/test/ -> contracts/examples/operations
const examples = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "examples", "operations");

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
let owner: string;
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
  owner = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, 'demo.owner', 'Demo owner', 'admin', 'x')`, [owner]);
  await enableDemo(db.app, owner);
});
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

const cab = async (name: string) => (await db.app.query<{ id: string; site_id: string }>("SELECT id, site_id FROM cabinets WHERE name = $1 AND demo_scenario IS NOT NULL", [name])).rows[0]!;
/** A stored answer, as the result of a command the cabinet ran `ageMinutes` ago. */
async function store(cabinetId: string, operation: string, output: unknown, ageMinutes = 5) {
  const id = randomUUID(), at = new Date(Date.now() - ageMinutes * 60_000);
  await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, delivered_at, result, result_at)
                      VALUES ($1, $2, $3, '{}', $4, $5, $6, 'succeeded', $5, $7, $5)`,
    [id, cabinetId, operation, owner, at, new Date(at.getTime() + 300_000), JSON.stringify({ commandId: id, status: "succeeded", startedAt: at.toISOString(), finishedAt: at.toISOString(), output })]);
}
const software = (...names: string[]) => ({ takenAt: "2026-10-16T10:00:00Z", programs: names.map(name => ({ name, version: "1.0", publisher: "Example", installedOn: null })), hotfixes: [{ id: "KB5034441", description: "Security Update", installedOn: null }], truncated: false });
const search = async (who: Awaited<ReturnType<typeof h.account>>, operation: string, q: string, extra = "") =>
  h.call("GET", `/api/readings/search?operation=${operation}&q=${encodeURIComponent(q)}${extra}`, undefined, who);

test("the simulated fleet comes with stored readings for the cabinet that is offline, so its last known state can be shown", async () => {
  const t1 = await h.account("tier1");
  const offline = (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM cabinets WHERE demo_scenario = 'offline'")).rows[0]!;
  const list = await h.call("GET", `/api/cabinets/${offline.id}/readings`, undefined, t1);
  assert.equal(list.status, 200);
  assert.ok(list.body.readings.some((r: { operation: string }) => r.operation === "power.status"));
  const one = await h.call("GET", `/api/cabinets/${offline.id}/readings/power.status`, undefined, t1);
  assert.equal(one.body.reading.output.plan, "Balanced");
  for (const op of ["system.hardware", "system.identity", "network.hosts"]) {
    assert.ok(list.body.readings.some((r: { operation: string }) => r.operation === op), `${op} is stored for the offline cabinet`);
    assert.equal((await h.call("GET", `/api/cabinets/${offline.id}/readings/${op}`, undefined, t1)).status, 200, op);
  }
  assert.equal(JSON.stringify((await h.call("GET", `/api/cabinets/${offline.id}/readings/system.identity`, undefined, t1)).body).toLowerCase().includes("password"), false, "no password anywhere in the identity reading");
  assert.deepEqual((await h.call("GET", `/api/cabinets/${offline.id}/readings/dns.cache`, undefined, t1)).body, { reading: null }, "never read");
  // Content that is audited when opened, or chosen by the person asking, is never replayed from storage.
  for (const op of ["eventlog.get", "eventlog.query", "files.list", "disk.folders"]) assert.equal((await h.call("GET", `/api/cabinets/${offline.id}/readings/${op}`, undefined, t1)).status, 404, op);
  assert.ok(!list.body.readings.some((r: { operation: string }) => r.operation.startsWith("eventlog.")));
  assert.equal((await h.call("GET", `/api/cabinets/${offline.id}/readings/firewall.setProfile`, undefined, t1)).status, 404, "a write is not a reading");
  // From here the tests store their own readings on a clean slate.
  await db.app.query("DELETE FROM commands WHERE operation IN (SELECT value FROM OPENJSON($1))", [["software.list", "startup.list", "power.status", "system.security", "shares.list", "system.hardware", "system.identity", "network.hosts"]]);
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

test("a heartbeat's load sample is stored at most every 15 minutes, kept in range, and read back as a history", async () => {
  const t1 = await h.account("tier1");
  const k = await cab("Surgery").catch(() => cab("Check-in"));
  const hb = (cpu: number) => ({ agentVersion: "1.4.2", uptimeSeconds: 100, readOnlyMode: false, health: { cpuPercent: cpu, memoryUsedPercent: 50, diskFreePercent: 40 } });
  await db.app.query("DELETE FROM health_samples WHERE cabinet_id = $1", [k.id]);
  await recordHeartbeat(db.app, k.id, hb(10));
  await recordHeartbeat(db.app, k.id, hb(90));   // within 15 minutes: not stored
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

test("the welcome tour is given a cabinet to walk through: an online one, and a real one before a simulated one", async () => {
  const t1 = await h.account("tier1");
  const first = (await h.call("GET", "/api/fleet/first-cabinet", undefined, t1)).body.cabinet;
  assert.ok(first.id && first.name);
  assert.equal((await h.call("GET", "/api/fleet/first-cabinet", undefined)).status, 401);
  await db.app.query("UPDATE cabinets SET status = 'removed' WHERE demo_scenario IS NOT NULL");
  assert.deepEqual((await h.call("GET", "/api/fleet/first-cabinet", undefined, t1)).body, { cabinet: null }, "nothing to show");
  await db.app.query("UPDATE cabinets SET status = 'active' WHERE demo_scenario IS NOT NULL");
});

const hardware = (model: string, biosVersion: string) => ({ takenAt: "2026-10-16T10:00:00Z", manufacturer: "Dell Inc.", model,
  bios: { vendor: "Dell Inc.", version: biosVersion, date: "2023-05-09T00:00:00Z" }, cpu: { model: "Intel(R) Core(TM) i5", logicalCores: 8 },
  memory: { totalBytes: 8589934592, moduleCount: 1, modules: [{ slot: "DIMM A1", capacityBytes: 8589934592, speedMhz: 2666 }] },
  tpm: { present: true, enabled: true, version: "2.0" }, secureBoot: "on", lastBoot: "2026-10-12T06:41:08Z", monitors: [{ name: "DELL", width: 1920, height: 1080 }], ports: [] });
const identity = (over: Record<string, unknown>) => ({ takenAt: "2026-10-16T10:00:00Z", joinType: "domain", name: "clinic.example", domainControllerFound: true,
  localAdministrators: { names: ["PC\\Administrator", "CLINIC\\Domain Admins"], truncated: false }, autoLogon: { enabled: false, userName: null }, groupPolicyLastApplied: null, ...over });

test("hardware, identity and the hosts file are searched by name, and identity also by fixed keyword", async () => {
  const t1 = await h.account("tier1");
  const [a, b, c] = [await cab("Exam Room 1"), await cab("Exam Room 2"), await cab("Exam Room 3")];
  await store(a.id, "system.hardware", hardware("OptiPlex 7090", "1.12.0"));
  await store(b.id, "system.hardware", hardware("OptiPlex 3080", "2.20.0"));
  await store(c.id, "system.hardware", hardware("OptiPlex 7090", "1.18.0"), 90);
  await store(c.id, "system.hardware", hardware("Latitude 5420", "1.18.0"), 3);       // newer: no longer a 7090
  assert.deepEqual((await search(t1, "system.hardware", "OptiPlex 7090")).body.matches.map((m: { name: string }) => m.name), ["Exam Room 1"]);
  assert.deepEqual((await search(t1, "system.hardware", "1.18")).body.matches.map((m: { name: string }) => m.name), ["Exam Room 3"], "BIOS version");
  assert.deepEqual((await search(t1, "system.hardware", "optiplex")).body.matches.map((m: { name: string }) => m.name), ["Exam Room 1", "Exam Room 2"]);
  assert.match((await search(t1, "system.hardware", "1.12")).body.matches[0].found.join(" "), /BIOS 1\.12\.0/);

  await store(a.id, "system.identity", identity({}));
  await store(b.id, "system.identity", identity({ joinType: "workgroup", name: "WORKGROUP", domainControllerFound: null, autoLogon: { enabled: true, userName: "cubex" },
    localAdministrators: { names: ["PC\\Administrator"], truncated: false } }));
  await store(c.id, "system.identity", identity({ domainControllerFound: false }));
  const names = async (q: string) => (await search(t1, "system.identity", q)).body.matches.map((m: { name: string }) => m.name);
  assert.deepEqual(await names("workgroup"), ["Exam Room 2"]);
  assert.deepEqual(await names("auto_logon"), ["Exam Room 2"]);
  assert.deepEqual(await names("no_domain_controller"), ["Exam Room 3"]);
  assert.deepEqual(await names("clinic.example"), ["Exam Room 1", "Exam Room 3"], "a name that is not a keyword is matched as text");
  assert.deepEqual(await names("domain admins"), ["Exam Room 1", "Exam Room 3"], "local administrators");
  assert.match((await search(t1, "system.identity", "auto_logon")).body.matches[0].found[0], /cubex/);

  const hosts = (...entries: [string, string[]][]) => ({ takenAt: "2026-10-16T10:00:00Z", entries: entries.map(([address, names]) => ({ address, names })), truncated: false });
  await store(a.id, "network.hosts", hosts(["127.0.0.1", ["localhost"]], ["10.21.4.12", ["sync.clinic.example", "sync"]]));
  await store(b.id, "network.hosts", hosts(["127.0.0.1", ["localhost"]]));
  await store(c.id, "network.hosts", hosts(["10.21.4.20", ["sync.clinic.example"]]));
  const hit = await search(t1, "network.hosts", "SYNC.clinic");
  assert.deepEqual(hit.body.matches.map((m: { name: string }) => m.name), ["Exam Room 1", "Exam Room 3"]);
  assert.deepEqual(hit.body.matches[0].found, ["sync.clinic.example, sync → 10.21.4.12"]);
  assert.deepEqual((await search(t1, "network.hosts", "10.21.4.20")).body.matches.map((m: { name: string }) => m.name), ["Exam Room 3"], "by address");
  assert.equal(hit.body.cabinetsRead, 3);
});

test("hostile text in the new searches is plain text, and malformed searches are refused", async () => {
  const t1 = await h.account("tier1");
  for (const op of ["system.hardware", "system.identity", "network.hosts"])
    for (const q of ["%", "_", "' OR '1'='1", "\"; DROP TABLE commands; --", ".*", "[a-z]+", "\",\""]) {
      const r = await search(t1, op, q);
      assert.equal(r.status, 200, `${op} ${q}`);
      assert.equal(r.body.matches.length, 0, `${op} ${JSON.stringify(q)} is plain text, not a pattern`);
    }
  for (const op of ["system.hardware", "system.identity", "network.hosts"])
    for (const q of ["", "a\nb", "x".repeat(81)]) assert.equal((await search(t1, op, q)).status, 400, `${op} ${JSON.stringify(q)}`);
  assert.equal((await search(t1, "printer.list", "x")).status, 400);
  assert.equal((await h.call("GET", "/api/readings/search?operation=network.hosts&q=x&path=C:/Windows", undefined, t1)).status, 400, "no extra parameter");
});

test("a stored reading keeps its searchable names beside it, and the search reads them: literally, without case, never the JSON when they exist", async () => {
  const t1 = await h.account("tier1");
  const [a, b, c] = [await cab("Exam Room 1"), await cab("Exam Room 2"), await cab("Exam Room 3")];
  /** A result through the real path: a delivered command, then the cabinet's answer to it. */
  const deliver = async (cabinetId: string, operation: string, output: unknown) => {
    const id = randomUUID(), at = new Date();
    await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, delivered_at)
                        VALUES ($1, $2, $3, '{}', $4, $5, $6, 'delivered', $5)`, [id, cabinetId, operation, owner, at, new Date(at.getTime() + 300_000)]);
    await storeResult(db.app, cabinetId, { commandId: id, status: "succeeded", startedAt: at.toISOString(), finishedAt: at.toISOString(), output } as never);
    return id;
  };
  const textOf = async (id: string) => (await db.app.query<{ t: string | null }>("SELECT search_text AS t FROM commands WHERE id = $1", [id])).rows[0]!.t;

  const ida = await deliver(a.id, "software.list", software("ÉCLAIR Scanner", "50%_off [Beta] O'Brien"));
  assert.equal(await textOf(ida), "éclair scanner\nexample\n50%_off [beta] o'brien\nexample\nkb5034441", "the names, publishers and update numbers, lower case, one per line");
  const idb = await deliver(b.id, "software.list", software("Plain Tool"));
  // A reading the search does not cover by name keeps no text.
  const power = await deliver(c.id, "power.status", JSON.parse(readFileSync(join(examples, "power.status", "output", "valid", "typical.json"), "utf8")));
  assert.equal(await textOf(power), null);

  const names = async (q: string) => (await search(t1, "software.list", q)).body.matches.map((m: { name: string }) => m.name).sort();
  assert.deepEqual(await names("éclair"), ["Exam Room 1"], "without case, past ASCII");
  for (const q of ["%_off [", "%", "_", "[beta]", "o'brien"]) assert.deepEqual(await names(q), ["Exam Room 1"], `${q} is plain text`);
  assert.deepEqual(await names("éclair scanner\nexample".split("\n")[0]!), ["Exam Room 1"]);
  // The search text is what is read when it exists: one that names a program the JSON does not is found, and one that leaves out a
  // program the JSON has is not. (Never so in service: both are written together. This shows which one the search reads.)
  await db.app.query("UPDATE commands SET search_text = $2 WHERE id = $1", [idb, "decoy program"]);
  assert.deepEqual(await names("decoy"), ["Exam Room 2"]);
  assert.deepEqual(await names("plain tool"), [], "the JSON is not read where the text exists");
  // A result stored before the text existed has none, and is read from its JSON as before.
  await db.app.query("UPDATE commands SET search_text = NULL WHERE id = $1", [idb]);
  assert.deepEqual(await names("plain tool"), ["Exam Room 2"]);
});

test("the search text covers exactly the readings the search reads by name", () => {
  assert.deepEqual([...SEARCHED_BY_NAME].sort(), searchableByName().sort());
  assert.equal(searchText("software.list", { programs: [{ name: "Two\r\nLines", publisher: null }], hotfixes: "not a list" }), "two lines", "a value never spans two lines; malformed parts are skipped");
  assert.equal(searchText("power.status", { fastStartup: true }), null);
  assert.equal(searchText("software.list", null), null);
});
