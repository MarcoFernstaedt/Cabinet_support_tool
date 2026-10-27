// Replacing a cabinet (docs/spec/05-server-spec.md "Replacing a cabinet"), through the real console routes on a real SQL Server: a sync
// cabinet whose drive failed is replaced by a new enrollment; the old one is retired with its history kept, the new one takes its name,
// its satellites, its Admin-set address and its own settings; a satellite's replacement keeps its sync link; and every replacement the
// rules do not allow is refused before anything is written.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SecretBox } from "../src/auth/secrets.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { approveEnrollment, createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { readLevelState } from "../src/services/approved-apps.js";
import { ISSUE } from "../src/services/rules.js";
import { ConsoleHarness, ORIGIN, type Account } from "./console-harness.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
let key: Awaited<ReturnType<typeof developmentIssuingKey>>;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);
const call = h.call.bind(h);
let ada: Account, tier2: Account;

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  key = await developmentIssuingKey(tempDir());
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  [ada, tier2] = [await h.account("admin"), await h.account("tier2")];
});
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

async function pending(hostname = "CAB-" + randomBytes(2).toString("hex")): Promise<string> {
  const { token } = await createBootstrapToken(db.app, ada.id);
  return submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: { hostname, serialNumber: null, macAddresses: [],
    provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 11", agentVersion: "0.3.1" } }, "10.0.0.9");
}
const approveDirect = async (clientName: string, siteName: string, cabinetName: string, role: "sync" | "satellite" | "standalone") =>
  approveEnrollment(db.app, key, await pending(), { clientName, siteName, cabinetName, role }, ada.id);
async function approve(requestId: string, body: Record<string, unknown>, who: Account = ada) {
  return call("POST", `/api/admin/enrollments/${requestId}/approve`, { ...body, stepUpToken: await h.codeToken(who, "enrollment.approve", requestId, body) }, who);
}
const row = async (id: string) => (await db.app.query<{ name: string; status: string; sync_cabinet_id: string | null; sync_address: string | null; sync_address_source: string | null;
  scanner_hardware_ids: unknown; watched_services: unknown; in_office: boolean; replaces_cabinet_id: string | null }>(
  "SELECT name, status, sync_cabinet_id, sync_address, sync_address_source, scanner_hardware_ids, watched_services, in_office, replaces_cabinet_id FROM cabinets WHERE id = $1", [id])).rows[0]!;
const asJson = (v: unknown) => typeof v === "string" ? JSON.parse(v) : v;
const APP = { key: "app:Kiosk", kind: "application", name: "Kiosk", path: "C:\\Program Files\\Vendor\\Kiosk\\kiosk.exe" };
const USB = { identityKey: { kind: "device", value: "UNIT-1", confidence: "high" }, enabled: true, absentForMinutes: 5, reconnect: { count: 3, windowMinutes: 10 },
  quietHours: null, severity: {}, autoRestart: false };

test("a sync cabinet's replacement takes its name, satellites, address and own settings; the old one is retired with its history", async () => {
  const sync = await approveDirect("Replace Health", "North", "SYNC", "sync");
  const sat = await approveDirect("Replace Health", "North", "SAT 1", "satellite");
  assert.equal((await row(sat.cabinetId)).sync_cabinet_id?.toLowerCase(), sync.cabinetId.toLowerCase());
  const old = sync.cabinetId;
  // The old cabinet's own settings and history.
  await db.app.query(`UPDATE cabinets SET sync_address = '10.30.0.5', sync_address_source = 'admin', scanner_hardware_ids = $2, watched_services = $3, in_office = 1,
                      filefacts_paths = NULL WHERE id = $1`, [old, JSON.stringify(["USB\\VID_1234&PID_5678"]), JSON.stringify(["Spooler"])]);
  const apps = { level: "cabinet", id: old.toLowerCase(), entries: [APP] };
  assert.equal((await call("PUT", `/api/cabinets/${old}/approved-apps`, { ...apps, stepUpToken: await h.codeToken(ada, "cabinet.apps", old.toLowerCase(), apps) }, ada)).status, 200);
  await db.app.query("INSERT INTO settings ([key], [value]) VALUES ($1, $2)", [`usb.policy.cabinet.${old.toLowerCase()}`, JSON.stringify({ version: 3, policy: USB })]);
  const baselineId = randomUUID();
  await db.app.query("INSERT INTO baselines (id, scope_kind, scope_id, name, created_by) VALUES ($1, 'cabinet', $2, 'SYNC', $3)", [baselineId, old.toLowerCase(), ada.id]);
  await db.app.query(`INSERT INTO baseline_versions (id, baseline_id, [version], status, content, description, created_by, decided_by, decided_at)
                      VALUES ($1, $2, 2, 'approved', '{"items":[]}', 'Its own', $3, $3, SYSUTCDATETIME())`, [randomUUID(), baselineId, ada.id]);
  await db.app.query(`INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen)
                      VALUES ($1, $2, 'major', 'drive', 'Drive failing', SYSUTCDATETIME(), SYSUTCDATETIME())`, [old, ISSUE.drive]);

  const requestId = await pending("SYNC-NEWDRIVE");
  const r = await approve(requestId, { client: "Replace Health", site: "North", cabinet: "SYNC", role: "sync", replacesCabinetId: old, baseline: { use: "capture" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const fresh = r.body.cabinetId as string;
  assert.equal(r.body.replacement.satellitesMoved, 1);
  assert.equal(r.body.replacement.alertsResolved, 1);

  // The new cabinet: the old name, the Admin-set address, the satellite, and the old cabinet's own settings.
  const n = await row(fresh);
  assert.equal(n.name, "SYNC");
  assert.deepEqual([n.sync_address, n.sync_address_source], ["10.30.0.5", "admin"]);
  assert.deepEqual([asJson(n.scanner_hardware_ids), asJson(n.watched_services), !!n.in_office], [["USB\\VID_1234&PID_5678"], ["Spooler"], true]);
  assert.equal(n.replaces_cabinet_id?.toLowerCase(), old.toLowerCase());
  assert.equal((await row(sat.cabinetId)).sync_cabinet_id?.toLowerCase(), fresh.toLowerCase(), "the satellite follows to the new sync cabinet");
  assert.deepEqual((await readLevelState(db.app, "cabinet", fresh)).list?.entries.map(e => e.key), ["app:Kiosk"], "signing is off here, so the copy is in force");
  const usb = (await db.app.query<{ value: unknown }>("SELECT [value] FROM settings WHERE [key] = $1", [`usb.policy.cabinet.${fresh.toLowerCase()}`])).rows[0];
  const usbCopy = asJson(usb!.value);
  assert.equal(usbCopy.version, 1);
  assert.deepEqual({ ...usbCopy.policy, settle: undefined }, { ...USB, settle: undefined }, "the policy is copied, with its defaults filled in");
  const copied = (await db.app.query<{ status: string; origin: unknown }>(
    "SELECT v.status, v.origin FROM baseline_versions v JOIN baselines b ON b.id = v.baseline_id WHERE b.scope_kind = 'cabinet' AND b.scope_id = $1", [fresh.toLowerCase()])).rows;
  assert.equal(copied.length, 1);
  assert.equal(copied[0]!.status, "approved");
  assert.equal(asJson(copied[0]!.origin).kind, "replacement");

  // The old cabinet: retired, renamed, certificate revoked, alerts resolved, history kept and linked both ways.
  const o = await row(old);
  assert.equal(o.status, "removed");
  assert.match(o.name, /^SYNC \(replaced \d{4}-\d{2}-\d{2}\)$/);
  assert.equal(Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM cabinet_certificates WHERE cabinet_id = $1 AND revoked_at IS NULL", [old])).rows[0]!.n), 0);
  const alert = (await db.app.query<{ state: string; resolution: string }>("SELECT state, resolution FROM alerts WHERE cabinet_id = $1", [old])).rows[0]!;
  assert.deepEqual([alert.state, alert.resolution], ["resolved", "Replaced by SYNC."]);
  const oldPage = (await call("GET", `/api/fleet/cabinets/${old}`, undefined, tier2)).body;
  assert.equal(oldPage.replacedBy.id.toLowerCase(), fresh.toLowerCase());
  const newPage = (await call("GET", `/api/fleet/cabinets/${fresh}`, undefined, tier2)).body;
  assert.equal(newPage.replaces.id.toLowerCase(), old.toLowerCase());
  assert.equal(newPage.replaces.name, o.name);
  const actions = (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE action IN ('cabinet.replace', 'cabinet.revoke') AND (target_id = $1 OR target_id = $2) ORDER BY seq",
    [fresh.toLowerCase(), old.toLowerCase()])).rows.map(x => x.action);
  assert.deepEqual(actions, ["cabinet.replace", "cabinet.revoke"]);
});

test("a satellite's replacement keeps the sync cabinet it reached, under a new name if it is given one", async () => {
  const sync = await approveDirect("Satellite Health", "North", "SYNC", "sync");
  const sat = await approveDirect("Satellite Health", "North", "EXAM 1", "satellite");
  const r = await approve(await pending(), { client: "Satellite Health", site: "North", cabinet: "EXAM 1B", role: "satellite", replacesCabinetId: sat.cabinetId, baseline: { use: "capture" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await row(r.body.cabinetId)).sync_cabinet_id?.toLowerCase(), sync.cabinetId.toLowerCase());
  const o = await row(sat.cabinetId);
  assert.deepEqual([o.name, o.status], ["EXAM 1", "removed"], "the old name is kept when the new cabinet does not take it");
});

test("a replacement the rules do not allow is refused, and nothing is written", async () => {
  const a = await approveDirect("Refuse Health", "North", "SYNC", "sync");
  const b = await approveDirect("Refuse Health", "South", "SOLO", "standalone");
  const cases: [Record<string, unknown>, number, string][] = [
    [{ client: "Refuse Health", site: "South", cabinet: "X", role: "sync", replacesCabinetId: a.cabinetId }, 409, "replacement_elsewhere"],
    [{ client: "Refuse Health", site: "North", cabinet: "X", role: "satellite", replacesCabinetId: a.cabinetId }, 409, "replacement_role_differs"],
    [{ client: "Refuse Health", site: "North", cabinet: "X", role: "sync", replacesCabinetId: randomUUID() }, 409, "not_replaceable"],
  ];
  for (const [body, status, error] of cases) {
    const requestId = await pending();
    const r = await approve(requestId, { ...body, baseline: { use: "capture" } });
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.equal(r.body.error, error);
    assert.equal((await db.app.query<{ s: string }>("SELECT status AS s FROM enrollment_requests WHERE id = $1", [requestId])).rows[0]!.s, "pending");
  }
  assert.deepEqual([(await row(a.cabinetId)).status, (await row(b.cabinetId)).status], ["active", "active"], "nothing was retired");

  // Replaced once: the old cabinet is no longer active, so a second replacement is refused.
  const first = await approve(await pending(), { client: "Refuse Health", site: "South", cabinet: "SOLO", role: "standalone", replacesCabinetId: b.cabinetId, baseline: { use: "capture" } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const again = await approve(await pending(), { client: "Refuse Health", site: "South", cabinet: "SOLO 2", role: "standalone", replacesCabinetId: b.cabinetId, baseline: { use: "capture" } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "not_replaceable");

  // Hostile ids never reach the database; only an Admin approves.
  const requestId = await pending();
  for (const replacesCabinetId of ["SYNC", "'; DELETE FROM cabinets;--", null, [a.cabinetId], 7]) {
    const r = await call("POST", `/api/admin/enrollments/${requestId}/approve`,
      { client: "Refuse Health", site: "North", cabinet: "X", role: "sync", replacesCabinetId, baseline: { use: "capture" }, stepUpToken: "A".repeat(43) }, ada);
    assert.equal(r.status, 400, `${JSON.stringify(replacesCabinetId)} → ${JSON.stringify(r.body)}`);
  }
  const t2 = await call("POST", `/api/admin/enrollments/${requestId}/approve`,
    { client: "Refuse Health", site: "North", cabinet: "X", role: "sync", replacesCabinetId: a.cabinetId, baseline: { use: "capture" }, stepUpToken: "A".repeat(43) }, tier2);
  assert.equal(t2.status, 403);
});

test("with list signing on, the copied approved programs wait for the Admin's signature", async () => {
  const { generateKeyPairSync, createHash } = await import("node:crypto");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { ListSigningKeys } = await import("../src/services/approved-list-signing.js");
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  const folder = mkdtempSync(join(tmpdir(), "list-trust-"));
  writeFileSync(join(folder, "approved-list-keys.json"), JSON.stringify({ version: 1, keys: [{ keyId: createHash("sha256").update(der).digest("hex"), name: "Test", publicKey: der.toString("base64") }] }));
  const signing = ListSigningKeys.fromFolder(folder);
  const old = await approveDirect("Signed Health", "North", "SOLO", "standalone");
  await db.app.query("UPDATE cabinets SET approved_apps = $2 WHERE id = $1", [old.cabinetId,
    JSON.stringify({ version: 1, entries: [APP], setBy: ada.id, setAt: new Date().toISOString() })]);
  // The list stored by hand is the old cabinet's in force only if it validates; read it the way the replacement does.
  const before = (await readLevelState(db.app, "cabinet", old.cabinetId)).list;
  const r = await approveEnrollment(db.app, key, await pending(), { clientName: "Signed Health", siteName: "North", cabinetName: "SOLO", role: "standalone",
    replacesCabinetId: old.cabinetId }, ada.id, signing);
  const state = await readLevelState(db.app, "cabinet", r.cabinetId);
  if (before) {
    assert.equal(r.replacement!.copied.approvedApps, "waiting");
    assert.equal(state.list, null, "nothing approved in force until the signature");
    assert.deepEqual(state.pending?.entries.map(e => e.key), ["app:Kiosk"]);
  } else {
    assert.equal(r.replacement!.copied.approvedApps, null, "a list that does not validate is not copied");
  }
});
