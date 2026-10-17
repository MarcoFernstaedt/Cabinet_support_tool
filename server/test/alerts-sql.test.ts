// The alerts, rules, crashes, known-fix and evidence services against a real SQL Server, set up with plain SQL so the
// tests do not depend on other modules. Includes hostile input (long signatures, SQL in phrases, huge messages).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { alertById, cabinetEvents, claimAlert, foldAlert, listAlerts, normalizeSignature, resolveAlert, resolveOfflineFor, sameErrorElsewhere, SIGNATURE_MAX, summary, unrecognizedSignature, upsertAlert } from "../src/services/alerts.js";
import { checkQuietLoops, checkRebootLoop, fleetCrashIncident, recordBoot, timeline, cabinetCrashes } from "../src/services/crashes.js";
import { buildEvidence, verifyEvidence } from "../src/services/evidence.js";
import { storeEvents } from "../src/services/events.js";
import { environmentOf, fixesForFindings, listKnownFixes, markSeen, pendingCount, removeKnownFix, reviewKnownFix, reviewQueue, saveKnownFix } from "../src/services/known-fixes.js";
import { ISSUE, liveRules, matches, matchSql, preview } from "../src/services/rules.js";
import { checkSiteOutages } from "../src/services/site-outage.js";
import { Refused } from "../src/services/errors.js";
import type { Event, SymptomMatch } from "../src/contracts.js";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
const id = { client: randomUUID(), site: randomUUID(), site2: randomUUID(), a: randomUUID(), b: randomUUID(), c: randomUUID(), d: randomUUID(), admin: randomUUID(), t1: randomUUID() };
const ISSUES = [ISSUE.drive, ISSUE.offline, ISSUE.siteOutage, ISSUE.rebootLoop, ISSUE.scanner];

test.before(async () => {
  db = await createTestDatabase();
  await asOwner(db, async c => {
    for (const [i, t] of ISSUES.entries())
      await c.query("IF NOT EXISTS (SELECT 1 FROM issue_types WHERE id = $1) INSERT INTO issue_types (id, [key], name, severity, description, built_in) VALUES ($1, $2, $2, 'major', 'x', 1)", [t, `issue-${i}`]);
  });
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Acme')", [id.client]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $3, 'North'), ($2, $3, 'South')", [id.site, id.site2, id.client]);
  for (const [cab, site, name] of [[id.a, id.site, "A"], [id.b, id.site, "B"], [id.c, id.site2, "C"], [id.d, id.site2, "D"]] as const)
    await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES ($1, $2, $3, 'standalone', 'active', SYSUTCDATETIME())", [cab, site, name]);
  await db.app.query("INSERT INTO users (id, username, name, role, password_hash, can_approve_fixes) VALUES ($1, 'admin', 'Admin', 'admin', 'x', 1), ($2, 't1', 'Tier One', 'tier1', 'x', 0)", [id.admin, id.t1]);
});
test.after(async () => { await db.drop(); });

const base = (cabinetId: string, signature: string, severity = "minor") => ({ cabinetId, issueTypeId: ISSUE.drive, severity, signature, title: "T", seenAt: new Date(), ruleId: null, eventId: null });
const count = async (sql: string, p: unknown[] = []) => Number((await db.app.query<{ n: number }>(sql, p)).rows[0]!.n);

test("a signature longer than the column is cut and ends in a hash, deterministically and distinctly", async () => {
  const short = "x".repeat(SIGNATURE_MAX);
  assert.equal(normalizeSignature(short), short);
  const a = "p".repeat(2000) + "A", b = "p".repeat(2000) + "B";
  assert.equal(normalizeSignature(a).length, SIGNATURE_MAX);
  assert.equal(normalizeSignature(a), normalizeSignature(a));
  assert.notEqual(normalizeSignature(a), normalizeSignature(b));
  assert.ok(unrecognizedSignature({ kind: "error", source: { log: "System", source: "S".repeat(3000), eventId: 1, level: "error", recordId: 1 } }).length <= SIGNATURE_MAX);
  const one = await upsertAlert(db.app, base(id.a, a)), again = await upsertAlert(db.app, base(id.a, a)), other = await upsertAlert(db.app, base(id.a, b));
  assert.deepEqual([one.created, again.created, again.id === one.id, other.id !== one.id], [true, false, true, true]);
  assert.equal((await db.app.query<{ occurrences: number; signature: string }>("SELECT occurrences, signature FROM alerts WHERE id = $1", [one.id])).rows[0]!.occurrences, 2);
});

