import test from "node:test";
import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";
import { randomUUID, X509Certificate } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { CommandNotifier } from "../src/agent-api/notifier.js";
import { buildAgentApi } from "../src/agent-api/server.js";
import { developmentIssuingKey, developmentServerCertificate } from "../src/pki/issuing.js";
import type { IssuingKey } from "../src/pki/x509.js";
import { issueCommand, commandRecord, expireUnanswered } from "../src/services/commands.js";
import { approveEnrollment, createBootstrapToken } from "../src/services/enrollment.js";
import { listCabinets, revokeCabinet } from "../src/services/cabinets.js";
import { verifyAuditChain } from "../src/db/db.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { opsMeter } from "../src/services/ops-meter.js";
import { configHash } from "../src/services/config-canonical.js";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir, type TestKey } from "./helpers.js";

let db: TestDatabase;
let key: IssuingKey;
let api: FastifyInstance;
let notifier: CommandNotifier;
let feed: NotificationFeed;
let port: number;
let admin: string;
let foreignKey: IssuingKey;

interface Identity { key: TestKey; certPem: string; }
interface Reply { status: number; body: any; }

function call(method: string, path: string, body?: unknown, identity?: Identity, raw?: { data: string | Buffer; type?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = raw ? raw.data : body === undefined ? undefined : JSON.stringify(body);
    const req = httpsRequest({ host: "127.0.0.1", port, path, method, servername: "localhost", ca: key.certificatePem,
      ...(identity ? { key: identity.key.keyPem, cert: identity.certPem } : {}),
      headers: data === undefined ? {} : { "content-type": raw?.type ?? "application/json", "content-length": Buffer.byteLength(data) } }, res => {
      let text = "";
      res.on("data", d => (text += d));
      res.on("end", () => { let parsed: unknown = text; try { parsed = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode!, body: parsed }); });
    });
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

const fingerprints = (hostname = "CAB-TEST-01") => ({
  hostname, serialNumber: "5CG1234XYZ", macAddresses: ["00-11-22-33-44-55"], provisionedClient: null, provisionedSite: null,
  onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 10 IoT Enterprise LTSC 21H2", agentVersion: "0.2.0",
});

/** Enrolls and approves one cabinet, returning its identity. */
async function enrolledCabinet(name = "Cabinet " + randomUUID().slice(0, 8)): Promise<Identity & { cabinetId: string }> {
  const agentKey = ecKey();
  const { token } = await createBootstrapToken(db.app, admin);
  const enrolled = await call("POST", "/agent/v1/enroll", { csr: csrFor(agentKey), bootstrapToken: token, fingerprints: fingerprints() });
  assert.equal(enrolled.status, 202, JSON.stringify(enrolled.body));
  const { cabinetId } = await approveEnrollment(db.app, key, enrolled.body.requestId, { clientName: "Test Client", siteName: "Main", cabinetName: name, role: "standalone" }, admin);
  const status = await call("GET", `/agent/v1/enroll/${enrolled.body.requestId}`);
  return { key: agentKey, certPem: status.body.certificate, cabinetId };
}

const heartbeat = { agentVersion: "0.2.0", uptimeSeconds: 100, readOnlyMode: false };

test.before(async () => {
  db = await createTestDatabase();
  const dir = tempDir();
  key = await developmentIssuingKey(dir);
  foreignKey = await developmentIssuingKey(tempDir());
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  notifier = new CommandNotifier(feed);
  await notifier.start();
  api = await buildAgentApi({ pool: db.app, issuingKey: key, notifier, tls: await developmentServerCertificate(key, dir, ["localhost"]), longPollMs: 1500, enrollPerHour: 1000, logger: false });
  await api.listen({ host: "127.0.0.1", port: 0 });
  port = (api.server.address() as { port: number }).port;
  admin = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'admin.test', 'Admin Test', 'admin')", [admin]);
});
test.after(async () => { await api.close(); await notifier.stop(); feed.stop(); await db.drop(); });

test("health answers without a certificate", async () => {
  assert.deepEqual((await call("GET", "/health")).body, { status: "ok" });
});

