// Known fixes on real (not demo) cabinets: cabinets with no demo scenario, a diagnosis they answer through the same command and result
// paths a Windows agent uses, a fix saved from one cabinet shown on another client's cabinet, and an alert's resolution carrying the fix.
// The agent's answers here are synthetic (schema-valid outputs); on Windows they come from the machine.
// several, or a whole site, what it finds from the baseline, and the fixes: one cabinet with an authenticator code, many with
// the password, each checked by reading the settings back. The simulated cabinets keep their own network state, so a fix
// really changes what the next check sees.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { SecretBox } from "../src/auth/secrets.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { demoOutput, type DemoContext } from "../src/demo/outputs.js";
import { baselineFor, initialNet } from "../src/demo/network.js";
import { storeEvents } from "../src/services/events.js";
import { storeResult, takeQueuedCommands } from "../src/services/commands.js";
import { ConsoleHarness, ORIGIN, type Account, type Role } from "./console-harness.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
const secrets = new SecretBox(randomBytes(32).toString("base64"));

const h = new ConsoleHarness(secrets);
const account = (role: Role) => h.account(role);
const call = h.call.bind(h);

interface Real { id: string; name: string; scenario: "net_flaky" | "healthy" }
const real: Real[] = [];

/** Creates a real cabinet: no demo scenario, heartbeat reported, filed under its own client and site. */
async function realCabinet(client: string, site: string, name: string, scenario: Real["scenario"]): Promise<Real> {
  const clientId = randomUUID(), siteId = randomUUID(), id = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [clientId, client]);
  await db.app.query("INSERT INTO sites (id, client_id, name, time_zone) VALUES ($1, $2, $3, 'Eastern Standard Time')", [siteId, clientId, site]);
  await db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, hostname, serial_number, read_only, agent_version, uptime_seconds, firewall_profiles, time_zone_id, clock_skew_seconds, last_heartbeat_at)
                      VALUES ($1, $2, $3, 'standalone', 'active', $4, $5, 0, '0.2.0', 100000, '{"domain":false,"private":false,"public":false}', 'Eastern Standard Time', 0.2, SYSUTCDATETIME())`,
    [id, siteId, name, name.toUpperCase(), `SN-${name}`]);
  const r = { id, name, scenario };
  real.push(r);
  return r;
}

let answering: NodeJS.Timeout | undefined;
let inFlight: Promise<void> = Promise.resolve();
/** Stands in for the agent: takes what the server queued for each real cabinet and stores a schema-valid answer, as the agent API does. */
function startAgents() {
  // The tick's promise is kept so teardown can wait for the one that is already running: a query left in flight when the
  // pool closes is an unhandled rejection that fails this whole file, not the test that was running.
  answering = setInterval(() => { inFlight = (async () => {
    for (const c of real) {
      for (const cmd of await takeQueuedCommands(db.app, c.id)) {
        const subnet = "10.77.1", baseline = baselineFor(subnet);
        const ctx: DemoContext = { hostname: c.name.toUpperCase(), role: "standalone", scenario: c.scenario, subnet, index: 1, startTypes: {}, power: {}, drawer: null, firewallProfiles: { domain: false, private: false, public: false },
          events: [], watchedServices: [], syncBlocked: false, now: new Date(), timeZoneId: "Eastern Standard Time", clockSkewSeconds: 0.2, net: initialNet(c.scenario, baseline, subnet, 1), baseline };
        const startedAt = new Date().toISOString();
        await storeResult(db.app, c.id, { commandId: cmd.commandId, status: "succeeded", startedAt, finishedAt: new Date().toISOString(), output: demoOutput(cmd.operation, cmd.params as Record<string, unknown>, ctx) } as never);
      }
    }
  })(); }, 40);
}

test.before(async () => {
  db = await createTestDatabase();
  const key = await developmentIssuingKey(tempDir());
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  startAgents();
});
test.after(async () => {
  clearInterval(answering);   // no new tick starts
  await inFlight;             // and the tick already running finishes before the pool closes
  await app.close(); await stream.stop(); feed.stop(); await db.drop();
});

async function diagnose(a: Account, cabinetId: string) {
  const started = await call("POST", `/api/cabinets/${cabinetId}/diagnose/network`, {}, a);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (const end = Date.now() + 30_000; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
    const d = (await call("GET", `/api/diagnoses/${started.body.diagnosisId}`, undefined, a)).body;
    if (d.state !== "running") return d;
  }
  assert.fail("the diagnosis did not finish");
}

test("on real cabinets: a diagnosis keeps its full read, a fix saved on one cabinet shows on another client's, and the alert carries it into its resolution", async () => {
  const boss = await account("admin"), member = await account("tier1");
  const a = await realCabinet("Real Clinic A", "Main", "Alpha", "net_flaky");
  const b = await realCabinet("Real Clinic B", "Annex", "Bravo", "net_flaky");
  assert.equal((await db.app.query("SELECT COUNT_BIG(*) AS n FROM cabinets WHERE demo_scenario IS NOT NULL")).rows[0].n, "0", "nothing here is a demo cabinet");

  // The diagnosis on a real cabinet: observations from the read, and the whole read kept.
  const first = await diagnose(boss, a.id);
  assert.equal(first.state, "done", JSON.stringify(first));
  assert.ok(first.findings.some((f: { id: string }) => f.id === "obs-ping-loss"), "packet loss is found from the read");
  assert.ok(first.readings.adapters.length > 0 && first.readings.routes.length > 0, "the full read is kept");

  // A member saves what fixed it; the environment comes from the real read; an Admin approves.
  const saved = await call("POST", "/api/known-fixes", { title: "Failing patch cable", solution: "Swapped the patch cable to the switch.", symptom: { kind: "finding", key: "obs-ping-loss" }, cabinetId: a.id }, member);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.status, "pending");
  assert.ok(saved.body.environment.network.gateway, "the environment has the gateway the cabinet reported");
  assert.equal(saved.body.environment.client, "Real Clinic A");
  assert.equal((await call("POST", `/api/known-fixes/${saved.body.id}/approve`, {}, boss)).status, 200);

  // The same problem on a cabinet of another client and site shows the fix, and the diagnosis counts it as shown.
  const second = await diagnose(member, b.id);
  assert.ok(second.findings.some((f: { id: string }) => f.id === "obs-ping-loss"));
  const there = await call("GET", `/api/known-fixes?findingKey=obs-ping-loss&cabinetId=${b.id}`, undefined, member);
  assert.equal(there.body.fixes.length, 1, "a fix applies to every cabinet in the fleet");
  assert.equal(there.body.now.client, "Real Clinic B");
  assert.equal((await db.app.query("SELECT seen_count FROM known_fixes WHERE id = $1", [saved.body.id])).rows[0].seen_count, 1);

  // An alert on a real cabinet, from events stored as the agent API stores them.
  await storeEvents(db.app, a.id, { events: [{ eventId: randomUUID(), kind: "scanner", occurredAt: new Date().toISOString(), severityHint: "major",
    device: { hardwareIds: ["USB\\VID_1234&PID_5678"], deviceInstanceId: "USB\\VID_1234&PID_5678\\1", name: "Fingerprint Reader", state: "disconnected" },
    detail: { message: "The fingerprint scanner is disconnected.", fields: {} } }] as never });
  const alert = (await call("GET", "/api/alerts?state=active", undefined, member)).body.find((x: { cabinet: { id: string } }) => x.cabinet.id === a.id);
  assert.ok(alert?.issueTypeId, "the alert is tied to the scanner issue");
  await call("POST", `/api/known-fixes`, { title: "Scanner needs its driver back", solution: "Rolled the driver back and replugged it.", symptom: { kind: "issue", issueTypeId: alert.issueTypeId }, cabinetId: b.id }, boss);
  // The other client's cabinet gets the same alert and the indicator's data: approved fixes for the issue.
  const listed = await call("GET", `/api/known-fixes?issueTypeId=${alert.issueTypeId}&cabinetId=${a.id}`, undefined, member);
  assert.equal(listed.body.fixes.length, 1);

  // Claim it, save the fix from the alert, resolve without typing a note: the fix's words become the resolution.
  assert.equal((await call("POST", `/api/alerts/${alert.id}/claim`, {}, member)).status, 200);
  const tied = await call("POST", "/api/known-fixes", { title: "Reseated the reader", solution: "Plugged the reader into a rear USB port.\nIt has stayed connected.", symptom: { kind: "issue", issueTypeId: alert.issueTypeId }, cabinetId: a.id, alertId: alert.id }, member);
  assert.equal(tied.status, 201, JSON.stringify(tied.body));
  const resolved = await call("POST", `/api/alerts/${alert.id}/resolve`, {}, member);
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.resolution, "Plugged the reader into a rear USB port. It has stayed connected.");
  assert.equal((await call("POST", "/api/known-fixes", { title: "x", solution: "y", symptom: { kind: "issue", issueTypeId: alert.issueTypeId }, cabinetId: a.id, alertId: randomUUID() }, member)).status, 404, "an alert that does not exist");
});
