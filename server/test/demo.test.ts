// Demo mode (docs/platform/demo.md): every simulated answer passes the operation's output schema, the simulated fleet's
// problems become real alerts through the real alerts engine, fixes made on a simulated cabinet take effect, only an
// Admin turns it on or off, and turning it off deletes every simulated record while leaving real cabinets alone.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { SCHEMA_DIR } from "@mashura/cabinet-contracts/load";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { approveEnrollment, createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { envelopes, operations } from "../src/contracts.js";
import { DemoSimulator, scenarioEvents } from "../src/demo/demo.js";
import { DEMO_FLEET, type Scenario } from "../src/demo/fleet.js";
import { demoOutput, type DemoContext } from "../src/demo/outputs.js";
import { ISSUE } from "../src/services/rules.js";
import { evaluateDrift } from "../src/services/firewall-policy.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";

const ORIGIN = "https://console.test";
const EXAMPLES = join(dirname(SCHEMA_DIR), "examples", "operations");
const SCENARIOS: Scenario[] = ["healthy", "firewall_drift", "scanner_disconnected", "service_failing", "disk_failing", "bsod", "offline", "dns_errors", "update_failure", "unknown_errors"];
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let clock = Date.now();
const secrets = new SecretBox(randomBytes(32).toString("base64"));
let realCabinet: string;
const downloadDir = tempDir();
const agentZip = Buffer.from("PK\u0003\u0004 not really a zip, but the server only serves the bytes");

