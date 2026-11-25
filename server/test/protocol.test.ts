// Protocol 1.1 on the agent API (docs/spec/03-protocol.md "Protocol 1.1"): leased delivery and acknowledgements, presence from the
// long poll, server-directed pacing, HTTP/2 with the same mutual-TLS checks as HTTP/1.1, remembered certificates and revocation,
// TLS session resumption, admission control and load shedding, graceful shutdown, gzip event batches, and the expiring-certificate alert.
import test from "node:test";
import assert from "node:assert/strict";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as http2Connect, type ClientHttp2Session } from "node:http2";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { CommandNotifier } from "../src/agent-api/notifier.js";
import { buildAgentApi, parseAcks, SourceBuckets, sourceKey, TokenBucket, type AgentApiOptions } from "../src/agent-api/server.js";
import { Presence } from "../src/agent-api/presence.js";
import { developmentIssuingKey, developmentServerCertificate } from "../src/pki/issuing.js";
import type { IssuingKey } from "../src/pki/x509.js";
import { commandRecord, expireCommands, issueCommand } from "../src/services/commands.js";
import { approveEnrollment, createBootstrapToken } from "../src/services/enrollment.js";
import { checkExpiringCertificates, listCabinets, revokeCabinet } from "../src/services/cabinets.js";
import { anyRolloutRunning } from "../src/services/rollouts.js";
import { upsertSetting } from "../src/services/settings.js";
import { APPS_SET_ACTION, listToSign, setApprovedApps, signApprovedApps } from "../src/services/approved-apps.js";
import { ListSigningKeys } from "../src/services/approved-list-signing.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import { paramsHash } from "../src/auth/canonical.js";
import { createPool, isBusy, limited, QueryTimeout, transaction } from "../src/db/db.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { HeavyQuery } from "../src/console-api/heavy.js";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir, type TestKey } from "./helpers.js";

let db: TestDatabase;
let key: IssuingKey;
let api: FastifyInstance;
let notifier: CommandNotifier;
let feed: NotificationFeed;
let presence: Presence;
let tls: { certPem: string; keyPem: string };
let port: number;
let admin: string;

interface Identity { key: TestKey; certPem: string; }
interface Reply { status: number; body: any; headers: Record<string, string | string[] | undefined>; reused?: boolean }

function call(method: string, path: string, body?: unknown, identity?: Identity,
  o: { port?: number; agent?: HttpsAgent | false; headers?: Record<string, string>; data?: Buffer } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = o.data ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
    const req = httpsRequest({ host: "127.0.0.1", port: o.port ?? port, path, method, servername: "localhost", ca: key.certificatePem,
      ...(o.agent !== undefined ? { agent: o.agent } : {}),
      ...(identity ? { key: identity.key.keyPem, cert: identity.certPem } : {}),
      headers: { ...(data === undefined ? {} : { "content-type": "application/json", "content-length": String(data.length) }), ...o.headers } }, res => {
      const reused = (res.socket as unknown as { isSessionReused?: () => boolean }).isSessionReused?.();
      let text = "";
      res.on("data", d => (text += d));
      res.on("end", () => { let parsed: unknown = text; try { parsed = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode!, body: parsed, headers: res.headers, ...(reused === undefined ? {} : { reused }) }); });
    });
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

/** One request on an HTTP/2 session. */
function call2(session: ClientHttp2Session, method: string, path: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const stream = session.request({ ":method": method, ":path": path, ...(data ? { "content-type": "application/json", "content-length": String(data.length) } : {}) });
    let status = 0, headers: Record<string, string | string[] | undefined> = {}, text = "";
    stream.on("response", h => { status = Number(h[":status"]); headers = h as typeof headers; });
    stream.on("data", d => (text += d));
    stream.on("end", () => { let parsed: unknown = text; try { parsed = JSON.parse(text); } catch { /* not JSON */ } resolve({ status, body: parsed, headers }); });
    stream.on("error", reject);
    if (data) stream.end(data); else stream.end();
  });
}

