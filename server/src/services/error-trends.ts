// Error trends (docs/spec/12-milestones-8-to-12.md "Error trends"): for each issue type and each error (log, source, event ID), how many cabinets
// and events there were per day over the last 30 days, marked new (first seen in the last day) or rising (the last 7 days more than double
// the 7 days before). Computed once a night from the events of each finished UTC day into two small tables; nothing here runs per request
// except reading those tables, so the cost does not grow with the fleet. Days are the UTC dates the platform received the events.
// The "cabinets" of a window are the cabinets on its busiest day (distinct cabinets over several days would need the events themselves).
import { audit, lock, transaction, type Pool, type Queryable } from "../db/db.js";
import { parseDailyTime, nextRunAt } from "./maintenance.js";
import type { ErrorTrendQuery } from "../contracts.js";
import { openRisingPatterns } from "./fleet-patterns.js";

export const TREND_DAYS = 30;
const KEEP_DAYS = 35;
/** The most error groups kept for a day across all clients (the busiest first), so a flood of one-off messages cannot fill the table. */
export const MAX_GROUPS_PER_DAY = 40_000;
/** Fewer events than this in the last 7 days is never "rising": two becoming five is noise. */
export const RISING_MIN_EVENTS = 5;
/** "New" needs a history to be new against. */
export const NEW_MIN_HISTORY_DAYS = 3;
const DAY = 86_400_000;

export type Mark = "new" | "rising" | null;

/**
 * Where a series stands. `events` is oldest to newest, one number per day, ending on the last computed day. `historyDays` is how many days
 * the platform has trend data for at all (a fleet seen for one day has nothing to be new against).
 */
export function classifyTrend(events: readonly number[], historyDays: number): { mark: Mark; last7: number; prev7: number } {
  const n = events.length;
  const at = (i: number) => (i >= 0 && i < n && Number.isFinite(events[i]) ? Math.max(0, events[i]!) : 0);
  let last7 = 0, prev7 = 0;
  for (let i = 0; i < 7; i++) { last7 += at(n - 1 - i); prev7 += at(n - 8 - i); }
  const firstSeen = events.findIndex(v => Number.isFinite(v) && v > 0);
  if (firstSeen < 0) return { mark: null, last7, prev7 };
  if (firstSeen >= n - 1 && historyDays >= NEW_MIN_HISTORY_DAYS) return { mark: "new", last7, prev7 };
  if (last7 >= RISING_MIN_EVENTS && last7 > 2 * prev7) return { mark: "rising", last7, prev7 };
  return { mark: null, last7, prev7 };
}

const utcDay = (t: number): Date => new Date(Math.floor(t / DAY) * DAY);
const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

// ---- Computing a day -------------------------------------------------------------------------------------------------------------------

/**
 * One finished UTC day: the errors and the matched events of the events received that day, grouped. Run again for the same day it gives the
 * same rows (the day's rows are replaced), so a night that was interrupted is simply redone.
 */
export async function computeTrendDay(pool: Pool, day: Date): Promise<{ errors: number; issues: number }> {
  const from = utcDay(day.getTime()), to = new Date(from.getTime() + DAY);
  return transaction(pool, async c => {
    await lock(c, "trends");
    const r = await c.query<{ errors: number; issues: number }>(
      `DELETE FROM error_daily WHERE [day] = CAST($1 AS date);
       DELETE FROM issue_daily WHERE [day] = CAST($1 AS date);
       -- One pass over the day's events: only errors and events a rule matched, with what the two groupings need.
       SELECT e.cabinet_id, c.id AS client_id, JSON_VALUE(e.source, '$.log') AS lg, JSON_VALUE(e.source, '$.source') AS src,
              TRY_CAST(JSON_VALUE(e.source, '$.eventId') AS int) AS eid, JSON_VALUE(e.source, '$.level') AS lvl, e.kind, r.issue_type_id,
              CASE WHEN e.matched_rule IS NOT NULL THEN 1 ELSE 0 END AS matched, LEFT(JSON_VALUE(e.detail, '$.message'), 300) AS msg
         INTO #day
         FROM events e JOIN cabinets k ON k.id = e.cabinet_id JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
         LEFT JOIN symptom_rules r ON r.id = e.matched_rule
        WHERE e.received_at >= $1 AND e.received_at < $2 AND (e.kind = 'error' OR e.matched_rule IS NOT NULL);
       -- Errors: every error with a source, minus the ones a suppress rule silenced; unmatched warnings are not "unrecognized errors".
       INSERT INTO error_daily ([day], client_id, [log], [source], event_id, issue_type_id, cabinets, [events], [sample])
       SELECT TOP (${MAX_GROUPS_PER_DAY}) CAST($1 AS date), client_id, LEFT(lg, 128), LEFT(src, 256), eid,
              CAST(MAX(CAST(issue_type_id AS char(36))) AS uniqueidentifier), COUNT(DISTINCT cabinet_id), COUNT(*), MAX(msg)
         FROM #day
        WHERE kind = 'error' AND lg IS NOT NULL AND src IS NOT NULL AND eid IS NOT NULL
          AND ((matched = 0 AND lvl IN ('error', 'critical')) OR (matched = 1 AND issue_type_id IS NOT NULL))
        GROUP BY client_id, LEFT(lg, 128), LEFT(src, 256), eid
        ORDER BY COUNT(DISTINCT cabinet_id) DESC, COUNT(*) DESC;
       DECLARE @errors int = @@ROWCOUNT;
       INSERT INTO issue_daily ([day], client_id, issue_type_id, cabinets, [events])
       SELECT CAST($1 AS date), client_id, issue_type_id, COUNT(DISTINCT cabinet_id), COUNT(*) FROM #day WHERE issue_type_id IS NOT NULL GROUP BY client_id, issue_type_id;
       DECLARE @issues int = @@ROWCOUNT;
       DROP TABLE #day;
       SELECT @errors AS errors, @issues AS issues;`, [from, to], { timeoutMs: 300_000 });
    return r.rows[0] ?? { errors: 0, issues: 0 };
  });
}