test("a machine without a certificate is refused on every agent route", async () => {
  for (const [method, path, body] of [["GET", "/agent/v1/commands"], ["POST", "/agent/v1/heartbeat", heartbeat], ["POST", "/agent/v1/results", {}],
    ["POST", "/agent/v1/events", { events: [] }], ["POST", "/agent/v1/config", { snapshots: [] }], ["POST", "/agent/v1/renew", { csr: "x" }]] as const) {
    const r = await call(method, path, body);
    assert.equal(r.status, 401, `${method} ${path}`);
    assert.deepEqual(r.body, { error: "certificate_refused" });
  }
});

test("a certificate from another CA, even for a real cabinet ID, is refused", async () => {
  const real = await enrolledCabinet();
  const forgedKey = ecKey();
  const { issueAgentCertificate } = await import("../src/pki/issuing.js");
  const forged = await issueAgentCertificate(foreignKey, csrFor(forgedKey), real.cabinetId);
  assert.equal((await call("POST", "/agent/v1/heartbeat", heartbeat, { key: forgedKey, certPem: forged.pem })).status, 401);
});

test("enrollment: a cabinet enrolls, is approved, picks up its certificate and stays online", async () => {
  const agentKey = ecKey();
  const { token } = await createBootstrapToken(db.app, admin);
  const enrolled = await call("POST", "/agent/v1/enroll", { csr: csrFor(agentKey), bootstrapToken: token, fingerprints: fingerprints("CAB-ENROLL") });
  assert.equal(enrolled.status, 202);
  assert.equal(enrolled.body.status, "pending");
  assert.equal((await call("GET", `/agent/v1/enroll/${enrolled.body.requestId}`)).body.status, "pending");

  const { cabinetId } = await approveEnrollment(db.app, key, enrolled.body.requestId, { clientName: "Acme Health", siteName: "North", cabinetName: "ICU 1", role: "sync" }, admin);
  const issued = await call("GET", `/agent/v1/enroll/${enrolled.body.requestId}`);
  assert.equal(issued.body.status, "issued");
  assert.equal(issued.body.cabinetId, cabinetId);
  assert.equal(issued.body.caChain, key.certificatePem);
  assert.ok(new X509Certificate(issued.body.certificate).subject.includes(cabinetId));

  const me = { key: agentKey, certPem: issued.body.certificate };
  const hb = await call("POST", "/agent/v1/heartbeat", { ...heartbeat, clockSkewSeconds: 1.5 }, me);
  assert.equal(hb.status, 200);
  assert.match(hb.body.serverTime, /Z$/);
  const cabinet = (await listCabinets(db.app)).find(c => c.id === cabinetId)!;
  assert.equal(cabinet.online, true);
  assert.equal(cabinet.role, "sync");
  assert.equal((await verifyAuditChain(db.app)).ok, true);
});

test("a bootstrap token works once, and bad tokens all get the same answer", async () => {
  const { token } = await createBootstrapToken(db.app, admin);
  const body = (t: string) => ({ csr: csrFor(ecKey()), bootstrapToken: t, fingerprints: fingerprints() });
  assert.equal((await call("POST", "/agent/v1/enroll", body(token))).status, 202);
  const reused = await call("POST", "/agent/v1/enroll", body(token));
  const unknown = await call("POST", "/agent/v1/enroll", body("A".repeat(43)));
  assert.deepEqual([reused.status, reused.body], [403, { error: "enrollment_refused" }]);
  assert.deepEqual([unknown.status, unknown.body], [403, { error: "enrollment_refused" }]);
  const expired = await createBootstrapToken(db.app, admin, -1);
  assert.equal((await call("POST", "/agent/v1/enroll", body(expired.token))).status, 403);
});

