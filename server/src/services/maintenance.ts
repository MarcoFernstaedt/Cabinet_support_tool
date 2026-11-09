// Daily jobs (docs/spec/05-server-spec.md "Audit log" and "Retention"): verify the audit chain, raising a security alert if it is broken,
// and remove what is past its retention period. Retention never runs as one big transaction: every table is trimmed in small autocommit
// batches (BATCH rows each, with a pause between them and a time limit on each), so the log, the locks and the buffer pool of a 10,000-cabinet
// database on SQL Server Express stay small and the agents' writes are never held up for long. The jobs run at a fixed quiet time of night.
import { advanceAuditCheckpoint, audit, auditChainHeadAnchor, auditCheckpoint, Pool, transaction, verifyAuditChain, type ChainCheck, type ChainCheckpoint, type Queryable } from "../db/db.js";
import { platformSettings } from "./settings.js";
import { closeStaleSecurityAlerts, raiseSecurityAlert } from "./security.js";
import { opsMeter, pruneOpsCounters } from "./ops-meter.js";
import { pruneExpiredSessions } from "../auth/sessions.js";
import { pruneExpiredStepUpTokens } from "../auth/stepup.js";
import { clearOldCommandResults, pruneFirewallChanges } from "./commands.js";
import { pruneFinishedJobs } from "./fleet-jobs.js";
import { clearOldEventDetail, EVENT_DETAIL_DAYS, pruneOldEvents, unlinkEventsOfOldAlerts } from "./events.js";
import { pruneResolvedAlerts } from "./alerts.js";
import { pruneOldBoots } from "./crashes.js";
import { pruneOldConfigChanges } from "./config-ingest.js";
import { pruneOldDiagnoses } from "../diagnose/cabinet.js";
import { pruneOldHealthTransitions } from "./cabinet-health.js";
import { pruneClosedIncidents } from "./incidents.js";

/** On a check a person asks for, stop after this many entries: the whole log is the weekly, off-peak check's job. */
export const ON_DEMAND_CHAIN_ENTRIES = 50_000;

let chainCheckInFlight: Promise<ChainCheck> | null = null;
let chainCheckRecent: { at: number; check: ChainCheck } | null = null;
/** Where a bounded full walk stopped, so the next check a person asks for goes on from there (null: the walk reached the end of the log). */
let chainSweep: ChainCheckpoint | null = null;

/**
 * Checks the audit chain: the whole of it ("full"), or only what was added since the last successful check ("incremental", from the
 * checkpoint). A break raises a security alert; the check itself is audited either way. A successful check moves the checkpoint forward.
 *
 * Every check is anchored: the last entry it reached is compared with the high-water mark the append path keeps for itself
 * (audit_chain_head, which the application's role may not read), so a chain whose entries at the end were deleted cannot come back clean.
 *
 * A check a person asks for is bounded and shared: it walks the log in steps of ON_DEMAND_CHAIN_ENTRIES, and each step goes on from where
 * the one before it stopped, so no single request walks a large log. A step that reaches the end of the log clears the step, so the next
 * check a person asks for starts from the beginning of it again and a break in an old entry is still found. A second request while one is
 * running gets that one's answer instead of starting a walk of its own. The whole log is walked by the nightly job (mode "full", the weekly
 * run) when nothing else is going on; the daily run goes on from the checkpoint.
 */
export async function verifyChainAndAlert(pool: Pool, by: { userId: string } | "daily" | "weekly", mode: "full" | "incremental" = "full",
  o: { maxEntries?: number } = {}): Promise<ChainCheck> {
  if (by !== "daily" && by !== "weekly") {
    // Two people pressing the button at once cause one walk. Asking again after something changed is a new walk, never the last answer.
    if (chainCheckInFlight) return { ...(await chainCheckInFlight), reused: true };
    const run = checkChain(pool, by, "full", o.maxEntries ?? ON_DEMAND_CHAIN_ENTRIES, chainSweep ?? undefined);
    chainCheckInFlight = run;
    try {
      const check = await run;
      chainCheckRecent = { at: Date.now(), check };
      return check;
    } finally {
      if (chainCheckInFlight === run) chainCheckInFlight = null;
    }
  }
  return checkChain(pool, by, mode, o.maxEntries);
}