let running = false;
export const trendsRunning = (): boolean => running;

/**
 * Computes every finished day since the last run (at most the last 30), oldest first, keeps 35 days, and records how far it got. Safe to
 * start twice: the days are replaced, and only one run at a time per process goes ahead.
 */
export async function runErrorTrends(pool: Pool, o: { now?: number; actor?: { userId: string } } = {}): Promise<{ days: string[]; skipped: boolean }> {
  if (running) return { days: [], skipped: true };
  running = true;
  try {
    const today = utcDay(o.now ?? Date.now());
    const state = (await pool.query<{ through: Date | null }>("SELECT computed_through AS through FROM trend_state WHERE id = 1")).rows[0];
    const first = Math.max(state?.through ? utcDay(state.through.getTime()).getTime() + DAY : 0, today.getTime() - TREND_DAYS * DAY);
    const done: string[] = [];
    for (let t = first; t < today.getTime(); t += DAY) {
      await computeTrendDay(pool, new Date(t));
      done.push(dayKey(new Date(t)));
      await pool.query("UPDATE trend_state SET computed_through = CAST($1 AS date), computed_at = SYSUTCDATETIME() WHERE id = 1", [new Date(t)]);
    }
    const purged = (await pool.query("DELETE FROM error_daily WHERE [day] < $1; DELETE FROM issue_daily WHERE [day] < $1", [new Date(today.getTime() - KEEP_DAYS * DAY)])).rowCount;
    if (done.length === 0) await pool.query("UPDATE trend_state SET computed_at = SYSUTCDATETIME() WHERE id = 1");
    // A rising unrecognised error is an alert, not only a mark on the trends page (F17, D50): one fleet pattern each, while it is open somewhere.
    const rising = (await errorTrends(pool, { mark: "rising", unrecognized: "true" } as ErrorTrendQuery)).errors
      .map(e => ({ log: e.log, source: e.source, eventId: e.eventId, last7: e.last7, prev7: e.prev7 }));
    const risingOpened = await openRisingPatterns(pool, rising);
    await transaction(pool, c => audit(c, { actorKind: o.actor ? "user" : "system", actorId: o.actor?.userId ?? "trends", action: "trends.run", outcome: "succeeded", details: { days: done.length, purged, rising: rising.length, risingOpened } }));
    return { days: done, skipped: false };
  } finally { running = false; }
}

/** Runs the error trends every night, twenty minutes after the retention job, so the two do not compete. */
export function scheduleTroubleshootingJobs(pool: Pool, log: (message: string) => void, options: { at?: string } = {}): () => void {
  const base = parseDailyTime(options.at);
  const at = { hour: (base.hour + (base.minute + 20 >= 60 ? 1 : 0)) % 24, minute: (base.minute + 20) % 60 };
  let timer: NodeJS.Timeout | null = null;
  const plan = () => {
    timer = setTimeout(() => { void runErrorTrends(pool).catch(() => log("Error trends failed to run.")).finally(plan); }, Math.max(1_000, nextRunAt(at).getTime() - Date.now()));
    timer.unref();
  };
  plan();
  return () => { if (timer) clearTimeout(timer); };
}

// ---- Reading ---------------------------------------------------------------------------------------------------------------------------