test("malformed, hostile and oversized enrollment bodies are refused before anything reads them", async () => {
  const { token } = await createBootstrapToken(db.app, admin);
  const good = { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: fingerprints() };
  const cases: [unknown, number][] = [
    [{ ...good, extra: "<script>" }, 400],
    [{ ...good, fingerprints: { ...good.fingerprints, hostname: "evil;rm -rf" } }, 400],
    [{ ...good, csr: "-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----\n" }, 400],
    [{ ...good, bootstrapToken: "short" }, 400],
    // Without a valid token the certificate request is never verified: the answer is the token refusal.
    [{ ...good, bootstrapToken: "A".repeat(43), csr: "-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----\n" }, 403],
    [[], 400],
    [{ __proto__: { polluted: true }, ...good, constructor: { prototype: { x: 1 } } }, 400],
  ];
  for (const [body, status] of cases) assert.equal((await call("POST", "/agent/v1/enroll", body)).status, status, JSON.stringify(body).slice(0, 80));
  assert.equal((await call("POST", "/agent/v1/enroll", undefined, undefined, { data: "not json" })).status, 400);
  assert.equal((await call("POST", "/agent/v1/enroll", undefined, undefined, { data: "a=b", type: "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await call("POST", "/agent/v1/enroll", undefined, undefined, { data: JSON.stringify({ pad: "x".repeat(1_100_000) }) })).status, 413);
  // The token was never consumed by the failures above.
  assert.equal((await call("POST", "/agent/v1/enroll", good)).status, 202);
  assert.equal((await call("GET", "/agent/v1/enroll/not-a-uuid")).status, 404);
  assert.equal((await call("GET", `/agent/v1/enroll/${randomUUID()}`)).status, 404);
});

test("enrollment is rate-limited per address", async () => {
  const limited = await buildAgentApi({ pool: db.app, issuingKey: key, notifier, tls: await developmentServerCertificate(key, tempDir(), ["localhost"]), enrollPerHour: 2, logger: false });
  await limited.listen({ host: "127.0.0.1", port: 0 });
  const saved = port;
  port = (limited.server.address() as { port: number }).port;
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await call("POST", "/agent/v1/enroll", { nope: 1 })).status);
    assert.deepEqual(statuses, [400, 400, 429, 429]);
  } finally { port = saved; await limited.close(); }
});

test("the long poll hands over a command as soon as it is issued, and the result is stored", async () => {
  const cab = await enrolledCabinet();
  const poll = call("GET", "/agent/v1/commands", undefined, cab);
  await new Promise(r => setTimeout(r, 200));
  const started = Date.now();
  const command = await issueCommand(db.app, admin, cab.cabinetId, "system.info", {});
  const got = await poll;
  assert.equal(got.status, 200);
  assert.ok(Date.now() - started < 1400, "woken by the notification, not the timeout");
  assert.equal(got.body.commands.length, 1);
  assert.equal(got.body.commands[0].commandId, command.commandId);
  assert.equal((await call("GET", "/agent/v1/commands", undefined, cab)).body.commands.length, 0, "delivered only once");

  const output = { hostname: "CAB-TEST-01", osVersion: "Windows 10", osBuild: "19044.1", uptimeSeconds: 5, agentVersion: "0.2.0", readOnlyMode: false, cabinetRole: "standalone", serialNumber: null };
  const result = { commandId: command.commandId, status: "succeeded", startedAt: "2026-10-06T12:00:00Z", finishedAt: "2026-10-06T12:00:01Z", output };
  assert.equal((await call("POST", "/agent/v1/results", { ...result, output: { ...output, hostname: 7 } }, cab)).status, 400, "output is checked against the operation");
  assert.equal((await call("POST", "/agent/v1/results", result, cab)).status, 200);
  assert.equal((await commandRecord(db.app, command.commandId))!.status, "succeeded");
  assert.equal((await call("POST", "/agent/v1/results", result, cab)).status, 409, "one result per command");
});

test("a cabinet cannot see or answer another cabinet's commands", async () => {
  const a = await enrolledCabinet();
  const b = await enrolledCabinet();
  const command = await issueCommand(db.app, admin, a.cabinetId, "devices.list", { problemsOnly: true });
  assert.equal((await call("GET", "/agent/v1/commands", undefined, b)).body.commands.length, 0);
  const result = { commandId: command.commandId, status: "failed", startedAt: "2026-10-06T12:00:00Z", finishedAt: "2026-10-06T12:00:01Z", error: { code: "timeout", message: "x" } };
  assert.equal((await call("POST", "/agent/v1/results", result, b)).status, 404);
});

test("the long poll returns empty after its time limit, and expired commands are never delivered", async () => {
  const cab = await enrolledCabinet();
  const started = Date.now();
  const r = await call("GET", "/agent/v1/commands", undefined, cab);
  assert.deepEqual(r.body.commands, []);
  assert.ok(Date.now() - started >= 1400);
  const command = await issueCommand(db.app, admin, cab.cabinetId, "system.info", {});
  await asOwner(db, c => c.query("UPDATE commands SET issued_at = DATEADD(minute, -10, SYSUTCDATETIME()), expires_at = DATEADD(minute, -5, SYSUTCDATETIME()) WHERE id = $1", [command.commandId]));
  assert.deepEqual((await call("GET", "/agent/v1/commands", undefined, cab)).body.commands, []);
  assert.equal((await commandRecord(db.app, command.commandId))!.status, "expired");
});

test("issuing refuses unknown operations, bad parameters, and writes without a step-up token", async () => {
  const cab = await enrolledCabinet();
  await assert.rejects(issueCommand(db.app, admin, cab.cabinetId, "shell.run", {}), /not a catalog operation/);
  await assert.rejects(issueCommand(db.app, admin, cab.cabinetId, "eventlog.query", { log: "Security" }), /schema/);
  await assert.rejects(issueCommand(db.app, admin, cab.cabinetId, "network.setDns", { interfaceIndex: 1, mode: "automatic" }, "command.issue", {}), /authenticator code/);
  await assert.rejects(issueCommand(db.app, admin, cab.cabinetId, "firewall.setProfile", { profile: "public", enabled: true, defaultInbound: "block", defaultOutbound: "allow" }),
    /needs its authority/, "a write never goes out without a person's confirmation path");
  await assert.rejects(issueCommand(db.app, admin, randomUUID(), "system.info", {}), /no such active cabinet/);
});

test("a revoked cabinet is refused on its next connection", async () => {
  const cab = await enrolledCabinet();
  assert.equal((await call("POST", "/agent/v1/heartbeat", heartbeat, cab)).status, 200);
  await revokeCabinet(db.app, cab.cabinetId, admin);
  assert.equal((await call("POST", "/agent/v1/heartbeat", heartbeat, cab)).status, 401);
  const refusals = await db.app.query("SELECT 1 FROM audit_log WHERE action = 'agent.connection_refused'");
  assert.ok(refusals.rowCount! >= 1, "a refused certificate is audited");
  // ...and raises a security alert for the Admins, naming the cabinet.
  const alert = (await db.app.query<{ cabinet_id: string; detail: { reason: string } }>(
    "SELECT cabinet_id, detail FROM security_alerts WHERE kind = 'certificate' AND signature = 'certificate|revoked'")).rows[0];
  assert.equal(alert?.cabinet_id, cab.cabinetId);
  assert.equal(alert?.detail.reason, "revoked");
});

test("a certificate this platform never issued is refused and raises one security alert, however often it is tried", async () => {
  const otherDir = tempDir();
  const stranger = await developmentServerCertificate(await developmentIssuingKey(otherDir), otherDir, ["cab-stranger"]);
  const identity = { key: { keyPem: stranger.keyPem }, certPem: stranger.certPem } as unknown as Identity;
  for (let i = 0; i < 3; i++) assert.equal((await call("POST", "/agent/v1/heartbeat", heartbeat, identity)).status, 401);
  const alerts = (await db.app.query<{ occurrences: number; detail: { reason: string } }>(
    "SELECT occurrences, detail FROM security_alerts WHERE kind = 'certificate' AND signature = 'certificate|unknown' AND state = 'open'")).rows;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.occurrences, 1, "the same certificate again within the hour is not another occurrence");
  // A caller with no certificate at all (a scanner, a browser) is refused and only logged.
  assert.equal((await call("POST", "/agent/v1/heartbeat", heartbeat)).status, 401);
  assert.equal((await db.app.query("SELECT COUNT(*) AS n FROM security_alerts WHERE kind = 'certificate'")).rows[0]!.n, 2);
});

