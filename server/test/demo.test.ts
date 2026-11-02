// Demo mode (docs/platform/demo.md): every simulated answer passes the operation's output schema, the simulated fleet's
// problems become real alerts through the real alerts engine, fixes made on a simulated cabinet take effect, only an
// Admin turns it on or off, and turning it off deletes every simulated record while leaving real cabinets alone.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { SCHEMA_DIR } from "@mashura/cabinet-contracts/load";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { paramsHash } from "../src/auth/canonical.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { approveEnrollment, createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { envelopes, operations } from "../src/contracts.js";
import { DemoSimulator, scenarioEvents } from "../src/demo/demo.js";
import { DEMO_FLEET, type Scenario } from "../src/demo/fleet.js";
import { demoOutput, type DemoContext } from "../src/demo/outputs.js";
import { searchReadings } from "../src/services/readings.js";
import { baselineFor, initialNet } from "../src/demo/network.js";
import { ISSUE } from "../src/services/rules.js";
import { evaluateDrift } from "../src/services/firewall-policy.js";
import { evaluateTime } from "../src/services/time.js";
import { checkSiteOutages } from "../src/services/site-outage.js";
import { recordHeartbeat } from "../src/services/cabinets.js";
import { createTestDatabase, type TestDatabase, startFeed } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";

const ORIGIN = "https://console.test";
const EXAMPLES = join(dirname(SCHEMA_DIR), "examples", "operations");
const SCENARIOS: Scenario[] = ["healthy", "firewall_drift", "scanner_disconnected", "scanner_flapping", "net_flaky", "service_failing", "disk_failing", "bsod", "offline", "dns_errors", "update_failure", "unknown_errors", "time_zone_wrong", "clock_drift", "site_outage", "net_dns_wrong", "net_static_wrong", "net_dhcp_failed", "net_gateway_wrong", "net_link_slow", "usb_missing", "disk_space_low", "mixed_errors", "scanner_errors"];
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let clock = Date.now();
const secrets = new SecretBox(randomBytes(32).toString("base64"));
let realCabinet: string;
let key: Awaited<ReturnType<typeof developmentIssuingKey>>;
const downloadDir = tempDir();
const agentZip = Buffer.from("PK\u0003\u0004 not really a zip, but the server only serves the bytes");
// The 32-bit build is its own file with its own hash, and the setup page must never hand it over as the 64-bit one.
const agentZipX86 = Buffer.from("PK\u0003\u0004 the 32-bit build is a different file, and the server says so");