export interface Series { cabinets: number[]; events: number[] }
export interface TrendRow { key: string; mark: Mark; cabinets: number; events: number; last7: number; prev7: number; series: Series }
export interface IssueTrend extends TrendRow { issueTypeId: string; name: string; severity: string }
export interface ErrorTrend extends TrendRow { log: string; source: string; eventId: number; issueTypeId: string | null; issueName: string | null; unrecognized: boolean; sample: string | null }

interface Loaded { through: Date | null; computedAt: Date | null; days: string[]; historyDays: number }

async function loadWindow(db: Queryable): Promise<Loaded> {
  const s = (await db.query<{ through: Date | null; at: Date | null }>("SELECT computed_through AS through, computed_at AS at FROM trend_state WHERE id = 1")).rows[0];
  const through = s?.through ? utcDay(s.through.getTime()) : null;
  const days = through ? Array.from({ length: TREND_DAYS }, (_, i) => dayKey(new Date(through.getTime() - (TREND_DAYS - 1 - i) * DAY))) : [];
  const history = through ? Number((await db.query<{ n: number }>("SELECT COUNT(DISTINCT [day]) AS n FROM error_daily WHERE [day] >= $1", [new Date(through.getTime() - (TREND_DAYS - 1) * DAY)])).rows[0]!.n) : 0;
  return { through, computedAt: s?.at ?? null, days, historyDays: history };
}

function series(days: string[], points: Map<string, { cabinets: number; events: number }>): Series {
  return { cabinets: days.map(d => points.get(d)?.cabinets ?? 0), events: days.map(d => points.get(d)?.events ?? 0) };
}

const clip = (s: Series, w: number): Series => ({ cabinets: s.cabinets.slice(-w), events: s.events.slice(-w) });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Issue-type and error trends for the fleet or one client, over 7, 14 or 30 days, with the new and rising marks. */
export async function errorTrends(db: Queryable, q: ErrorTrendQuery) {
  const w = q.days ? Number(q.days) : TREND_DAYS;
  const win = await loadWindow(db);
  const empty = { computedThrough: win.through ? dayKey(win.through) : null, computedAt: win.computedAt?.toISOString() ?? null, days: win.days.slice(-w), issues: [] as IssueTrend[], errors: [] as ErrorTrend[] };
  if (!win.through) return empty;
  const from = new Date(win.through.getTime() - (TREND_DAYS - 1) * DAY);
  const client = q.clientId ?? null;

  const ir = (await db.query<{ day: Date; issue_type_id: string; cabinets: number; events: number; name: string; severity: string }>(
    `SELECT d.[day], d.issue_type_id, SUM(d.cabinets) AS cabinets, SUM(d.[events]) AS [events], MAX(t.name) AS name, MAX(t.severity) AS severity
       FROM issue_daily d JOIN issue_types t ON t.id = d.issue_type_id
      WHERE d.[day] >= $1 AND ($2 IS NULL OR d.client_id = CAST($2 AS uniqueidentifier)) GROUP BY d.[day], d.issue_type_id`, [from, client])).rows;
  const byIssue = new Map<string, { name: string; severity: string; points: Map<string, { cabinets: number; events: number }> }>();
  for (const r of ir) {
    const g = byIssue.get(r.issue_type_id) ?? byIssue.set(r.issue_type_id, { name: r.name, severity: r.severity, points: new Map() }).get(r.issue_type_id)!;
    g.points.set(dayKey(r.day), { cabinets: Number(r.cabinets), events: Number(r.events) });
  }
  const issues: IssueTrend[] = [...byIssue.entries()].map(([issueTypeId, g]) => {
    const s = series(win.days, g.points), c = classifyTrend(s.events, win.historyDays), v = clip(s, w);
    return { key: issueTypeId, issueTypeId, name: g.name, severity: g.severity, mark: c.mark, cabinets: Math.max(0, ...v.cabinets), events: sum(v.events), last7: c.last7, prev7: c.prev7, series: v };
  });

  const er = (await db.query<{ day: Date; lg: string; src: string; eid: number; issue: string | null; cabinets: number; events: number; sample: string | null }>(
    `SELECT d.[day], d.[log] AS lg, d.[source] AS src, d.event_id AS eid, CAST(MAX(CAST(d.issue_type_id AS char(36))) AS uniqueidentifier) AS issue,
            SUM(d.cabinets) AS cabinets, SUM(d.[events]) AS [events], MAX(d.[sample]) AS [sample]
       FROM error_daily d WHERE d.[day] >= $1 AND ($2 IS NULL OR d.client_id = CAST($2 AS uniqueidentifier)) GROUP BY d.[day], d.[log], d.[source], d.event_id`, [from, client])).rows;
  const names = new Map((await db.query<{ id: string; name: string }>("SELECT id, name FROM issue_types")).rows.map(r => [r.id, r.name]));
  const byError = new Map<string, { lg: string; src: string; eid: number; issue: string | null; sample: string | null; points: Map<string, { cabinets: number; events: number }> }>();
  for (const r of er) {
    const key = `${r.lg}|${r.src}|${r.eid}`;
    const g = byError.get(key) ?? byError.set(key, { lg: r.lg, src: r.src, eid: r.eid, issue: r.issue, sample: r.sample, points: new Map() }).get(key)!;
    g.points.set(dayKey(r.day), { cabinets: Number(r.cabinets), events: Number(r.events) });
    if (r.issue) g.issue = r.issue;
    if (r.sample) g.sample = r.sample;
  }
  const errors: ErrorTrend[] = [...byError.entries()].map(([key, g]) => {
    const s = series(win.days, g.points), c = classifyTrend(s.events, win.historyDays), v = clip(s, w);
    return { key, log: g.lg, source: g.src, eventId: g.eid, issueTypeId: g.issue, issueName: g.issue ? names.get(g.issue) ?? null : null, unrecognized: g.issue === null,
      sample: g.sample, mark: c.mark, cabinets: Math.max(0, ...v.cabinets), events: sum(v.events), last7: c.last7, prev7: c.prev7, series: v };
  });

  const markOk = (m: Mark) => (q.mark === undefined || q.mark === "all" ? true : m === q.mark);
  const markRank = (m: Mark) => (m === "new" ? 0 : m === "rising" ? 1 : 2);
  const order = (a: TrendRow, b: TrendRow) => markRank(a.mark) - markRank(b.mark) || b.cabinets - a.cabinets || b.events - a.events || (a.key < b.key ? -1 : 1);
  return { ...empty,
    issues: issues.filter(i => markOk(i.mark) && i.events > 0).sort(order).slice(0, 100),
    errors: errors.filter(e => markOk(e.mark) && e.events > 0 && (q.unrecognized === undefined ? true : e.unrecognized === (q.unrecognized === "true"))).sort(order).slice(0, 200) };
}

