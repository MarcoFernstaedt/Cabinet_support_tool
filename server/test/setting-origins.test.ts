// Where a cabinet's settings come from (F6.R5, decision-log D38). A cabinet approved after its site, client and the fleet have settings
// follows them at once (nothing is copied onto it), and the console's origins read names the level each one comes from, using the same
// resolver the setting is enforced with. A cabinet's own value wins; a damaged level is reported as rejected. Through the real
// enrollment approval and the real console route on a real SQL Server.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { paramsHash } from "../src/auth/canonical.js";
import { SecretBox } from "../src/auth/secrets.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { reevaluationsSettled } from "../src/console-api/baseline-routes.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { APPS_SET_ACTION, setApprovedApps } from "../src/services/approved-apps.js";
import { createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { ORIGIN_SETTINGS } from "../src/services/setting-origins.js";
import { ConsoleHarness, ORIGIN, type Account } from "./console-harness.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);
const call = h.call.bind(h);
let ada: Account, tier1: Account;

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  [ada, tier1] = [await h.account("admin"), await h.account("tier1")];
});
test.after(async () => { await reevaluationsSettled(); await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

const APP = { key: "app:dispenser", kind: "application", name: "Dispenser", path: "C:\\Program Files\\Dispenser\\dispenser.exe" };
const USB = { identityKey: { kind: "device", value: "UNIT-1", confidence: "high" }, enabled: true, absentForMinutes: 5, reconnect: { count: 3, windowMinutes: 10 },
  quietHours: null, severity: {}, autoRestart: false };
const admin = () => ({ userId: ada.id, role: "admin" });
const setting = (key: string, value: unknown) => db.app.query("INSERT INTO settings ([key], [value]) VALUES ($1, $2)", [key, JSON.stringify(value)]);

async function newSite() {
  const clientId = randomUUID(), siteId = randomUUID(), tag = randomBytes(3).toString("hex");
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [clientId, `Client ${tag}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [siteId, clientId, `Site ${tag}`]);
  return { clientId, siteId, client: `Client ${tag}`, site: `Site ${tag}` };
}
/** A cabinet enrolled and approved through the real routes, as a new cabinet arrives. */
async function approvedCabinet(s: { siteId: string; client: string; site: string }, name: string): Promise<string> {
  const { token } = await createBootstrapToken(db.app, ada.id);
  const requestId = await submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token,
    fingerprints: { hostname: "CAB-" + randomBytes(2).toString("hex"), serialNumber: "SN-" + randomBytes(3).toString("hex"), macAddresses: [],
      provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 11", agentVersion: "0.3.1" } }, "10.77.0.9");
  const body = { client: s.client, site: s.site, cabinet: name, role: "standalone", baseline: { use: "capture" } };
  const r = await call("POST", `/api/admin/enrollments/${requestId}/approve`, { ...body, stepUpToken: await h.codeToken(ada, "enrollment.approve", requestId, body) }, ada);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE site_id = $1 AND name = $2", [s.siteId, name])).rows[0]!.id.toLowerCase();
}
type Origin = { setting: string; source: string; setAt: string[]; rejected: string[]; count: number | null };
async function origins(cabinetId: string, who: Account = tier1): Promise<Record<string, Origin>> {
  const r = await call("GET", `/api/cabinets/${cabinetId}/setting-origins`, undefined, who);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const list = r.body.settings as Origin[];
  assert.deepEqual(list.map(o => o.setting), [...ORIGIN_SETTINGS], "every setting with a parent scope, in order");
  return Object.fromEntries(list.map(o => [o.setting, o]));
}
const brief = (o: Origin) => [o.source, o.setAt, o.rejected, o.count];

test("a cabinet approved after its site, client and the fleet have settings follows each of them, and the read says which level each comes from", async () => {
  const s = await newSite();
  // The fleet: firewall policy, sync ports, scanner IDs, a USB watch.
  await setting("firewall.policy", { domain: "on", private: "on", public: "off" });
  await setting("sync.ports", [5000]);
  await setting("scanner.hardwareIds", ["USB\\VID_1111&PID_2222"]);
  await setting("usb.policy", { version: 1, policy: USB });
  await setting("services.watched.role.standalone", ["W32Time"]);
  // The client: its time zone, watched services and approved programs.
  await db.app.query("UPDATE clients SET time_zone = 'Eastern Standard Time', watched_services = $2 WHERE id = $1", [s.clientId, JSON.stringify(["Spooler"])]);
  // An approved-programs code is bound to the entries as sent (approved-apps.ts).
  await setApprovedApps(db.app, admin(), "client", s.clientId, [APP],
    await issueStepUpToken(db.app, ada.id, APPS_SET_ACTION.client, s.clientId.toLowerCase(), paramsHash({ level: "client", id: s.clientId.toLowerCase(), entries: [APP] })));
  // The site: its network baseline, scanner IDs and the file paths it may read.
  await db.app.query("UPDATE sites SET network_baseline = $2, scanner_hardware_ids = $3 WHERE id = $1",
    [s.siteId, JSON.stringify({ addressing: "dhcp", prefixLength: 24, gateway: "10.40.0.1", dnsServers: ["10.40.0.2"] }), JSON.stringify(["USB\\VID_3333&PID_4444"])]);

  const cabinetId = await approvedCabinet(s, "New 1");
  const o = await origins(cabinetId);
  assert.deepEqual(brief(o.firewallPolicy!), ["fleet", ["fleet"], [], null]);
  assert.deepEqual(brief(o.networkBaseline!), ["site", ["site"], [], null]);
  assert.deepEqual(brief(o.timeZone!), ["client", ["client"], [], null]);
  assert.deepEqual(brief(o.syncPorts!), ["fleet", ["fleet"], [], 1]);
  assert.deepEqual(brief(o.scannerUse!), ["client", ["client"], [], null]);
  assert.deepEqual(brief(o.scannerIds!), ["site", ["site", "fleet"], [], 1]);
  assert.deepEqual(brief(o.watchedServices!), ["client", ["client", "role"], [], 1], "the role's list is the last resort (D34)");
  assert.deepEqual(brief(o.approvedApps!), ["client", ["client"], [], 1]);
  assert.deepEqual(brief(o.usbWatch!), ["fleet", ["fleet"], [], 1]);
  assert.deepEqual(brief(o.configBaseline!), ["none", [], [], null], "no approved baseline anywhere yet");
  // Nothing was copied onto the cabinet: every value it follows is read from the level above it.
  const own = (await db.app.query<Record<string, unknown>>("SELECT scanner_hardware_ids, watched_services, approved_apps FROM cabinets WHERE id = $1", [cabinetId])).rows[0]!;
  assert.deepEqual(Object.values(own), [null, null, null]);
});

test("a cabinet's own value wins over the levels above it; a damaged level is named as rejected, not passed over", async () => {
  const s = await newSite();
  const cabinetId = await approvedCabinet(s, "Own 1");
  const before = await origins(cabinetId);
  assert.deepEqual(brief(before.firewallPolicy!).slice(0, 2), ["fleet", ["fleet"]], "the fleet's policy from the first test");
  await db.app.query("UPDATE cabinets SET scanner_hardware_ids = $2 WHERE id = $1", [cabinetId, JSON.stringify(["USB\\VID_9999&PID_0001"])]);
  await db.app.query("UPDATE sites SET firewall_policy = $2, sync_ports = '[]' WHERE id = $1", [s.siteId, JSON.stringify({ domain: "on", private: "off", public: "off" })]);
  // A site list edited outside the platform: its hash does not match its entries.
  await db.app.query("UPDATE sites SET approved_apps = $2 WHERE id = $1", [s.siteId, JSON.stringify({ version: 1, entries: [APP], hash: "0".repeat(64), setBy: ada.id, setAt: "2026-10-01T00:00:00.000Z" })]);
  await setting(`usb.policy.client.${s.clientId.toLowerCase()}`, { version: "x" });
  const o = await origins(cabinetId);
  assert.deepEqual(brief(o.scannerIds!), ["cabinet", ["cabinet", "fleet"], [], 1]);
  assert.deepEqual(brief(o.firewallPolicy!), ["site", ["site", "fleet"], [], null]);
  assert.deepEqual(brief(o.syncPorts!), ["site", ["site", "fleet"], [], 0], "an empty site list still overrides the fleet's");
  assert.deepEqual(brief(o.approvedApps!), ["site", ["site"], ["site"], 0], "a damaged level denies everything rather than falling through");
  assert.deepEqual(brief(o.usbWatch!), ["fleet", ["client", "fleet"], ["client"], 1]);
});

test("the read is for a signed-in person, for a cabinet that exists; a removed cabinet has no origins", async () => {
  const s = await newSite();
  const cabinetId = await approvedCabinet(s, "Read 1");
  assert.equal((await call("GET", `/api/cabinets/${cabinetId}/setting-origins`, undefined)).status, 401);
  for (const bad of [randomUUID(), "not-a-cabinet", "1' OR '1'='1", "%00"])
    assert.equal((await call("GET", `/api/cabinets/${encodeURIComponent(bad)}/setting-origins`, undefined, tier1)).status, 404, bad);
  await db.app.query("UPDATE cabinets SET status = 'removed' WHERE id = $1", [cabinetId]);
  assert.equal((await call("GET", `/api/cabinets/${cabinetId}/setting-origins`, undefined, tier1)).status, 404);
});

test("every setting a client or site can hold is one the origins read covers (a new column fails here until it is added)", async () => {
  const SETTING: Record<string, string> = { scanner_hardware_ids: "scannerIds", sync_ports: "syncPorts", firewall_policy: "firewallPolicy", watched_services: "watchedServices",
    time_zone: "timeZone", clock_tolerance_seconds: "clockTolerance", network_baseline: "networkBaseline", approved_apps: "approvedApps", fingerprint_scanner: "scannerUse",
    scanner_service: "scannerUse" };
  // What a client or site is, not a setting its cabinets follow.
  const NOT_SETTINGS = new Set(["id", "name", "client_id", "created_at", "removed_at", "demo", "write_paused", "write_pause_reason"]);
  const columns = (await db.app.query<{ t: string; c: string }>(
    "SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME IN ('clients', 'sites') ORDER BY TABLE_NAME, ORDINAL_POSITION")).rows;
  const unknown = columns.filter(x => !NOT_SETTINGS.has(x.c) && !(x.c in SETTING)).map(x => `${x.t}.${x.c}`);
  assert.deepEqual(unknown, [], "a column on clients or sites that is neither a known setting nor listed as not one");
  for (const name of new Set(Object.values(SETTING))) assert.ok((ORIGIN_SETTINGS as readonly string[]).includes(name), name);
});