function h2(identity?: Identity, p = port): Promise<ClientHttp2Session> {
  return new Promise((resolve, reject) => {
    const s = http2Connect(`https://localhost:${p}`, { ca: key.certificatePem, servername: "localhost", ...(identity ? { key: identity.key.keyPem, cert: identity.certPem } : {}) });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

const fingerprints = (hostname = "CAB-P11-01") => ({
  hostname, serialNumber: "5CG1234XYZ", macAddresses: ["00-11-22-33-44-55"], provisionedClient: null, provisionedSite: null,
  onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 10 IoT Enterprise LTSC 21H2", agentVersion: "0.2.0",
});

async function enrolledCabinet(name = "Cabinet " + randomUUID().slice(0, 8)): Promise<Identity & { cabinetId: string }> {
  const agentKey = ecKey();
  const { token } = await createBootstrapToken(db.app, admin);
  const enrolled = await call("POST", "/agent/v1/enroll", { csr: csrFor(agentKey), bootstrapToken: token, fingerprints: fingerprints() });
  assert.equal(enrolled.status, 202, JSON.stringify(enrolled.body));
  const { cabinetId } = await approveEnrollment(db.app, key, enrolled.body.requestId, { clientName: "Protocol Client", siteName: "Main", cabinetName: name, role: "standalone" }, admin);
  const status = await call("GET", `/agent/v1/enroll/${enrolled.body.requestId}`);
  return { key: agentKey, certPem: status.body.certificate, cabinetId };
}

const heartbeat = { agentVersion: "0.2.0", uptimeSeconds: 100, readOnlyMode: false };
const output = { hostname: "CAB-P11-01", osVersion: "Windows 10", osBuild: "19044.1", uptimeSeconds: 5, agentVersion: "0.2.0", readOnlyMode: false, cabinetRole: "standalone", serialNumber: null };
const resultFor = (commandId: string) => ({ commandId, status: "succeeded", startedAt: "2026-10-06T12:00:00Z", finishedAt: "2026-10-06T12:00:01Z", output });

/** Another agent API on the same database, for options that change how it answers. */
async function otherApi(o: Partial<AgentApiOptions>): Promise<{ app: FastifyInstance; port: number }> {
  const app = await buildAgentApi({ pool: db.app, issuingKey: key, notifier, tls, longPollMs: 1500, enrollPerHour: 1000, logger: false, presence, ...o });
  await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, port: (app.server.address() as { port: number }).port };
}

test.before(async () => {
  db = await createTestDatabase();
  const dir = tempDir();
  key = await developmentIssuingKey(dir);
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  notifier = new CommandNotifier(feed);
  await notifier.start();
  presence = new Presence(db.app);
  tls = await developmentServerCertificate(key, dir, ["localhost"]);
  api = await buildAgentApi({ pool: db.app, issuingKey: key, notifier, tls, longPollMs: 1500, leaseSeconds: 1, enrollPerHour: 1000, logger: false, presence });
  await api.listen({ host: "127.0.0.1", port: 0 });
  port = (api.server.address() as { port: number }).port;
  admin = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'admin.p11', 'Admin P11', 'admin')", [admin]);
});
test.after(async () => { await api.close(); await notifier.stop(); feed.stop(); await db.drop(); });

// ---- Leased delivery ---------------------------------------------------------------------------------------------------------

test("a poll whose answer was lost gets the command again on the next poll; an acknowledged one does not come back", async () => {
  const cab = await enrolledCabinet();
  const command = await issueCommand(db.app, admin, cab.cabinetId, "system.info", {});
  const first = await call("GET", "/agent/v1/commands", undefined, cab);
  assert.equal(first.body.commands[0].commandId, command.commandId);
  assert.equal(first.body.pollSeconds, 15, "the answer says how long polls are held (the contract's minimum here)");
  // That answer "went into a dead connection": no acknowledgement. The next poll waits out the lease (1 s here) and gets it again.
  const started = Date.now();
  const again = await call("GET", "/agent/v1/commands", undefined, cab);
  assert.deepEqual(again.body.commands.map((c: { commandId: string }) => c.commandId), [command.commandId], "offered again after the lease");
  assert.ok(Date.now() - started < 1500, "at the end of the lease, not of the poll");
  assert.equal((await commandRecord(db.app, command.commandId))?.status, "delivered", "the console shows it running");
  // This time the agent acknowledges it: it never comes back, even after the lease.
  const acked = await call("GET", `/agent/v1/commands?ack=${command.commandId}`, undefined, cab);
  assert.deepEqual(acked.body.commands, []);
  assert.deepEqual((await call("GET", "/agent/v1/commands", undefined, cab)).body.commands, []);
  const row = (await db.app.query<{ ack_at: Date | null; status: string }>("SELECT ack_at, status FROM commands WHERE id = $1", [command.commandId])).rows[0]!;
  assert.ok(row.ack_at);
  assert.equal(row.status, "delivered");
  assert.equal((await call("POST", "/agent/v1/results", resultFor(command.commandId), cab)).status, 200);
  assert.equal((await commandRecord(db.app, command.commandId))?.status, "succeeded");
});

test("a result counts as the acknowledgement: an answered command is never offered again", async () => {
  const cab = await enrolledCabinet();
  const command = await issueCommand(db.app, admin, cab.cabinetId, "system.info", {});
  assert.equal((await call("GET", "/agent/v1/commands", undefined, cab)).body.commands.length, 1);
  assert.equal((await call("POST", "/agent/v1/results", resultFor(command.commandId), cab)).status, 200);
  await new Promise(r => setTimeout(r, 1100));
  assert.deepEqual((await call("GET", "/agent/v1/commands", undefined, cab)).body.commands, []);
});

test("an expired command is not offered again, and a repeat refused as replayed is not taken for the outcome", async () => {
  const cab = await enrolledCabinet();
  const command = await issueCommand(db.app, admin, cab.cabinetId, "system.info", {});
  assert.equal((await call("GET", "/agent/v1/commands", undefined, cab)).body.commands.length, 1);
  // An older agent without a stored result answers the repeat with "replayed": that is an acknowledgement, not the result.
  const now = new Date().toISOString();
  const replayed = { commandId: command.commandId, status: "rejected", startedAt: now, finishedAt: now, error: { code: "replayed", message: "seen" } };
  assert.equal((await call("POST", "/agent/v1/results", replayed, cab)).status, 200);
  assert.equal((await commandRecord(db.app, command.commandId))?.status, "delivered");
  assert.equal((await call("POST", "/agent/v1/results", resultFor(command.commandId), cab)).status, 200, "the real result still counts");
  assert.equal((await commandRecord(db.app, command.commandId))?.status, "succeeded");

  const late = await issueCommand(db.app, admin, cab.cabinetId, "system.info", {});
  assert.equal((await call("GET", "/agent/v1/commands", undefined, cab)).body.commands.length, 1);
  await asOwner(db, c => c.query("UPDATE commands SET expires_at = DATEADD(second, -1, SYSUTCDATETIME()), issued_at = DATEADD(minute, -6, SYSUTCDATETIME()) WHERE id = $1", [late.commandId]));
  assert.deepEqual((await call("GET", "/agent/v1/commands", undefined, cab)).body.commands, [], "past its expiry it is never offered again");
  // Never confirmed, its lease over and its lifetime gone: it is shown as expired, not as running for the next 35 minutes.
  await new Promise(r => setTimeout(r, 1100));
  await call("GET", "/agent/v1/commands", undefined, cab);
  await expireCommands(db.app);
  assert.equal((await commandRecord(db.app, late.commandId))?.status, "expired");
  assert.deepEqual((await db.app.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'command.expire' AND target_id = $1",
    [late.commandId.toLowerCase()])).rows.map(r => r.details.why), ["unconfirmed"]);
  // A result that still arrives (the cabinet did get it) is kept.
  assert.equal((await call("POST", "/agent/v1/results", resultFor(late.commandId), cab)).status, 200);
  assert.equal((await commandRecord(db.app, late.commandId))?.status, "succeeded");
});