/** The marks for the groups the triage queue shows (it ranks live alerts; the trend says whether each is new or growing). */
export async function trendMarks(db: Queryable, issueIds: string[], errors: { log: string; source: string; eventId: number }[]): Promise<{ issue: Map<string, { mark: Mark; last7: number; prev7: number }>; error: Map<string, { mark: Mark; last7: number; prev7: number }>; asOf: string | null }> {
  const win = await loadWindow(db);
  const out = { issue: new Map<string, { mark: Mark; last7: number; prev7: number }>(), error: new Map<string, { mark: Mark; last7: number; prev7: number }>(), asOf: win.through ? dayKey(win.through) : null };
  if (!win.through) return out;
  const from = new Date(win.through.getTime() - (TREND_DAYS - 1) * DAY);
  if (issueIds.length > 0) {
    const rows = (await db.query<{ day: Date; issue_type_id: string; events: number }>(
      "SELECT [day], issue_type_id, SUM([events]) AS [events] FROM issue_daily WHERE [day] >= $1 AND issue_type_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($2)) GROUP BY [day], issue_type_id", [from, issueIds])).rows;
    const by = new Map<string, Map<string, number>>();
    for (const r of rows) (by.get(r.issue_type_id) ?? by.set(r.issue_type_id, new Map()).get(r.issue_type_id)!).set(dayKey(r.day), Number(r.events));
    for (const [id, pts] of by) out.issue.set(id, classifyTrend(win.days.map(d => pts.get(d) ?? 0), win.historyDays));
  }
  if (errors.length > 0) {
    const rows = (await db.query<{ day: Date; lg: string; src: string; eid: number; events: number }>(
      `SELECT d.[day], d.[log] AS lg, d.[source] AS src, d.event_id AS eid, SUM(d.[events]) AS [events] FROM error_daily d
        WHERE d.[day] >= $1 AND EXISTS (SELECT 1 FROM OPENJSON($2) WITH (lg nvarchar(128) '$.log', src nvarchar(256) '$.source', eid int '$.eventId') x WHERE x.lg = d.[log] AND x.src = d.[source] AND x.eid = d.event_id)
        GROUP BY d.[day], d.[log], d.[source], d.event_id`, [from, JSON.stringify(errors)])).rows;
    const by = new Map<string, Map<string, number>>();
    for (const r of rows) { const k = `${r.lg}|${r.src}|${r.eid}`; (by.get(k) ?? by.set(k, new Map()).get(k)!).set(dayKey(r.day), Number(r.events)); }
    for (const [k, pts] of by) out.error.set(k, classifyTrend(win.days.map(d => pts.get(d) ?? 0), win.historyDays));
  }
  return out;
}
