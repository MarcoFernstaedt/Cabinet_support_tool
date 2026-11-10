// The changes that let one SQL Server Express database carry 10,000 cabinets (docs/platform/performance.md "Database size"): batched
// retention and the hourly roll-up of load samples, the data diet in the schema, set-based event ingest with the rules in memory, batched
// audit entries and the incremental chain check, the notification feed's look-back, the outage guard on offline judgements, and lock().
// Includes hostile input: odd text in events, malformed audit batches, bad maintenance times.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { advanceAuditCheckpoint, audit, auditCheckpoint, auditMany, isDeadlock, lock, LockDeadlock, Pool, transaction, Tx, verifyAuditChain, type Queryable } from "../src/db/db.js";
import { FAILURES_UNTIL_DOWN, NotificationFeed } from "../src/db/notifications.js";
import { checkOffline, FleetContact, resolveOfflineFor, upsertAlert } from "../src/services/alerts.js";
import { bootFromHeartbeat, crossedRecovery, LOOP_RECOVERED_SECONDS } from "../src/services/crashes.js";
import { storeEvents } from "../src/services/events.js";
import { chainCheckMode, inBatches, nextRunAt, parseDailyTime, pruneNotifications, rollUpAndTrimSamples, runRetention, verifyChainAndAlert } from "../src/services/maintenance.js";
import { healthHistory } from "../src/services/readings.js";
import { flushRuleHits, ISSUE, listRules } from "../src/services/rules.js";
import { checkSiteOutages } from "../src/services/site-outage.js";
import { envelopes, type Event } from "../src/contracts.js";
import { recordHeartbeat } from "../src/services/cabinets.js";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
const ids = { client: randomUUID(), site: randomUUID(), quiet: randomUUID(), a: randomUUID(), b: randomUUID(), q1: randomUUID(), q2: randomUUID(), admin: randomUUID() };
const FAST = { batch: 3, pauseMs: 0, timeoutMs: 10_000 };

test.before(async () => {
  db = await createTestDatabase();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Acme')", [ids.client]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $3, 'North'), ($2, $3, 'Quiet')", [ids.site, ids.quiet, ids.client]);
  for (const [cab, site, name] of [[ids.a, ids.site, "A"], [ids.b, ids.site, "B"], [ids.q1, ids.quiet, "Q1"], [ids.q2, ids.quiet, "Q2"]] as const)
    await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES ($1, $2, $3, 'standalone', 'active', SYSUTCDATETIME())", [cab, site, name]);
  await db.app.query("INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, 'admin', 'Admin', 'admin', 'x')", [ids.admin]);
});
test.after(async () => { await db.drop(); });

const count = async (sql: string, p: unknown[] = []) => Number((await db.app.query<{ n: number }>(sql, p)).rows[0]!.n);
const now = () => new Date().toISOString();
const err = (source: string, eventId: number, o: Partial<Event> & { level?: "error" | "warning" | "critical"; message?: string } = {}): Event => ({
  eventId: randomUUID(), kind: "error", occurredAt: now(), severityHint: "minor",
  source: { log: "System", source, eventId, level: o.level ?? "error", recordId: 1 + Math.floor(Math.random() * 1e9) }, detail: { message: o.message ?? "m" }, ...o,
} as Event);
const service = (name: string, change: string): Event => ({ eventId: randomUUID(), kind: "service", occurredAt: now(), severityHint: "minor", detail: { message: "s", fields: { service: name, change } } } as Event);

// ---- The schema ------------------------------------------------------------------------------------------------------------