interface Account { id: string; username: string; password: string; secret: Buffer; }
async function account(role: "tier1" | "tier2" | "admin"): Promise<Account> {
  const a: Account = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple", secret: totp.newSecret() };
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc) VALUES ($1, $2, $3, $4, $5, false, true, $6)`,
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
const until = async (what: string, check: () => Promise<boolean>, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (await check()) return;
  assert.fail(`timed out waiting for ${what}`);
};
const openAlert = async (cabinetId: string, issue: string) => (await db.app.query(
  "SELECT 1 FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved'", [cabinetId, issue])).rows.length > 0;
const demoCabinet = async (scenario: string) => (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE demo_scenario = $1 LIMIT 1", [scenario])).rows[0]!.id;

test.before(async () => {
  db = await createTestDatabase();
  const key = await developmentIssuingKey(tempDir());
  stream = new ResultStream(db.appUrl, db.app);
  await stream.start();
  writeFileSync(join(downloadDir, "CabinetAgent-win-x64.zip"), agentZip);
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => clock,
    agentSetup: { host: "cabinets.example.com", port: 8443, downloadDir } });
  const admin = await account("admin");
  const { token } = await createBootstrapToken(db.app, admin.id);
  const requestId = await submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: {
    hostname: "MY-HP", serialNumber: null, macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 11", agentVersion: "0.5.0" } }, "127.0.0.1");
  realCabinet = (await approveEnrollment(db.app, key, requestId, { clientName: "Mashura Office", siteName: "HQ", cabinetName: "Marco's HP", role: "standalone" }, admin.id)).cabinetId;
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = now(), read_only = false WHERE id = $1", [realCabinet]);
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

test("every simulated answer, for every operation and every scenario, passes the operation's output schema", () => {
  for (const scenario of SCENARIOS)
    for (const op of Object.keys(operations)) {
      const paramsDir = join(EXAMPLES, op, "params", "valid");
      for (const file of readdirSync(paramsDir)) {
        const params = JSON.parse(readFileSync(join(paramsDir, file), "utf8"));
        const ctx: DemoContext = { hostname: "CAB-01S01", role: "sync", scenario, subnet: "10.21.4", index: 1, now: new Date(),
          firewallProfiles: { domain: scenario === "firewall_drift", private: false, public: scenario === "firewall_drift" }, watchedServices: ["BioScanSvc", "Spooler"], syncBlocked: scenario === "healthy",
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
  const ca = await signIn(await account("admin"));
  assert.equal((await call("PUT", "/api/admin/demo", { enabled: true }, t2)).status, 403);
  for (const body of [{}, { enabled: "true" }, { enabled: 1 }, { enabled: true, scenario: "bsod" }, [true], null])
    assert.equal((await call("PUT", "/api/admin/demo", body, ca)).status, 400, JSON.stringify(body));
  assert.equal((await call("PUT", "/api/admin/demo", { enabled: true })).status, 401);
  assert.deepEqual((await call("GET", "/api/demo", undefined, t2)).body, { enabled: false, clients: 0, cabinets: 0 });
});

test("demo mode adds the simulated fleet, and its problems become real alerts through the alerts engine", async () => {
  const ca = await signIn(await account("admin"));
  const on = await call("PUT", "/api/admin/demo", { enabled: true }, ca);
  const expected = DEMO_FLEET.flatMap(c => c.sites.flatMap(s => s.cabinets)).length;
  assert.deepEqual(on.body, { enabled: true, clients: DEMO_FLEET.length, cabinets: expected });
  assert.equal((await call("PUT", "/api/admin/demo", { enabled: true }, ca)).body.cabinets, expected, "turning it on twice adds nothing");
  assert.ok(await openAlert(await demoCabinet("firewall_drift"), ISSUE.firewallPolicy), "firewall drift");
  assert.ok(await openAlert(await demoCabinet("scanner_disconnected"), ISSUE.scanner), "scanner");
  assert.ok(await openAlert(await demoCabinet("service_failing"), ISSUE.serviceFailing), "service failing");
  assert.ok(await openAlert(await demoCabinet("disk_failing"), ISSUE.drive), "drive");
  assert.ok(await openAlert(await demoCabinet("bsod"), "00000000-0000-4000-8000-000000000109"), "blue screen");
  assert.ok(await openAlert(await demoCabinet("offline"), ISSUE.offline), "offline");
  assert.ok(!(await openAlert(await demoCabinet("healthy"), ISSUE.firewallPolicy)), "a healthy cabinet has nothing");
  const fleet = (await call("GET", "/api/fleet/clients", undefined, ca)).body as { name: string; demo: boolean }[];
  assert.deepEqual(fleet.filter(c => c.demo).map(c => c.name).sort(), DEMO_FLEET.map(c => c.name).sort());
  assert.ok(fleet.some(c => c.name === "Mashura Office" && !c.demo), "the real client is listed too, not marked demo");
});

test("simulated cabinets answer commands, and a fix made on one takes effect", async () => {
  const t1 = await signIn(await account("tier1"));
  const t2 = await signIn(await account("tier2"));
  const sim = new DemoSimulator(db.app, m => assert.fail(m), 50, [0, 10]);
  sim.start();
  try {
    const drift = await demoCabinet("firewall_drift");
    const read = await call("POST", `/api/cabinets/${drift}/commands`, { operation: "system.info", params: {} }, t1);
    assert.equal(read.status, 202);
    await until("the simulated answer", async () => (await db.app.query("SELECT status FROM commands WHERE id = $1", [read.body.commandId])).rows[0]?.status === "succeeded");
    const info = (await db.app.query("SELECT result FROM commands WHERE id = $1", [read.body.commandId])).rows[0].result.output;
    assert.match(info.hostname, /^CAB-\d{2}[SC]\d{2}$/);

    // Tier 1 applies the client's policy (all off) with one click: the drift alert resolves as it would on a real cabinet.
    const fix = await call("POST", `/api/cabinets/${drift}/commands`, { operation: "firewall.applyPolicy", params: {} }, t1);
    assert.equal(fix.status, 202, JSON.stringify(fix.body));
    await until("the drift alert to resolve", async () => !(await openAlert(drift, ISSUE.firewallPolicy)));
    assert.equal((await db.app.query("SELECT demo_scenario FROM cabinets WHERE id = $1", [drift])).rows[0].demo_scenario, "healthy");

    // Tier 2 restarts the failing scanner service: it recovers and its major alert resolves.
    const failing = await demoCabinet("service_failing");
    const restart = await call("POST", `/api/cabinets/${failing}/commands`, { operation: "service.control", params: { name: "BioScanSvc", action: "restart" } }, t2);
    assert.equal(restart.status, 202);
    await until("the service alert to resolve", async () => !(await openAlert(failing, ISSUE.serviceFailing)));

    // The offline cabinet never answers: its command stays queued, never falsely succeeds.
    const offline = await demoCabinet("offline");
    const silent = await call("POST", `/api/cabinets/${offline}/commands`, { operation: "system.info", params: {} }, t1);
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await db.app.query("SELECT status FROM commands WHERE id = $1", [silent.body.commandId])).rows[0].status, "queued");

    // The real cabinet's commands are never answered by the simulator.
    const real = await call("POST", `/api/cabinets/${realCabinet}/commands`, { operation: "system.info", params: {} }, t1);
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await db.app.query("SELECT status FROM commands WHERE id = $1", [real.body.commandId])).rows[0].status, "queued");
  } finally {
    sim.stop();
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
    assert.ok(Number((await db.app.query("SELECT count(*) FROM audit_log WHERE action = 'command.issue' AND details->>'operation' = 'network.test' AND target_id = $1", [surgery])).rows[0].count) >= 4);
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

test("turning demo mode off deletes every simulated record and leaves the real cabinet alone", async () => {
  const ca = await signIn(await account("admin"));
  const off = await call("PUT", "/api/admin/demo", { enabled: false }, ca);
  assert.deepEqual(off.body, { enabled: false, clients: 0, cabinets: 0 });
  for (const table of ["alerts", "events", "commands", "firewall_changes"])
    assert.equal((await db.app.query(`SELECT count(*)::int AS n FROM ${table} t JOIN cabinets k ON k.id = t.cabinet_id WHERE k.demo_scenario IS NOT NULL`)).rows[0].n, 0, table);
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM cabinets WHERE id = $1 AND status = 'active'", [realCabinet])).rows[0].n, 1);
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM commands WHERE cabinet_id = $1", [realCabinet])).rows[0].n, 1, "the real cabinet's command history is kept");
  const audited = (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'demo.%' ORDER BY seq")).rows.map(r => r.action);
  assert.deepEqual(audited, ["demo.enable", "demo.disable"]);
});

test("the setup page: Admin only; it says where cabinets connect and serves the one agent package, never another path", async () => {
  const t2 = await signIn(await account("tier2"));
  const ca = await signIn(await account("admin"));
  assert.equal((await call("GET", "/api/admin/setup", undefined, t2)).status, 403);
  assert.equal((await call("GET", "/api/admin/agent-package", undefined, t2)).status, 403);
  const setup = (await call("GET", "/api/admin/setup", undefined, ca)).body;
  assert.deepEqual(setup.agent, { host: "cabinets.example.com", port: 8443,
    package: { name: "CabinetAgent-win-x64.zip", bytes: agentZip.length, sha256: createHash("sha256").update(agentZip).digest("hex") } });
  assert.equal(setup.realCabinets, 1);
  assert.equal(setup.newestCabinetId, realCabinet);
  const r = await app.inject({ method: "GET", url: "/api/admin/agent-package", headers: { origin: ORIGIN, cookie: ca } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["content-disposition"], 'attachment; filename="CabinetAgent-win-x64.zip"');
  assert.deepEqual(r.rawPayload, agentZip);
  for (const url of ["/api/admin/agent-package/../../etc/passwd", "/api/admin/agent-package?name=../../etc/passwd", "/api/admin/agent-package%2f..%2f..%2fetc%2fpasswd"]) {
    const h = await app.inject({ method: "GET", url, headers: { origin: ORIGIN, cookie: ca } });
    assert.ok(h.statusCode === 404 || !h.rawPayload.toString().includes("root:"), url);
    if (h.statusCode === 200) assert.deepEqual(h.rawPayload, agentZip, url);
  }
});
