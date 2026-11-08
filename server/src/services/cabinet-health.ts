// Health and the last known healthy state (docs/spec/15-baselines-and-config.md). Health is judged from meaningful checks, not from the
// agent being online: recent contact, every required baseline item meeting its expectation, no open major alert. A cabinet
// with no baseline or no snapshot yet is "unknown", never "healthy". The criteria come from the baseline in force (so they vary by model,
// client, site and cabinet). When a healthy cabinet's configuration is not the one the last mark recorded, a new mark is stored.
import { lock, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { ISSUE } from "./rules.js";
import { resolveForCabinet, type ResolvedHealth } from "./baselines.js";
import { diffItems, type ItemChange } from "./config-diff.js";
import { CATEGORIES, currentItems, unpackItems, type Category } from "./config-ingest.js";

export type HealthState = "healthy" | "degraded" | "offline" | "unknown";
export interface Reason { code: "no_contact" | "required_item" | "critical_alert" | "no_configuration" | "no_baseline"; text: string; detail?: unknown }
export const KEEP_MARKS = 10;
export const MARK_DAYS = 30;
export const MAX_MARKS = 60;
/** A cabinet is judged again at least this often (contact can lapse with no event to trigger it). */
export const SWEEP_MINUTES = 15;

export interface Facts { lastContactAt: Date | null; now: Date; hasConfig: boolean; hasBaseline: boolean; requiredDrift: { itemKey: string; field: string; category: string }[]; criticalAlerts: { title: string }[] }

/** Pure: the state and why. */
export function judge(f: Facts, h: ResolvedHealth): { state: HealthState; reasons: Reason[] } {
  const reasons: Reason[] = [];
  const quiet = f.lastContactAt === null || f.now.getTime() - f.lastContactAt.getTime() > h.maxOfflineMinutes * 60_000;
  if (quiet) return { state: "offline", reasons: [{ code: "no_contact", text: f.lastContactAt ? `Not heard from since ${f.lastContactAt.toISOString()}.` : "Never heard from." }] };
  if (!f.hasConfig) return { state: "unknown", reasons: [{ code: "no_configuration", text: "The cabinet has not reported its configuration yet." }] };
  if (!f.hasBaseline) return { state: "unknown", reasons: [{ code: "no_baseline", text: "No approved baseline applies to this cabinet, so there is nothing to judge its configuration against." }] };
  if (h.requireRequiredItems) for (const d of f.requiredDrift) reasons.push({ code: "required_item", text: `${d.itemKey}${d.field ? ` (${d.field})` : ""} is not as the baseline requires.`, detail: d });
  if (h.requireNoCriticalAlerts) for (const a of f.criticalAlerts) reasons.push({ code: "critical_alert", text: a.title });
  return { state: reasons.length === 0 ? "healthy" : "degraded", reasons };
}

export interface HealthView { state: HealthState; evaluatedAt: string; since: string; reasons: Reason[]; lastHealthyAt: string | null; lastMarkId: number | null; degradedSince: string | null }

async function facts(c: Queryable, cabinetId: string, now: Date): Promise<Facts> {
  const k = (await c.query<{ last: Date | null }>("SELECT last_heartbeat_at AS [last] FROM cabinets WHERE id = $1", [cabinetId])).rows[0];
  const hasConfig = (await c.query("SELECT TOP (1) 1 AS x FROM config_current WHERE cabinet_id = $1", [cabinetId])).rows.length > 0;
  const drift = (await c.query<{ item_key: string; field: string; category: string }>("SELECT item_key, field, category FROM cabinet_drift WHERE cabinet_id = $1 AND [required] = 1", [cabinetId])).rows;
  // Not the offline alerts: that the cabinet is out of contact is judged above, from the contact itself.
  const alerts = (await c.query<{ title: string }>(
    `SELECT TOP (10) CAST(title AS nvarchar(300)) AS title FROM alerts WITH (FORCESEEK) WHERE cabinet_id = $1 AND state <> 'resolved' AND scope = 'fleet' AND severity = 'major'
        AND (issue_type_id IS NULL OR issue_type_id NOT IN (CAST($2 AS uniqueidentifier), CAST($3 AS uniqueidentifier))) ORDER BY last_seen DESC`, [cabinetId, ISSUE.offline, ISSUE.siteOutage])).rows;
  return { lastContactAt: k?.last ?? null, now, hasConfig, hasBaseline: false, requiredDrift: drift.map(d => ({ itemKey: d.item_key, field: d.field, category: d.category })), criticalAlerts: alerts };
}

/** Evaluates one cabinet, stores the result, and keeps a healthy mark when the configuration changed since the last one. */
export async function evaluateHealth(pool: Pool, cabinetId: string, now = new Date(), observedAt?: Date | null): Promise<HealthView> {
  return transaction(pool, async c => {
    await lock(c, `health:${cabinetId}`);
    const resolved = await resolveForCabinet(c, cabinetId);
    const f = await facts(c, cabinetId, now);
    f.hasBaseline = resolved.scopes.length > 0;
    const { state, reasons } = judge(f, resolved.health);
    const prev = (await c.query<{ state: HealthState; since: Date; last_healthy_at: Date | null; last_mark_id: string | null; degraded_since: Date | null }>(
      "SELECT state, since, last_healthy_at, last_mark_id, degraded_since FROM cabinet_health WITH (UPDLOCK, ROWLOCK) WHERE cabinet_id = $1", [cabinetId])).rows[0];
    // A change of state is dated by what the agent observed when that is what triggered this (never earlier than the last change of state).
    const stamp = observedAt && observedAt < now ? new Date(Math.max(observedAt.getTime(), prev?.since.getTime() ?? 0)) : now;
    const changed = !prev || prev.state !== state;
    const since = changed ? stamp : prev!.since;
    const lastHealthyAt = state === "healthy" ? stamp : prev?.last_healthy_at ?? null;
    // The problem began between the last healthy look and the first unhealthy one; the later of the two is when it was first observed.
    const degradedSince = state === "healthy" ? null : state === "unknown" ? prev?.degraded_since ?? null : prev?.degraded_since ?? stamp;
    let markId = prev?.last_mark_id ? Number(prev.last_mark_id) : null;
    if (state === "healthy") markId = await keepMark(c, cabinetId, stamp, resolved.scopes.map(s => ({ kind: s.kind, id: s.id, version: s.version }))) ?? markId;
    await c.query(
      `MERGE cabinet_health WITH (HOLDLOCK) AS t
       USING (SELECT $1 AS cabinet_id) AS s ON t.cabinet_id = s.cabinet_id
        WHEN MATCHED THEN UPDATE SET state = $2, evaluated_at = $3, since = $4, reasons = $5, last_healthy_at = $6, last_mark_id = $7, degraded_since = $8
        WHEN NOT MATCHED THEN INSERT (cabinet_id, state, evaluated_at, since, reasons, last_healthy_at, last_mark_id, degraded_since) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
      [cabinetId, state, now, since, safeJson(reasons), lastHealthyAt, markId, degradedSince]);
    if (changed) await c.query("INSERT INTO health_transitions (cabinet_id, [at], from_state, to_state, reasons) VALUES ($1, $2, $3, $4, $5)", [cabinetId, stamp, prev?.state ?? null, state, safeJson(reasons)]);
    return { state, evaluatedAt: now.toISOString(), since: since.toISOString(), reasons, lastHealthyAt: lastHealthyAt?.toISOString() ?? null, lastMarkId: markId, degradedSince: degradedSince?.toISOString() ?? null };
  });
}

const sortKeys = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

/** A mark of what is in force now, unless the last mark already recorded exactly this. Returns the mark ID (new or the unchanged last one). */
async function keepMark(c: Queryable, cabinetId: string, now: Date, inForce: unknown): Promise<number | null> {
  const rows = (await c.query<{ category: string; version_id: string }>("SELECT category, version_id FROM config_current WHERE cabinet_id = $1", [cabinetId])).rows;
  const versions = Object.fromEntries(rows.map(r => [r.category, Number(r.version_id)]));
  const last = (await c.query<{ id: string; versions: Record<string, number> }>("SELECT TOP (1) id, versions FROM healthy_marks WHERE cabinet_id = $1 ORDER BY id DESC", [cabinetId])).rows[0];
  if (last && JSON.stringify(sortKeys(last.versions)) === JSON.stringify(sortKeys(versions))) return Number(last.id);
  const id = Number((await c.query<{ id: string }>("INSERT INTO healthy_marks (cabinet_id, marked_at, versions, in_force) OUTPUT inserted.id VALUES ($1, $2, $3, $4)",
    [cabinetId, now, safeJson(versions), safeJson(inForce)])).rows[0]!.id);
  await pruneMarks(c, cabinetId);
  return id;
}

/**
 * Recent marks are kept (30 days, and always the last 10), within a cap. The mark the cabinet's health points at is never deleted
 * (F8.R2): "changed since healthy" and the last healthy state are read from it. The foreign key from cabinet_health refuses it too.
 */
export async function pruneMarks(c: Queryable, cabinetId: string): Promise<number> {
  return (await c.query(
    `DELETE FROM healthy_marks WHERE cabinet_id = $1 AND id IN (
       SELECT x.id FROM (SELECT id, marked_at, ROW_NUMBER() OVER (ORDER BY id DESC) AS n FROM healthy_marks WHERE cabinet_id = $1) x
        WHERE x.n > $2 AND (x.marked_at < DATEADD(day, -$3, SYSUTCDATETIME()) OR x.n > $4))
       AND NOT EXISTS (SELECT 1 FROM cabinet_health h WHERE h.cabinet_id = $1 AND h.last_mark_id = healthy_marks.id)`,
    [cabinetId, KEEP_MARKS, MARK_DAYS, MAX_MARKS])).rowCount;
}

export async function healthFor(db: Queryable, cabinetId: string): Promise<HealthView & { changesSinceHealthy: number | null }> {
  const h = (await db.query<{ state: HealthState; evaluated_at: Date; since: Date; reasons: Reason[]; last_healthy_at: Date | null; last_mark_id: string | null; degraded_since: Date | null }>(
    "SELECT state, evaluated_at, since, reasons, last_healthy_at, last_mark_id, degraded_since FROM cabinet_health WHERE cabinet_id = $1", [cabinetId])).rows[0];
  if (!h) return { state: "unknown", evaluatedAt: new Date(0).toISOString(), since: new Date(0).toISOString(), reasons: [{ code: "no_configuration", text: "Not evaluated yet." }], lastHealthyAt: null, lastMarkId: null, degradedSince: null, changesSinceHealthy: null };
  const view: HealthView = { state: h.state, evaluatedAt: h.evaluated_at.toISOString(), since: h.since.toISOString(), reasons: h.reasons, lastHealthyAt: h.last_healthy_at?.toISOString() ?? null,
    lastMarkId: h.last_mark_id ? Number(h.last_mark_id) : null, degradedSince: h.degraded_since?.toISOString() ?? null };
  const cmp = h.last_mark_id && h.state !== "healthy" ? await compareWithHealthy(db, cabinetId) : null;
  return { ...view, changesSinceHealthy: cmp ? cmp.changes.length : h.state === "healthy" ? 0 : null };
}

export interface CategoryChange extends ItemChange { category: string }

/** What differs between the last healthy mark and the configuration now, by category and item. */
export async function compareWithHealthy(db: Queryable, cabinetId: string): Promise<{ markId: number; markedAt: string; changes: CategoryChange[]; unavailable: string[] } | null> {
  const mark = (await db.query<{ id: string; marked_at: Date; versions: Record<string, number> }>(
    "SELECT m.id, m.marked_at, m.versions FROM healthy_marks m JOIN cabinet_health h ON h.last_mark_id = m.id WHERE h.cabinet_id = $1", [cabinetId])).rows[0];
  if (!mark) return null;
  const now = await currentItems(db, cabinetId);
  const changes: CategoryChange[] = [];
  const unavailable: string[] = [];
  for (const category of CATEGORIES) {
    const then = mark.versions[category], cur = now.get(category as Category);
    if (then === undefined || !cur || cur.versionId === then) continue;
    const old = (await db.query<{ items: Buffer }>("SELECT items FROM config_versions WHERE id = $1 AND cabinet_id = $2", [then, cabinetId])).rows[0];
    if (!old) { unavailable.push(category); continue; }
    for (const ch of diffItems(unpackItems(old.items), cur.items)) changes.push({ ...ch, category });
  }
  return { markId: Number(mark.id), markedAt: mark.marked_at.toISOString(), changes, unavailable };
}

/**
 * Evaluates the cabinets that most need it (the periodic sweep: contact can lapse, and come back, with no event to trigger it): first those
 * whose state disagrees with their contact, then the ones evaluated longest ago, at most `limit` a time.
 */
export async function sweepHealth(pool: Pool, limit = 300): Promise<number> {
  const ids = (await pool.query<{ id: string }>(
    `SELECT TOP (${Math.max(1, Math.min(2000, Math.floor(limit)))}) k.id FROM cabinets k LEFT JOIN cabinet_health h ON h.cabinet_id = k.id
      WHERE k.status = 'active' AND EXISTS (SELECT 1 FROM config_current c WHERE c.cabinet_id = k.id)
        AND (h.evaluated_at IS NULL OR h.evaluated_at < DATEADD(minute, -${SWEEP_MINUTES}, SYSUTCDATETIME())
             OR (h.state = 'offline' AND k.last_heartbeat_at >= DATEADD(minute, -10, SYSUTCDATETIME()) AND h.evaluated_at < DATEADD(minute, -1, SYSUTCDATETIME()))
             OR (h.state <> 'offline' AND (k.last_heartbeat_at IS NULL OR k.last_heartbeat_at < DATEADD(minute, -10, SYSUTCDATETIME())) AND h.evaluated_at < DATEADD(minute, -1, SYSUTCDATETIME())))
      ORDER BY CASE WHEN h.evaluated_at IS NULL THEN 0 WHEN h.evaluated_at >= DATEADD(minute, -${SWEEP_MINUTES}, SYSUTCDATETIME()) THEN 1 ELSE 2 END, h.evaluated_at`)).rows.map(r => r.id);
  for (const id of ids) await evaluateHealth(pool, id);
  return ids.length;
}