test("the data diet is in the schema: JSON as UTF-8 varchar, page compression, events clustered on seq, filtered and retention indexes", async () => {
  const json = (await asOwner(db, c => c.query<{ t: string; c: string; type: string; collation: string | null }>(
    `SELECT OBJECT_NAME(col.object_id) AS t, col.name AS c, TYPE_NAME(col.user_type_id) AS type, col.collation_name AS collation FROM sys.check_constraints cc
       JOIN sys.columns col ON col.object_id = cc.parent_object_id AND col.column_id = cc.parent_column_id WHERE cc.definition LIKE '%isjson%'`))).rows;
  assert.ok(json.length >= 30);
  for (const j of json) assert.deepEqual([j.type, j.collation], ["varchar", "Latin1_General_100_CI_AS_SC_UTF8"], `${j.t}.${j.c}`);
  const compressed = new Set((await asOwner(db, c => c.query<{ t: string }>(
    "SELECT DISTINCT OBJECT_NAME(p.object_id) AS t FROM sys.partitions p WHERE p.index_id IN (0, 1) AND p.data_compression_desc = 'PAGE'"))).rows.map(r => r.t));
  for (const t of ["events", "health_samples", "drive_samples", "audit_log", "commands", "alerts", "health_hourly"]) assert.ok(compressed.has(t), t);
  const idx = new Map((await asOwner(db, c => c.query<{ name: string; type: string; filter: string | null; uniq: boolean }>(
    "SELECT i.name, i.type_desc AS type, i.filter_definition AS filter, i.is_unique AS uniq FROM sys.indexes i WHERE i.name IS NOT NULL"))).rows.map(r => [r.name, r]));
  assert.equal(idx.get("events_seq")?.type, "CLUSTERED");
  assert.deepEqual([idx.get("events_pkey")?.type, idx.get("events_pkey")?.uniq], ["NONCLUSTERED", true]);
  assert.match(idx.get("events_alert")?.filter ?? "", /alert_id\] IS NOT NULL/);
  assert.equal(idx.has("events_received"), false, "the unused index on occurred_at alone is gone");
  for (const name of ["commands_result_at", "firewall_changes_occurred", "diagnoses_started", "cabinet_boots_booted", "alerts_open_issue", "events_received_at"]) assert.ok(idx.has(name), name);
  // Each trigger leaves at once when its statement touched no row.
  const triggers = (await asOwner(db, c => c.query<{ name: string; body: string }>(
    "SELECT t.name, m.definition AS body FROM sys.triggers t JOIN sys.sql_modules m ON m.object_id = t.object_id WHERE t.name LIKE '%notify'"))).rows;
  assert.equal(triggers.length, 3);
  for (const t of triggers) assert.match(t.body, /BEGIN\s+IF @@ROWCOUNT = 0 RETURN;/, t.name);
});

test("JSON in UTF-8 columns keeps any text exactly and still comes back parsed", async () => {
  const text = "Fehler: Größe überschritten — 指紋センサー 🔒 \"quoted\" '; DROP TABLE events; -- \\ back".repeat(80); // over 4,000 characters
  const e = err("Unicode-Test", 1, { message: text });
  await storeEvents(db.app, ids.a, { events: [e] });
  const row = (await db.app.query<{ detail: { message: string }; source: { source: string } }>("SELECT detail, source FROM events WHERE event_id = $1", [e.eventId])).rows[0]!;
  assert.equal(row.detail.message, text);
  assert.equal(row.source.source, "Unicode-Test");
  const nul = err("Nul", 2, { message: "a\u0000b" });
  await storeEvents(db.app, ids.a, { events: [nul] });
  assert.equal((await db.app.query<{ detail: { message: string } }>("SELECT detail FROM events WHERE event_id = $1", [nul.eventId])).rows[0]!.detail.message, "ab");
});

// ---- Event ingest ------------------------------------------------------------------------------------------------------------

test("a batch is judged as if one event at a time: repeats fold, a warning is only stored, the first of an alert is the one that created it", async () => {
  const first = err("Batch-Source", 100), dup = { ...first };
  const r = await storeEvents(db.app, ids.a, { events: [first, dup, err("Batch-Source", 100), err("Batch-Source", 100, { level: "warning" }), err("batch-source", 100)] });
  assert.equal(r.stored, 4, "the same eventId twice in one batch is stored once");
  assert.deepEqual(r.outcomes.map(o => o.kind), ["unrecognized", "unrecognized", "stored", "unrecognized"]);
  const alertIds = r.outcomes.filter(o => o.kind === "unrecognized").map(o => (o as { alertId: string }).alertId);
  assert.equal(new Set(alertIds).size, 1, "the source's case does not split the alert");
  assert.deepEqual(r.outcomes.filter(o => o.kind === "unrecognized").map(o => (o as { created: boolean }).created), [true, false, false]);
  const a = (await db.app.query<{ occurrences: number; last_event_id: string }>("SELECT occurrences, last_event_id FROM alerts WHERE id = $1", [alertIds[0]])).rows[0]!;
  assert.equal(a.occurrences, 3);
  const linked = await count("SELECT COUNT(*) AS n FROM events WHERE alert_id = $1", [alertIds[0]]);
  assert.equal(linked, 3, "every event of the alert points at it");
  const again = await storeEvents(db.app, ids.a, { events: [first] });
  assert.deepEqual([again.stored, again.outcomes.length], [0, 0], "a retried batch changes nothing");
});

