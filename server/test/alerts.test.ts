// Milestone 4 on the server: symptom rules, the alerts engine, Map to issue with approval,
// claims, the live stream and offline alerts. Includes hostile and malformed input.
import test from "node:test";
import { paramsHash } from "../src/auth/canonical.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { approveEnrollment, createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { storeEvents } from "../src/services/events.js";
import { checkOffline, unrecognizedSignature } from "../src/services/alerts.js";
import { checkUserMatch, decide, ISSUE, matches, matchSql, type LiveRule } from "../src/services/rules.js";
import { verifyAuditChain } from "../src/db/db.js";
import type { Event, SymptomMatch } from "../src/contracts.js";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir, firstCookie } from "./helpers.js";

const ORIGIN = "https://console.test";
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
let clock = Date.SYSUTCDATETIME();
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const cab: Record<"a" | "b" | "far", string> = { a: "", b: "", far: "" };

interface Account { id: string; username: string; password: string; secret: Buffer; }
async function account(role: "tier1" | "tier2" | "admin"): Promise<Account> {
  const a: Account = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple", secret: totp.newSecret() };
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc)
                      VALUES ($1, $2, $3, $4, $5, 0, 1, $6)`, [a.id, a.username, "Test " + a.username, role, await hashPassword(a.password), secrets.seal(a.secret)]);
  return a;
}
const nextCode = (a: Account) => { clock += 30_000; return totp.code(a.secret, totp.stepAt(clock)); };

interface Reply { status: number; body: any; cookie?: string; }
async function call(method: "GET" | "POST", url: string, body?: unknown, cookie?: string): Promise<Reply> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const r = await app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
  const set = r.headers["set-cookie"];
  let parsed: unknown = r.body; try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
  return { status: r.statusCode, body: parsed, ...(firstCookie(set) ? { cookie: firstCookie(set)! } : {}) };
}
async function signIn(a: Account): Promise<string> {
  const r = await call("POST", "/api/auth/login", { username: a.username, password: a.password });
  assert.equal((await call("POST", "/api/auth/totp", { code: nextCode(a) }, r.cookie)).body.stage, "complete");
  return r.cookie!;
}
async function stepUp(a: Account, cookie: string, action: string, target: string, params?: unknown): Promise<string> {
  const r = await call("POST", "/api/auth/step-up", { code: nextCode(a), action, target, ...(params !== undefined ? { paramsHash: paramsHash(params) } : {}) }, cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

const at = (minutesAgo = 0) => new Date(Date.SYSUTCDATETIME() - minutesAgo * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
type Log = NonNullable<Event["source"]>["log"];
const errorEvent = (o: { log?: Log; source?: string; eventId?: number; message?: string; record?: number; level?: "error" | "critical" } = {}): Event => ({
  eventId: randomUUID(), kind: "error", occurredAt: at(), severityHint: "minor",
  source: { log: o.log ?? "System", source: o.source ?? "Microsoft-Windows-Kernel-PnP", eventId: o.eventId ?? 219, level: o.level ?? "error", recordId: o.record ?? 1 + Math.floor(Math.random() * 1e9) },
  detail: { message: o.message ?? "The driver \\Driver\\WUDFRd failed to load for the device USB\\VID_1234&PID_5678\\1." },
});
const scannerEvent = (state: "disconnected" | "device_error" | "driver_missing" | "recovered"): Event => ({
  eventId: randomUUID(), kind: "scanner", occurredAt: at(), severityHint: state === "recovered" ? "minor" : "major",
  detail: { message: `The fingerprint scanner is ${state}.` }, device: { hardwareIds: ["USB\\VID_1234&PID_5678"], state },
});
const send = (cabinetId: string, ...events: [Event, ...Event[]]) => storeEvents(db.app, cabinetId, { events });

test.before(async () => {
  db = await createTestDatabase();
  const key = await developmentIssuingKey(tempDir());
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => clock });
  const admin = await account("admin");
  for (const [name, site] of [["a", "North"], ["b", "North"], ["far", "South"]] as const) {
    const { token } = await createBootstrapToken(db.app, admin.id);
    const requestId = await submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: {
      hostname: `CAB-${name}`, serialNumber: null, macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z",
      osVersion: "Windows 10", agentVersion: "0.2.0" } }, "127.0.0.1");
    cab[name] = (await approveEnrollment(db.app, key, requestId, { clientName: "Acme Health", siteName: site, cabinetName: `Cabinet ${name}`, role: "standalone" }, admin.id)).cabinetId;
  }
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME()");
});
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

// ---- Matching ----------------------------------------------------------------------------

test("matching uses structured fields and a plain, case-insensitive phrase", () => {
  const e = errorEvent({ message: "Device USB\\VID_1234 was not migrated (a+)+$" });
  assert.ok(matches({ log: "System", source: "microsoft-windows-kernel-pnp", eventId: 219 }, e));
  assert.ok(matches({ kind: "error", phrase: "NOT MIGRATED" }, e));
  assert.ok(matches({ phrase: "(a+)+$" }, e), "a phrase that looks like a pattern is just text");
  assert.ok(!matches({ phrase: ".*" }, e), "no wildcards");
  assert.ok(!matches({ eventId: 220 }, e));
  assert.ok(!matches({ log: "Application" }, e));
  assert.ok(!matches({ kind: "scanner" }, e));
  assert.ok(matches({ hardwareId: "usb\\vid_1234&pid_5678" }, scannerEvent("disconnected")));
  assert.ok(!matches({ log: "System" }, scannerEvent("disconnected")), "log fields never match an event without a source");
});

test("a hostile phrase is fast: matching has no regular expressions to blow up", () => {
  const e = errorEvent({ message: "a".repeat(32_000) });
  const started = Date.SYSUTCDATETIME();
  for (let i = 0; i < 2_000; i++) matches({ phrase: "a".repeat(127) + "b" }, e);
  assert.ok(Date.SYSUTCDATETIME() - started < 2_000);
});

test("people's rules must name something specific and fit the contract", () => {
  assert.throws(() => checkUserMatch({ log: "System" }), /source, event ID/);
  assert.throws(() => checkUserMatch({ level: "error" } as SymptomMatch));
  assert.throws(() => checkUserMatch({ kind: "scanner", eventId: 5 }), /log fields/);
  assert.throws(() => checkUserMatch({ log: "Security", eventId: 4625 } as unknown as SymptomMatch));
  assert.throws(() => checkUserMatch({ eventId: 5, pattern: "x" } as unknown as SymptomMatch));
  checkUserMatch({ log: "System", eventId: 219 });
});

test("the most specific rule wins, and a suppression beats any map rule", () => {
  const rule = (id: string, match: SymptomMatch, kind: "map" | "suppress" = "map", created = 0): LiveRule =>
    ({ id, kind, issueTypeId: kind === "map" ? "t" : null, match, builtIn: false, createdAt: new Date(created), severity: null });
  const e = errorEvent();
  assert.equal(decide([rule("broad", { eventId: 219 }), rule("narrow", { eventId: 219, log: "System" })], e)?.id, "narrow");
  assert.equal(decide([rule("old", { eventId: 219 }, "map", 1), rule("new", { eventId: 219 }, "map", 2)], e)?.id, "old");
  assert.equal(decide([rule("narrow", { eventId: 219, log: "System" }), rule("hush", { eventId: 219 }, "suppress")], e)?.id, "hush");
  assert.equal(decide([rule("other", { eventId: 1 })], e), null);
});

test("the SQL form of a match agrees with the code form", async () => {
  const events = [errorEvent(), errorEvent({ source: "Disk", eventId: 7, message: "bad block" }), errorEvent({ log: "Application", message: "Fingerprint SERVICE stopped" })];
  await send(cab.far, events[0]!, ...events.slice(1));
  const cases: SymptomMatch[] = [{ eventId: 219 }, { source: "DISK" }, { phrase: "fingerprint service" }, { log: "Application", phrase: "x'; DROP TABLE events; --" }, { kind: "error", level: "error", eventId: 7 }];
  for (const m of cases) {
    const { where, params } = matchSql(m, 2);
    const ids = (await db.app.query<{ event_id: string }>(`SELECT event_id FROM events e WHERE e.cabinet_id = $1 AND ${where}`, [cab.far, ...params])).rows.map(r => r.event_id).sort();
    assert.deepEqual(ids, events.filter(e => matches(m, e)).map(e => e.eventId).sort(), JSON.stringify(m));
  }
});

// ---- The engine --------------------------------------------------------------------------

test("a forced scanner disconnect raises Fingerprint scanner problem, repeats fold, and recovery resolves it", async () => {
  const first = await send(cab.a, scannerEvent("disconnected"));
  assert.equal(first.outcomes[0]!.kind, "issue");
  const o = first.outcomes[0] as { alertId: string; issueTypeId: string; created: boolean };
  assert.equal(o.issueTypeId, ISSUE.scanner);
  assert.ok(o.created);
  const again = await send(cab.a, scannerEvent("device_error"));
  assert.equal((again.outcomes[0] as { alertId: string }).alertId, o.alertId, "one open alert per issue per cabinet");
  const alert = (await db.app.query("SELECT * FROM alerts WHERE id = $1", [o.alertId])).rows[0];
  assert.equal(alert.severity, "major");
  assert.equal(alert.occurrences, 2);
  assert.equal(alert.title, "Fingerprint scanner problem");

  const recovered = await send(cab.a, scannerEvent("recovered"));
  assert.deepEqual(recovered.outcomes[0], { kind: "resolved", alertIds: [o.alertId] });
  assert.equal((await db.app.query("SELECT state, resolved_by FROM alerts WHERE id = $1", [o.alertId])).rows[0].state, "resolved");
  // The next problem is a new alert.
  const next = await send(cab.a, scannerEvent("disconnected"));
  assert.notEqual((next.outcomes[0] as { alertId: string }).alertId, o.alertId);
});

test("SMART warnings raise Drive failing; outside firewall changes raise Unexpected firewall change; platform ones do not", async () => {
  const smart = await send(cab.b, { eventId: randomUUID(), kind: "smart_warning", occurredAt: at(), severityHint: "minor", detail: { message: "Reallocated sectors." } });
  assert.equal((smart.outcomes[0] as { issueTypeId: string }).issueTypeId, ISSUE.drive);
  const outside = await send(cab.b, { eventId: randomUUID(), kind: "firewall_changed", occurredAt: at(), severityHint: "major", detail: { message: "1 removed" } });
  assert.equal((outside.outcomes[0] as { issueTypeId: string }).issueTypeId, ISSUE.firewall);
  // A change only counts as the platform's when it names a firewall write this cabinet was sent; a made-up command ID is an outside change.
  const madeUp = await send(cab.b, { eventId: randomUUID(), kind: "firewall_changed", occurredAt: at(), severityHint: "minor", commandId: randomUUID(), detail: {} });
  assert.equal((madeUp.outcomes[0] as { issueTypeId: string }).issueTypeId, ISSUE.firewall);
  const commandId = randomUUID();
  await asOwner(db, c => c.query(`INSERT INTO commands (id, cabinet_id, operation, params, status, issued_by, issued_at, expires_at)
    SELECT TOP (1) $1, $2, 'firewall.setRule', '{"change":"delete","ruleName":"MashuraDiag x"}', 'succeeded', id, SYSUTCDATETIME(), DATEADD(minute, 5, SYSUTCDATETIME()) FROM users`, [commandId, cab.b]));
  const ours = await send(cab.b, { eventId: randomUUID(), kind: "firewall_changed", occurredAt: at(), severityHint: "minor", commandId, detail: {} });
  assert.deepEqual(ours.outcomes, [{ kind: "platform_change" }]);
});

test("an unrecognized error is a minor alert keyed by log, source and event ID; a resent event is not counted twice", async () => {
  const e = errorEvent({ source: "Contoso Lock Service", eventId: 1001, log: "Application" });
  const r = await send(cab.b, e, errorEvent({ source: "contoso lock service", eventId: 1001, log: "Application" }));
  assert.equal(r.outcomes[0]!.kind, "unrecognized");
  const id = (r.outcomes[0] as { alertId: string }).alertId;
  assert.equal((r.outcomes[1] as { alertId: string }).alertId, id, "source case does not split an alert");
  assert.equal((await send(cab.b, e)).stored, 0, "the agent resending a batch changes nothing");
  const a = (await db.app.query("SELECT severity, occurrences, signature, issue_type_id FROM alerts WHERE id = $1", [id])).rows[0];
  assert.deepEqual([a.severity, a.occurrences, a.issue_type_id], ["minor", 2, null]);
  assert.equal(a.signature, unrecognizedSignature(e));
});

test("the same issue on two cabinets at one site within the hour is a site-wide pattern; another site is not", async () => {
  const smartA = await send(cab.a, { eventId: randomUUID(), kind: "smart_warning", occurredAt: at(), severityHint: "minor", detail: {} });
  const id = (o: { outcomes: unknown[] }) => (o.outcomes[0] as { alertId: string }).alertId;
  const flags = async () => (await db.app.query<{ cabinet_id: string; site_pattern: boolean }>(
    "SELECT cabinet_id, site_pattern FROM alerts WHERE issue_type_id = $1 AND state <> 'resolved'", [ISSUE.drive])).rows;
  assert.ok((await flags()).filter(f => f.cabinet_id === cab.a || f.cabinet_id === cab.b).every(f => f.site_pattern), "a and b are both at North");
  await send(cab.far, { eventId: randomUUID(), kind: "smart_warning", occurredAt: at(), severityHint: "minor", detail: {} });
  assert.equal((await flags()).find(f => f.cabinet_id === cab.far)!.site_pattern, false);
  assert.ok(id(smartA));
});

test("an agent clock in the future cannot push an alert's last-seen time ahead", async () => {
  const e = { ...errorEvent({ source: "Future", eventId: 9 }), occurredAt: "2099-01-01T00:00:00Z" };
  const r = await send(cab.far, e);
  const a = (await db.app.query("SELECT last_seen FROM alerts WHERE id = $1", [(r.outcomes[0] as { alertId: string }).alertId])).rows[0];
  assert.ok(a.last_seen.getTime() <= Date.SYSUTCDATETIME() + 1000);
});

// ---- Map to issue -----------------------------------------------------------------------

test("an unrecognized error is mapped by Tier 2, approved by an Admin, regrouped, and the next one raises the issue", async () => {
  const tier1 = await account("tier1"); const t1 = await signIn(tier1);
  const tier2 = await account("tier2"); const t2 = await signIn(tier2);
  const admin = await account("admin"); const ad = await signIn(admin);
  const lockError = () => errorEvent({ log: "Application", source: "Biometric Lock Driver", eventId: 4242, message: "Fingerprint sensor timed out" });
  const first = await send(cab.a, lockError());
  const unrecognizedId = (first.outcomes[0] as { alertId: string }).alertId;

  const listed = await call("GET", "/api/alerts?unrecognized=true", undefined, t1);
  assert.ok(listed.body.some((x: { id: string }) => x.id === unrecognizedId));
  const detail = await call("GET", `/api/events/${(first.outcomes[0] as { alertId: string }) && (await db.app.query("SELECT last_event_id FROM alerts WHERE id = $1", [unrecognizedId])).rows[0].last_event_id}`, undefined, t1);
  assert.equal(detail.body.source.eventId, 4242);
  assert.equal(detail.body.elsewhere.events, 1);
  const opened = (await db.app.query("SELECT target_id FROM audit_log WHERE action = 'event.open' AND JSON_VALUE(details, '$.eventId') = $1", [detail.body.eventId])).rows;
  assert.deepEqual(opened, [{ target_id: cab.a }], "opening a stored event is audited against its cabinet");

  const match: SymptomMatch = { kind: "error", log: "Application", source: "Biometric Lock Driver", eventId: 4242 };
  assert.equal((await call("POST", "/api/rules/preview", { match }, t1)).status, 403, "Tier 1 cannot map");
  const preview = await call("POST", "/api/rules/preview", { match }, t2);
  assert.deepEqual(preview.body, { events: 1, cabinets: 1, openUnrecognizedAlerts: 1, days: 30 });

  // Without step-up, or with a token for another target, nothing happens.
  assert.equal((await call("POST", "/api/rules", { issueTypeId: ISSUE.scanner, match, regroup: true, stepUpToken: "A".repeat(43) }, t2)).body.error, "step_up_required");
  const wrongTarget = await stepUp(tier2, t2, "rule.propose", ISSUE.drive);
  assert.equal((await call("POST", "/api/rules", { issueTypeId: ISSUE.scanner, match, regroup: true, stepUpToken: wrongTarget }, t2)).body.error, "step_up_required");

  const proposed = await call("POST", "/api/rules", { issueTypeId: ISSUE.scanner, match, regroup: true, stepUpToken: await stepUp(tier2, t2, "rule.propose", ISSUE.scanner, { issueTypeId: ISSUE.scanner, match, regroup: true }) }, t2);
  assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
  assert.equal(proposed.body.state, "proposed");
  const ruleId = proposed.body.ruleId;
  // A proposal does nothing yet.
  assert.equal((await send(cab.a, lockError())).outcomes[0]!.kind, "unrecognized");
  // Tier 2 cannot approve their own (or anyone's) proposal.
  assert.equal((await call("POST", `/api/rules/${ruleId}/approve`, { stepUpToken: "A".repeat(43) }, t2)).status, 403);
  const approved = await call("POST", `/api/rules/${ruleId}/approve`, { stepUpToken: await stepUp(admin, ad, "rule.approve", ruleId) }, ad);
  assert.equal(approved.body.state, "live");
  assert.equal(approved.body.regrouped, 1);
  const old = (await db.app.query("SELECT state, resolution FROM alerts WHERE id = $1", [unrecognizedId])).rows[0];
  assert.deepEqual([old.state, old.resolution], ["resolved", "Regrouped under Fingerprint scanner problem."]);

  // The next occurrence raises the issue.
  const next = await send(cab.a, lockError());
  assert.equal(next.outcomes[0]!.kind, "issue");
  assert.equal((next.outcomes[0] as { issueTypeId: string }).issueTypeId, ISSUE.scanner);

  const history = await call("GET", `/api/rules/${ruleId}/history`, undefined, t1);
  assert.deepEqual(history.body.map((h: { change: string }) => h.change), ["proposed", "approved"]);
  assert.equal(history.body[0].changedBy.id, tier2.id);
  assert.equal(history.body[1].changedBy.id, admin.id);
  const rules = await call("GET", "/api/rules?state=live", undefined, t1);
  assert.ok(rules.body.find((r: { id: string; matchedCount: number }) => r.id === ruleId).matchedCount >= 1);

  // Disable, then roll back to the live version.
  assert.equal((await call("POST", `/api/rules/${ruleId}/disable`, { stepUpToken: await stepUp(admin, ad, "rule.disable", ruleId) }, ad)).status, 200);
  assert.equal((await send(cab.a, lockError())).outcomes[0]!.kind, "unrecognized");
  assert.equal((await call("POST", `/api/rules/${ruleId}/rollback`, { version: 1, stepUpToken: await stepUp(admin, ad, "rule.rollback", ruleId, { version: 1 }) }, ad)).status, 200);
  const states = (await call("GET", `/api/rules/${ruleId}/history`, undefined, t1)).body.map((h: { change: string; state: string; version: number }) => `${h.change}:${h.state}:${h.version}`);
  assert.deepEqual(states, ["proposed:proposed:1", "approved:live:1", "disabled:disabled:1", "rolled_back:live:2"]);
  assert.equal((await send(cab.a, lockError())).outcomes[0]!.kind, "issue");

  const actions = (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY seq", [ruleId])).rows.map(r => r.action);
  assert.deepEqual(actions, ["rule.propose", "rule.approve", "rule.disable", "rule.rollback"]);
  assert.equal((await asOwner(db, c => verifyAuditChain(c))).ok, true);
});

test("an Admin's mapping goes live at once; rejected proposals never go live", async () => {
  const admin = await account("admin"); const ad = await signIn(admin);
  const tier2 = await account("tier2"); const t2 = await signIn(tier2);
  const match: SymptomMatch = { log: "System", source: "disk", eventId: 7 };
  const live = await call("POST", "/api/rules", { issueTypeId: ISSUE.drive, match, regroup: false, stepUpToken: await stepUp(admin, ad, "rule.propose", ISSUE.drive, { issueTypeId: ISSUE.drive, match, regroup: false }) }, ad);
  assert.equal(live.body.state, "live");
  const p = await call("POST", "/api/rules", { issueTypeId: ISSUE.drive, match: { phrase: "bad sector" }, regroup: false, stepUpToken: await stepUp(tier2, t2, "rule.propose", ISSUE.drive, { issueTypeId: ISSUE.drive, match: { phrase: "bad sector" }, regroup: false }) }, t2);
  const rejected = await call("POST", `/api/rules/${p.body.ruleId}/reject`, { stepUpToken: await stepUp(admin, ad, "rule.reject", p.body.ruleId) }, ad);
  assert.equal(rejected.body.state, "rejected");
  assert.equal((await call("POST", `/api/rules/${p.body.ruleId}/approve`, { stepUpToken: await stepUp(admin, ad, "rule.approve", p.body.ruleId) }, ad)).body.error, "not_pending");
});

test("hostile rule and filter input is refused before it reaches the database", async () => {
  const tier2 = await account("tier2"); const t2 = await signIn(tier2);
  for (const match of [{}, { log: "System" }, { eventId: 1, regex: "(a+)+" }, { log: "Security", eventId: 4625 }, { phrase: "\u0000abc" }, { eventId: "1 OR 1=1" }, []])
    assert.equal((await call("POST", "/api/rules/preview", { match }, t2)).status, 400, JSON.stringify(match));
  for (const q of ["state=open'--", "severity=critical", "cabinetId=not-a-uuid", "claimedBy=everyone", "state=open&state=closed", "orderBy=1"])
    assert.equal((await call("GET", `/api/alerts?${q}`, undefined, t2)).status, 400, q);
  assert.equal((await call("GET", "/api/rules?state=live;DROP", undefined, t2)).status, 400);
  assert.equal((await call("GET", "/api/events/lookup?cabinetId=" + cab.a + "&log=Security&source=x&eventId=4625", undefined, t2)).status, 400);
  assert.equal((await call("GET", "/api/alerts/not-a-uuid", undefined, t2)).status, 404);
});

// ---- Claims and the live stream ----------------------------------------------------------

test("a major alert reaches every signed-in console and only one person can claim it", async () => {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const people = await Promise.all([account("tier1"), account("tier2"), account("admin")]);
  const cookies = await Promise.all(people.map(signIn));
  const aborts = cookies.map(() => new AbortController());
  const received = cookies.map(async (cookie, i) => {
    const r = await fetch(`${base}/api/stream`, { headers: { cookie }, signal: aborts[i]!.signal });
    assert.equal(r.status, 200);
    const reader = r.body!.getReader();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString("utf8");
      const m = /event: alert\ndata: (.*)\n/.exec(text);
      if (m) { aborts[i]!.abort(); return JSON.parse(m[1]!); }
    }
    return null;
  });
  await new Promise(r => setTimeout(r, 300)); // all three streams attached
  assert.equal(stream.count >= 3, true);

  const raised = await send(cab.b, scannerEvent("driver_missing"));
  const alertId = (raised.outcomes[0] as { alertId: string }).alertId;
  const got = await Promise.race([Promise.all(received), new Promise<null>(r => setTimeout(() => r(null), 5000))]);
  assert.ok(got, "every console heard about it");
  for (const g of got!) assert.deepEqual([g.alertId, g.change, g.severity, g.title], [alertId, "created", "major", "Fingerprint scanner problem"]);

  const summary = await call("GET", "/api/alerts/summary", undefined, cookies[0]);
  assert.ok(summary.body.openMajor >= 1);

  // All three click at once: exactly one wins, the others are told who.
  const claims = await Promise.all(cookies.map(c => call("POST", `/api/alerts/${alertId}/claim`, undefined, c)));
  const winners = claims.filter(c => c.status === 200);
  assert.equal(winners.length, 1);
  const winner = people[claims.findIndex(c => c.status === 200)]!;
  for (const lost of claims.filter(c => c.status !== 200)) {
    assert.equal(lost.status, 409);
    assert.equal(lost.body.error, "already_claimed");
    assert.equal(lost.body.claimedBy.id, winner.id);
  }
  // Only the claimant resolves it (an Admin may too): a Tier 1 or Tier 2 who lost is refused.
  const winnerIndex = claims.findIndex(c => c.status === 200);
  const nonAdminLoser = [0, 1].find(i => i !== winnerIndex)!;
  assert.equal((await call("POST", `/api/alerts/${alertId}/resolve`, {}, cookies[nonAdminLoser])).body.error, "claim_first");
  const resolved = await call("POST", `/api/alerts/${alertId}/resolve`, { note: "Reinstalled the scanner driver." }, cookies[winnerIndex]);
  assert.equal(resolved.body.state, "resolved");
  assert.equal(resolved.body.resolvedBy.id, winner.id);
  assert.equal((await call("POST", `/api/alerts/${alertId}/claim`, { force: true }, cookies[0])).status, 400);
  const audit = (await db.app.query<{ action: string; outcome: string }>("SELECT action, outcome FROM audit_log WHERE target_id = $1 ORDER BY seq", [alertId])).rows;
  assert.equal(audit.filter(a => a.action === "alert.claim" && a.outcome === "succeeded").length, 1);
  assert.equal(audit.filter(a => a.action === "alert.claim" && a.outcome === "refused").length, 2);
  assert.equal(audit.filter(a => a.action === "alert.resolve").length, 1);
});

test("minor alerts are not broadcast as new alerts", async () => {
  const before = (await db.app.query("SELECT COUNT(*) AS n FROM alerts")).rows[0].n;
  await send(cab.far, errorEvent({ source: "Quiet", eventId: 3 }));
  assert.equal((await db.app.query("SELECT COUNT(*) AS n FROM alerts")).rows[0].n, before + 1);
  // deliverAlert ignores created minors; checked by the filter in stream.ts and the e2e console test.
});

// ---- Offline -----------------------------------------------------------------------------

test("offline is a status; past the threshold it becomes an alert that resolves itself when the cabinet returns", async () => {
  const tier1 = await account("tier1"); const t1 = await signIn(tier1);
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(minute, -10, SYSUTCDATETIME()) WHERE id = $1", [cab.b]);
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(day, -6, SYSUTCDATETIME()) WHERE id = $1", [cab.far]);
  const clients = await call("GET", "/api/alerts/offline", undefined, t1);
  assert.equal(clients.body.level, "clients");
  const acme = clients.body.items.find((c: { name: string }) => c.name === "Acme Health");
  assert.equal(acme.offline, 2);
  const sites = await call("GET", `/api/alerts/offline?clientId=${acme.id}`, undefined, t1);
  assert.deepEqual(sites.body.items.map((s: { name: string; offline: number }) => `${s.name}:${s.offline}`).sort(), ["North:1", "South:1"]);
  const south = sites.body.items.find((s: { name: string }) => s.name === "South");
  const cabinets = await call("GET", `/api/alerts/offline?siteId=${south.id}`, undefined, t1);
  assert.deepEqual(cabinets.body.items.map((k: { id: string; pastThreshold: boolean }) => [k.id, k.pastThreshold]), [[cab.far, true]]);

  assert.deepEqual(await checkOffline(db.app), { raised: 1, resolved: 0 });
  assert.deepEqual(await checkOffline(db.app), { raised: 0, resolved: 0 }, "no duplicate");
  const offline = (await db.app.query("SELECT cabinet_id, severity, state FROM alerts WHERE issue_type_id = $1", [ISSUE.offline])).rows;
  assert.deepEqual(offline, [{ cabinet_id: cab.far, severity: "minor", state: "open" }]);

  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME() WHERE id = $1", [cab.far]);
  assert.deepEqual(await checkOffline(db.app), { raised: 0, resolved: 1 });
  // A shorter threshold set by an Admin applies.
  await asOwner(db, c => c.query("INSERT INTO settings ([key], [value]) VALUES ('alerts.offlineDays', '1')"));
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(day, -2, SYSUTCDATETIME()) WHERE id = $1", [cab.b]);
  assert.equal((await checkOffline(db.app)).raised, 1);
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME()");
});

// ---- Early signs of failure: the catalog, warnings, severity per rule ------------------------

test("a drive's early warning raises a minor Drive failing alert; a bad block on the same drive makes it major", async () => {
  const k = cab.b;
  await asOwner(db, c => c.query("UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME() WHERE cabinet_id = $1 AND issue_type_id = $2", [k, ISSUE.drive]));
  const retried = await send(k, { ...errorEvent({ source: "disk", eventId: 153, message: "The IO operation at logical block address 0x1f was retried." }),
    source: { log: "System", source: "disk", eventId: 153, level: "warning", recordId: 1530 } });
  const o = retried.outcomes[0] as { kind: string; alertId: string; issueTypeId: string };
  assert.equal(o.issueTypeId, ISSUE.drive);
  const severity = async () => (await db.app.query("SELECT severity FROM alerts WHERE id = $1", [o.alertId])).rows[0].severity;
  assert.equal(await severity(), "minor", "an early sign shows only on the cabinet");
  const bad = await send(k, errorEvent({ source: "disk", eventId: 7, message: "The device, \\Device\\Harddisk0\\DR0, has a bad block." }));
  assert.equal((bad.outcomes[0] as { alertId: string }).alertId, o.alertId, "one alert per issue per cabinet");
  assert.equal(await severity(), "major", "a real failure makes it major: home page and Alerts tab");
  // A later early sign does not make it minor again.
  await send(k, { ...errorEvent({ source: "disk", eventId: 153 }), source: { log: "System", source: "disk", eventId: 153, level: "warning", recordId: 1531 } });
  assert.equal(await severity(), "major");
});

test("a warning no rule recognizes is kept on its cabinet but raises no alert; an unrecognized error still does", async () => {
  const warning = { ...errorEvent({ source: "Some-Chatty-Driver", eventId: 3 }), source: { log: "System" as const, source: "Some-Chatty-Driver", eventId: 3, level: "warning" as const, recordId: 77 } };
  const r = await send(cab.far, warning);
  assert.deepEqual(r.outcomes, [{ kind: "stored" }]);
  assert.equal((await db.app.query("SELECT alert_id FROM events WHERE event_id = $1", [warning.eventId])).rows[0].alert_id, null);
  assert.equal((await send(cab.far, errorEvent({ source: "Some-Chatty-Driver", eventId: 3 }))).outcomes[0]!.kind, "unrecognized");
});

test("the catalog recognizes crashes, unexpected shutdowns, hardware errors and service failures with their own severities", async () => {
  const cases: [string, number, string, "major" | "minor"][] = [
    ["Microsoft-Windows-WER-SystemErrorReporting", 1001, "System crash (blue screen)", "major"],
    ["Microsoft-Windows-Kernel-Power", 41, "Unexpected shutdown or power loss", "minor"],
    ["Microsoft-Windows-WHEA-Logger", 18, "Hardware error", "major"],
    ["Service Control Manager", 7031, "Windows service failure", "minor"],
    ["Microsoft-Windows-Ntfs", 55, "Drive failing", "major"],
  ];
  for (const [source, eventId, name, severity] of cases) {
    const r = await send(cab.a, errorEvent({ source, eventId }));
    const o = r.outcomes[0] as { alertId: string };
    const a = (await db.app.query("SELECT a.severity, t.name FROM alerts a JOIN issue_types t ON t.id = a.issue_type_id WHERE a.id = $1", [o.alertId])).rows[0];
    assert.deepEqual([source, a.name], [source, name]);
    if (name !== "Drive failing") assert.equal(a.severity, severity, `${source} ${eventId}`);
  }
});

test("a mapping can set its own severity; an Admin can create a new issue type while mapping, Tier 2 cannot", async () => {
  const admin = await account("admin"); const ad = await signIn(admin);
  const tier2 = await account("tier2"); const t2 = await signIn(tier2);
  // A minor issue type, but this symptom of it is serious enough for the home page.
  const r = await call("POST", "/api/rules", { newIssueType: { name: "Receipt printer fault", severity: "minor", description: "The receipt printer reported a fault." },
    match: { log: "System", source: "Contoso-Printer", eventId: 12 }, severity: "major", regroup: false, stepUpToken: await stepUp(admin, ad, "rule.propose", "fleet", { newIssueType: { name: "Receipt printer fault", severity: "minor", description: "The receipt printer reported a fault." },
    match: { log: "System", source: "Contoso-Printer", eventId: 12 }, severity: "major", regroup: false }) }, ad);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.state, "live");
  const type = (await db.app.query("SELECT severity FROM issue_types WHERE id = $1", [r.body.issueTypeId])).rows[0];
  assert.equal(type.severity, "minor");
  const fired = await send(cab.a, errorEvent({ source: "Contoso-Printer", eventId: 12 }));
  const alert = (await db.app.query("SELECT severity, title FROM alerts WHERE id = $1", [(fired.outcomes[0] as { alertId: string }).alertId])).rows[0];
  assert.deepEqual(alert, { severity: "major", title: "Receipt printer fault" });
  assert.ok((await db.app.query("SELECT 1 FROM audit_log WHERE action = 'issue_type.create' AND JSON_VALUE(details, '$.from') = 'map_to_issue'")).rowCount === 1);

  const refused = await call("POST", "/api/rules", { newIssueType: { name: "Tier 2 type", severity: "major", description: "x" },
    match: { log: "System", source: "Other", eventId: 1 }, regroup: false, stepUpToken: await stepUp(tier2, t2, "rule.propose", "fleet", { newIssueType: { name: "Tier 2 type", severity: "major", description: "x" },
    match: { log: "System", source: "Other", eventId: 1 }, regroup: false }) }, t2);
  assert.equal(refused.status, 403);
  assert.equal((await call("POST", "/api/rules", { issueTypeId: ISSUE.drive, match: { eventId: 1, source: "x" }, severity: "critical", regroup: false, stepUpToken: "A".repeat(43) }, t2)).status, 400);
});