test("events are stored once even when the agent retries", async () => {
  const cab = await enrolledCabinet();
  const event = { eventId: randomUUID(), kind: "smart_warning", occurredAt: "2026-10-06T12:00:00Z", severityHint: "major",
    detail: { message: "Drive 0 reports 12 reallocated sectors.", fields: { reallocatedSectors: "12" } } };
  for (let i = 0; i < 2; i++) assert.equal((await call("POST", "/agent/v1/events", { events: [event] }, cab)).status, 200);
  assert.equal((await db.app.query("SELECT 1 FROM events WHERE event_id = $1", [event.eventId])).rowCount, 1);
  assert.equal((await call("POST", "/agent/v1/events", { events: [{ ...event, kind: "run_this" }] }, cab)).status, 400);
});

test("each cabinet has an hourly event quota: over it, a batch is refused with 429 and nothing of it is stored; other cabinets are unaffected", async () => {
  const limited = await buildAgentApi({ pool: db.app, issuingKey: key, notifier, tls: await developmentServerCertificate(key, tempDir(), ["localhost"]), eventsPerHour: 3, logger: false });
  await limited.listen({ host: "127.0.0.1", port: 0 });
  const saved = port;
  port = (limited.server.address() as { port: number }).port;
  try {
    const noisy = await enrolledCabinet(), quiet = await enrolledCabinet();
    const ev = () => ({ eventId: randomUUID(), kind: "smart_warning", occurredAt: "2026-10-06T12:00:00Z", severityHint: "minor", detail: { message: "x" } });
    assert.equal((await call("POST", "/agent/v1/events", { events: [ev(), ev()] }, noisy)).status, 200);
    const over = [ev(), ev()];
    assert.equal((await call("POST", "/agent/v1/events", { events: over }, noisy)).status, 429);
    assert.equal((await db.app.query("SELECT COUNT(*) AS n FROM events WHERE event_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))", [over.map(e => e.eventId)])).rows[0]!.n, 0);
    assert.equal((await call("POST", "/agent/v1/events", { events: [ev()] }, noisy)).status, 200, "what is left of the quota is still usable");
    assert.equal((await call("POST", "/agent/v1/events", { events: [ev(), ev(), ev()] }, quiet)).status, 200);
  } finally { port = saved; await limited.close(); }
});