interface Account { id: string; username: string; password: string; secret: Buffer; }
async function account(role: "tier1" | "tier2" | "admin"): Promise<Account> {
  const a: Account = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple", secret: totp.newSecret() };
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc) VALUES ($1, $2, $3, $4, $5, 0, 1, $6)`,
    [a.id, a.username, "Test " + a.username, role, await hashPassword(a.password), secrets.seal(a.secret)]);
  return a;
}
async function call(method: "GET" | "POST" | "PUT", url: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
  let parsed: any = r.body; try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
  return { status: r.statusCode, body: parsed };
}
async function signIn(a: Account): Promise<string> {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ username: a.username, password: a.password }) });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  clock += 30_000;
  assert.equal((await call("POST", "/api/auth/totp", { code: totp.code(a.secret, totp.stepAt(clock)) }, cookie)).body.stage, "complete");
  return cookie;
}
/** Demo mode changes are confirmed with an authenticator code bound to the exact body. */
async function demoChange(a: Account, cookie: string, body: Record<string, unknown>) {
  clock += 30_000;
  const t = await call("POST", "/api/auth/step-up", { code: totp.code(a.secret, totp.stepAt(clock)), action: "demo.change", target: "fleet", paramsHash: paramsHash(body) }, cookie);
  assert.equal(t.status, 200, JSON.stringify(t.body));
  return call("PUT", "/api/admin/demo", { ...body, stepUpToken: t.body.token }, cookie);
}
const until = async (what: string, check: () => Promise<boolean>, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (await check()) return;
  assert.fail(`timed out waiting for ${what}`);
};
const openAlert = async (cabinetId: string, issue: string) => (await db.app.query(
  "SELECT 1 FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved'", [cabinetId, issue])).rows.length > 0;
const demoCabinet = async (scenario: string) => (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM cabinets WHERE demo_scenario = $1", [scenario])).rows[0]!.id;

test.before(async () => {
  db = await createTestDatabase();
  key = await developmentIssuingKey(tempDir());
  stream = new ResultStream(await startFeed(db), db.app);
  await stream.start();
  writeFileSync(join(downloadDir, "CabinetAgent-win-x64.zip"), agentZip);
  writeFileSync(join(downloadDir, "CabinetAgent-win-x86.zip"), agentZipX86);
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => clock,
    agentSetup: { host: "cabinets.example.com", port: 8443, downloadDir } });
  const admin = await account("admin");
  const { token } = await createBootstrapToken(db.app, admin.id);
  const requestId = await submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: {
    hostname: "MY-HP", serialNumber: null, macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 11", agentVersion: "0.5.0" } }, "127.0.0.1");
  realCabinet = (await approveEnrollment(db.app, key, requestId, { clientName: "Mashura Office", siteName: "HQ", cabinetName: "Marco's HP", role: "standalone" }, admin.id)).cabinetId;
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME(), read_only = 0 WHERE id = $1", [realCabinet]);
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

test("every simulated answer, for every operation and every scenario, passes the operation's output schema", () => {
  for (const scenario of SCENARIOS)
    for (const op of Object.keys(operations)) {
      const paramsDir = join(EXAMPLES, op, "params", "valid");
      for (const file of readdirSync(paramsDir)) {
        const params = JSON.parse(readFileSync(join(paramsDir, file), "utf8"));
        const ctx: DemoContext = { hostname: "CAB-01S01", role: "sync", scenario, subnet: "10.21.4", index: 1, now: new Date(),
          firewallProfiles: { domain: scenario === "firewall_drift", private: false, public: scenario === "firewall_drift" }, startTypes: {}, power: {}, drawer: null, watchedServices: ["BioScanSvc", "Spooler"], syncBlocked: scenario === "healthy",
          timeZoneId: scenario === "time_zone_wrong" ? "Mountain Standard Time" : "US Mountain Standard Time", clockSkewSeconds: scenario === "clock_drift" ? 437 : 0.3,
          baseline: baselineFor("10.21.4"), net: initialNet(scenario, baselineFor("10.21.4"), "10.21.4", 1),
          events: scenarioEvents(scenario).filter(e => e.source).map(e => ({ log: e.source!.log, source: e.source!.source, eventId: e.source!.eventId, level: e.source!.level,
            occurredAt: e.occurredAt, message: e.detail.message ?? "", recordId: e.source!.recordId })) };
        const out = demoOutput(op, params, ctx);
        const validator = operations[op as keyof typeof operations]!.output;
        assert.ok(validator.is(out), `${op} (${file}) for ${scenario}: ${JSON.stringify(out).slice(0, 300)}`);
      }
    }
});

test("every scenario's events pass the event contract", () => {
  for (const scenario of SCENARIOS) {
    const events = scenarioEvents(scenario);
    if (events.length) envelopes.eventBatch.parse({ events });
  }
});

test("only an Admin turns demo mode on or off; hostile bodies are refused", async () => {
  const t2 = await signIn(await account("tier2"));
  const admin = await account("admin");
  const ca = await signIn(admin);
  assert.equal((await call("PUT", "/api/admin/demo", { enabled: true }, t2)).status, 403);
  // An authenticator code confirms the exact change: none, or one confirmed for turning it off, does not turn it on.
  assert.equal((await call("PUT", "/api/admin/demo", { enabled: true }, ca)).status, 400);
  clock += 30_000;
  const offToken = (await call("POST", "/api/auth/step-up", { code: totp.code(admin.secret, totp.stepAt(clock)), action: "demo.change", target: "fleet",
    paramsHash: paramsHash({ enabled: false }) }, ca)).body.token;
  assert.equal((await call("PUT", "/api/admin/demo", { enabled: true, stepUpToken: offToken }, ca)).status, 403);
  for (const body of [{}, { enabled: "true" }, { enabled: 1 }, { enabled: true, scenario: "bsod" }, [true], null])
    assert.equal((await call("PUT", "/api/admin/demo", body, ca)).status, 400, JSON.stringify(body));
  assert.equal((await call("PUT", "/api/admin/demo", { enabled: true })).status, 401);
  assert.deepEqual((await call("GET", "/api/demo", undefined, t2)).body, { enabled: false, clients: 0, cabinets: 0, storyReady: false });
});

test("demo mode adds the simulated fleet, and its problems become real alerts through the alerts engine", async () => {
  const admin = await account("admin");
  const ca = await signIn(admin);
  const on = await demoChange(admin, ca, { enabled: true });
  const expected = DEMO_FLEET.flatMap(c => c.sites.flatMap(s => s.cabinets)).length;
  assert.deepEqual(on.body, { enabled: true, clients: DEMO_FLEET.length, cabinets: expected, storyReady: true });
  assert.equal((await demoChange(admin, ca, { enabled: true })).body.cabinets, expected, "turning it on twice adds nothing");
  assert.ok(await openAlert(await demoCabinet("firewall_drift"), ISSUE.firewallPolicy), "firewall drift");
  assert.ok(await openAlert(await demoCabinet("scanner_flapping"), ISSUE.scanner), "scanner");
  // The flapping scanner: three drops in a day, and a driver for it installed shortly before the first one.
  const history = (await call("GET", `/api/cabinets/${await demoCabinet("scanner_flapping")}/scanner-history`, undefined, ca)).body;
  assert.equal(history.drops24h, 3);
  assert.equal(history.offNow, true);
  assert.equal(history.changes.filter((c: { kind: string; relatedToScanner: boolean }) => c.kind === "driver" && c.relatedToScanner).length, 1);
  assert.ok(history.changes[0].hoursBeforeFirstDrop > 1 && history.changes[0].hoursBeforeFirstDrop < 3);
  assert.match(history.lead, /dropped off 3 times/);
  assert.match(history.lead, /oem42\.inf/);
  assert.ok(!/cause[ds]? by/i.test(history.lead), "it says what to check first, not what caused it");
  const calm = (await call("GET", `/api/cabinets/${await demoCabinet("healthy")}/scanner-history`, undefined, ca)).body;
  assert.deepEqual([calm.drops7d, calm.lead], [0, null]);
  assert.ok(await openAlert(await demoCabinet("service_failing"), ISSUE.serviceFailing), "service failing");
  assert.ok(await openAlert(await demoCabinet("disk_failing"), ISSUE.drive), "drive");
  assert.ok(await openAlert(await demoCabinet("bsod"), "00000000-0000-4000-8000-000000000109"), "blue screen");
  assert.ok(await openAlert(await demoCabinet("offline"), ISSUE.offline), "offline");
  assert.ok(!(await openAlert(await demoCabinet("healthy"), ISSUE.firewallPolicy)), "a healthy cabinet has nothing");
  const fleet = (await call("GET", "/api/fleet/clients", undefined, ca)).body as { name: string; demo: boolean }[];
  assert.deepEqual(fleet.filter(c => c.demo).map(c => c.name).sort(), DEMO_FLEET.map(c => c.name).sort());
  assert.ok(fleet.some(c => c.name === "Mashura Office" && !c.demo), "the real client is listed too, not marked demo");
  // Every simulated cabinet has its installed software read, so the obvious search finds the scanner software across the fleet.
  const found = await searchReadings(db.app, "software.list", "bioscan", {});
  assert.equal(found.cabinetsRead, expected);
  assert.equal(found.matches.length, expected);
  // The machine facts are read for every simulated cabinet too, and tell their own small stories.
  const names = async (op: string, q: string) => (await searchReadings(db.app, op, q, {}));
  const hosts = await names("network.hosts", "sync.clinic.example");
  assert.equal(hosts.cabinetsRead, expected);
  const stale = hosts.matches.filter(m => m.found.some(f => f.endsWith(".12")));
  assert.equal(stale.length, 4, "four cabinets still send the sync cabinet's name to an old address");
  assert.ok(stale.every(m => m.found.every(f => f.startsWith("sync.clinic.example, sync → "))));
  assert.ok(hosts.matches.length > stale.length, "a few others pin the right address, so the search shows both");
  assert.deepEqual((await names("system.identity", "workgroup")).matches.map(m => m.name), ["Intake"]);
  assert.deepEqual((await names("system.identity", "auto_logon")).matches.map(m => m.name), ["Treatment Room"]);
  assert.equal((await names("system.identity", "no_domain_controller")).matches.length, 3);
  assert.equal((await names("system.identity", "clinic.example")).cabinetsRead, expected);
  assert.equal((await names("system.hardware", "optiplex")).matches.length, expected);
  const versions = (await db.app.query<{ v: string }>("SELECT DISTINCT JSON_VALUE(result, '$.output.bios.version') AS v FROM commands WHERE operation = 'system.hardware'")).rows;
  assert.ok(versions.length >= 4, `the fleet runs several BIOS versions: ${versions.map(r => r.v).join(", ")}`);
  const raw = JSON.stringify((await db.app.query("SELECT result FROM commands WHERE operation IN ('system.identity', 'system.hardware', 'network.hosts')")).rows).toLowerCase();
  assert.ok(!raw.includes("password"), "no password in any simulated answer");
});

test("every simulated cabinet reports its configuration through the server's own ingest, with approved baselines; one cabinet differs, and its history tells how", async () => {
  const t1 = await signIn(await account("tier1"));
  const total = DEMO_FLEET.flatMap(c => c.sites.flatMap(s => s.cabinets)).length;
  const one = async (sql: string, args: unknown[] = []) => (await db.app.query<any>(sql, args)).rows[0];
  // All eleven categories for every simulated cabinet, and the machine's make and model remembered from them.
  assert.equal(Number((await one("SELECT COUNT(DISTINCT cabinet_id) AS n FROM config_current c JOIN cabinets k ON k.id = c.cabinet_id WHERE k.demo_scenario IS NOT NULL")).n), total);
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM config_current c JOIN cabinets k ON k.id = c.cabinet_id WHERE k.demo_scenario IS NOT NULL")).n), total * 11);
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM cabinets WHERE demo_scenario IS NOT NULL AND model LIKE 'OptiPlex%'")).n), total);
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM config_versions v JOIN cabinets k ON k.id = v.cabinet_id WHERE k.demo_scenario IS NULL")).n), 0, "the real cabinet got nothing from the demo");
  // The baselines are tied to simulated clients and sites; the working cabinets they were taken from meet them.
  const baselines = (await call("GET", "/api/baselines", undefined, t1)).body.baselines as { scope: { kind: string }; name: string; approvedVersion: number | null }[];
  assert.deepEqual(baselines.map(b => b.scope.kind).sort(), ["client", "site", "site"]);
  assert.ok(baselines.every(b => b.approvedVersion === 1));
  const named = async (name: string) => (await db.app.query<{ id: string }>("SELECT k.id FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.name = $1 AND k.demo_scenario IS NOT NULL", [name])).rows[0]!.id;
  const examRoom = await named("Exam Room 1"), midtownSync = await named("Midtown Sync");
  assert.equal((await call("GET", `/api/cabinets/${examRoom}/condition`, undefined, t1)).body.state, "healthy");
  // The one that differs: its firewall was switched on after it was last seen well, and the baseline says the profiles are off.
  const bad = (await call("GET", `/api/cabinets/${midtownSync}/condition`, undefined, t1)).body;
  assert.equal(bad.state, "degraded");
  assert.ok(bad.lastHealthyAt && bad.degradedSince && bad.lastHealthyAt < bad.degradedSince);
  assert.match(bad.reasons.map((r: { text: string }) => r.text).join(" "), /profile:public \(enabled\) is not as the baseline requires/);
  const drift = (await call("GET", `/api/cabinets/${midtownSync}/drift`, undefined, t1)).body.drift as { itemKey: string; field: string; expected: unknown; actual: unknown }[];
  assert.deepEqual(drift.map(d => [d.itemKey, d.expected, d.actual]).sort(), [["profile:domain", false, true], ["profile:private", false, true], ["profile:public", false, true]]);
  const changes = (await call("GET", `/api/cabinets/${midtownSync}/config-changes`, undefined, t1)).body.changes as { category: string; notBefore: string | null; observedAt: string; violatesBaseline: boolean }[];
  const firewall = changes.filter(c => c.category === "firewall");
  assert.equal(firewall.length, 3);
  assert.ok(firewall.every(c => c.violatesBaseline && c.notBefore && c.notBefore < c.observedAt), "a window between two looks, going against the baseline");
  // Windows also called the network a domain network once the domain profile was on: a change too, but not against any baseline.
  assert.deepEqual(changes.filter(c => c.category !== "firewall").map(c => [c.category, c.violatesBaseline]), [["network", false]]);
  const since = (await call("GET", `/api/cabinets/${midtownSync}/compare-healthy`, undefined, t1)).body;
  assert.equal(since.changes.length, 4);
  // Cabinets with no baseline are never called healthy; offline ones say so.
  const unjudged = (await call("GET", `/api/cabinets/${await named("Central Sync")}/condition`, undefined, t1)).body;
  assert.equal(unjudged.state, "unknown");
  assert.equal(unjudged.reasons[0].code, "no_baseline");
  assert.equal((await call("GET", `/api/cabinets/${await named("Step-down")}/condition`, undefined, t1)).body.state, "offline");
  // The fleet view: the differences are where the scenarios put them (the three wrong time zones at the Upper East Side, the static address at the Lab, the firewall).
  const fleet = (await call("GET", "/api/fleet/differences", undefined, t1)).body;
  const group = (key: string, field: string) => fleet.groups.find((g: { itemKey: string; field: string }) => g.itemKey === key && g.field === field);
  assert.equal(group("time", "timeZoneId").cabinets, 3);
  assert.equal(group("profile:public", "enabled").cabinets, 2, "both sync cabinets whose firewall is on");
  assert.ok(fleet.cabinetsJudged > 0 && fleet.cabinetsJudged < fleet.cabinetsReporting);
  // A simulated cabinet answers config.snapshot like an agent: valid, with hashes the server accepts.
  const sim = new DemoSimulator(db.app, m => assert.fail(m), 50, [0, 10]);
  sim.start();
  try {
    const read = await call("POST", `/api/cabinets/${midtownSync}/commands`, { operation: "config.snapshot", params: { categories: ["firewall", "hosts"] } }, t1);
    assert.equal(read.status, 202, JSON.stringify(read.body));
    await until("the simulated snapshot", async () => (await db.app.query<{ status: string }>("SELECT status FROM commands WHERE id = $1", [read.body.commandId])).rows[0]?.status === "succeeded");
    const out = (await db.app.query<{ result: { output: { categories: { category: string }[] } } }>("SELECT result FROM commands WHERE id = $1", [read.body.commandId])).rows[0]!.result.output;
    assert.deepEqual(out.categories.map(c => c.category), ["firewall", "hosts"]);
    // And the Tier 1 fix: applying the client's policy changes the configuration, and the next report says so as a change made through the platform.
    const fix = await call("POST", `/api/cabinets/${midtownSync}/commands`, { operation: "firewall.applyPolicy", params: {} }, t1);
    assert.equal(fix.status, 202, JSON.stringify(fix.body));
    await until("the drift to clear", async () => (await call("GET", `/api/cabinets/${midtownSync}/drift`, undefined, t1)).body.drift.length === 0);
    const after = (await call("GET", `/api/cabinets/${midtownSync}/config-changes`, undefined, t1)).body.changes as { category: string; viaPlatform: boolean; violatesBaseline: boolean }[];
    const platform = after.filter(c => c.viaPlatform);
    assert.equal(platform.length, 3, "the three profiles switched off by the platform");
    assert.ok(platform.every(c => c.category === "firewall" && !c.violatesBaseline));
    await until("the baseline's own requirement to be met again", async () => {
      const now = (await call("GET", `/api/cabinets/${midtownSync}/condition`, undefined, t1)).body;
      return !now.reasons.some((r: { code: string }) => r.code === "required_item");
    });
  } finally { sim.stop(); }
});

test("simulated cabinets answer commands, and a fix made on one takes effect", async () => {
  const t1 = await signIn(await account("tier1"));
  const tier2 = await account("tier2");
  const t2 = await signIn(tier2);
  const sim = new DemoSimulator(db.app, m => assert.fail(m), 50, [0, 10]);
  sim.start();
  try {
    const drift = await demoCabinet("firewall_drift");
    const read = await call("POST", `/api/cabinets/${drift}/commands`, { operation: "system.info", params: {} }, t1);
    assert.equal(read.status, 202);
    await until("the simulated answer", async () => (await db.app.query<{ status: string }>("SELECT status FROM commands WHERE id = $1", [read.body.commandId])).rows[0]?.status === "succeeded");
    const info = (await db.app.query<{ result: { output: any } }>("SELECT result FROM commands WHERE id = $1", [read.body.commandId])).rows[0]!.result.output;
    assert.match(info.hostname, /^CAB-\d{2}[SC]\d{2}$/);

    // Tier 1 applies the client's policy (all off) with one click: the drift alert resolves as it would on a real cabinet.
    const fix = await call("POST", `/api/cabinets/${drift}/commands`, { operation: "firewall.applyPolicy", params: {} }, t1);
    assert.equal(fix.status, 202, JSON.stringify(fix.body));
    await until("the drift alert to resolve", async () => !(await openAlert(drift, ISSUE.firewallPolicy)));
    assert.equal((await db.app.query<{ demo_scenario: string }>("SELECT demo_scenario FROM cabinets WHERE id = $1", [drift])).rows[0]!.demo_scenario, "healthy");

    // Tier 2 restarts the failing scanner service: it recovers and its major alert resolves.
    const failing = await demoCabinet("service_failing");
    // The scanner service is on the demo clients' approved-applications list; controlling a service needs a code bound to the parameters.
    const restartParams = { name: "BioScanSvc", action: "restart" };
    clock += 30_000;
    const code = await call("POST", "/api/auth/step-up", { code: totp.code(tier2.secret, totp.stepAt(clock)), action: "service.control", target: failing, paramsHash: paramsHash(restartParams) }, t2);
    assert.equal(code.status, 200, JSON.stringify(code.body));
    const restart = await call("POST", `/api/cabinets/${failing}/commands`, { operation: "service.control", params: restartParams, stepUpToken: code.body.token }, t2);
    assert.equal(restart.status, 202, JSON.stringify(restart.body));
    await until("the service alert to resolve", async () => !(await openAlert(failing, ISSUE.serviceFailing)));

    // The offline cabinet never answers: its command stays queued, never falsely succeeds.
    const offline = await demoCabinet("offline");
    const silent = await call("POST", `/api/cabinets/${offline}/commands`, { operation: "system.info", params: {} }, t1);
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await db.app.query<{ status: string }>("SELECT status FROM commands WHERE id = $1", [silent.body.commandId])).rows[0]!.status, "queued");

    // The real cabinet's commands are never answered by the simulator.
    const real = await call("POST", `/api/cabinets/${realCabinet}/commands`, { operation: "system.info", params: {} }, t1);
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await db.app.query<{ status: string }>("SELECT status FROM commands WHERE id = $1", [real.body.commandId])).rows[0]!.status, "queued");
  } finally {
    sim.stop();
  }
});

test("time: wrong zones and a drifting clock raise alerts; Tier 1 corrects them and the alerts close; Tier 2 sets a site's zone", async () => {
  const t1 = await signIn(await account("tier1"));
  const t2 = await signIn(await account("tier2"));
  const wrong = await demoCabinet("time_zone_wrong"), drift = await demoCabinet("clock_drift");
  assert.ok(await openAlert(wrong, ISSUE.timeZone), "wrong time zone");
  assert.ok(await openAlert(drift, ISSUE.clock), "clock off");
  const facts = (await call("GET", `/api/cabinets/${wrong}/time`, undefined, t1)).body;
  assert.equal(facts.zoneWrong, true);
  assert.notEqual(facts.timeZoneId, facts.siteTimeZone);
  const sim = new DemoSimulator(db.app, m => assert.fail(m), 50, [0, 10]);
  sim.start();
  try {
    const status = await call("POST", `/api/cabinets/${wrong}/commands`, { operation: "time.status", params: {} }, t1);
    await until("time.status", async () => (await db.app.query<{ status: string }>("SELECT status FROM commands WHERE id = $1", [status.body.commandId])).rows[0]?.status === "succeeded");
    // Tier 1 sets the site's zone with one click; the zone alert closes from the next heartbeat.
    const set = await call("POST", `/api/cabinets/${wrong}/commands`, { operation: "time.setZone", params: { timeZoneId: facts.siteTimeZone } }, t1);
    assert.equal(set.status, 202, JSON.stringify(set.body));
    await until("the zone alert to close", async () => !(await openAlert(wrong, ISSUE.timeZone)));
    assert.equal((await call("GET", `/api/cabinets/${wrong}/time`, undefined, t1)).body.zoneWrong, false);
    const sync = await call("POST", `/api/cabinets/${drift}/commands`, { operation: "time.sync", params: {} }, t1);
    assert.equal(sync.status, 202);
    await until("the clock alert to close", async () => !(await openAlert(drift, ISSUE.clock)));
    // Only the allowed zones can be sent; anything else is refused before a command exists.
    for (const params of [{ timeZoneId: "UTC" }, { timeZoneId: "Eastern Standard Time /s UTC" }, {}, { timeZoneId: "Eastern Standard Time", force: true }])
      assert.equal((await call("POST", `/api/cabinets/${wrong}/commands`, { operation: "time.setZone", params }, t1)).status, 400, JSON.stringify(params));
  } finally {
    sim.stop();
  }
  // A site's zone: Tier 2 sets it, Tier 1 cannot; the real cabinet in another zone gets an alert at once, cleared when it matches.
  const home = (await db.app.query<{ site_id: string }>("SELECT site_id FROM cabinets WHERE id = $1", [realCabinet])).rows[0]!.site_id;
  await recordHeartbeat(db.app, realCabinet, { agentVersion: "0.5.0", uptimeSeconds: 100, readOnlyMode: false, timeZoneId: "Pacific Standard Time", clockSkewSeconds: 0.2 });
  assert.equal((await call("PUT", `/api/sites/${home}/time-zone`, { timeZone: "US Mountain Standard Time" }, t1)).status, 403);
  for (const body of [{ timeZone: "UTC" }, { timeZone: "x".repeat(300) }, {}, { timeZone: "Pacific Standard Time", cabinets: "all" }])
    assert.equal((await call("PUT", `/api/sites/${home}/time-zone`, body, t2)).status, 400, JSON.stringify(body));
  assert.equal((await call("PUT", `/api/sites/${home}/time-zone`, { timeZone: "US Mountain Standard Time" }, t2)).status, 200);
  assert.ok(await openAlert(realCabinet, ISSUE.timeZone));
  const { timeCheck } = await recordHeartbeat(db.app, realCabinet, { agentVersion: "0.5.0", uptimeSeconds: 160, readOnlyMode: false, timeZoneId: "US Mountain Standard Time", clockSkewSeconds: 0.2 });
  assert.equal(timeCheck, true);
  await evaluateTime(db.app, { cabinetId: realCabinet });
  assert.ok(!(await openAlert(realCabinet, ISSUE.timeZone)));
  assert.equal((await call("PUT", `/api/sites/${home}/time-zone`, { timeZone: null }, t2)).status, 200);
  assert.ok((await db.app.query("SELECT 1 FROM audit_log WHERE action = 'site.time_zone'")).rowCount! >= 2);
});

test("a whole site going quiet together is one outage, not several cabinet problems; a lone offline cabinet or ones that drifted off hours apart are not", async () => {
  // The Chicago pharmacy: all five cabinets lose the network at the same time (made here; the demo fleet has no such site).
  const site = (await db.app.query<{ id: string }>("SELECT s.id FROM sites s JOIN clients c ON c.id = s.client_id WHERE c.demo = 1 AND s.name LIKE 'Chicago%'")).rows[0]!.id;
  const down = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE site_id = $1 ORDER BY name", [site])).rows;
  assert.equal(down.length, 5);
  const quiet = async (minutes: number) => { for (const [i, k] of down.entries()) await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(second, $3, DATEADD(minute, -$2, SYSUTCDATETIME())) WHERE id = $1", [k.id, minutes, -i * 20]); };
  try {
    await quiet(40);
    assert.equal((await checkSiteOutages(db.app)).raised, 5);
    for (const k of down) assert.ok(await openAlert(k.id, ISSUE.siteOutage), "each cabinet at the site carries it");
    // Denver has one offline cabinet and online ones: no site outage there. Harbor's crash loops are a crash incident, not a network outage.
    assert.ok(!(await openAlert(await demoCabinet("offline"), ISSUE.siteOutage)));
    assert.equal((await db.app.query<{ n: number }>(`SELECT count(*) AS n FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id
                                        WHERE a.issue_type_id = $1 AND a.state <> 'resolved' AND k.demo_scenario LIKE 'incident_%'`, [ISSUE.siteOutage])).rows[0]!.n, 0);
    // Cabinets that stopped hours apart are not "together".
    await db.app.query("UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME() WHERE issue_type_id = $1", [ISSUE.siteOutage]);
    await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(hour, -5, SYSUTCDATETIME()) WHERE id = $1", [down[0]!.id]);
    assert.equal((await checkSiteOutages(db.app)).raised, 0);
    // Together again, then one cabinet is heard again: the site is reachable, so every outage alert closes.
    await quiet(40);
    assert.equal((await checkSiteOutages(db.app)).raised, 5);
    await recordHeartbeat(db.app, down[1]!.id, { agentVersion: "1.4.2", uptimeSeconds: 99, readOnlyMode: false });
    assert.equal((await checkSiteOutages(db.app)).resolved, 5);
    for (const k of down) assert.ok(!(await openAlert(k.id, ISSUE.siteOutage)));
  } finally {
    await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME() WHERE site_id = $1", [site]);
    await db.app.query("UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME() WHERE issue_type_id = $1 AND state <> 'resolved'", [ISSUE.siteOutage]);
  }
});

test("diagnose network on a satellite finds the sync cabinet's firewall, offers the fix on that cabinet, and finds it fixed afterwards", async () => {
  const t1 = await signIn(await account("tier1"));
  const sim = new DemoSimulator(db.app, m => assert.fail(m), 50, [0, 10]);
  sim.start();
  try {
    const surgery = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE name = 'Surgery' AND demo_scenario IS NOT NULL")).rows[0]!.id;
    // The earlier test fixed the sync cabinet's firewall; someone turns it back on (the cabinet reports it in its next heartbeat).
    const sync = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE name = 'Pharmacy Sync' AND demo_scenario IS NOT NULL")).rows[0]!.id;
    await db.app.query(`UPDATE cabinets SET firewall_profiles = '{"domain":true,"private":true,"public":true}', demo_scenario = 'firewall_drift' WHERE id = $1`, [sync]);
    await evaluateDrift(db.app, { cabinetId: sync });
    const run = async () => {
      const started = await call("POST", `/api/cabinets/${surgery}/diagnose/network`, {}, t1);
      assert.equal(started.status, 202, JSON.stringify(started.body));
      let d: any;
      await until("the diagnosis", async () => (d = (await call("GET", `/api/diagnoses/${started.body.diagnosisId}`, undefined, t1)).body).state === "done", 20_000);
      return d.findings as { id: string; severity: string; certainty: string; title: string; action?: { kind: string; cabinetId: string } }[];
    };
    const before = await run();
    const blocked = before.find(f => f.id === "sync-firewall");
    assert.ok(blocked, JSON.stringify(before.map(f => f.id)));
    assert.equal(blocked.severity, "problem");
    assert.equal(blocked.certainty, "probable", "a closed port and a firewall that is on are evidence, not proof");
    assert.deepEqual(blocked.action, { kind: "apply_policy", cabinetId: sync, cabinetName: "Pharmacy Sync" });
    assert.equal(before[0]!.id, "sync-firewall", "problems come first");
    // Each command the diagnosis issued is the person's own, in the audit log.
    assert.ok(Number((await db.app.query<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE action = 'command.issue' AND JSON_VALUE(details, '$.operation') = 'network.test' AND target_id = $1", [surgery])).rows[0]!.n) >= 4);
    // The fix, as the finding offers it: apply the policy on the sync cabinet. Then the satellite reaches it.
    assert.equal((await call("POST", `/api/cabinets/${sync}/commands`, { operation: "firewall.applyPolicy", params: {} }, t1)).status, 202);
    await until("the sync cabinet's firewall to report off", async () => !(await openAlert(sync, ISSUE.firewallPolicy)));
    const after = await run();
    assert.ok(after.some(f => f.id === "sync-ok"), JSON.stringify(after.map(f => f.id)));
    assert.ok(!after.some(f => f.severity === "problem"), JSON.stringify(after.filter(f => f.severity === "problem")));
    assert.equal((await call("GET", `/api/cabinets/${surgery}/diagnose/network`, undefined, t1)).body.latest.state, "done");
  } finally {
    sim.stop();
  }
});

test("the sync database check on a demo cabinet answers through the same path as a real agent, agrees with the TCP test, and only names SQL Server on 1433", async () => {
  const t1 = await signIn(await account("tier1"));
  const sim = new DemoSimulator(db.app, m => assert.fail(m), 50, [0, 10]);
  sim.start();
  try {
    const surgery = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE name = 'Surgery' AND demo_scenario IS NOT NULL")).rows[0]!.id;
    const run = async (operation: string, params: Record<string, unknown>) => {
      const issued = await call("POST", `/api/cabinets/${surgery}/commands`, { operation, params }, t1);
      assert.equal(issued.status, 202, JSON.stringify(issued.body));
      let r: any;
      // "succeeded" means the server's result path accepted the output, and it checks every output against the operation's contract.
      await until(`${operation} to answer`, async () => ["succeeded", "failed", "rejected"].includes((r = (await call("GET", `/api/commands/${issued.body.commandId}`, undefined, t1)).body).status), 20_000);
      assert.equal(r.status, "succeeded", JSON.stringify(r));
      return r.result.output;
    };
    const tcp = await run("network.test", { target: "sync_cabinet", method: "tcp", port: 1433 });
    const sql = await run("database.connectivity", { port: 1433 });
    assert.equal(sql.result === "sql_server", tcp.success, `the two checks of port 1433 agree: ${JSON.stringify({ tcp: tcp.success, sql: sql.result })}`);
    if (sql.result === "sql_server") {
      assert.equal(sql.prelogin.serverVersion, "16.0.4305");
      assert.ok(sql.tls.certificate.selfSigned);
      assert.equal((await run("database.connectivity", { port: 8080 })).result, "not_sql_server", "another port answers, but not as SQL Server");
    }
    assert.equal(sql.address, tcp.resolvedTarget, "both aim at the sync cabinet the console has set");
  } finally { sim.stop(); }
});

test("diagnoses cannot be used to flood a cabinet or the server: a running one is shared, and one person runs at most 3", async () => {
  const t1 = await signIn(await account("tier1"));
  // Cabinets that never answer keep their diagnoses running.
  const quiet = (await db.app.query<{ id: string }>("SELECT TOP (4) id FROM cabinets WHERE demo_scenario = 'incident_loop' ORDER BY name")).rows.map(r => r.id);
  assert.equal(quiet.length, 4);
  const start = (cab: string) => call("POST", `/api/cabinets/${cab}/diagnose/network`, {}, t1);
  const a = await start(quiet[0]!), again = await start(quiet[0]!);
  assert.equal(a.status, 202);
  assert.equal(again.body.diagnosisId, a.body.diagnosisId, "the running diagnosis is shared");
  assert.equal((await start(quiet[1]!)).status, 202);
  assert.equal((await start(quiet[2]!)).status, 202);
  const fourth = await start(quiet[3]!);
  assert.equal(fourth.status, 429, JSON.stringify(fourth.body));
  // At the limit, asking for one already running still answers with it.
  assert.equal((await start(quiet[0]!)).body.diagnosisId, a.body.diagnosisId);
  await db.app.query("UPDATE diagnoses SET state = 'failed', finished_at = SYSUTCDATETIME() WHERE state = 'running'");
});

test("a real cabinet is never filed under a simulated client, and turning demo mode off never deletes one", async () => {
  const admin = await account("admin");
  const ca = await signIn(admin);
  const demoClient = (await db.app.query<{ id: string; name: string }>("SELECT TOP (1) id, name FROM clients WHERE demo = 1 ORDER BY name")).rows[0]!;
  const { token } = await createBootstrapToken(db.app, admin.id);
  const requestId = await submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: {
    hostname: "REAL-2", serialNumber: null, macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 11", agentVersion: "0.5.0" } }, "127.0.0.1");
  await assert.rejects(approveEnrollment(db.app, key, requestId, { clientName: demoClient.name, siteName: "Anywhere", cabinetName: "Real 2", role: "standalone" }, admin.id),
    (e: Error & { code?: string }) => e.code === "demo_client");
  clock += 30_000;
  const body = { clientId: demoClient.id, name: "Sneaky" };
  const t = (await call("POST", "/api/auth/step-up", { code: totp.code(admin.secret, totp.stepAt(clock)), action: "site.create", target: demoClient.id, paramsHash: paramsHash(body) }, ca)).body.token;
  assert.equal((await call("POST", "/api/admin/sites", { ...body, stepUpToken: t }, ca)).body.error, "demo_client");
  // Older data could still hold one: turning demo mode off then refuses rather than deleting a real cabinet.
  const home = (await db.app.query<{ site_id: string }>("SELECT site_id FROM cabinets WHERE id = $1", [realCabinet])).rows[0]!.site_id;
  await db.app.query("UPDATE cabinets SET site_id = (SELECT TOP (1) id FROM sites WHERE client_id = $2) WHERE id = $1", [realCabinet, demoClient.id]);
  assert.equal((await demoChange(admin, ca, { enabled: false })).body.error, "real_cabinet_in_demo_client");
  await db.app.query("UPDATE cabinets SET site_id = $2 WHERE id = $1", [realCabinet, home]);
});

test("turning demo mode off deletes every simulated record and leaves the real cabinet alone", async () => {
  const admin = await account("admin");
  const ca = await signIn(admin);
  const off = await demoChange(admin, ca, { enabled: false });
  assert.deepEqual(off.body, { enabled: false, clients: 0, cabinets: 0, storyReady: false });
  for (const table of ["alerts", "events", "commands", "firewall_changes"])
    assert.equal((await db.app.query<{ n: number }>(`SELECT count(*) AS n FROM ${table} t JOIN cabinets k ON k.id = t.cabinet_id WHERE k.demo_scenario IS NOT NULL`)).rows[0]!.n, 0, table);
  assert.equal((await db.app.query<{ n: number }>("SELECT count(*) AS n FROM cabinets WHERE id = $1 AND status = 'active'", [realCabinet])).rows[0]!.n, 1);
  assert.equal((await db.app.query<{ n: number }>("SELECT count(*) AS n FROM commands WHERE cabinet_id = $1", [realCabinet])).rows[0]!.n, 1, "the real cabinet's command history is kept");
  const audited = (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'demo.%' ORDER BY seq")).rows.map(r => r.action);
  assert.deepEqual(audited, ["demo.enable", "demo.disable"]);
});

test("the setup page: Admin only; it says where cabinets connect and serves an agent package per architecture, never another path", async () => {
  const t2 = await signIn(await account("tier2"));
  const ca = await signIn(await account("admin"));
  assert.equal((await call("GET", "/api/admin/setup", undefined, t2)).status, 403);
  assert.equal((await call("GET", "/api/admin/agent-package", undefined, t2)).status, 403);
  const setup = (await call("GET", "/api/admin/setup", undefined, ca)).body;
  // Both architectures are listed with their own file and hash, so the operator can see which one this server can
  // hand over before walking to a 32-bit machine.
  assert.deepEqual({ ...setup.agent, caSha256: undefined }, { host: "cabinets.example.com", port: 8443, caSha256: undefined, unsigned: false,
    packages: [
      { architecture: "windows-x64", name: "CabinetAgent-win-x64.zip", bytes: agentZip.length, sha256: createHash("sha256").update(agentZip).digest("hex") },
      { architecture: "windows-x86", name: "CabinetAgent-win-x86.zip", bytes: agentZipX86.length, sha256: createHash("sha256").update(agentZipX86).digest("hex") },
    ] });
  assert.match(setup.agent.caSha256, /^[0-9A-F]{64}$/, "the installer checks the CA file against this");
  assert.equal(setup.realCabinets, 1);
  assert.equal(setup.newestCabinetId, realCabinet);
  const r = await app.inject({ method: "GET", url: "/api/admin/agent-package", headers: { origin: ORIGIN, cookie: ca } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["content-disposition"], 'attachment; filename="CabinetAgent-win-x64.zip"', "a request that names no architecture gets the 64-bit package");
  assert.deepEqual(r.rawPayload, agentZip);
  // A 32-bit machine is handed the 32-bit build: the 64-bit one cannot install there at all, so serving it would be a
  // setup that fails on the machine rather than on the page.
  const x86 = await app.inject({ method: "GET", url: "/api/admin/agent-package?architecture=windows-x86", headers: { origin: ORIGIN, cookie: ca } });
  assert.equal(x86.statusCode, 200);
  assert.equal(x86.headers["content-disposition"], 'attachment; filename="CabinetAgent-win-x86.zip"');
  assert.deepEqual(x86.rawPayload, agentZipX86);
  assert.notDeepEqual(x86.rawPayload, agentZip);
  // And an architecture nobody builds for is refused rather than quietly served something else.
  const bogus = await app.inject({ method: "GET", url: "/api/admin/agent-package?architecture=win-arm64", headers: { origin: ORIGIN, cookie: ca } });
  assert.equal(bogus.statusCode, 400);
  for (const url of ["/api/admin/agent-package/../../etc/passwd", "/api/admin/agent-package?name=../../etc/passwd", "/api/admin/agent-package%2f..%2f..%2fetc%2fpasswd"]) {
    const h = await app.inject({ method: "GET", url, headers: { origin: ORIGIN, cookie: ca } });
    assert.ok(h.statusCode === 404 || !h.rawPayload.toString().includes("root:"), url);
    if (h.statusCode === 200) assert.deepEqual(h.rawPayload, agentZip, url);
  }
});

test("an installer for one cabinet: Admin only, confirmed with a code, holds a working one-time token and this server's packages", async () => {
  const t2 = await signIn(await account("tier2"));
  const admin = await account("admin");
  const ca = await signIn(admin);
  assert.equal((await call("POST", "/api/admin/installer", { stepUpToken: "x".repeat(43) }, t2)).status, 403);
  assert.ok((await call("POST", "/api/admin/installer", { stepUpToken: "x".repeat(43) }, ca)).status >= 400, "a made-up confirmation is refused");
  assert.equal((await call("POST", "/api/admin/installer", { stepUpToken: "x".repeat(43), extra: 1 }, ca)).status, 400, "the body is checked against its schema");
  clock += 30_000;
  const confirmation = (await call("POST", "/api/auth/step-up", { code: totp.code(admin.secret, totp.stepAt(clock)), action: "token.create", target: "fleet" }, ca)).body.token;
  const r = await call("POST", "/api/admin/installer", { stepUpToken: confirmation }, ca);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.fileName, "Install-CabinetAgent.cmd");
  const script: string = r.body.script;
  assert.match(script, new RegExp(`'windows-x64' = @\\{ Name = 'CabinetAgent-win-x64\\.zip'; Sha256 = '${createHash("sha256").update(agentZip).digest("hex")}' \\}`));
  assert.match(script, new RegExp(`'windows-x86' = @\\{ Name = 'CabinetAgent-win-x86\\.zip'; Sha256 = '${createHash("sha256").update(agentZipX86).digest("hex")}' \\}`));
  assert.match(script, /\$serverHost = 'cabinets\.example\.com'/);
  assert.equal(script.includes("-AllowUnsigned"), false, "no build said its packages are unsigned");
  // The token in the file is a real one-time token: a cabinet can ask to join with it, once.
  const token = /\$token = '([A-Za-z0-9_-]+)'/.exec(script)![1]!;
  const fingerprints = { hostname: "CAB-INSTALLER", serialNumber: "SN-INSTALLER", macAddresses: [], provisionedClient: null, provisionedSite: null,
    onlineSince: new Date().toISOString(), osVersion: "Windows 10 Pro (32-bit)", agentVersion: "0.2.0" };
  await submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints }, "127.0.0.1");
  await assert.rejects(submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints }, "127.0.0.1"), "a used token is refused");
  // The confirmation was used up.
  assert.ok((await call("POST", "/api/admin/installer", { stepUpToken: confirmation }, ca)).status >= 400);
});

test("unsigned packages are accepted only when the build says so, and never in production", async () => {
  const admin = await account("admin");
  const ca = await signIn(admin);
  const installer = async () => {
    clock += 30_000;
    const confirmation = (await call("POST", "/api/auth/step-up", { code: totp.code(admin.secret, totp.stepAt(clock)), action: "token.create", target: "fleet" }, ca)).body.token;
    const r = await call("POST", "/api/admin/installer", { stepUpToken: confirmation }, ca);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.script as string;
  };
  writeFileSync(join(downloadDir, "UNSIGNED-DEVELOPMENT-BUILD"), "");
  try {
    assert.equal((await call("GET", "/api/admin/setup", undefined, ca)).body.agent.unsigned, true, "the page says so");
    assert.match(await installer(), /\$installerArgs \+= '-AllowUnsigned'/);
    const production = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => clock,
      agentSetup: { host: "cabinets.example.com", port: 8443, downloadDir, production: true } });
    try {
      const r = await production.inject({ method: "GET", url: "/api/admin/setup", headers: { origin: ORIGIN, cookie: ca } });
      assert.equal(JSON.parse(r.body).agent.unsigned, false, "a production server never accepts an unsigned build, marker or not");
    } finally { await production.close(); }
  } finally { rmSync(join(downloadDir, "UNSIGNED-DEVELOPMENT-BUILD")); }
  assert.equal((await installer()).includes("-AllowUnsigned"), false);
});