async function checkChain(pool: Pool, by: { userId: string } | "daily" | "weekly", mode: "full" | "incremental", maxEntries?: number,
  resume?: ChainCheckpoint): Promise<ChainCheck> {
  const from = resume ?? (mode === "incremental" ? await auditCheckpoint(pool) : undefined);
  // No anchor (a database not yet migrated to audit_head) is not a failure by itself; the check says so in its audit entry.
  const head = await auditChainHeadAnchor(pool);
  const check = await verifyAuditChain(pool, 10_000, from, { ...(maxEntries === undefined ? {} : { maxEntries }), head });
  // A full walk that stopped at the limit is continued by the next check a person asks for; one that reached the end clears the step, so
  // the following check starts from the beginning of the log again.
  if (mode === "full")
    chainSweep = check.more === true && check.lastSeq !== undefined && check.lastHash !== undefined ? { seq: check.lastSeq, hash: check.lastHash } : null;
  if (check.ok && check.lastSeq !== undefined && check.lastHash !== undefined && check.lastSeq > 0)
    await advanceAuditCheckpoint(pool, { seq: check.lastSeq, hash: check.lastHash });
  await transaction(pool, async c => {
    if (!check.ok)
      await raiseSecurityAlert(c, { kind: "audit_chain", signature: `audit_chain|${check.firstBadSeq}`,
        title: check.behindHead ? `The audit log ends before the entry the append path last wrote (${check.headSeq})` : `The audit log's hash chain is broken at entry ${check.firstBadSeq}`,
        detail: { firstBadSeq: check.firstBadSeq, entries: check.entries, headSeq: check.headSeq ?? null, behindHead: check.behindHead ?? false, anchored: head !== null } });
    await audit(c, { actorKind: by === "daily" || by === "weekly" ? "system" : "user", actorId: by === "daily" ? "daily-check" : by === "weekly" ? "weekly-check" : by.userId,
      action: "audit.verify", outcome: check.ok ? "succeeded" : "failed", details: { entries: check.entries, firstBadSeq: check.firstBadSeq ?? null, mode, fromSeq: check.fromSeq ?? 1,
        maxEntries: maxEntries ?? null, more: check.more ?? false, headSeq: check.headSeq ?? null, behindHead: check.behindHead ?? false, anchored: head !== null } });
  });
  const { lastHash: _hash, ...shown } = check;
  return shown;
}

// The batching helpers live in db/batches.ts, which imports nothing but db.ts, so an owner's prune can use them without importing this
// module (and making an import cycle that runs a module before its constants exist). Re-exported for the callers that import them here.
export { checkRetentionCutoff, inBatches, RETENTION_BATCH, type BatchAudit, type BatchOptions } from "../db/batches.js";
import { inBatches, RETENTION_BATCH, type BatchOptions } from "../db/batches.js";

const sleep = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

/** Notifications only wake other server processes (each reads them within a second), so one older than an hour is of no use. */
export async function pruneNotifications(db: Queryable, o: BatchOptions = RETENTION_BATCH): Promise<number> {
  return inBatches(db, "DELETE TOP ($1) FROM notifications WHERE [at] < DATEADD(hour, -1, SYSUTCDATETIME())", [], o);
}

/** Load samples are kept as they came for this long, then as one row per hour (health_hourly). */
export const HEALTH_RAW_HOURS = 48;
/** Load samples are for trend charts only, so two weeks is all they are kept. */
export const HEALTH_DAYS = 14;
/** A drive's history is kept for 400 days: long enough to see a year of wear. */
export const DRIVE_DAYS = 400;
/** Cabinets handled together by the per-cabinet steps (40 cabinets × 96 samples a day stays under one batch). */
const CABINET_CHUNK = 40;

const DAY = 86_400_000;
const daysAgo = (n: number, now: number) => new Date(now - n * DAY);

/**
 * Rolls load samples older than HEALTH_RAW_HOURS up into hourly rows (min, average, max) and removes them, then removes hourly rows past
 * HEALTH_DAYS and drive samples past DRIVE_DAYS. Done per group of cabinets, by the tables' primary keys (cabinet first), one short
 * transaction per group. Returns the raw samples rolled up.
 */
