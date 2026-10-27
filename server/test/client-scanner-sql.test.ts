// The fingerprint scanner as a per-client choice, on a real SQL Server (docs/spec/05-server-spec.md "Fingerprint scanner per client").
// On: the service joins the client's approved list (waiting for the Admin's signature when signing is on) and its watched services, and
// the broker only keeps it running once it is approved in force. Off: no scanner IDs, no alerts, open scanner alerts resolved, the service
// off the watched list. Existing clients start on. Every change needs an Admin and a code bound to the exact choice.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";
import { listToSign, readLevelState, setApprovedApps, signApprovedApps } from "../src/services/approved-apps.js";
import { ListSigningKeys } from "../src/services/approved-list-signing.js";
import { paramsHash } from "../src/auth/canonical.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import { recordHeartbeat } from "../src/services/cabinets.js";
import { clientScanner, knowsScannerWatch, setClientScanner, type ScannerChoice } from "../src/services/client-scanner.js";
import { approveEnrollment, createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { storeEvents } from "../src/services/events.js";
import { upsertAlert } from "../src/services/alerts.js";
import { ISSUE } from "../src/services/rules.js";
import { Refused } from "../src/services/errors.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import type { ApprovedListSignature, Event } from "../src/contracts.js";

const admin = { userId: randomUUID(), role: "admin" };
const tier2 = { userId: randomUUID(), role: "tier2" };
const SERVICE = { key: "app:bioscan", kind: "service", name: "Fingerprint scanner", path: "C:\\Program Files\\BioScan\\BioScanSvc.exe", serviceName: "BioScanSvc" };
const KIOSK = { key: "app:kiosk", kind: "application", name: "Kiosk", path: "C:\\Program Files\\Vendor\\Kiosk\\kiosk.exe" };
let db: TestDatabase;

function makeKey(): { privateKey: KeyObject; keys: ListSigningKeys; keyId: string } {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  const keyId = createHash("sha256").update(der).digest("hex");
  const folder = mkdtempSync(join(tmpdir(), "list-trust-"));
  writeFileSync(join(folder, "approved-list-keys.json"), JSON.stringify({ version: 1, keys: [{ keyId, name: "Test list key", publicKey: der.toString("base64") }] }));
  return { privateKey: pair.privateKey, keys: ListSigningKeys.fromFolder(folder), keyId };
}
const signWith = (key: { privateKey: KeyObject; keyId: string }, documentBase64: string): ApprovedListSignature => ({
  keyId: key.keyId, algorithm: "ecdsa-p256-sha256",
  signature: sign("sha256", Buffer.from(documentBase64, "base64"), { key: key.privateKey, dsaEncoding: "der" }).toString("base64"),
});

async function place(): Promise<{ client: string; site: string; cabinet: string }> {
  const [client, site, cabinet] = [randomUUID(), randomUUID(), randomUUID()];
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `Client ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'North')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'ICU 1', 'standalone', 'active')", [cabinet, site]);
  return { client, site, cabinet };
}
const choose = async (clientId: string, choice: ScannerChoice, signing?: ListSigningKeys, user = admin) =>
  setClientScanner(db.app, user, clientId, choice, await issueStepUpToken(db.app, user.userId, "client.fingerprint_scanner", clientId, paramsHash({ scanner: choice })), signing);
const beat = (cabinet: string, agentVersion = "0.3.1") => recordHeartbeat(db.app, cabinet, { agentVersion, uptimeSeconds: 100, readOnlyMode: false });
const watchedOf = async (client: string): Promise<string[] | null> => {
  const w = (await db.app.query<{ w: string | null }>("SELECT watched_services AS w FROM clients WHERE id = $1", [client])).rows[0]!.w;
  return w === null ? null : JSON.parse(w) as string[];
};
const scannerEvent = (state: "disconnected" | "recovered"): Event => ({ eventId: randomUUID(), kind: "scanner", occurredAt: new Date().toISOString(),
  severityHint: state === "recovered" ? "minor" : "major", detail: { message: `The fingerprint scanner is ${state}.` }, device: { hardwareIds: ["USB\\VID_1234&PID_5678"], state } } as Event);
async function refused(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof Refused && e.code === code, code);
}

test.before(async () => {
  db = await createTestDatabase();
  for (const u of [admin, tier2])
    await db.app.query(`INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, $2, 'Test', $3, 'x')`, [u.userId, `u.${u.userId.slice(0, 8)}`, u.role]);
});
test.after(async () => { await db.drop(); });

test("an existing client starts on, and an agent that knows the setting is told only when it is off", async () => {
  const p = await place();
  assert.deepEqual(await clientScanner(db.app, p.client), { enabled: true, service: null, approval: null });
  assert.equal((await beat(p.cabinet)).scannerUsed, true);
  assert.equal(knowsScannerWatch("0.3.1"), true);
  assert.equal(knowsScannerWatch("0.3.1-beta.2"), true);
  assert.equal(knowsScannerWatch("0.3.0"), false, "the answer's contract is closed: an older agent would refuse the field");
  assert.equal(knowsScannerWatch("not a version"), false);
});

test("switching on with signing: the service waits for the signature, is watched once signed, and the list in force never loses an entry", async () => {
  const p = await place();
  const key = makeKey();
  // The client already approves a kiosk program; the scanner's service is added beside it, not instead of it.
  const kioskToken = await issueStepUpToken(db.app, admin.userId, "client.apps", p.client, paramsHash({ level: "client", id: p.client, entries: [KIOSK] }));
  await setApprovedApps(db.app, admin, "client", p.client, [KIOSK], kioskToken);
  const r = await choose(p.client, { enabled: true, service: SERVICE, hardwareIds: ["USB\\VID_1234&PID_5678"] }, key.keys);
  assert.equal(r.approval, "waiting");
  assert.deepEqual(await clientScanner(db.app, p.client), { enabled: true, service: "BioScanSvc", approval: "waiting" });
  assert.deepEqual(await watchedOf(p.client), ["BioScanSvc"]);
  const state = await readLevelState(db.app, "client", p.client);
  assert.deepEqual(state.list?.entries.map(e => e.key), ["app:kiosk"], "the list in force is untouched until the signature");
  assert.deepEqual(state.pending?.entries.map(e => e.key), ["app:bioscan", "app:kiosk"]);
  // The heartbeat: IDs as set, but the service is not kept running yet, because it is not approved in force.
  const before = await beat(p.cabinet);
  assert.deepEqual(before.scannerIds, ["USB\\VID_1234&PID_5678"]);
  assert.deepEqual(before.watched, []);
  // The Admin signs the change offline; the service is approved and watched from the next heartbeat.
  const toSign = (await listToSign(db.app, "client", p.client))!;
  await signApprovedApps(db.app, admin, "client", p.client, toSign.version, signWith(key, toSign.document), key.keys);
  assert.equal((await clientScanner(db.app, p.client))!.approval, "approved");
  assert.deepEqual((await beat(p.cabinet)).watched, ["BioScanSvc"]);
  // Switching on again changes nothing that is already there.
  assert.equal((await choose(p.client, { enabled: true, service: SERVICE }, key.keys)).approval, "approved");
  assert.deepEqual(await watchedOf(p.client), ["BioScanSvc"]);
});

test("switching on without signing writes the list in force; a fleet list that approves the service needs no client list", async () => {
  const a = await place();
  assert.equal((await choose(a.client, { enabled: true, service: SERVICE })).approval, "written");
  assert.deepEqual((await readLevelState(db.app, "client", a.client)).list?.entries.map(e => e.key), ["app:bioscan"]);

  const b = await place();
  const fleetToken = await issueStepUpToken(db.app, admin.userId, "settings.apps", "fleet", paramsHash({ level: "fleet", id: null, entries: [SERVICE] }));
  await setApprovedApps(db.app, admin, "fleet", null, [SERVICE], fleetToken);
  assert.equal((await choose(b.client, { enabled: true, service: SERVICE })).approval, "approved");
  assert.equal((await readLevelState(db.app, "client", b.client)).list, null, "the client still inherits the fleet's list");
  await setApprovedApps(db.app, admin, "fleet", null, null, await issueStepUpToken(db.app, admin.userId, "settings.apps", "fleet", paramsHash({ level: "fleet", id: null, entries: null })));
});

test("switching off: no IDs, no alerts, open scanner alerts resolved and audited, the service off the watched list", async () => {
  const p = await place();
  await choose(p.client, { enabled: true, service: SERVICE, hardwareIds: ["USB\\VID_1234&PID_5678"] });
  await db.app.query("UPDATE clients SET watched_services = $2 WHERE id = $1", [p.client, JSON.stringify(["BioScanSvc", "Spooler"])]);
  await storeEvents(db.app, p.cabinet, { events: [scannerEvent("disconnected")] });
  const open = async () => Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved'", [p.cabinet, ISSUE.scanner])).rows[0]!.n);
  assert.equal(await open(), 1, "while on, a disconnected scanner opens an alert");

  const r = await choose(p.client, { enabled: false });
  assert.equal(r.resolvedAlerts, 1);
  assert.equal(await open(), 0);
  assert.deepEqual(await watchedOf(p.client), ["Spooler"], "only the scanner's service comes off");
  const hb = await beat(p.cabinet);
  assert.deepEqual([hb.scannerUsed, hb.scannerIds], [false, null]);
  // An agent from before the setting keeps reporting: its scanner events are stored and open nothing.
  await storeEvents(db.app, p.cabinet, { events: [scannerEvent("disconnected")] });
  assert.equal(await open(), 0);
  const audited = (await db.app.query<{ action: string }>(
    "SELECT action FROM audit_log WHERE (target_id = $1 AND action = 'client.fingerprint_scanner') OR (action = 'alert.resolve' AND details LIKE '%fingerprint scanner%') ORDER BY seq", [p.client])).rows.map(x => x.action);
  assert.deepEqual(audited, ["client.fingerprint_scanner", "alert.resolve", "client.fingerprint_scanner"]);
});

test("only an Admin, with a code bound to the exact choice; hostile services and full lists are refused and change nothing", async () => {
  const p = await place();
  await refused(choose(p.client, { enabled: false }, undefined, tier2), "forbidden");
  // A code confirmed for "off" does not switch it on.
  const offToken = await issueStepUpToken(db.app, admin.userId, "client.fingerprint_scanner", p.client, paramsHash({ scanner: { enabled: false } }));
  await refused(setClientScanner(db.app, admin, p.client, { enabled: true, service: SERVICE }, offToken), "step_up_required");
  // The approved-list rules run on the service even when the contract was skipped.
  for (const service of [{ ...SERVICE, path: "C:\\Windows\\System32\\cmd.exe" + " /c whoami" }, { ...SERVICE, path: "..\\..\\evil.exe" }, { ...SERVICE, path: "C:\\Tools\\run.bat" },
    { ...SERVICE, serviceName: "Bio'; DROP TABLE clients;--" }, { ...KIOSK }])
    await refused(choose(p.client, { enabled: true, service }), "invalid_params");
  await db.app.query("UPDATE clients SET watched_services = $2 WHERE id = $1", [p.client, JSON.stringify(Array.from({ length: 16 }, (_, i) => `Svc${i}`))]);
  await refused(choose(p.client, { enabled: true, service: SERVICE }), "too_many_items");
  assert.deepEqual(await clientScanner(db.app, p.client), { enabled: true, service: null, approval: null }, "nothing was written");
  assert.equal((await readLevelState(db.app, "client", p.client)).list, null);
});

test("a new client chooses at its first approval; an existing client's setting is not changed by an approval", async () => {
  const key = await developmentIssuingKey(tempDir());
  const pending = async () => submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: (await createBootstrapToken(db.app, admin.userId)).token,
    fingerprints: { hostname: "CAB-" + randomBytes(2).toString("hex"), serialNumber: null, macAddresses: [], provisionedClient: null, provisionedSite: null,
      onlineSince: "2026-10-27T08:00:00Z", osVersion: "Windows 11", agentVersion: "0.3.1" } }, "127.0.0.1");
  const name = `New ${randomUUID().slice(0, 6)}`;
  await approveEnrollment(db.app, key, await pending(), { clientName: name, siteName: "North", cabinetName: "A", role: "standalone", scanner: { enabled: false } }, admin.userId);
  const id = (await db.app.query<{ id: string }>("SELECT id FROM clients WHERE name = $1", [name])).rows[0]!.id;
  assert.equal((await clientScanner(db.app, id))!.enabled, false);
  const request = await pending();
  await refused(approveEnrollment(db.app, key, request, { clientName: name, siteName: "North", cabinetName: "B", role: "standalone", scanner: { enabled: true, service: SERVICE } }, admin.userId),
    "scanner_for_existing_client");
  assert.equal((await clientScanner(db.app, id))!.enabled, false, "the refused approval changed nothing");
  assert.equal((await db.app.query<{ status: string }>("SELECT status FROM enrollment_requests WHERE id = $1", [request])).rows[0]!.status, "pending");

  const on = `On ${randomUUID().slice(0, 6)}`;
  await approveEnrollment(db.app, key, await pending(), { clientName: on, siteName: "North", cabinetName: "A", role: "standalone", scanner: { enabled: true, service: SERVICE } }, admin.userId);
  const onId = (await db.app.query<{ id: string }>("SELECT id FROM clients WHERE name = $1", [on])).rows[0]!.id;
  assert.deepEqual(await clientScanner(db.app, onId), { enabled: true, service: "BioScanSvc", approval: "approved" });
});

test("disconnected-scanner events open alerts only for clients that use a scanner", async () => {
  const p = await place();
  await upsertAlert(db.app, { cabinetId: p.cabinet, issueTypeId: ISSUE.scanner, severity: "major", signature: `issue:${ISSUE.scanner}`, title: "Scanner", seenAt: new Date(), ruleId: null, eventId: null } as never);
  await choose(p.client, { enabled: false });
  const r = await storeEvents(db.app, p.cabinet, { events: [scannerEvent("disconnected"), scannerEvent("recovered")] });
  assert.deepEqual(r.outcomes.map(o => o.kind), ["stored", "stored"]);
});