test("acknowledgements count only for the cabinet's own commands", async () => {
  const a = await enrolledCabinet(), b = await enrolledCabinet();
  const command = await issueCommand(db.app, admin, a.cabinetId, "system.info", {});
  assert.equal((await call("GET", "/agent/v1/commands", undefined, a)).body.commands.length, 1);
  assert.deepEqual((await call("GET", `/agent/v1/commands?ack=${command.commandId}`, undefined, b)).body.commands, []);
  assert.equal((await db.app.query("SELECT ack_at FROM commands WHERE id = $1", [command.commandId])).rows[0].ack_at, null, "b cannot acknowledge a's command");
  assert.equal((await call("GET", "/agent/v1/commands", undefined, a)).body.commands[0]?.commandId, command.commandId, "so a gets it again");
});

test("malformed and hostile acknowledgement lists are refused before the database is touched", async () => {
  const cab = await enrolledCabinet();
  const id = randomUUID();
  const bad = ["ack=", "ack=not-a-guid", `ack=${id},`, `ack=${id};DROP TABLE commands`, `ack=${id}'--`, `ack=${Array.from({ length: 51 }, () => randomUUID()).join(",")}`,
    `ack=${id}&ack=${randomUUID()}`, `ack=${id}&x=1`, "x=1", `ack[]=${id}`, `ack=${"a".repeat(5000)}`, `ack=%00${id}`];
  for (const q of bad) assert.equal((await call("GET", `/agent/v1/commands?${encodeURI(q)}`, undefined, cab)).status, 400, q.slice(0, 60));
  assert.equal((await call("GET", `/agent/v1/commands?ack=${Array.from({ length: 50 }, () => randomUUID()).join(",")}`, undefined, cab)).status, 200, "50 is the limit");
  assert.equal((await call("GET", `/agent/v1/commands?ack=${id.toUpperCase()}`, undefined, cab)).status, 200, "GUIDs in either case");
  assert.throws(() => parseAcks({ ack: [id] }));
  assert.deepEqual(parseAcks({ ack: `${id},${id}` }), [id], "duplicates folded");
});

// ---- Presence and pacing -------------------------------------------------------------------------------------------------------------

test("a poll counts as contact: written in one batch, never moved backwards, and the cabinet shows online", async () => {
  const cab = await enrolledCabinet();
  assert.equal((await listCabinets(db.app)).find(c => c.id === cab.cabinetId)?.online, false, "never heard from");
  await call("GET", "/agent/v1/commands", undefined, cab);
  assert.ok(await presence.flush() >= 1);
  assert.equal((await listCabinets(db.app)).find(c => c.id === cab.cabinetId)?.online, true);
  // A heartbeat newer than the noted contact is never moved back by a later flush.
  presence.touch(cab.cabinetId);
  const noted = Date.now();
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await call("POST", "/agent/v1/heartbeat", heartbeat, cab)).status, 200);
  await presence.flush();
  const at = (await db.app.query<{ last_heartbeat_at: Date }>("SELECT last_heartbeat_at FROM cabinets WHERE id = $1", [cab.cabinetId])).rows[0]!.last_heartbeat_at;
  assert.ok(at.getTime() > noted);
  // A removed cabinet is never brought back by a contact.
  await revokeCabinet(db.app, cab.cabinetId, admin);
  presence.touch(cab.cabinetId);
  await asOwner(db, c => c.query("UPDATE cabinets SET last_heartbeat_at = NULL WHERE id = $1", [cab.cabinetId]));
  await presence.flush();
  assert.equal((await db.app.query("SELECT last_heartbeat_at FROM cabinets WHERE id = $1", [cab.cabinetId])).rows[0].last_heartbeat_at, null);
});