test("a minor and a major symptom of one issue in the same batch make one major alert; a recovery between two failures splits them", async () => {
  // Built-in rules: disk 15 is a minor drive symptom, disk 7 a major one.
  const r = await storeEvents(db.app, ids.b, { events: [err("disk", 15), err("disk", 7)] });
  const [x, y] = r.outcomes as { kind: string; alertId: string; issueTypeId: string; created: boolean }[];
  assert.deepEqual([x!.kind, y!.kind, x!.issueTypeId, x!.alertId === y!.alertId, x!.created, y!.created], ["issue", "issue", ISSUE.drive, true, true, false]);
  const a = (await db.app.query<{ severity: string; occurrences: number; rule_id: string }>("SELECT severity, occurrences, rule_id FROM alerts WHERE id = $1", [x!.alertId])).rows[0]!;
  assert.deepEqual([a.severity, a.occurrences, a.rule_id], ["major", 2, "00000000-0000-4000-8000-000000000301"]);

  const s = await storeEvents(db.app, ids.b, { events: [service("Spooler", "failing"), service("Spooler", "recovered"), service("Spooler", "failing")] });
  const [f1, rec, f2] = s.outcomes as { kind: string; alertId?: string; alertIds?: string[]; created?: boolean }[];
  assert.deepEqual([f1!.kind, rec!.kind, f2!.kind], ["issue", "resolved", "issue"]);
  assert.deepEqual(rec!.alertIds, [f1!.alertId]);
  assert.notEqual(f2!.alertId, f1!.alertId);
  assert.equal(f2!.created, true);
  assert.equal((await db.app.query<{ state: string }>("SELECT state FROM alerts WHERE id = $1", [f1!.alertId])).rows[0]!.state, "resolved");
});

test("a batch costs a handful of round trips, not ~9 per event", async t => {
  const events = Array.from({ length: 30 }, (_, i) => i % 3 === 0 ? err("disk", 15) : i % 3 === 1 ? err("Rt-Source", 5) : err("Rt-Other", 6));
  await storeEvents(db.app, ids.a, { events: [err("Warm-Up", 1)] }); // the rules are in memory after the first batch
  let trips = 0;
  const original = Tx.prototype.query;
  Tx.prototype.query = function (this: Tx, ...args: Parameters<Tx["query"]>) { trips++; return original.apply(this, args); } as Tx["query"];
  try { await storeEvents(db.app, ids.a, { events: events as [Event, ...Event[]] }); } finally { Tx.prototype.query = original; }
  t.diagnostic(`round trips for a batch of 30 events with 3 signatures: ${trips}`);
  assert.ok(trips <= 3, `${trips} round trips`);
});

test("rule matches are counted in memory, shown at once, and written in one statement", async () => {
  const rule = "00000000-0000-4000-8000-000000000305"; // disk 15
  await flushRuleHits();
  const stored = async () => Number((await db.app.query<{ n: string }>("SELECT matched_count AS n FROM symptom_rules WHERE id = $1", [rule])).rows[0]!.n);
  const before = await stored();
  await storeEvents(db.app, ids.b, { events: [err("disk", 15), err("disk", 15)] });
  assert.equal(await stored(), before, "the hot rule row is not touched by ingest");
  const shown = (await listRules(db.app, { state: "live" })).find(r => r.id === rule)!;
  assert.equal(shown.matchedCount, before + 2, "the rule list adds what is not written yet");
  assert.ok(await flushRuleHits() >= 1);
  assert.equal(await stored(), before + 2);
});

test("a rule changed directly in the database is seen by the next batch (the stamp moves), with no restart", async () => {
  const before = await storeEvents(db.app, ids.a, { events: [err("disk", 51)] });
  assert.equal(before.outcomes[0]!.kind, "issue");
  await asOwner(db, c => c.query("UPDATE symptom_rules SET state = 'disabled' WHERE id = '00000000-0000-4000-8000-000000000306'"));
  try {
    const after = await storeEvents(db.app, ids.a, { events: [err("disk", 51)] });
    assert.equal(after.outcomes[0]!.kind, "unrecognized");
  } finally { await asOwner(db, c => c.query("UPDATE symptom_rules SET state = 'live' WHERE id = '00000000-0000-4000-8000-000000000306'")); }
});

// ---- Audit ------------------------------------------------------------------------------------------------------------------