const configItems = [{ key: "service:BioScanSvc", values: { startType: "automatic", state: "running" } }, { key: "service:Spooler", values: { startType: "automatic", state: "running" } }];
/** A snapshot with the hash the agent would compute (items the agent could never make get a made-up hash). */
const snapshotOf = (category: string, items: unknown[], observedAt = "2026-10-06T12:00:00Z", extra: Record<string, unknown> = {}) => {
  let hash = "0".repeat(64);
  try { hash = configHash(items as never); } catch { /* not a configuration */ }
  return { observedAt, category, hash, truncated: false, items, ...extra };
};

test("configuration snapshots: the server recomputes every hash, stores only what changed, and refuses anything malformed or hostile before storing it", async () => {
  const cab = await enrolledCabinet();
  const send = (snapshots: unknown[]) => call("POST", "/agent/v1/config", { snapshots }, cab);
  const versions = async () => Number((await db.app.query("SELECT COUNT(*) AS n FROM config_versions WHERE cabinet_id = $1", [cab.cabinetId])).rows[0]!.n);
  assert.equal((await send([snapshotOf("services", configItems)])).status, 200);
  assert.equal((await send([snapshotOf("services", configItems, "2026-10-06T12:10:00Z")])).status, 200);
  assert.equal(await versions(), 1, "an unchanged category stores no new version");
  const changed = [configItems[0]!, { key: "service:Spooler", values: { startType: "disabled", state: "stopped" } }];
  assert.equal((await send([snapshotOf("services", changed, "2026-10-06T12:20:00Z")])).status, 200);
  assert.equal(await versions(), 2);
  assert.equal(Number((await db.app.query("SELECT COUNT(*) AS n FROM config_changes WHERE cabinet_id = $1", [cab.cabinetId])).rows[0]!.n), 1);
  // Hostile shapes: wrong hash, unknown category, a key from another category, a duplicate key, extra fields, nested values, too many snapshots, a control character.
  const before = await versions();
  const hostile: [string, unknown[]][] = [
    ["a hash that is not the items'", [{ ...snapshotOf("services", changed, "2026-10-06T12:30:00Z"), hash: "0".repeat(64) }]],
    ["a short hash", [{ ...snapshotOf("services", changed), hash: "abc" }]],
    ["an unknown category", [snapshotOf("registry", changed)]],
    ["a key of another category", [snapshotOf("services", [{ key: "rule:Allow", values: { enabled: true } }])]],
    ["a repeated key", [snapshotOf("services", [configItems[0], configItems[0]])]],
    ["an extra field", [{ ...snapshotOf("services", changed), script: "x" }]],
    ["a nested value", [snapshotOf("services", [{ key: "service:A", values: { a: { run: "cmd" } } }])]],
    ["a fraction", [snapshotOf("services", [{ key: "service:A", values: { a: 1.5 } }])]],
    ["a control character", [snapshotOf("services", [{ key: "service:A", values: { a: "x\u0007" } }])]],
    ["nine snapshots", Array.from({ length: 9 }, () => snapshotOf("time", [{ key: "time", values: { timeZoneId: "UTC" } }]))],
    ["none", []],
  ];
  for (const [why, snapshots] of hostile) assert.equal((await send(snapshots)).status, 400, why);
  assert.equal((await call("POST", "/agent/v1/config", { snapshots: [snapshotOf("time", [{ key: "time", values: { timeZoneId: "UTC" } }])], extra: 1 }, cab)).status, 400);
  assert.equal(await versions(), before, "nothing malformed was stored");
  // A batch with one bad snapshot stores none of it.
  const mixed = await send([snapshotOf("time", [{ key: "time", values: { timeZoneId: "UTC" } }], "2026-10-06T12:40:00Z"), { ...snapshotOf("services", changed), hash: "1".repeat(64) }]);
  assert.equal(mixed.status, 400);
  assert.equal(await versions(), before);
  // A cabinet can only write its own configuration: the cabinet ID is its certificate's, never a field of the request.
  const other = await enrolledCabinet();
  assert.equal(Number((await db.app.query("SELECT COUNT(*) AS n FROM config_current WHERE cabinet_id = $1", [other.cabinetId])).rows[0]!.n), 0);
  // The route takes nothing but JSON, and is audited by the system as the agent's own.
  assert.equal((await call("POST", "/agent/v1/config", undefined, cab, { data: "snapshots=1", type: "application/x-www-form-urlencoded" })).status, 415);
});