test("a cabinet that only polls is online, and a cabinet silent past 5 minutes is offline", async () => {
  const cab = await enrolledCabinet();
  assert.equal((await call("POST", "/agent/v1/heartbeat", heartbeat, cab)).status, 200);
  await asOwner(db, c => c.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(minute, -6, SYSUTCDATETIME()) WHERE id = $1", [cab.cabinetId]));
  assert.equal((await listCabinets(db.app)).find(c => c.id === cab.cabinetId)?.online, false);
  await call("GET", "/agent/v1/commands", undefined, cab);
  await presence.flush();
  assert.equal((await listCabinets(db.app)).find(c => c.id === cab.cabinetId)?.online, true);
});

test("the heartbeat answer carries the pacing, the scanner and the watched services, read in the same round trip", async () => {
  const cab = await enrolledCabinet();
  const hb = await call("POST", "/agent/v1/heartbeat", { ...heartbeat, health: { cpuPercent: 3, memoryUsedPercent: 4, diskFreePercent: 5 } }, cab);
  assert.equal(hb.status, 200);
  assert.deepEqual(hb.body.intervals, { heartbeatSeconds: 300, pollSeconds: 15, eventsPaceMs: 2000 });
  assert.equal(hb.body.scanner.hardwareIds, null);
  assert.deepEqual(hb.body.watchedServices, { names: [] });
  assert.equal((await db.app.query("SELECT COUNT(*) AS n FROM health_samples WHERE cabinet_id = $1", [cab.cabinetId])).rows[0].n, 1, "the load sample is stored with it");
  // Only a watched service the approved list names is sent: Spooler is approved for this cabinet, TermService is not.
  const spooler = [{ key: "app:spooler", kind: "service", name: "Spooler", serviceName: "Spooler", path: "C:\\Windows\\System32\\spoolsv.exe" }];
  await setApprovedApps(db.app, { userId: admin, role: "admin" }, "cabinet", cab.cabinetId, spooler,
    await issueStepUpToken(db.app, admin, APPS_SET_ACTION.cabinet, cab.cabinetId, paramsHash({ level: "cabinet", id: cab.cabinetId, entries: spooler })));
  await transaction(db.app, async c => { await upsertSetting(c, "services.watched", ["Spooler", "TermService"], admin); await upsertSetting(c, "agents.heartbeatSeconds", 120, admin);
    await upsertSetting(c, "agents.eventsPaceMs", 99_999_999, admin); });
  await db.app.query("UPDATE cabinets SET scanner_hardware_ids = $2 WHERE id = $1", [cab.cabinetId, JSON.stringify(["USB\\VID_1234", "USB\\VID_1234"])]);
  // A fresh API, so the pacing cache is read again.
  const other = await otherApi({});
  try {
    const next = await call("POST", "/agent/v1/heartbeat", heartbeat, cab, { port: other.port });
    assert.deepEqual(next.body.intervals, { heartbeatSeconds: 120, pollSeconds: 15, eventsPaceMs: 60_000 }, "an out-of-range setting is clamped to the allowed range");
    assert.deepEqual(next.body.scanner.hardwareIds, ["USB\\VID_1234"]);
    assert.deepEqual(next.body.watchedServices.names, ["Spooler"]);
  } finally { await other.app.close(); }
});

test("the signed approved list is sent only to an agent that knows the field; an older agent gets the answer it always got", async () => {
  const cab = await enrolledCabinet();
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  const keyId = createHash("sha256").update(der).digest("hex");
  const folder = mkdtempSync(join(tmpdir(), "list-trust-"));
  writeFileSync(join(folder, "approved-list-keys.json"), JSON.stringify({ version: 1, keys: [{ keyId, name: "Test", publicKey: der.toString("base64") }] }));
  const keys = ListSigningKeys.fromFolder(folder);
  const kiosk = [{ key: "app:kiosk", kind: "application", name: "Kiosk", path: "C:\\Program Files\\Vendor\\kiosk.exe" }];
  await setApprovedApps(db.app, { userId: admin, role: "admin" }, "cabinet", cab.cabinetId, kiosk,
    await issueStepUpToken(db.app, admin, APPS_SET_ACTION.cabinet, cab.cabinetId, paramsHash({ level: "cabinet", id: cab.cabinetId, entries: kiosk })), undefined, keys);
  const doc = (await listToSign(db.app, "cabinet", cab.cabinetId))!;
  await signApprovedApps(db.app, { userId: admin, role: "admin" }, "cabinet", cab.cabinetId, doc.version,
    { keyId, algorithm: "ecdsa-p256-sha256", signature: sign("sha256", Buffer.from(doc.document, "base64"), { key: pair.privateKey, dsaEncoding: "der" }).toString("base64") }, keys);

  const older = await call("POST", "/agent/v1/heartbeat", { ...heartbeat, agentVersion: "0.2.0" }, cab);
  assert.equal(older.status, 200);
  assert.deepEqual(Object.keys(older.body.approvedApps), ["entries"], "an agent before 0.3.0 would refuse an answer with a field it does not know");
  assert.deepEqual(older.body.approvedApps.entries.map((e: { key: string }) => e.key), ["app:kiosk"]);
  const newer = await call("POST", "/agent/v1/heartbeat", { ...heartbeat, agentVersion: "0.3.0" }, cab);
  assert.equal(newer.body.approvedApps.signed.document, doc.document);
  assert.equal(newer.body.approvedApps.signed.signature.keyId, keyId);
});

test("a client without a scanner: an agent that knows the setting is told to stop looking, an older one gets the answer it always got", async () => {
  const cab = await enrolledCabinet();
  const clientId = (await db.app.query<{ id: string }>("SELECT s.client_id AS id FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1", [cab.cabinetId])).rows[0]!.id;
  const on = await call("POST", "/agent/v1/heartbeat", { ...heartbeat, agentVersion: "0.3.1" }, cab);
  assert.deepEqual(Object.keys(on.body.scanner), ["hardwareIds"], "a client that uses a scanner: nothing new in the answer");
  await db.app.query("UPDATE clients SET fingerprint_scanner = 0 WHERE id = $1", [clientId]);
  const older = await call("POST", "/agent/v1/heartbeat", { ...heartbeat, agentVersion: "0.3.0" }, cab);
  assert.equal(older.status, 200);
  assert.deepEqual(older.body.scanner, { hardwareIds: null }, "an agent before 0.3.1 would refuse an answer with a field it does not know");
  const newer = await call("POST", "/agent/v1/heartbeat", { ...heartbeat, agentVersion: "0.3.1" }, cab);
  assert.deepEqual(newer.body.scanner, { hardwareIds: null, watch: false });
  await db.app.query("UPDATE clients SET fingerprint_scanner = 1 WHERE id = $1", [clientId]);
});

// ---- Connections: HTTP/2, mutual TLS, remembered certificates, resumption ----------------------------------------------------------

test("HTTP/2 clients get the same answers and the same certificate checks as HTTP/1.1", async () => {
  const cab = await enrolledCabinet();
  const session = await h2(cab);
  try {
    assert.equal(session.alpnProtocol, "h2");
    const hb = await call2(session, "POST", "/agent/v1/heartbeat", heartbeat);
    assert.equal(hb.status, 200, JSON.stringify(hb.body));
    const command = await issueCommand(db.app, admin, cab.cabinetId, "system.info", {});
    // Several requests at once on the one connection.
    const [poll, hb2] = await Promise.all([call2(session, "GET", "/agent/v1/commands"), call2(session, "POST", "/agent/v1/heartbeat", heartbeat)]);
    assert.equal(poll.body.commands[0].commandId, command.commandId);
    assert.equal(hb2.status, 200);
    assert.equal((await call2(session, "POST", "/agent/v1/results", resultFor(command.commandId))).status, 200);
  } finally { session.close(); }
  // No certificate, over HTTP/2: refused on every route.
  const anonymous = await h2();
  try {
    for (const [m, p, b] of [["GET", "/agent/v1/commands"], ["POST", "/agent/v1/heartbeat", heartbeat], ["POST", "/agent/v1/events", { events: [] }]] as const)
      assert.equal((await call2(anonymous, m, p, b)).status, 401, `${m} ${p}`);
    assert.equal((await call2(anonymous, "GET", "/health")).status, 200);
  } finally { anonymous.close(); }
  // A certificate from another CA naming a real cabinet, over HTTP/2.
  const forgedKey = ecKey();
  const { issueAgentCertificate } = await import("../src/pki/issuing.js");
  const forged = await issueAgentCertificate(await developmentIssuingKey(tempDir()), csrFor(forgedKey), cab.cabinetId);
  const impostor = await h2({ key: forgedKey, certPem: forged.pem });
  try { assert.equal((await call2(impostor, "POST", "/agent/v1/heartbeat", heartbeat)).status, 401); } finally { impostor.close(); }
});

test("a remembered certificate is dropped at once when the cabinet is revoked, on HTTP/1.1 and HTTP/2 connections that stay open", async () => {
  const cab = await enrolledCabinet();
  const agent = new HttpsAgent({ keepAlive: true, maxSockets: 1 });
  const session = await h2(cab);
  try {
    for (let i = 0; i < 2; i++) {
      assert.equal((await call("POST", "/agent/v1/heartbeat", heartbeat, cab, { agent })).status, 200);
      assert.equal((await call2(session, "POST", "/agent/v1/heartbeat", heartbeat)).status, 200);
    }
    await revokeCabinet(db.app, cab.cabinetId, admin);
    assert.equal((await call("POST", "/agent/v1/heartbeat", heartbeat, cab, { agent })).status, 401);
    assert.equal((await call2(session, "POST", "/agent/v1/heartbeat", heartbeat)).status, 401);
  } finally { agent.destroy(); session.close(); }
});

test("a reconnecting agent resumes its TLS session, and its certificate is still checked", async () => {
  const cab = await enrolledCabinet();
  // A fresh connection each time (no keep-alive), with the agent's TLS session cache.
  const agent = new HttpsAgent({ keepAlive: false, maxCachedSessions: 10 });
  try {
    const first = await call("POST", "/agent/v1/heartbeat", heartbeat, cab, { agent });
    assert.equal(first.status, 200);
    await new Promise(r => setTimeout(r, 50));
    const second = await call("POST", "/agent/v1/heartbeat", heartbeat, cab, { agent });
    assert.equal(second.status, 200);
    assert.equal(second.reused, true, "the second connection resumed the session");
    await revokeCabinet(db.app, cab.cabinetId, admin);
    const third = await call("POST", "/agent/v1/heartbeat", heartbeat, cab, { agent });
    assert.equal(third.status, 401, "a resumed session is still checked against the cabinet record");
  } finally { agent.destroy(); }
});

// ---- Admission control, load shedding, shutdown ----------------------------------------------------------------------------------

test("under load, requests are shed before the database with a randomised Retry-After; a long poll is told when to come back", async () => {
  const other = await otherApi({ admission: { overloaded: () => true } });
  try {
    const cab = await enrolledCabinet();
    const hb = await call("POST", "/agent/v1/heartbeat", heartbeat, cab, { port: other.port });
    assert.equal(hb.status, 503);
    const retry = Number(hb.headers["retry-after"]);
    assert.ok(retry >= 30 && retry <= 90, String(retry));
    const poll = await call("GET", "/agent/v1/commands", undefined, cab, { port: other.port });
    assert.equal(poll.status, 200);
    assert.deepEqual(poll.body.commands, []);
    assert.ok(poll.body.reconnectAfterMs >= 10_000 && poll.body.reconnectAfterMs <= 30_000, "a poll comes back sooner than other requests, so commands still arrive");
    assert.equal((await call("GET", "/health", undefined, undefined, { port: other.port })).status, 200, "health is never shed");
  } finally { await other.app.close(); }
});

test("new connections beyond the admission rate get 503 with Retry-After; admitted connections carry on", async () => {
  const other = await otherApi({ admission: { newConnectionsPerSecond: 0.001, newConnectionsBurst: 1 } });
  const cab = await enrolledCabinet();
  const kept = new HttpsAgent({ keepAlive: true, maxSockets: 1 });
  try {
    assert.equal((await call("POST", "/agent/v1/heartbeat", heartbeat, cab, { port: other.port, agent: kept })).status, 200);
    const refused = await call("POST", "/agent/v1/heartbeat", heartbeat, cab, { port: other.port, agent: false });
    assert.equal(refused.status, 503);
    const wait = Number(refused.headers["retry-after"]);
    assert.ok(wait >= 3 && wait <= 15, `a refusal for the connection rate alone is cheap and short: ${wait}`);
    assert.equal(refused.headers.connection, "close");
    assert.equal((await call("POST", "/agent/v1/heartbeat", heartbeat, cab, { port: other.port, agent: kept })).status, 200, "the admitted connection is unaffected");
  } finally { kept.destroy(); await other.app.close(); }
  const limited = await otherApi({ admission: { requestsPerSecond: 0.001, requestsBurst: 2 } });
  try {
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await call("POST", "/agent/v1/heartbeat", heartbeat, cab, { port: limited.port })).status);
    assert.deepEqual(statuses, [200, 200, 503]);
    const overloadedApi = await otherApi({ admission: { overloaded: () => true } });
    try {
      const over = await call("POST", "/agent/v1/heartbeat", heartbeat, cab, { port: overloadedApi.port });
      assert.equal(over.status, 503);
      assert.ok(Number(over.headers["retry-after"]) >= 30, "database or event-loop overload keeps 30-90 s");
    } finally { await overloadedApi.app.close(); }
  } finally { await limited.app.close(); }
  // The bucket on its own. At a refill of 1,000 tokens a second, one millisecond between two takes put a token back, so on a loaded
  // machine the third take passed: the rate under test here is one token in about 17 minutes, so the 5 ms wait cannot refill it.
  const bucket = new TokenBucket(0.001, 2);
  const firstTwo = [bucket.take(), bucket.take()];
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual([...firstTwo, bucket.take()], [true, true, false], "a burst of two, then refused");
  // And it does refill: a fast bucket that was emptied has a token again after the same 5 ms.
  const fast = new TokenBucket(1000, 1);
  assert.deepEqual([fast.take(), fast.take()], [true, false]);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(fast.take(), true, "refilled at its rate");
});