export async function rollUpAndTrimSamples(pool: Pool, now = Date.now(), o: BatchOptions = RETENTION_BATCH): Promise<{ rolledUp: number; driveSamples: number }> {
  // Whole hours only: the hour that holds the cut-off stays raw until the next run.
  const cut = new Date(Math.floor((now - HEALTH_RAW_HOURS * 3_600_000) / 3_600_000) * 3_600_000);
  const healthCut = daysAgo(HEALTH_DAYS, now), driveCut = daysAgo(DRIVE_DAYS, now);
  const ids = (await pool.query<{ id: string }>("SELECT id FROM cabinets ORDER BY id")).rows.map(r => r.id);
  let rolledUp = 0, driveSamples = 0;
  for (let i = 0; i < ids.length; i += CABINET_CHUNK) {
    const chunk = JSON.stringify(ids.slice(i, i + CABINET_CHUNK));
    rolledUp += await transaction(pool, async c => {
      // Samples already older than the whole history are not worth rolling up; an hour already rolled up (a run stopped half way) is not again.
      await c.query(
        `INSERT INTO health_hourly (cabinet_id, [hour], samples, cpu_min, cpu_avg, cpu_max, memory_min, memory_avg, memory_max, disk_free_min, disk_free_avg, disk_free_max)
         SELECT s.cabinet_id, s.[hour], COUNT(*), MIN(s.cpu), ROUND(AVG(CAST(s.cpu AS float)), 0), MAX(s.cpu), MIN(s.mem), ROUND(AVG(CAST(s.mem AS float)), 0), MAX(s.mem),
                MIN(s.disk), ROUND(AVG(CAST(s.disk AS float)), 0), MAX(s.disk)
           FROM (SELECT h.cabinet_id, CAST(DATEADD(hour, DATEDIFF(hour, '2000-01-01', h.[at]), '2000-01-01') AS datetime2(0)) AS [hour],
                        h.cpu_percent AS cpu, h.memory_used_percent AS mem, h.disk_free_percent AS disk
                   FROM health_samples h
                  WHERE h.cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1)) AND h.[at] < $2 AND h.[at] >= $3) s
          WHERE NOT EXISTS (SELECT 1 FROM health_hourly x WHERE x.cabinet_id = s.cabinet_id AND x.[hour] = s.[hour])
          GROUP BY s.cabinet_id, s.[hour]`, [chunk, cut, healthCut], { timeoutMs: o.timeoutMs });
      return (await c.query(
        "DELETE FROM health_samples WHERE cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1)) AND [at] < $2", [chunk, cut], { timeoutMs: o.timeoutMs })).rowCount ?? 0;
    });
    await inBatches(pool, "DELETE TOP ($1) FROM health_hourly WHERE cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($2)) AND [hour] < $3", [chunk, healthCut], o,
      { table: "health_hourly", cutoff: healthCut });
    driveSamples += await inBatches(pool, "DELETE TOP ($1) FROM drive_samples WHERE cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($2)) AND [at] < $3", [chunk, driveCut], o,
      { table: "drive_samples", cutoff: driveCut });
    await sleep(o.pauseMs);
  }
  return { rolledUp, driveSamples };
}

// Event retention, the clearing of old events' detail included, is events.ts's own (D75); re-exported for the callers that import it here.
export { clearOldEventDetail, EVENT_DETAIL_DAYS } from "./events.js";

export interface RetentionRun { events: number; eventsCleared: number; opsCounters: number; commandResults: number; alerts: number; firewallChanges: number; sessions: number; stepUpTokens: number;
  diagnoses: number; boots: number; jobs: number; healthRolledUp: number; driveSamples: number; notifications: number; configChanges: number; healthTransitions: number; incidents: number }

/**
 * Removes events, resolved alerts, firewall history, diagnoses, boot records and finished fleet jobs past their retention, and clears old command results
 * (the command itself, who sent it and when, stays in the history). The audit log is never pruned. Every step is batched (inBatches); the
 * run is audited at the end in its own small transaction.
 */
export async function runRetention(pool: Pool, o: BatchOptions = RETENTION_BATCH): Promise<RetentionRun> {
  const r = (await platformSettings(pool)).retention;
  const now = Date.now();
  const cut = (days: number) => daysAgo(days, now);
  // Every destructive step names the table it trims and the cut-off it used, so each batch it removes leaves an audit entry of its own
  // (the run's own entry below says how much was removed in all).
  // Events, their detail, their link to an old alert, and old resolved alerts: each table's owner removes its own (events.ts, alerts.ts, D75).
  const events = await pruneOldEvents(pool, cut(r.eventsDays), o);
  const eventsCleared = r.eventsDays > EVENT_DETAIL_DAYS ? await clearOldEventDetail(pool, now, o) : 0;
  // The cleared rows only free space inside their pages; compacting the index gives it back (incremental: a stopped run is not lost).
  if (eventsCleared > 0) await pool.query("EXEC reorganize_events", [], { timeoutMs: 20 * 60_000 });
  const opsCounters = await pruneOpsCounters(pool, now);
  // Old command results and firewall history: their owner, commands.ts, clears and removes them (D72).
  const commandResults = await clearOldCommandResults(pool, cut(r.commandsDays), o);
  // Events kept longer than their alert would point at nothing; they keep the event and lose the link, then the alert goes.
  await unlinkEventsOfOldAlerts(pool, cut(r.alertsDays), o);
  const alerts = await pruneResolvedAlerts(pool, cut(r.alertsDays), o);
  const firewallChanges = await pruneFirewallChanges(pool, cut(r.firewallDays), o);
  // Expired sign-in sessions and step-up tokens, a day after they expired: each owner removes its own (D71).
  const sessions = await pruneExpiredSessions(pool, cut(1), o);
  const stepUpTokens = await pruneExpiredStepUpTokens(pool, cut(1), o);
  const diagnoses = await pruneOldDiagnoses(pool, cut(r.diagnosesDays), o);
  const samples = await rollUpAndTrimSamples(pool, now, o);
  const notifications = await pruneNotifications(pool, o);
  const boots = await pruneOldBoots(pool, cut(r.bootsDays), o);
  // The record of configuration changes and health transitions is kept as long as events are (the stored versions are bounded by count instead).
  const configChanges = await pruneOldConfigChanges(pool, cut(r.eventsDays), o);
  const healthTransitions = await pruneOldHealthTransitions(pool, cut(r.eventsDays), o);
  // A finished job and its per-cabinet results, removed by their owner, fleet-jobs.ts (D73); the commands it sent and the audit log stay.
  const jobs = await pruneFinishedJobs(pool, cut(r.jobsDays), o);
  // A closed incident is kept as long as a resolved alert (its steps and links go with it); an open one is never removed (incidents.ts, D74).
  const incidents = await pruneClosedIncidents(pool, cut(r.alertsDays), o);
  const run = { events, eventsCleared, opsCounters, commandResults, alerts, firewallChanges, sessions, stepUpTokens, diagnoses, boots, jobs, healthRolledUp: samples.rolledUp,
    driveSamples: samples.driveSamples, notifications, configChanges, healthTransitions, incidents };
  await transaction(pool, c => audit(c, { actorKind: "system", actorId: "retention", action: "retention.run", outcome: "succeeded", details: { ...run, retention: r } }));
  // Counts for the System health page: that it ran, and how many rows it removed or cleared per table (numbers only).
  opsMeter.count("retention", "ok");
  for (const [table, n] of Object.entries(run)) if (n > 0) opsMeter.count("retention_rows", table, n);
  return run;
}