test("auditMany chains several entries in one call, exactly as audit_append would, and rolls back with its transaction", async () => {
  const seqs = await transaction(db.app, async c => {
    await audit(c, { actorKind: "system", actorId: "t", action: "many.before", outcome: "succeeded" });
    const s = await auditMany(c, [
      { actorKind: "user", actorId: ids.admin, action: "many.one", targetKind: "cabinet", targetId: ids.a, outcome: "succeeded", details: { text: "ü 🔒 \"q\" \u0000x" } },
      { actorKind: "system", actorId: "t", action: "many.two", outcome: "refused", details: { long: "x".repeat(9000) } },
      { actorKind: "agent", actorId: ids.a, action: "many.three", outcome: "failed" },
    ]);
    await audit(c, { actorKind: "system", actorId: "t", action: "many.after", outcome: "succeeded" });
    return s;
  });
  assert.equal(seqs.length, 3);
  assert.deepEqual([seqs[1]! - seqs[0]!, seqs[2]! - seqs[1]!], [1, 1]);
  assert.equal((await verifyAuditChain(db.app)).ok, true);
  assert.deepEqual(await transaction(db.app, c => auditMany(c, [])), []);
  const n = await count("SELECT COUNT(*) AS n FROM audit_log");
  await assert.rejects(transaction(db.app, async c => {
    await auditMany(c, [{ actorKind: "system", actorId: "t", action: "many.rolled-back", outcome: "succeeded" }]);
    throw new Error("the action failed");
  }));
  assert.equal(await count("SELECT COUNT(*) AS n FROM audit_log"), n);
});

test("hostile batches are refused by audit_append_many and leave the chain as it was", async () => {
  const n = await count("SELECT COUNT(*) AS n FROM audit_log");
  for (const bad of ['{"actorKind":"system"}', "[1, 2]", "not json", '[{"actorKind":"system","action":"x","outcome":"succeeded","details":"{}"}]'])
    await assert.rejects(transaction(db.app, c => c.query("DECLARE @f bigint, @l bigint; EXEC audit_append_many $1, @f OUTPUT, @l OUTPUT;", [bad])), bad);
  assert.equal(await count("SELECT COUNT(*) AS n FROM audit_log"), n);
  assert.equal((await verifyAuditChain(db.app)).ok, true);
});

test("the daily check goes on from its checkpoint; only the procedure moves it, and only to a real entry", async () => {
  const full = await verifyChainAndAlert(db.app, "weekly", "full");
  assert.equal(full.ok, true);
  const cp = await auditCheckpoint(db.app);
  assert.ok(cp.seq >= full.entries - 1, "a successful check moves the checkpoint");
  for (let i = 0; i < 4; i++) await transaction(db.app, c => audit(c, { actorKind: "system", actorId: "t", action: `cp.${i}`, outcome: "succeeded" }));
  const daily = await verifyChainAndAlert(db.app, "daily", "incremental");
  assert.equal(daily.ok, true);
  assert.equal(daily.fromSeq, cp.seq + 1);
  assert.ok(daily.entries >= 5 && daily.entries <= 6, `only the new entries: ${daily.entries}`);
  await assert.rejects(db.app.query("UPDATE audit_checkpoint SET seq = 0"), /permission/i);
  await assert.rejects(advanceAuditCheckpoint(db.app, { seq: cp.seq + 1, hash: "0".repeat(64) }), /no audit entry/);
  const now = await auditCheckpoint(db.app);
  const old = (await db.app.query<{ hash: string }>("SELECT hash FROM audit_log WHERE seq = $1", [cp.seq])).rows[0]!;
  await advanceAuditCheckpoint(db.app, { seq: cp.seq, hash: old.hash });
  assert.deepEqual(await auditCheckpoint(db.app), now, "it never moves back");
});

test("the incremental check misses an old change the weekly full check finds, and catches a changed checkpoint entry", async () => {
  // (This test breaks the chain on purpose; it runs last of the audit tests.)
  const tamper = (seq: number) => asOwner(db, async c => {
    await c.query("DISABLE TRIGGER audit_log_immutable ON audit_log");
    await c.query("UPDATE audit_log SET outcome = 'failed' WHERE seq = $1", [seq]);
    await c.query("ENABLE TRIGGER audit_log_immutable ON audit_log");
  });
  await tamper(2);
  assert.equal((await verifyChainAndAlert(db.app, "daily", "incremental")).ok, true, "before the checkpoint: not looked at");
  const weekly = await verifyChainAndAlert(db.app, "weekly", "full");
  assert.deepEqual([weekly.ok, weekly.firstBadSeq], [false, 2]);
  // Rewriting the checkpoint entry's stored hash is seen by the next daily check.
  const cp = await auditCheckpoint(db.app);
  await asOwner(db, async c => {
    await c.query("DISABLE TRIGGER audit_log_immutable ON audit_log");
    await c.query("UPDATE audit_log SET hash = REPLICATE('f', 64) WHERE seq = $1", [cp.seq]);
    await c.query("ENABLE TRIGGER audit_log_immutable ON audit_log");
  });
  const daily = await verifyChainAndAlert(db.app, "daily", "incremental");
  assert.equal(daily.ok, false);
  assert.equal(daily.firstBadSeq, cp.seq);
});