test("repeats fold into one active alert; severity only rises; time is bounded; a resolved alert starts a new one", async () => {
  const sig = `fold:${randomUUID()}`;
  const first = await upsertAlert(db.app, { ...base(id.a, sig), seenAt: new Date(Date.now() - 3_600_000) });
  await upsertAlert(db.app, { ...base(id.a, sig, "major"), seenAt: new Date(Date.now() + 86_400_000) });
  await upsertAlert(db.app, base(id.a, sig, "minor"));
  const row = (await db.app.query<{ occurrences: number; severity: string; first_seen: Date; last_seen: Date }>("SELECT * FROM alerts WHERE id = $1", [first.id])).rows[0]!;
  assert.deepEqual([row.occurrences, row.severity], [3, "major"]);
  assert.ok(row.last_seen.getTime() <= Date.now() + 1000, "a clock in the future is capped");
  assert.ok(row.first_seen.getTime() < Date.now() - 3_000_000);
  await claimAlert(db.app, id.t1, first.id);
  await resolveAlert(db.app, { userId: id.t1, role: "tier1" }, first.id, "ok");
  const next = await upsertAlert(db.app, base(id.a, sig));
  assert.ok(next.created && next.id !== first.id);
});

test("many writers at once make exactly one alert and count every sighting", async () => {
  const sig = `race:${randomUUID()}`;
  const results = await Promise.all(Array.from({ length: 12 }, () => upsertAlert(db.app, base(id.b, sig))));
  assert.equal(new Set(results.map(r => r.id)).size, 1);
  assert.equal(results.filter(r => r.created).length, 1);
  assert.equal(await count("SELECT occurrences AS n FROM alerts WHERE cabinet_id = $1 AND signature = $2", [id.b, sig]), 12);
});

test("claim and resolve refuse correctly", async () => {
  const a = await upsertAlert(db.app, base(id.c, `claim:${randomUUID()}`));
  await claimAlert(db.app, id.t1, a.id);
  await assert.rejects(claimAlert(db.app, id.admin, a.id), (e: Refused) => e.code === "already_claimed");
  await assert.rejects(resolveAlert(db.app, { userId: id.admin, role: "tier2" }, a.id, undefined), (e: Refused) => e.code === "claim_first");
  await assert.rejects(claimAlert(db.app, id.t1, randomUUID()), (e: Refused) => e.code === "not_found");
  assert.equal((await resolveAlert(db.app, { userId: id.admin, role: "admin" }, a.id, undefined)).state, "resolved");
  await assert.rejects(resolveAlert(db.app, { userId: id.admin, role: "admin" }, a.id, undefined), (e: Refused) => e.code === "already_resolved");
  await assert.rejects(claimAlert(db.app, id.t1, a.id), (e: Refused) => e.code === "already_resolved");
});

test("listing, filters, order and the summary", async () => {
  const all = await listAlerts(db.app, {}, id.t1);
  assert.ok(all.length > 0 && all.every(a => a.state !== "resolved"));
  const majors = all.map(a => a.severity === "major" ? 0 : 1);
  assert.deepEqual(majors, [...majors].sort(), "major first");
  assert.ok((await listAlerts(db.app, { state: "resolved" }, id.t1)).every(a => a.state === "resolved"));
  assert.ok((await listAlerts(db.app, { cabinetId: id.b }, id.t1)).every(a => a.cabinet.id === id.b));
  assert.ok((await listAlerts(db.app, { unrecognized: "true" } as never, id.t1)).every(a => a.unrecognized));
  assert.equal((await listAlerts(db.app, { claimedBy: "me" } as never, id.t1)).every(a => a.claimedBy?.id === id.t1), true);
  const s = await summary(db.app);
  assert.equal(s.active, all.length);
  assert.equal(await alertById(db.app, randomUUID()), null);
});