test("each cabinet has an hourly quota of configuration snapshots: over it, an upload is refused with 429 and nothing of it is stored", async () => {
  const limited = await buildAgentApi({ pool: db.app, issuingKey: key, notifier, tls: await developmentServerCertificate(key, tempDir(), ["localhost"]), configPerHour: 3, logger: false });
  await limited.listen({ host: "127.0.0.1", port: 0 });
  const saved = port;
  port = (limited.server.address() as { port: number }).port;
  try {
    const noisy = await enrolledCabinet(), quiet = await enrolledCabinet();
    const one = (n: number) => snapshotOf("time", [{ key: "time", values: { timeZoneId: `Zone ${n}` } }], `2026-10-06T12:0${n}:00Z`);
    assert.equal((await call("POST", "/agent/v1/config", { snapshots: [one(1), snapshotOf("services", configItems)] }, noisy)).status, 200);
    assert.equal((await call("POST", "/agent/v1/config", { snapshots: [one(2), one(3)] }, noisy)).status, 429);
    assert.equal(Number((await db.app.query("SELECT COUNT(*) AS n FROM config_versions WHERE cabinet_id = $1 AND category = 'time'", [noisy.cabinetId])).rows[0]!.n), 1);
    assert.equal((await call("POST", "/agent/v1/config", { snapshots: [one(2)] }, noisy)).status, 200, "what is left of the quota is still usable");
    assert.equal((await call("POST", "/agent/v1/config", { snapshots: [one(1), one(2), one(3)] }, quiet)).status, 200);
  } finally { port = saved; await limited.close(); }
});

test("renewal is refused until the certificate is near expiry, then the new certificate works", async () => {
  const cab = await enrolledCabinet();
  const newKey = ecKey();
  assert.deepEqual((await call("POST", "/agent/v1/renew", { csr: csrFor(newKey) }, cab)).body, { error: "renew_too_early" });
  await asOwner(db, c => c.query("UPDATE cabinet_certificates SET not_after = DATEADD(day, 10, SYSUTCDATETIME()) WHERE cabinet_id = $1", [cab.cabinetId]));
  const renewed = await call("POST", "/agent/v1/renew", { csr: csrFor(newKey) }, cab);
  assert.equal(renewed.status, 200);
  assert.equal((await call("POST", "/agent/v1/heartbeat", heartbeat, { key: newKey, certPem: renewed.body.certificate })).status, 200);
});