// ---- lock() ------------------------------------------------------------------------------------------------------------------

test("lock(): a deadlock between named locks is a retryable deadlock, and a held lock is given up on after 5 seconds", async () => {
  assert.equal(isDeadlock(new LockDeadlock("x")), true);
  const [l1, l2] = [`dl:${randomUUID()}`, `dl:${randomUUID()}`];
  let gate!: () => void;
  const bothHoldOne = new Promise<void>(r => { let n = 0; gate = () => { if (++n === 2) r(); }; });
  const attempts: [number, number] = [0, 0];
  const run = (i: 0 | 1, first: string, second: string) => db.app.transaction(async c => {
    attempts[i]++;
    await lock(c, first);
    if (attempts[i] === 1) { gate(); await bothHoldOne; }
    await lock(c, second);
  });
  await Promise.all([run(0, l1, l2), run(1, l2, l1)]);
  assert.equal(attempts[0]! + attempts[1]!, 3, "the victim ran again and both finished");

  const held = `held:${randomUUID()}`;
  let release!: () => void;
  const holding = db.app.transaction(async c => { await lock(c, held); await new Promise<void>(r => { release = r; }); });
  await new Promise(r => setTimeout(r, 200));
  const started = Date.now();
  await assert.rejects(db.app.transaction(c => lock(c, held)), /could not take the lock/);
  const waited = Date.now() - started;
  release();
  await holding;
  assert.ok(waited >= 4_500 && waited < 15_000, `waited ${waited} ms`);
});

// ---- Notifications -------------------------------------------------------------------------------------------------------------

test("a notification whose transaction commits after a later one is still delivered, once", async () => {
  const feed = new NotificationFeed(db.app, 20);
  const got: string[] = [];
  feed.on("late", p => got.push(p));
  await feed.start();
  try {
    let commit!: () => void;
    const open = db.app.transaction(async c => {
      await c.query("INSERT INTO notifications (channel, payload) VALUES ('late', 'first-id')");
      await new Promise<void>(r => { commit = r; });
    });
    await new Promise(r => setTimeout(r, 100));
    await db.app.query("INSERT INTO notifications (channel, payload) VALUES ('late', 'second-id')");
    for (let i = 0; i < 100 && !got.includes("second-id"); i++) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(got, ["second-id"]);
    commit();
    await open;
    for (let i = 0; i < 100 && !got.includes("first-id"); i++) await new Promise(r => setTimeout(r, 20));
    await new Promise(r => setTimeout(r, 200));
    assert.deepEqual(got.sort(), ["first-id", "second-id"], "the late row is delivered, and nothing twice");
  } finally { feed.stop(); }
});

test("the feed reports itself down after 3 failed polls and up after a good one, and follows ids that went back", async () => {
  let fail = false;
  let rows: { id: string | null; channel: string | null; payload: string | null }[] = [];
  const fake: Queryable = {
    async query<R>(text: string) {
      if (fail) throw new Error("the database is away");
      if (text.startsWith("SELECT MAX(id)")) return { rows: [{ id: "1000" }] as R[], rowCount: 1 };
      return { rows: rows as R[], rowCount: rows.length };
    },
  };
  const feed = new NotificationFeed(fake, 60_000);
  const got: string[] = [];
  feed.on("c", p => got.push(p));
  await feed.start();
  try {
    assert.equal(feed.running, true);
    fail = true;
    for (let i = 0; i < FAILURES_UNTIL_DOWN - 1; i++) await feed.poll();
    assert.equal(feed.running, true, "two failures are a blip");
    await feed.poll();
    assert.equal(feed.running, false, "three in a row: long polls re-check on their own");
    fail = false;
    rows = [{ id: "1001", channel: "c", payload: "a" }, { id: "1001", channel: null, payload: null }];
    await feed.poll();
    assert.equal(feed.running, true);
    // The table was restored: its newest id is now 5. New rows after that are delivered.
    rows = [{ id: "5", channel: null, payload: null }];
    await feed.poll();
    rows = [{ id: "6", channel: "c", payload: "after-restore" }, { id: "6", channel: null, payload: null }];
    await feed.poll();
    assert.deepEqual(got, ["a", "after-restore"]);
  } finally { feed.stop(); }
});

// ---- Retention and load samples ------------------------------------------------------------------------------------------------