test("a flood of requests without a client certificate does not shed enrolled cabinets, and is limited per source", async () => {
  // The shared buckets are tiny here: before this change, certificate-less requests drew on them and turned the fleet away.
  const other = await otherApi({ admission: { newConnectionsPerSecond: 0.001, newConnectionsBurst: 3, requestsPerSecond: 0.001, requestsBurst: 6,
    unauthenticatedPerSecond: 0.001, unauthenticatedBurst: 10, enrollStatusPerMinute: 0.001 } });
  const cab = await enrolledCabinet();
  try {
    const flood: number[] = [];
    for (let i = 0; i < 40; i++) {
      const target = i % 4 === 0 ? "/agent/v1/heartbeat" : i % 4 === 1 ? `/agent/v1/enroll/${randomUUID()}` : i % 4 === 2 ? "/health" : "/agent/v1/commands";
      flood.push((await call(i % 4 === 0 ? "POST" : "GET", target, i % 4 === 0 ? heartbeat : undefined, undefined, { port: other.port, agent: false })).status);
    }
    assert.ok(flood.filter(s => s === 429).length >= 25, `the source is limited on its own: ${flood.join(",")}`);
    // The enrolled cabinet, on new connections, is still admitted: none of the flood was charged to the fleet's buckets.
    for (let i = 0; i < 3; i++) {
      const beat = await call("POST", "/agent/v1/heartbeat", heartbeat, cab, { port: other.port, agent: false });
      assert.equal(beat.status, 200, `heartbeat ${i}: ${beat.status} ${JSON.stringify(beat.body)}`);
    }
    // A refused answer to the flood names a wait and closes the connection.
    const refused = await call("GET", "/health", undefined, undefined, { port: other.port, agent: false });
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers["retry-after"]) >= 3);
  } finally { await other.app.close(); }
});