test("renewal works once: a lost answer can be asked again, but once the new certificate is used the old one is revoked", async () => {
  const cab = await enrolledCabinet();
  await asOwner(db, c => c.query("UPDATE cabinet_certificates SET not_after = DATEADD(day, 10, SYSUTCDATETIME()) WHERE cabinet_id = $1", [cab.cabinetId]));
  const lostKey = ecKey();
  const lost = await call("POST", "/agent/v1/renew", { csr: csrFor(lostKey) }, cab);
  assert.equal(lost.status, 200);
  // The agent never got that answer: it asks again with its old certificate, and the unused one is withdrawn.
  const newKey = ecKey();
  const renewed = await call("POST", "/agent/v1/renew", { csr: csrFor(newKey) }, cab);
  assert.equal(renewed.status, 200);
  assert.equal((await call("POST", "/agent/v1/heartbeat", heartbeat, { key: lostKey, certPem: lost.body.certificate })).status, 401, "the unused certificate was revoked");
  assert.equal((await call("POST", "/agent/v1/heartbeat", heartbeat, cab)).status, 200, "the old one works until the new one is used");
  assert.equal((await call("POST", "/agent/v1/heartbeat", heartbeat, { key: newKey, certPem: renewed.body.certificate })).status, 200);
  // A copy of the old certificate now neither connects nor renews.
  assert.equal((await call("POST", "/agent/v1/heartbeat", heartbeat, cab)).status, 401);
  assert.equal((await call("POST", "/agent/v1/renew", { csr: csrFor(ecKey()) }, cab)).status, 401);
});

test("a delivered command that is never answered expires, and a late result is still kept", async () => {
  const cab = await enrolledCabinet();
  const command = await issueCommand(db.app, admin, cab.cabinetId, "system.info", {});
  const polled = await call("GET", "/agent/v1/commands", undefined, cab);
  assert.equal(polled.body.commands[0].commandId, command.commandId);
  assert.equal(await expireUnanswered(db.app), 0, "not yet");
  await asOwner(db, c => c.query("UPDATE commands SET delivered_at = DATEADD(minute, -36, SYSUTCDATETIME()) WHERE id = $1", [command.commandId]));
  assert.equal(await expireUnanswered(db.app), 1);
  assert.equal((await commandRecord(db.app, command.commandId))?.status, "expired");
  const now = new Date().toISOString();
  const late = await call("POST", "/agent/v1/results", { commandId: command.commandId, status: "failed", startedAt: now, finishedAt: now,
    error: { code: "timeout", message: "late" } }, cab);
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal((await commandRecord(db.app, command.commandId))?.status, "failed");
});

test("unknown paths are 404 and the package and update downloads do not exist yet", async () => {
  const cab = await enrolledCabinet();
  for (const path of ["/agent/v1/packages/x", "/agent/v1/updates/1.0.0", "/agent/v1/files", "/admin"])
    assert.equal((await call("GET", path, undefined, cab)).status, 404, path);
});

test("operations counters: requests, refusals and sheds are counted by route pattern, with nothing identifying", async () => {
  opsMeter.drain();
  const me = await enrolledCabinet();
  await call("POST", "/agent/v1/heartbeat", heartbeat, me);
  await call("POST", "/agent/v1/heartbeat", heartbeat); // no certificate
  await call("GET", "/agent/v1/no-such-route-" + me.cabinetId, undefined, me);
  const d = opsMeter.drain();
  const counts = Object.fromEntries([...d.counts].map(([k, n]) => [k.replace("\u0000", "|"), n]));
  assert.ok(counts["requests|agent"]! >= 3, JSON.stringify(counts));
  assert.ok(counts["agent_auth_fail|no_certificate"]! >= 1, JSON.stringify(counts));
  const text = JSON.stringify(counts);
  assert.ok(!text.includes(me.cabinetId) && !text.includes("no-such-route"), "no identifier or URL in a code");
});