test("retention works in small batches until done, and every step is its own statement", async () => {
  await asOwner(db, c => c.query(`INSERT INTO notifications (channel, payload, [at]) SELECT TOP (10) 'old', 'x', DATEADD(hour, -3, SYSUTCDATETIME()) FROM sys.all_objects`));
  assert.equal(await pruneNotifications(db.app, FAST), 10);
  assert.equal(await inBatches(db.app, "DELETE TOP ($1) FROM notifications WHERE channel = $2", ["none"], FAST), 0);
  await asOwner(db, async c => {
    await c.query(`INSERT INTO events (event_id, cabinet_id, kind, occurred_at, received_at)
                   SELECT TOP (7) NEWID(), $1, 'error', DATEADD(day, -100, SYSUTCDATETIME()), DATEADD(day, -100, SYSUTCDATETIME()) FROM sys.all_objects`, [ids.b]);
    await c.query("INSERT INTO cabinet_boots (cabinet_id, booted_at, source) VALUES ($1, DATEADD(day, -400, SYSUTCDATETIME()), 'heartbeat')", [ids.b]);
    await c.query("INSERT INTO firewall_changes (cabinet_id, explained, occurred_at) VALUES ($1, 0, DATEADD(day, -400, SYSUTCDATETIME()))", [ids.b]);
  });
  const audits = await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'retention.run'");
  const run = await runRetention(db.app, FAST);
  assert.ok(run.events >= 7, "older than the 90-day default");
  assert.ok(run.boots >= 1 && run.firewallChanges >= 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'retention.run'"), audits + 1);
});

test("load samples older than 48 hours become one row per hour (min, average, max); the chart shows both; a second run changes nothing", async () => {
  const k = ids.q2;
  await db.app.query("DELETE FROM health_samples WHERE cabinet_id = $1", [k]);
  // Two whole hours, 60 and 61 hours ago, four samples each; and recent samples that stay.
  const hourStart = new Date(Math.floor((Date.now() - 61 * 3_600_000) / 3_600_000) * 3_600_000);
  const values: [number, number, number, number][] = [];
  for (let h = 0; h < 2; h++) for (let q = 0; q < 4; q++) values.push([h * 3_600_000 + q * 900_000, 10 + q * 10 + h, 50, 80 - q]);
  for (const [off, cpu, mem, disk] of values)
    await db.app.query("INSERT INTO health_samples (cabinet_id, [at], cpu_percent, memory_used_percent, disk_free_percent) VALUES ($1, $2, $3, $4, $5)", [k, new Date(hourStart.getTime() + off), cpu, mem, disk]);
  await db.app.query("INSERT INTO health_samples (cabinet_id, [at], cpu_percent, memory_used_percent, disk_free_percent) VALUES ($1, DATEADD(hour, -1, SYSUTCDATETIME()), 5, 5, 5)", [k]);
  const r = await rollUpAndTrimSamples(db.app, Date.now(), FAST);
  assert.ok(r.rolledUp >= 8);
  const hourly = (await db.app.query<{ hour: Date; samples: number; cpu_min: number; cpu_avg: number; cpu_max: number; disk_free_min: number }>(
    "SELECT [hour], samples, cpu_min, cpu_avg, cpu_max, disk_free_min FROM health_hourly WHERE cabinet_id = $1 ORDER BY [hour]", [k])).rows;
  assert.deepEqual(hourly.map(h => [h.hour.getTime() - hourStart.getTime(), h.samples, h.cpu_min, h.cpu_avg, h.cpu_max, h.disk_free_min]),
    [[0, 4, 10, 25, 40, 77], [3_600_000, 4, 11, 26, 41, 77]]);
  assert.equal(await count("SELECT COUNT(*) AS n FROM health_samples WHERE cabinet_id = $1", [k]), 1, "the raw samples rolled up are gone; the recent one stays");
  const chart = await healthHistory(db.app, k, 72);
  assert.equal(chart.length, 3);
  assert.deepEqual(chart.map(p => p.cpu), [25, 26, 5], "oldest first");
  assert.equal(chart[0]!.cpuMax, 40);
  assert.equal(chart[2]!.cpuMax, undefined, "a raw sample is a plain point");
  const again = await rollUpAndTrimSamples(db.app, Date.now(), FAST);
  assert.equal(again.rolledUp, 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM health_hourly WHERE cabinet_id = $1", [k]), 2);
});

test("the nightly time is fixed and checked: HH:MM, next occurrence, a full chain check on Sundays", () => {
  assert.deepEqual(parseDailyTime(undefined), { hour: 2, minute: 30 });
  assert.deepEqual(parseDailyTime("23:59"), { hour: 23, minute: 59 });
  for (const bad of ["24:00", "2:3:4", "aa:bb", "-1:00", "", "02:30; DROP TABLE x", "02:60", "1e1:00"]) assert.throws(() => parseDailyTime(bad), /HH:MM/, bad);
  const from = new Date(2026, 9, 17, 1, 0);
  assert.equal(nextRunAt({ hour: 2, minute: 30 }, from).getTime(), new Date(2026, 9, 17, 2, 30).getTime());
  assert.equal(nextRunAt({ hour: 2, minute: 30 }, new Date(2026, 9, 17, 2, 30)).getTime(), new Date(2026, 9, 18, 2, 30).getTime());
  assert.equal(chainCheckMode(new Date(2026, 9, 18)), "full");
  assert.equal(chainCheckMode(new Date(2026, 9, 19)), "incremental");
});

// ---- Offline judgements and outages ----------------------------------------------------------------------------------------------

test("the outage guard holds judgements after a start, a gap in the checks, silence, or contact halving, and lets them go after the window", () => {
  const o = { windowMs: 5 * 60_000, backoffMs: 5 * 60_000, minFleet: 20, maxRunGapMs: 3 * 60_000, quietIngestMs: 3 * 60_000, baselineMs: 60 * 60_000 };
  const normal = { recent: 100, newestAgeMs: 1_000 };
  const g = new FleetContact(o);
  let t = 1_000_000;
  assert.equal(g.judge(normal, t), true, "not started: judged as before");
  g.start(t);
  for (; t < 1_000_000 + 9 * 60_000; t += 60_000) assert.equal(g.judge(normal, t), false, "held after the start");
  t = 1_000_000 + 10 * 60_000;
  assert.equal(g.judge(normal, t), true);
  // The database was away for 10 minutes: no check ran.
  t += 10 * 60_000;
  assert.equal(g.judge(normal, t), false);
  assert.match(g.reason ?? "", /did not run/);
  t += 10 * 60_000 + 1;
  for (let s = t - 10 * 60_000; s <= t; s += 60_000) g.judge(normal, s);
  assert.equal(g.judge(normal, t), true);
  // Contact falls to 40% of the usual: held, and for the window after it recovers.
  t += 60_000;
  assert.equal(g.judge({ recent: 40, newestAgeMs: 1_000 }, t), false);
  assert.match(g.reason ?? "", /more than half/);
  t += 60_000;
  assert.equal(g.judge(normal, t), false, "recovered, but the window has not passed");
  for (let i = 0; i < 8; i++) { t += 60_000; assert.equal(g.judge(normal, t), false); } // held until 10 minutes after the drop
  t += 60_000;
  assert.equal(g.judge(normal, t), true);
  // No heartbeat from anyone for 5 minutes.
  t += 60_000;
  assert.equal(g.judge({ recent: 100, newestAgeMs: 5 * 60_000 }, t), false);
  // A small installation never holds on fleet-wide signals.
  const small = new FleetContact(o);
  assert.equal(small.judge({ recent: 3, newestAgeMs: 1_000 }, 0), true);
  assert.equal(small.judge({ recent: 0, newestAgeMs: 99 * 60_000 }, 60_000), true);
});

test("offline and site-outage alerts are not raised while contact is in doubt, and are once it is back", async () => {
  // A fleet of 24 more cabinets reporting normally, so fleet-wide signals count.
  const many = Array.from({ length: 24 }, () => randomUUID());
  for (const [i, k] of many.entries())
    await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES ($1, $2, $3, 'standalone', 'active', SYSUTCDATETIME())", [k, ids.site, `M${i}`]);
  const guard = new FleetContact({ minFleet: 20 });
  assert.deepEqual(await checkSiteOutages(db.app, guard), { raised: 0, resolved: 0 }, "a normal minute sets the baseline");
  // Most of the fleet goes silent at once (the server's own network, say), the quiet site among it, one cabinet past the offline threshold.
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(minute, -30, SYSUTCDATETIME()) WHERE id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))",
    [JSON.stringify([...many.slice(0, 20), ids.q1, ids.q2])]);
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(day, -30, SYSUTCDATETIME()) WHERE id = $1", [many[23]]);
  assert.equal((await checkSiteOutages(db.app, guard)).raised, 0, "held");
  assert.equal((await checkOffline(db.app, guard)).raised, 0, "held");
  assert.match(guard.reason ?? "", /more than half/);
  // A guard that never saw the fleet normally has no baseline to compare with, so it judges: the quiet site is an outage.
  const fresh = new FleetContact({ minFleet: 20 });
  assert.equal((await checkSiteOutages(db.app, fresh)).raised, 2);
  assert.equal((await checkOffline(db.app, fresh)).raised, 1);
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME() WHERE status = 'active'");
  await checkSiteOutages(db.app, fresh);
  await resolveOfflineFor(db.app, null);
  await db.app.query("UPDATE cabinets SET status = 'removed' WHERE id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))", [JSON.stringify(many)]);
});

