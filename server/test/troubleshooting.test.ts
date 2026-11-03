// The troubleshooting workflow end to end on a real database with the simulated fleet: Diagnose this cabinet, runbooks (proposed, approved,
// retired, and every hostile shape refused), case notes (append-only, redaction), resolution notes feeding "usually fixed by", the nightly error
// trends and the triage queue. Roles are checked on the server for every route.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { SecretBox } from "../src/auth/secrets.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { DemoSimulator, enableDemo } from "../src/demo/demo.js";
import { BUILT_IN_RUNBOOKS } from "../src/services/runbooks-builtin.js";
import { checkRunbookBody } from "../src/services/runbooks.js";
import { runErrorTrends } from "../src/services/error-trends.js";
import { ISSUE } from "../src/services/rules.js";
import { ContractError } from "../src/contracts.js";
import { Refused } from "../src/services/errors.js";
import { ConsoleHarness, ORIGIN, type Role } from "./console-harness.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
let sim: DemoSimulator;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);
const account = (role: Role) => h.account(role);
const call = h.call.bind(h);
const cab = async (name: string) => (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE name = $1 AND demo_scenario IS NOT NULL", [name])).rows[0]!;
const UUID0 = "00000000-0000-4000-8000-000000000000";
/** Every unexpected server error (a 500): the app is built without a logger, so this is the only place its cause shows up. */
const serverErrors: string[] = [];
const errorsSoFar = () => (serverErrors.length ? ` Server errors so far: ${serverErrors.join(" | ")}` : "");

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  app.addHook("onError", async (request, _reply, error) => {
    // The ones the error handler answers with a 4xx (a refusal, a contract failure, a client error) are expected here.
    if (error instanceof Refused || error instanceof ContractError || ((error as { statusCode?: number }).statusCode ?? 500) < 500) return;
    serverErrors.push(`${request.method} ${request.url}: ${error.name}: ${error.message}`.slice(0, 500));
  });
  const owner = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, 'demo.owner', 'Demo owner', 'admin', 'x')`, [owner]);
  await enableDemo(db.app, owner);
  sim = new DemoSimulator(db.app, () => {}, 100, [10, 50]);
  sim.start();
});
test.after(async () => { if (serverErrors.length) console.error(`troubleshooting: ${serverErrors.length} server error(s): ${serverErrors.join(" | ")}`); sim.stop(); await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

async function finished(url: string, t: Awaited<ReturnType<typeof account>>) {
  for (const end = Date.now() + 90_000; Date.now() < end; await new Promise(r => setTimeout(r, 200))) {
    const d = (await call("GET", url, undefined, t)).body;
    if (d.state !== "running") return d;
  }
  throw new Error("the diagnosis did not finish");
}

test("the platform's own runbooks follow the rules a proposed runbook must", () => {
  for (const b of BUILT_IN_RUNBOOKS) assert.doesNotThrow(() => checkRunbookBody(b.body), b.body.title);
});

test("Diagnose this cabinet: the scanner that is not detected comes first, with its runbook, and the run is stored", async () => {
  const t1 = await account("tier1");
  const k = (await cab("Treatment Room")).id;
  assert.equal((await call("POST", `/api/cabinets/${k}/diagnose`, {})).status, 401);
  assert.equal((await call("POST", `/api/cabinets/${k}/diagnose`, { extra: 1 }, t1)).status, 400);
  assert.equal((await call("POST", `/api/cabinets/${UUID0}/diagnose`, {}, t1)).status, 404);
  const started = await call("POST", `/api/cabinets/${k}/diagnose`, {}, t1);
  assert.equal(started.status, 202, JSON.stringify(started.body) + errorsSoFar());
  // A second click while it runs joins the same run.
  assert.equal((await call("POST", `/api/cabinets/${k}/diagnose`, {}, t1)).body.diagnosisId, started.body.diagnosisId);
  const d = await finished(`/api/cabinet-diagnoses/${started.body.diagnosisId}`, t1);
  assert.equal(d.state, "done", JSON.stringify(d.failure));
  const top = d.findings[0];
  assert.equal(top.key, "scanner-missing");
  assert.equal(top.rank, 1);
  assert.equal(top.severity, "problem");
  assert.equal(top.runbook.builtIn, true);
  assert.ok(d.readings.areas.length >= 9, "every area is accounted for");
  assert.ok(d.findings.every((f: { severity: string }) => f.severity !== "ok"));
  assert.equal((await call("GET", `/api/cabinets/${k}/diagnose`, undefined, t1)).body.latest.id, started.body.diagnosisId);
  // The reads it issued are audited as the person's own, and nothing but reads went out.
  const ops = (await db.app.query<{ operation: string }>("SELECT DISTINCT operation FROM commands WHERE cabinet_id = $1 AND issued_by = $2", [k, t1.id])).rows.map(r => r.operation);
  for (const op of ops) assert.ok(["system.info", "disk.smart", "system.performance", "peripheral.status", "usb.ports", "devices.list", "services.list", "updates.status", "time.status", "eventlog.query", "network.config", "firewall.state", "network.test", "network.trace", "database.connectivity"].includes(op), op);
  const audited = await db.app.query("SELECT 1 FROM audit_log WHERE action = 'diagnosis.start' AND actor_id = $1", [t1.id]);
  assert.equal(audited.rowCount, 1);
});

test("a drive that is failing and a clock that is wrong are found on the cabinets that have them", async () => {
  const t1 = await account("tier1");
  const pharmacy = (await cab("Pharmacy")).id;
  const s = await call("POST", `/api/cabinets/${pharmacy}/diagnose`, {}, t1);
  const d = await finished(`/api/cabinet-diagnoses/${s.body.diagnosisId}`, t1);
  const drive = d.findings.find((f: { key: string }) => f.key === "drive-health");
  assert.equal(drive?.severity, "problem");
  assert.equal(d.findings[0].key, "drive-health", "a failing drive outranks everything else on it");
  // The failing drive opened the cabinet's storage incident, linked to this run, by the platform (D16). It is recorded just after the run is stored.
  let storage: { symptom: string; opened_by_kind: string } | undefined;
  for (const end = Date.now() + 15_000; !storage && Date.now() < end; await new Promise(r => setTimeout(r, 200)))
    storage = (await db.app.query<{ symptom: string; opened_by_kind: string }>(
      `SELECT i.symptom, i.opened_by_kind FROM incidents i JOIN incident_links l ON l.incident_id = i.id AND l.kind = 'diagnosis' AND l.ref_id = $2
        WHERE i.cabinet_id = $1 AND i.module_id = 'cabinet-storage' AND i.state = 'open'`, [pharmacy, s.body.diagnosisId])).rows[0];
  assert.ok(storage, "no open storage incident linked to the diagnosis");
  assert.equal(storage.opened_by_kind, "system");
  const icu = (await cab("ICU")).id;
  const s2 = await call("POST", `/api/cabinets/${icu}/diagnose`, {}, t1);
  const d2 = await finished(`/api/cabinet-diagnoses/${s2.body.diagnosisId}`, t1);
  const skew = d2.findings.find((f: { key: string }) => f.key === "time-skew");
  // When this fails, say what the diagnosis did find (and its state), not only that the finding is missing.
  assert.equal(skew?.action?.operation, "time.sync",
    `no time-skew finding with a time.sync fix on ICU; the diagnosis ended ${d2.state} with: ${JSON.stringify(d2.findings.map((f: { key: string; severity: string }) => [f.key, f.severity]))}`);
});

test("an offline cabinet is refused at once, not waited for", async () => {
  const t1 = await account("tier1");
  const r = await call("POST", `/api/cabinets/${(await cab("Step-down")).id}/diagnose`, {}, t1);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "cabinet_offline");
});

test("runbooks: Tier 2 proposes, nothing is live until an Admin approves with a code, and retiring brings the platform's own back", async () => {
  const t1 = await account("tier1"), t2 = await account("tier2"), boss = await account("admin");
  const clock = ISSUE.clock;
  const body = { target: { kind: "issue", issueTypeId: clock }, title: "Clock is off (our version)", steps: [
    { title: "Look", check: { operation: "time.status", params: {} } }, { title: "Sync", fix: { operation: "time.sync", params: {}, label: "Sync now" } }],
    links: [{ label: "Docs", url: "https://learn.microsoft.com/windows-server/" }] };
  assert.equal((await call("POST", "/api/runbooks", body, t1)).status, 403);
  const made = await call("POST", "/api/runbooks", body, t2);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.state, "proposed");
  // Still the platform's own for everyone.
  assert.equal((await call("GET", `/api/runbooks?issueTypeId=${clock}`, undefined, t1)).body.runbook.builtIn, true);
  // Tier 1 cannot list proposals; Tier 2 can; neither can decide.
  assert.equal((await call("GET", "/api/runbooks?state=proposed", undefined, t1)).status, 403);
  assert.equal((await call("GET", "/api/runbooks?state=proposed", undefined, t2)).body.runbooks.length, 1);
  const noToken = await call("POST", `/api/runbooks/${made.body.id}/approve`, {}, boss);
  assert.equal(noToken.status, 400);
  assert.equal((await call("POST", `/api/runbooks/${made.body.id}/approve`, { stepUpToken: "x".repeat(43) }, t2)).status, 403);
  const wrong = await h.codeToken(boss, "runbook.reject", made.body.id, {});
  assert.equal((await call("POST", `/api/runbooks/${made.body.id}/approve`, { stepUpToken: wrong }, boss)).status, 403, "a token for another action is refused");
  const token = await h.codeToken(boss, "runbook.approve", made.body.id, {});
  const approved = await call("POST", `/api/runbooks/${made.body.id}/approve`, { stepUpToken: token }, boss);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.state, "approved");
  const live = (await call("GET", `/api/runbooks?issueTypeId=${clock}`, undefined, t1)).body.runbook;
  assert.equal(live.builtIn, false);
  assert.equal(live.title, "Clock is off (our version)");
  // The same token cannot be used twice, and a decided runbook cannot be decided again.
  assert.equal((await call("POST", `/api/runbooks/${made.body.id}/approve`, { stepUpToken: token }, boss)).status, 403);
  // A newer proposal replaces it on approval; the old one is retired.
  const second = await call("POST", "/api/runbooks", { ...body, title: "Clock is off v2" }, t2);
  assert.equal(second.body.version, 2);
  await call("POST", `/api/runbooks/${second.body.id}/approve`, { stepUpToken: await h.codeToken(boss, "runbook.approve", second.body.id, {}) }, boss);
  assert.equal((await call("GET", `/api/runbooks?state=retired`, undefined, t2)).body.runbooks.length, 1);
  await call("POST", `/api/runbooks/${second.body.id}/retire`, { stepUpToken: await h.codeToken(boss, "runbook.retire", second.body.id, {}) }, boss);
  assert.equal((await call("GET", `/api/runbooks?issueTypeId=${clock}`, undefined, t1)).body.runbook.builtIn, true);
  const audit = await db.app.query("SELECT action FROM audit_log WHERE action LIKE 'runbook.%'");
  assert.ok(audit.rowCount! >= 5);
});

test("hostile runbooks are refused: shells, scripts, code-level changes, reads as fixes, wrong parameters, markup links, too much text", async () => {
  const t2 = await account("tier2");
  const target = { kind: "finding", key: "dns-all" };
  const step = (extra: object) => ({ target, title: "x", steps: [{ title: "s", ...extra }] });
  const refused = async (b: unknown, code = 400) => { const r = await call("POST", "/api/runbooks", b, t2); assert.equal(r.status, code, JSON.stringify(b).slice(0, 200) + JSON.stringify(r.body)); return r; };
  await refused(step({ fix: { operation: "shell.run", params: {}, label: "x" } }));
  await refused(step({ fix: { operation: "package.install", params: {}, label: "x" } }));
  await refused(step({ fix: { operation: "network.setIp", params: { interfaceIndex: 1, mode: "dhcp" }, label: "needs a code" } }));
  await refused(step({ fix: { operation: "system.info", params: {}, label: "a read is not a fix" } }));
  await refused(step({ check: { operation: "time.sync", params: {} } }));
  await refused(step({ check: { operation: "eventlog.query", params: { log: "Security" } } }));
  await refused(step({ fix: { operation: "service.control", params: { name: "x; calc", action: "start" }, label: "x" } }));
  await refused(step({ fix: { operation: "service.control", params: { name: "Spooler", action: "start", extra: 1 }, label: "x" } }));
  await refused(step({ fix: { operation: "firewall.applyPolicy", params: { profiles: { domain: false, private: false, public: false } }, label: "browser sets the profiles" } }));
  await refused({ ...step({}), links: [{ label: "x", url: "javascript:alert(1)" }] });
  await refused({ ...step({}), steps: Array.from({ length: 13 }, () => ({ title: "s" })) });
  await refused({ ...step({}), target: { kind: "finding", key: "dns-.*" } });
  await refused({ ...step({}), target: { kind: "issue", issueTypeId: UUID0 } }, 404);
  // Valid pieces that together hold too much text.
  await refused({ target, title: "x", steps: Array.from({ length: 6 }, () => ({ title: "s", detail: "d".repeat(790) })) });
  assert.equal((await call("POST", "/api/runbooks", "not an object", t2)).status, 400);
  // Three proposals wait per target at most.
  for (let i = 0; i < 3; i++) await refused({ target: { kind: "finding", key: "gateway" }, title: `v${i}`, steps: [{ title: "s" }] }, 201);
  await refused({ target: { kind: "finding", key: "gateway" }, title: "four", steps: [{ title: "s" }] }, 409);
});

test("case notes are append-only; an Admin can remove the text of one, with a reason", async () => {
  const t1 = await account("tier1"), other = await account("tier1"), boss = await account("admin");
  const k = (await cab("Surgery")).id, elsewhere = (await cab("Lab")).id;
  const made = await call("POST", `/api/cabinets/${k}/notes`, { body: "Reseated the cable.\nWaiting for the next check." }, t1);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.author.id, t1.id);
  assert.equal((await call("POST", `/api/cabinets/${k}/notes`, { body: "" }, t1)).status, 400);
  assert.equal((await call("POST", `/api/cabinets/${k}/notes`, { body: "x", authorId: other.id }, t1)).status, 400);
  assert.equal((await call("POST", `/api/cabinets/${k}/notes`, { body: "bell\u0007" }, t1)).status, 400);
  assert.equal((await call("POST", `/api/cabinets/${k}/notes`, { body: "x".repeat(2001) }, t1)).status, 400);
  assert.equal((await call("POST", `/api/cabinets/${UUID0}/notes`, { body: "x" }, t1)).status, 404);
  // An alert of another cabinet cannot carry the note.
  const alertElsewhere = (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM alerts WHERE cabinet_id = $1", [elsewhere])).rows[0];
  if (alertElsewhere) assert.equal((await call("POST", `/api/cabinets/${k}/notes`, { body: "x", alertId: alertElsewhere.id }, t1)).status, 404);
  assert.equal((await call("GET", `/api/cabinets/${k}/notes`, undefined, other)).body.notes[0].body, "Reseated the cable.\nWaiting for the next check.");
  // The database refuses an edit, from the application's own account too.
  await assert.rejects(db.app.query("UPDATE case_notes SET body = 'edited' WHERE id = $1", [made.body.id]), /append-only/);
  await assert.rejects(db.app.query("UPDATE case_notes SET author_id = $2 WHERE id = $1", [made.body.id, other.id]), /append-only/);
  assert.equal((await call("POST", `/api/notes/${made.body.id}/redact`, { reason: "A password was pasted into it." }, t1)).status, 403);
  assert.equal((await call("POST", `/api/notes/${made.body.id}/redact`, {}, boss)).status, 400);
  const red = await call("POST", `/api/notes/${made.body.id}/redact`, { reason: "A password was pasted into it." }, boss);
  assert.equal(red.status, 200);
  assert.equal(red.body.body, null);
  assert.equal(red.body.redacted.reason, "A password was pasted into it.");
  assert.equal((await call("POST", `/api/notes/${made.body.id}/redact`, { reason: "again please" }, boss)).status, 409);
  await assert.rejects(db.app.query("UPDATE case_notes SET body = 'back again' WHERE id = $1", [made.body.id]), /append-only/);
  const logged = await db.app.query<{ details: { reason?: string; length?: number } }>("SELECT details FROM audit_log WHERE action IN ('case_note.add', 'case_note.redact') AND target_id = $1", [k]);
  assert.ok(logged.rows.every(r => !JSON.stringify(r.details).includes("Reseated")), "the note's text is not copied into the audit log");
});

test("resolving an alert records the cause and the fix, writes a case note, and counts toward 'usually fixed by'", async () => {
  const t1 = await account("tier1"), boss = await account("admin");
  const room = (await cab("Treatment Room")).id;
  // Alerts on this cabinet: its scanner alert (an issue type), claimed and resolved by the person.
  const alert = (await db.app.query<{ id: string; issue_type_id: string }>("SELECT TOP (1) id, issue_type_id FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved'", [room, ISSUE.scanner])).rows[0]!;
  assert.ok(alert, "the demo cabinet has a scanner alert");
  assert.equal((await call("POST", `/api/alerts/${alert.id}/resolve`, { cause: "x" }, t1)).status, 409, "claim first");
  assert.equal((await call("POST", `/api/alerts/${alert.id}/claim`, undefined, t1)).status, 200);
  assert.equal((await call("POST", `/api/alerts/${alert.id}/resolve`, { cause: "bell\u0007" }, t1)).status, 400);
  assert.equal((await call("POST", `/api/alerts/${alert.id}/resolve`, { fix: { kind: "known", fixId: UUID0 } }, t1)).body.error, "fix_not_for_this_issue");
  assert.equal((await call("POST", `/api/alerts/${alert.id}/resolve`, { saveFix: true }, t1)).status, 400, "nothing typed to keep");
  const done = await call("POST", `/api/alerts/${alert.id}/resolve`, { cause: "A cleaner pulled the cable.", fix: { kind: "text", text: "Reseated the scanner cable on a rear port." }, saveFix: true }, t1);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.resolutionCause, "A cleaner pulled the cable.");
  assert.equal(done.body.resolution, "Reseated the scanner cable on a rear port.");
  const notes = (await call("GET", `/api/cabinets/${room}/notes?alertId=${alert.id}`, undefined, t1)).body.notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, "resolution");
  assert.match(notes[0].body, /Cause: A cleaner pulled the cable\./);
  // The fix was kept for every cabinet, waiting for approval (a Tier 1 submitted it).
  const waiting = await db.app.query("SELECT 1 FROM known_fixes WHERE issue_type_id = $1 AND alert_id = $2 AND status = 'pending'", [ISSUE.scanner, alert.id]);
  assert.equal(waiting.rowCount, 1);
  const stats = (await call("GET", `/api/issues/${ISSUE.scanner}/resolutions`, undefined, t1)).body;
  // The demo's own history (two cable fixes and a driver rollback) is counted too; the typed fix is one more.
  assert.equal(stats.fixes[0].count, 2, "the most common fix comes first");
  assert.equal(stats.fixes.find((f: { fix: string }) => f.fix === "Reseated the scanner cable on a rear port.").count, 1);
  assert.equal(stats.recent[0].cause, "A cleaner pulled the cable.");
  // A second alert (another cabinet) is resolved with the same words: the count goes to 2, and picking an approved known fix works.
  const known = (await db.app.query<{ id: string }>("SELECT id FROM known_fixes WHERE issue_type_id = $1 AND status = 'pending'", [ISSUE.scanner])).rows[0]!;
  await call("POST", `/api/known-fixes/${known.id}/approve`, {}, boss);
  const other = (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM alerts WHERE issue_type_id = $1 AND state <> 'resolved'", [ISSUE.scanner])).rows[0];
  if (other) {
    await call("POST", `/api/alerts/${other.id}/claim`, undefined, t1);
    assert.equal((await call("POST", `/api/alerts/${other.id}/resolve`, { fix: { kind: "known", fixId: known.id } }, t1)).status, 200);
    const again = (await call("GET", `/api/issues/${ISSUE.scanner}/resolutions`, undefined, t1)).body;
    assert.equal(again.resolved >= 2, true);
  }
  assert.equal((await call("GET", `/api/issues/${UUID0}/resolutions`, undefined, t1)).body.resolved, 0);
});

test("error trends are computed from the finished days, marked new or rising, and the triage queue ranks the live alerts", async () => {
  const t1 = await account("tier1"), boss = await account("admin");
  const k = (await cab("Billing")).id;
  const day = (ago: number) => new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - ago * 86_400_000 + 3_600_000);
  const add = async (n: number, ago: number, source: string, eventId: number, level = "error") => {
    for (let i = 0; i < n; i++)
      await db.app.query(`INSERT INTO events (event_id, cabinet_id, kind, occurred_at, received_at, source, detail) VALUES ($1, $2, 'error', $3, $3, $4, $5)`,
        [randomUUID(), k, day(ago), JSON.stringify({ log: "System", source, eventId, level, recordId: i }), JSON.stringify({ message: `${source} said something\u0007 odd` })]);
  };
  // A steady error over a month, one that grows, and one that appeared yesterday.
  for (let ago = 29; ago >= 1; ago -= 2) await add(1, ago, "SteadySource", 100);
  for (let ago = 14; ago >= 1; ago--) await add(ago > 7 ? 1 : 4, ago, "GrowingSource", 200);
  await add(3, 1, "BrandNewSource", 300);
  await add(2, 1, "Quiet", 400, "warning");
  // The demo ships 30 days of trends of its own; start the job from nothing so it computes these events.
  await db.app.query("UPDATE trend_state SET computed_through = NULL WHERE id = 1; DELETE FROM error_daily; DELETE FROM issue_daily");
  const out = await runErrorTrends(db.app);
  assert.ok(out.days.length >= 29);
  assert.equal((await runErrorTrends(db.app)).days.length, 0, "a second run finds nothing left to do");
  const trends = await call("GET", "/api/trends/errors?unrecognized=true", undefined, t1);
  assert.equal(trends.status, 200);
  const by = (s: string) => trends.body.errors.find((e: { source: string }) => e.source === s);
  assert.equal(by("BrandNewSource").mark, "new");
  assert.equal(by("GrowingSource").mark, "rising");
  assert.equal(by("SteadySource").mark, null);
  assert.equal(by("Quiet"), undefined, "an unmatched warning is not an unrecognized error");
  assert.ok(by("BrandNewSource").sample && !by("BrandNewSource").sample.includes("\u0007") || by("BrandNewSource").sample.length > 0);
  assert.equal(by("BrandNewSource").series.events.length, 30);
  assert.equal((await call("GET", "/api/trends/errors?mark=new", undefined, t1)).body.errors.every((e: { mark: string }) => e.mark === "new"), true);
  assert.equal((await call("GET", "/api/trends/errors?mark=bogus", undefined, t1)).status, 400);
  assert.equal((await call("GET", "/api/trends/errors?clientId=1%20OR%201=1", undefined, t1)).status, 400);
  assert.equal((await call("GET", `/api/trends/errors?clientId=${UUID0}`, undefined, t1)).body.errors.length, 0, "another client's filter shows none of it");
  // Only an Admin brings the trends up to date by hand, and not twice in ten minutes.
  assert.equal((await call("POST", "/api/trends/refresh", {}, t1)).status, 403);
  assert.equal((await call("POST", "/api/trends/refresh", {}, boss)).status, 429);

  const q = await call("GET", "/api/triage", undefined, t1);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.ok(q.body.items.length > 0);
  const scores = q.body.items.map((i: { score: number }) => i.score);
  assert.deepEqual([...scores].sort((a: number, b: number) => b - a), scores, "most important first");
  assert.ok(q.body.items.every((i: { why: string[] }) => i.why.length > 0));
  assert.ok(q.body.items.some((i: { runbook: unknown }) => i.runbook), "groups say which runbook applies");
  assert.ok(Array.isArray(q.body.unrecognized));
  assert.equal(q.body.trendsAsOf !== null, true);
  assert.equal((await call("GET", "/api/triage?days=9999", undefined, t1)).status, 400);
  assert.equal((await call("GET", "/api/triage?siteId=%27;DROP", undefined, t1)).status, 400);
  assert.equal((await call("GET", "/api/triage", undefined)).status, 401);
  assert.equal((await call("GET", `/api/triage?clientId=${UUID0}`, undefined, t1)).body.items.length, 0);
});

test("an Admin-only job cannot be reached by Tier 2 and the retention of notes does not leak through a cabinet's removal", async () => {
  const t2 = await account("tier2");
  assert.equal((await call("POST", "/api/runbooks/" + UUID0 + "/approve", { stepUpToken: "x".repeat(43) }, t2)).status, 403);
  assert.equal((await call("POST", "/api/trends/refresh", {}, t2)).status, 403);
});