test("a revoked certificate on new connections is counted as unauthenticated, not against the fleet", async () => {
  // Tiny shared buckets: three new connections and six requests. A revoked certificate still passes the TLS handshake.
  const other = await otherApi({ admission: { newConnectionsPerSecond: 0.001, newConnectionsBurst: 3, requestsPerSecond: 0.001, requestsBurst: 6 } });
  const revoked = await enrolledCabinet();
  const cab = await enrolledCabinet();
  try {
    await revokeCabinet(db.app, revoked.cabinetId, admin);
    const first = await call("POST", "/agent/v1/heartbeat", heartbeat, revoked, { port: other.port, agent: false });
    assert.equal(first.status, 401, "refused once, on its first connection (charged as a cabinet: it could not be told apart yet)");
    for (let i = 0; i < 10; i++) {
      const again = await call("POST", "/agent/v1/heartbeat", heartbeat, revoked, { port: other.port, agent: false });
      assert.ok([401, 429].includes(again.status), `request ${i}: ${again.status}`);
    }
    // Ten more new connections from the revoked certificate took nothing from the fleet: the enrolled cabinet still gets in.
    for (let i = 0; i < 2; i++) {
      const beat = await call("POST", "/agent/v1/heartbeat", heartbeat, cab, { port: other.port, agent: false });
      assert.equal(beat.status, 200, `heartbeat ${i}: ${beat.status} ${JSON.stringify(beat.body)}`);
    }
  } finally { await other.app.close(); }
});

test("a revoked certificate cannot spend the fleet's buckets through health, enrollment or unknown routes either", async () => {
  const other = await otherApi({ admission: { newConnectionsPerSecond: 0.001, newConnectionsBurst: 3, requestsPerSecond: 0.001, requestsBurst: 6 } });
  const revoked = await enrolledCabinet();
  const cab = await enrolledCabinet();
  try {
    await revokeCabinet(db.app, revoked.cabinetId, admin);
    // Never refused on a cabinet route, so its serial is not remembered: only the route decides which buckets it uses.
    for (const [method, path] of [["GET", "/health"], ["GET", "/health?x=1"], ["GET", `/agent/v1/enroll/${randomUUID()}`], ["GET", "/agent/v1/nowhere"], ["GET", "/nowhere"]] as const)
      for (let i = 0; i < 3; i++) await call(method, path, undefined, revoked, { port: other.port, agent: false });
    for (let i = 0; i < 2; i++) {
      const beat = await call("POST", "/agent/v1/heartbeat", heartbeat, cab, { port: other.port, agent: false });
      assert.equal(beat.status, 200, `heartbeat ${i}: ${beat.status} ${JSON.stringify(beat.body)}`);
    }
  } finally { await other.app.close(); }
});

test("certificate-less requests that reach the database have a small total of their own", async () => {
  const other = await otherApi({ admission: { unauthenticatedDatabasePerSecond: 0.001, unauthenticatedDatabaseBurst: 3 } });
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call("GET", `/agent/v1/enroll/${randomUUID()}`, undefined, undefined, { port: other.port, agent: false })).status);
    assert.deepEqual(statuses, [404, 404, 404, 429, 429, 429]);
    // Health touches no database and is not counted against it.
    assert.equal((await call("GET", "/health", undefined, undefined, { port: other.port, agent: false })).status, 200);
  } finally { await other.app.close(); }
});