test("events are stored once; an unrecognized error raises one alert; hostile text is just text", async () => {
  const ev = (over: Record<string, unknown> = {}): Event => ({ eventId: randomUUID(), kind: "error", occurredAt: new Date().toISOString(), severityHint: "minor",
    source: { log: "System", source: "Contoso'; DROP TABLE alerts;--", eventId: 77, level: "error", recordId: 1 }, detail: { message: "m".repeat(9000) + " needle" }, ...over } as Event);
  const e1 = ev();
  const first = await storeEvents(db.app, id.d, { events: [e1, e1] });
  assert.equal(first.stored, 1, "a repeated id inside a batch counts once");
  const again = await storeEvents(db.app, id.d, { events: [e1] });
  assert.equal(again.stored, 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM events WHERE event_id = $1", [e1.eventId]), 1);
  await storeEvents(db.app, id.d, { events: [ev()] });
  const alert = (await db.app.query<{ occurrences: number; issue_type_id: string | null }>("SELECT occurrences, issue_type_id FROM alerts WHERE cabinet_id = $1 AND signature LIKE 'unrecognized:%'", [id.d])).rows;
  assert.deepEqual([alert.length, alert[0]!.occurrences, alert[0]!.issue_type_id], [1, 2, null]);
  assert.equal((await cabinetEvents(db.app, id.d)).length, 2);
  const el = await sameErrorElsewhere(db.app, id.a, "System", "Contoso'; DROP TABLE alerts;--", 77);
  assert.deepEqual([el.otherCabinets, el.events], [1, 2]);
  assert.ok((await db.app.query("SELECT 1 FROM alerts")).rowCount! > 0, "the table is still there");
  // Scanner recovery resolves its alert.
  await upsertAlert(db.app, { ...base(id.d, "scanner"), issueTypeId: ISSUE.scanner });
  await storeEvents(db.app, id.d, { events: [ev({ kind: "scanner", detail: { message: "ok" }, device: { hardwareIds: ["X"], state: "recovered" } })] });
  assert.equal(await count("SELECT COUNT(*) AS n FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2 AND state = 'resolved'", [id.d, ISSUE.scanner]), 1);
});

test("the SQL form of a match agrees with the code form, including a message longer than 4000 characters", async () => {
  const cases: SymptomMatch[] = [{ eventId: 77 }, { source: "CONTOSO'; drop table alerts;--" }, { phrase: "NEEDLE" }, { phrase: "m".repeat(10) + "x" }, { log: "Application", eventId: 77 }, { log: "System", level: "error" }, { kind: "error", phrase: "x'; --" }];
  const rows = (await db.app.query<{ event_id: string; kind: string; source: Event["source"]; detail: Event["detail"]; device: Event["device"] }>("SELECT event_id, kind, source, detail, device FROM events WHERE cabinet_id = $1", [id.d])).rows;
  for (const m of cases) {
    const { where, params } = matchSql(m, 2);
    const got = (await db.app.query<{ event_id: string }>(`SELECT event_id FROM events e WHERE e.cabinet_id = $1 AND ${where}`, [id.d, ...params])).rows.map(r => r.event_id).sort();
    const want = rows.filter(r => matches(m, { kind: r.kind as Event["kind"], ...(r.source ? { source: r.source } : {}), ...(r.detail ? { detail: r.detail } : {}), ...(r.device ? { device: r.device } : {}) } as Parameters<typeof matches>[1])).map(r => r.event_id).sort();
    assert.deepEqual(got, want, JSON.stringify(m));
  }
  const p = await preview(db.app, { eventId: 77 });
  assert.ok(p.events >= 2 && p.cabinets >= 1);
  assert.deepEqual(await liveRules(db.app), []);
});

test("offline alerts are raised past the threshold and resolve when the cabinet is back", async () => {
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(day, -5, SYSUTCDATETIME()) WHERE id = $1", [id.a]);
  const { checkOffline, offline } = await import("../src/services/alerts.js");
  const r1 = await checkOffline(db.app), r2 = await checkOffline(db.app);
  assert.deepEqual([r1.raised, r2.raised], [1, 0]);
  const list = await offline(db.app, {});
  assert.equal(list.level, "clients");
  assert.equal((list.items[0] as { offline: number }).offline, 1);
  assert.equal((await offline(db.app, { siteId: id.site })).level, "cabinets");
  assert.equal((await offline(db.app, { clientId: id.client })).level, "sites");
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME() WHERE id = $1", [id.a]);
  assert.equal(await resolveOfflineFor(db.app, id.a), 1);
  assert.equal(await resolveOfflineFor(db.app, null), 0);
});

test("a site whose cabinets all went quiet together is an outage; it closes when one is heard from", async () => {
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(minute, -60, SYSUTCDATETIME()) WHERE site_id = $1", [id.site2]);
  const r1 = await checkSiteOutages(db.app), r2 = await checkSiteOutages(db.app);
  assert.deepEqual([r1.raised, r2.raised], [2, 0], "two cabinets, once");
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME() WHERE id = $1", [id.c]);
  assert.equal((await checkSiteOutages(db.app)).resolved, 2);
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME() WHERE site_id = $1", [id.site2]);
});

test("boots are folded, three in an hour is a reboot loop, a quiet restarting cabinet is found", async () => {
  const now = Date.now();
  assert.equal(await recordBoot(db.app, id.b, new Date(now - 50 * 60_000), "event"), true);
  assert.equal(await recordBoot(db.app, id.b, new Date(now - 49 * 60_000), "heartbeat"), false, "within three minutes is the same boot");
  await recordBoot(db.app, id.b, new Date(now - 30 * 60_000), "event");
  assert.equal(await checkRebootLoop(db.app, id.b), false);
  await recordBoot(db.app, id.b, new Date(now - 10 * 60_000), "event");
  assert.equal(await count("SELECT COUNT(*) AS n FROM alerts WHERE cabinet_id = $1 AND signature = 'reboot_loop' AND state <> 'resolved'", [id.b]), 1);
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(minute, -30, SYSUTCDATETIME()), uptime_seconds = 100 WHERE id = $1", [id.d]);
  await db.app.query("INSERT INTO cabinet_boots (cabinet_id, booted_at, source) VALUES ($1, DATEADD(minute, -60, SYSUTCDATETIME()), 'event'), ($1, DATEADD(minute, -40, SYSUTCDATETIME()), 'event')", [id.d]);
  assert.equal(await checkQuietLoops(db.app), 1);
});

test("timeline, crashes, the fleet incident and the evidence package", async () => {
  const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const change = (m: number, src: string, eid: number, message: string): Event => ({ eventId: randomUUID(), kind: "change", occurredAt: at(m), severityHint: "minor", source: { log: "System", source: src, eventId: eid, level: "information", recordId: 1 }, detail: { message } });
  const crash = (m: number): Event => ({ eventId: randomUUID(), kind: "error", occurredAt: at(m), severityHint: "major", source: { log: "System", source: "BugCheck", eventId: 1001, level: "error", recordId: 2 },
    detail: { message: "The computer has rebooted from a bugcheck. The bugcheck was: 0x0000007e (0x1, 0x2)." } });
  for (const cab of [id.a, id.c])
    await storeEvents(db.app, cab, { events: [change(600, "Microsoft-Windows-WindowsUpdateClient", 19, "Installation Successful: Windows successfully installed the following update: KB1"), crash(300)] });
  const from = new Date(Date.now() - 86_400_000), to = new Date();
  const items = await timeline(db.app, id.a, from, to);
  assert.ok(items.some(i => i.category === "crash" && i.stopCode?.name === "SYSTEM_THREAD_EXCEPTION_NOT_HANDLED"));
  const c = await cabinetCrashes(db.app, id.a, 7);
  assert.equal(c.crashes, 1);
  assert.ok(c.beforeFirst.some(i => i.title.includes("KB1")));
  const inc = await fleetCrashIncident(db.app, { from, to });
  assert.equal(inc.affected, 4, "two crashed, two are in a reboot loop from the earlier test");
  assert.equal(inc.cabinets, 4);
  const upd = inc.comparisons.find(x => x.change.includes("KB1"));
  assert.equal(upd?.affected, 2);
  assert.equal((await fleetCrashIncident(db.app, { from, to, clientId: randomUUID() })).cabinets, 0);
  const pkg = await buildEvidence(db.app, id.a, from, to, { userId: id.admin, name: "Admin" });
  assert.ok(pkg && verifyEvidence(JSON.parse(JSON.stringify(pkg))));
  assert.equal(await buildEvidence(db.app, randomUUID(), from, to, { userId: id.admin, name: "Admin" }), null);
});

test("known fixes: submit, approve once, visibility, seen counts, removal", async () => {
  const body = (title: string) => ({ title, solution: "Reseat the cable.", cabinetId: id.a, symptom: { kind: "finding" as const, key: "obs-errors" } });
  const mine = await saveKnownFix(db.app, { userId: id.t1, canApproveFixes: false }, body("Waiting"));
  assert.equal(mine.status, "pending");
  const auto = await saveKnownFix(db.app, { userId: id.admin, canApproveFixes: true }, { ...body("Auto"), symptom: { kind: "issue", issueTypeId: ISSUE.drive } });
  assert.equal(auto.status, "approved");
  await assert.rejects(saveKnownFix(db.app, { userId: id.admin, canApproveFixes: true }, { ...body("x"), symptom: { kind: "issue", issueTypeId: randomUUID() } }), (e: Refused) => e.code === "not_found");
  assert.equal((await listKnownFixes(db.app, { findingKey: "obs-errors" }, id.admin)).length, 0, "pending is private to its submitter");
  assert.equal((await listKnownFixes(db.app, { findingKey: "obs-errors" }, id.t1)).length, 1);
  assert.equal(await pendingCount(db.app), 1);
  assert.equal((await reviewQueue(db.app)).pending.length, 1);
  assert.equal((await reviewKnownFix(db.app, id.admin, mine.id, "approved")).status, "approved");
  await assert.rejects(reviewKnownFix(db.app, id.admin, mine.id, "rejected"), (e: Refused) => e.code === "not_pending");
  const f = await fixesForFindings(db.app, ["obs-errors-12", "other-3"]);
  assert.deepEqual(Object.keys(f), ["obs-errors-12"]);
  await markSeen(db.app, [mine.id]);
  await markSeen(db.app, []);
  assert.equal(await count("SELECT seen_count AS n FROM known_fixes WHERE id = $1", [mine.id]), 1);
  await removeKnownFix(db.app, id.admin, mine.id);
  await assert.rejects(removeKnownFix(db.app, id.admin, mine.id), (e: Refused) => e.code === "not_found");
  const env = await environmentOf(db.app, id.a);
  assert.equal(env.client, "Acme");
  await assert.rejects(environmentOf(db.app, randomUUID()), (e: Refused) => e.code === "not_found");
});

test("foldAlert regroup mode adds counts to the active alert", async () => {
  const sig = `regroup:${randomUUID()}`;
  const w = { cabinetId: id.c, issueTypeId: ISSUE.drive, severity: "minor", signature: sig, title: "T", firstSeen: new Date(Date.now() - 5000), lastSeen: new Date(), ruleId: null, eventId: null, occurrences: 4 };
  const a = await db.app.transaction(tx => foldAlert(tx, w, "regroup"));
  const b = await db.app.transaction(tx => foldAlert(tx, w, "regroup"));
  assert.deepEqual([a.created, b.created, a.id === b.id], [true, false, true]);
  assert.equal(await count("SELECT occurrences AS n FROM alerts WHERE id = $1", [a.id]), 8);
});