/** "HH:MM" (server local time) as hours and minutes; the default is 02:30. */
export function parseDailyTime(text: string | undefined): { hour: number; minute: number } {
  const m = (text ?? "02:30").trim().split(":");
  const digits = (s: string | undefined) => s !== undefined && s.length >= 1 && s.length <= 2 && [...s].every(ch => ch >= "0" && ch <= "9");
  const hour = Number(m[0]), minute = Number(m[1]);
  if (m.length !== 2 || !digits(m[0]) || !digits(m[1]) || !Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59)
    throw new Error("The maintenance time must be HH:MM, 00:00 to 23:59.");
  return { hour, minute };
}

/** The next time of day at { hour, minute } (server local time) after `from`. */
export function nextRunAt(at: { hour: number; minute: number }, from = new Date()): Date {
  const next = new Date(from.getFullYear(), from.getMonth(), from.getDate(), at.hour, at.minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** Sundays the chain is checked whole; on the other days from the checkpoint. */
export const chainCheckMode = (day: Date): "full" | "incremental" => (day.getDay() === 0 ? "full" : "incremental");

/**
 * Runs the chain check and retention every day at a fixed quiet time (`at`, server local time, default 02:30), the chain check whole once a
 * week; the notifications table is trimmed every hour.
 */
export function scheduleDailyJobs(pool: Pool, log: (message: string) => void, options: { at?: string; runIf?: (job: "daily" | "hourly") => Promise<boolean> } = {}): () => void {
  const at = parseDailyTime(options.at);
  let timer: NodeJS.Timeout | null = null;
  // With more than one server instance, only the holder of each job's lease runs it (F21.R1, job-lease.ts).
  const allowed = options.runIf ?? (async () => true);
  const run = async () => {
    if (!(await allowed("daily").catch(() => false))) return;
    const mode = chainCheckMode(new Date());
    await verifyChainAndAlert(pool, mode === "full" ? "weekly" : "daily", mode)
      .then(c => { if (!c.ok) log(`Audit chain broken at entry ${c.firstBadSeq}.`); }, () => log("Audit chain check failed to run."));
    await runRetention(pool).catch(() => { opsMeter.count("retention", "failed"); log("Retention failed to run."); });
    await closeStaleSecurityAlerts(pool).then(n => { if (n > 0) log(`Closed ${n} security alert(s) not seen again for 14 days.`); },
      () => log("Closing stale security alerts failed to run."));
  };
  const plan = () => {
    const delay = Math.max(1_000, nextRunAt(at).getTime() - Date.now());
    timer = setTimeout(() => { void run().finally(plan); }, delay);
    timer.unref();
  };
  plan();
  const hourly = setInterval(() => { void allowed("hourly").catch(() => false).then(ok => ok ? pruneNotifications(pool) : 0).catch(() => log("Pruning notifications failed to run.")); }, 3_600_000);
  hourly.unref();
  return () => { if (timer) clearTimeout(timer); clearInterval(hourly); };
}