test("open connections are capped per source before TLS, and a closed one frees its place", async () => {
  const other = await otherApi({ admission: { maxConnectionsPerSource: 2 } });
  const { connect } = await import("node:net");
  const open = (): Promise<import("node:net").Socket> => new Promise((resolve, reject) => {
    const s = connect(other.port, "127.0.0.1", () => resolve(s)); s.once("error", reject);
  });
  const closed = (s: import("node:net").Socket, ms = 2000): Promise<boolean> => new Promise(resolve => {
    const t = setTimeout(() => resolve(false), ms); s.once("close", () => { clearTimeout(t); resolve(true); });
  });
  try {
    const a = await open(), b = await open();
    const c = await open().catch(() => null);
    assert.equal(c === null || await closed(c), true, "the third connection from one source is closed at once");
    assert.equal(await closed(a, 300), false, "the first two stay open");
    a.destroy();
    await new Promise(r => setTimeout(r, 100));
    const d = await open();
    assert.equal(await closed(d, 300), false, "a freed place can be used again");
    b.destroy(); d.destroy();
  } finally { await other.app.close(); }
});

test("a refused certificate-less request over HTTP/2 closes the session rather than sending a Connection header", async () => {
  const other = await otherApi({ admission: { unauthenticatedPerSecond: 0.001, unauthenticatedBurst: 1 } });
  const session = http2Connect(`https://localhost:${other.port}`, { ca: key.certificatePem, servername: "localhost" });
  try {
    const sessionClosed = new Promise<void>(r => { session.once("goaway", () => r()); session.once("close", () => r()); });
    assert.equal((await call2(session, "GET", "/health")).status, 200);
    const refused = await call2(session, "GET", "/health");
    assert.equal(refused.status, 429);
    assert.equal(refused.headers["connection"], undefined);
    await Promise.race([sessionClosed, new Promise((_, reject) => setTimeout(() => reject(new Error("the server did not end the session")), 3000))]);
  } finally { session.destroy(); await other.app.close(); }
});