test("a site whose cabinets went quiet while one is in a reboot loop is left to the crash alert (the rebootLoop check is intended)", async () => {
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(minute, -60, SYSUTCDATETIME()) WHERE site_id = $1", [ids.quiet]);
  const loop = await upsertAlert(db.app, { cabinetId: ids.q1, issueTypeId: ISSUE.rebootLoop, severity: "major", signature: "reboot_loop", title: "Loop", seenAt: new Date(), ruleId: null, eventId: null });
  const guard = new FleetContact();
  assert.equal((await checkSiteOutages(db.app, guard)).raised, 0, "a crash incident, not an outage");
  await db.app.query("UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME() WHERE id = $1", [loop.id]);
  assert.equal((await checkSiteOutages(db.app, guard)).raised, 2, "without the loop it is an outage");
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME() WHERE site_id = $1", [ids.quiet]);
  assert.equal((await checkSiteOutages(db.app, guard)).resolved, 2);
});

test("resolving offline alerts for one cabinet touches only that cabinet", async () => {
  for (const k of [ids.a, ids.b])
    await upsertAlert(db.app, { cabinetId: k, issueTypeId: ISSUE.offline, severity: "minor", signature: `issue:${ISSUE.offline}`, title: "Offline", seenAt: new Date(), ruleId: null, eventId: null });
  assert.equal(await resolveOfflineFor(db.app, ids.a), 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved'", [ids.b, ISSUE.offline]), 1);
  assert.equal(await resolveOfflineFor(db.app, null), 1);
});

test("a reboot loop is resolved on the heartbeat that crosses 2 hours of uptime, not looked at on every heartbeat after", async () => {
  assert.equal(crossedRecovery(LOOP_RECOVERED_SECONDS + 60, LOOP_RECOVERED_SECONDS - 10, false), true);
  assert.equal(crossedRecovery(LOOP_RECOVERED_SECONDS + 120, LOOP_RECOVERED_SECONDS + 60, false), false);
  assert.equal(crossedRecovery(LOOP_RECOVERED_SECONDS + 60, null, true), true, "the first heartbeat the server has");
  assert.equal(crossedRecovery(100, 50, false), false);
  const loop = await upsertAlert(db.app, { cabinetId: ids.b, issueTypeId: ISSUE.rebootLoop, severity: "major", signature: "reboot_loop", title: "Loop", seenAt: new Date(), ruleId: null, eventId: null });
  const at = new Date(Date.now() - 60_000);
  await bootFromHeartbeat(db.app, ids.b, LOOP_RECOVERED_SECONDS + 120, { uptimeSeconds: LOOP_RECOVERED_SECONDS + 60, at });
  assert.equal((await db.app.query<{ state: string }>("SELECT state FROM alerts WHERE id = $1", [loop.id])).rows[0]!.state, "open", "already past: not looked at");
  await bootFromHeartbeat(db.app, ids.b, LOOP_RECOVERED_SECONDS + 30, { uptimeSeconds: LOOP_RECOVERED_SECONDS - 30, at });
  assert.equal((await db.app.query<{ state: string }>("SELECT state FROM alerts WHERE id = $1", [loop.id])).rows[0]!.state, "resolved");
});

// Keep the pool type referenced for readers of this file: every service here takes the application's pool.
void Pool;

test("twelve heartbeats for one cabinet at the same moment store one load sample, never a duplicate key", async () => {
  // The heartbeat itself (cabinets.ts, the table's owner) stores the sample: the race is tested on the path the agents take (D78).
  const id = (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM cabinets")).rows[0]?.id;
  assert.ok(id, "the scale fixture has cabinets");
  const beat = envelopes.heartbeat.parse({ agentVersion: "1.4.2", uptimeSeconds: 100, readOnlyMode: false,
    health: { cpuPercent: 5, memoryUsedPercent: 40, diskFreePercent: 60, drives: [] } });
  for (let round = 0; round < 25; round++) {
    await db.app.query("DELETE FROM health_samples WHERE cabinet_id = $1", [id]);
    await Promise.all(Array.from({ length: 12 }, () => recordHeartbeat(db.app, id, beat)));
    assert.equal(Number((await db.app.query<{ n: number }>("SELECT count(*) AS n FROM health_samples WHERE cabinet_id = $1", [id])).rows[0]!.n), 1, `round ${round}`);
  }
});