test("per-source limits count an IPv4 address or an IPv6 /64, and stay bounded", () => {
  assert.equal(sourceKey("203.0.113.9"), "203.0.113.9");
  assert.equal(sourceKey("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(sourceKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(sourceKey("2001:0db8:0001:0002::1"), "2001:db8:1:2::/64");
  assert.equal(sourceKey("2001:DB8:1:2::ffff"), sourceKey("2001:db8:1:2:ffff::1"), "one /64, whatever the interface id");
  assert.notEqual(sourceKey("2001:db8:1:2::1"), sourceKey("2001:db8:1:3::1"));
  assert.equal(sourceKey("::1"), "0:0:0:0::/64");
  assert.equal(sourceKey("fe80::1%eth0"), "fe80:0:0:0::/64");
  for (const hostile of ["", "not an address", "1:2:3", "zzzz::1", "x".repeat(500)]) assert.equal(typeof sourceKey(hostile), "string");

  const buckets = new SourceBuckets(1, 2, 3);
  const t = 1_000_000;
  assert.deepEqual([buckets.take("a", t), buckets.take("a", t), buckets.take("a", t)], [true, true, false]);
  assert.equal(buckets.take("b", t), true);
  assert.equal(buckets.take("c", t), true);
  assert.equal(buckets.size, 3);
  // Past the cap, new sources share one overflow bucket, larger than one source's, instead of growing the map (and without a prune).
  assert.deepEqual([buckets.take("d", t), buckets.take("e", t), buckets.take("f", t)], [true, true, true]);
  assert.equal(buckets.size, 4, "the three sources and the overflow bucket");
  let overflowTaken = 0;
  while (buckets.take(`new-${overflowTaken}`, t) && overflowTaken < 1_000) overflowTaken++;
  assert.equal(overflowTaken + 3, 2 * SourceBuckets.OVERFLOW_FACTOR, "the overflow bucket holds OVERFLOW_FACTOR sources' worth, then refuses");
  // Once the buckets have refilled, the timer's prune forgets the sources.
  buckets.prune(t + 1_000_000);
  assert.ok(buckets.size <= 1, `pruned: ${buckets.size}`);
  assert.equal(buckets.take("a", t + 10_000), true);
});

test("shutdown ends every held poll with a spread-out reconnectAfterMs, then closes HTTP/1.1 and HTTP/2 connections", async () => {
  const other = await otherApi({ longPollMs: 20_000 });
  const a = await enrolledCabinet(), b = await enrolledCabinet();
  const agent = new HttpsAgent({ keepAlive: true });
  const session = await h2(b, other.port);
  const polls = [call("GET", "/agent/v1/commands", undefined, a, { port: other.port, agent }), call2(session, "GET", "/agent/v1/commands")];
  await new Promise(r => setTimeout(r, 300));
  const started = Date.now();
  await other.app.close();
  assert.ok(Date.now() - started < 4_000, `closed in ${Date.now() - started} ms`);
  for (const p of await Promise.all(polls)) {
    assert.equal(p.status, 200);
    assert.deepEqual(p.body.commands, []);
    assert.ok(p.body.reconnectAfterMs >= 0 && p.body.reconnectAfterMs <= 60_000, String(p.body.reconnectAfterMs));
  }
  agent.destroy();
  session.destroy();
});

// ---- Events: gzip, the 1 MB limit after decompression -------------------------------------------------------------------------------

test("gzip event batches are accepted; past 1 MB after decompression they get 413; other encodings 415", async () => {
  const cab = await enrolledCabinet();
  let rec = 9100;
  const ev = () => ({ eventId: randomUUID(), kind: "error", occurredAt: "2026-10-06T12:00:00Z", severityHint: "minor", source: { log: "System", source: "Weird", eventId: 9, level: "error", recordId: rec++ }, detail: { message: "x" } });
  const batch = { events: [ev(), ev()] };
  const gz = (v: unknown) => gzipSync(Buffer.from(typeof v === "string" ? v : JSON.stringify(v)));
  const ok = await call("POST", "/agent/v1/events", undefined, cab, { data: gz(batch), headers: { "content-encoding": "gzip" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await db.app.query("SELECT COUNT(*) AS n FROM events WHERE event_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))", [batch.events.map(e => e.eventId)])).rows[0].n, 2);
  // A bomb: 50 MB of spaces in a few kilobytes. Stopped at 1 MB, never inflated in full.
  const bomb = gzipSync(Buffer.concat([Buffer.from('{"events":['), Buffer.alloc(50 * 1024 * 1024, 0x20), Buffer.from("]}")]));
  assert.ok(bomb.length < 100_000);
  const big = await call("POST", "/agent/v1/events", undefined, cab, { data: bomb, headers: { "content-encoding": "gzip" } });
  assert.equal(big.status, 413);
  assert.deepEqual(big.body, { error: "too_large" });
  assert.equal((await call("POST", "/agent/v1/events", undefined, cab, { data: Buffer.from("not gzip at all"), headers: { "content-encoding": "gzip" } })).status, 400);
  assert.equal((await call("POST", "/agent/v1/events", undefined, cab, { data: gz("{not json"), headers: { "content-encoding": "gzip" } })).status, 400);
  assert.equal((await call("POST", "/agent/v1/events", undefined, cab, { data: gz({ events: [{ ...ev(), kind: "run_this" }] }), headers: { "content-encoding": "gzip" } })).status, 400);
  assert.equal((await call("POST", "/agent/v1/events", undefined, cab, { data: Buffer.from(JSON.stringify(batch)), headers: { "content-encoding": "br" } })).status, 415);
  assert.equal((await call("POST", "/agent/v1/heartbeat", undefined, cab, { data: gz(heartbeat), headers: { "content-encoding": "gzip" } })).status, 415, "only event batches may be compressed");
  // An unknown caller's compressed body is never decompressed: the certificate is checked first.
  assert.equal((await call("POST", "/agent/v1/events", undefined, undefined, { data: bomb, headers: { "content-encoding": "gzip" } })).status, 401);
  // Uncompressed, the 1 MB limit still holds.
  assert.equal((await call("POST", "/agent/v1/events", undefined, cab, { data: Buffer.from(JSON.stringify({ events: [], pad: "x".repeat(1_100_000) })) })).status, 413);
});

// ---- Fail fast -------------------------------------------------------------------------------------------------------------------

test("the database layer fails fast: no free connection within the acquire limit, or a statement past its limit, counts as busy", async () => {
  const small = await createPool(db.appUrl, { max: 1, min: 1, acquireTimeoutMs: 300 });
  try {
    let release!: () => void;
    const holding = transaction(small, () => new Promise<void>(r => { release = r; }));
    await new Promise(r => setTimeout(r, 100));
    const started = Date.now();
    const e = await small.query("SELECT 1 AS x").then(() => null, (err: unknown) => err);
    assert.ok(e && isBusy(e), `busy: ${String(e)}`);
    assert.ok(Date.now() - started < 2_000);
    release();
    await holding;
    const slow = await small.query("WAITFOR DELAY '00:00:03'; SELECT 1 AS x", [], { timeoutMs: 300 }).then(() => null, (err: unknown) => err);
    assert.ok(slow instanceof QueryTimeout && isBusy(slow));
    assert.equal(isBusy(new Error("x")), false);
  } finally { await small.end(); }
});

test("a rollout lookup that fails answers false, so a database error never offers upgrades or opens transactions", async () => {
  const failing = { query: () => Promise.reject(new Error("database away")) } as never;
  assert.equal(await anyRolloutRunning(failing), false);
});

test("heavy console queries run one at a time per person and are stopped at their limit", async () => {
  const heavy = new HeavyQuery("test query", 300);
  let release!: () => void;
  const first = heavy.run("u1", db.app, () => new Promise<number>(r => { release = () => r(1); }));
  await assert.rejects(heavy.run("u1", db.app, async () => 2), (e: { status?: number }) => e.status === 429);
  assert.equal(await heavy.run("u2", db.app, async () => 3), 3, "another person is not held up");
  release();
  assert.equal(await first, 1);
  await assert.rejects(heavy.run("u1", db.app, d => d.query("WAITFOR DELAY '00:00:03'; SELECT 1 AS x")), (e: { status?: number; code?: string }) => e.status === 503 && e.code === "query_too_slow");
  // The limit covers the whole operation, not each statement.
  const l = limited(db.app, 200);
  await new Promise(r => setTimeout(r, 250));
  await assert.rejects(l.query("SELECT 1 AS x"), QueryTimeout);
});

// ---- Certificates near expiry ---------------------------------------------------------------------------------------------------

test("an active cabinet whose certificate expires within 7 days and was not renewed raises one security alert", async () => {
  const soon = await enrolledCabinet(), renewed = await enrolledCabinet(), fine = await enrolledCabinet();
  await asOwner(db, c => c.query("UPDATE cabinet_certificates SET not_after = DATEADD(day, 3, SYSUTCDATETIME()) WHERE cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))",
    [[soon.cabinetId, renewed.cabinetId]]));
  // The renewed one has a newer certificate as well.
  await asOwner(db, c => c.query("INSERT INTO cabinet_certificates (serial, cabinet_id, not_after) VALUES ($1, $2, DATEADD(day, 90, SYSUTCDATETIME()))",
    [randomUUID().replaceAll("-", "").toUpperCase(), renewed.cabinetId]));
  const raised = await checkExpiringCertificates(db.app);
  assert.ok(raised >= 1);
  const alerts = (await db.app.query<{ cabinet_id: string; kind: string; detail: { reason: string } }>(
    "SELECT cabinet_id, kind, detail FROM security_alerts WHERE signature LIKE 'certificate_expiring|%' AND state = 'open'")).rows;
  assert.ok(alerts.some(a => a.cabinet_id === soon.cabinetId && a.kind === "certificate" && a.detail.reason === "expiring"));
  assert.ok(!alerts.some(a => a.cabinet_id === renewed.cabinetId || a.cabinet_id === fine.cabinetId));
  assert.equal(await checkExpiringCertificates(db.app), 0, "one alert while it is open, not one a run");
});
