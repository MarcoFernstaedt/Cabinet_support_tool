// What the console and the agent API do with configuration: ingest then evaluate, and the reads behind the cabinet's configuration
// screens and the fleet's differences from baselines. Every read here is of what the platform already holds; nothing asks a cabinet.
import type { ConfigUpload } from "../contracts.js";
import type { Pool, Queryable } from "../db/db.js";
import { currentItems, ingestConfig, isCategory, type Category, type IngestSummary } from "./config-ingest.js";
import { evaluateBaselineDrift } from "./baseline-drift.js";
import { evaluateHealth } from "./cabinet-health.js";
import { likeContains } from "./sql-like.js";

/** Verifies and stores snapshots, then brings the cabinet's drift and health up to date once. */
export async function ingestAndEvaluate(pool: Pool, cabinetId: string, snapshots: ConfigUpload["snapshots"], source: "agent" | "refresh"): Promise<IngestSummary> {
  const summary = await ingestConfig(pool, cabinetId, snapshots, source);
  if (summary.first + summary.changed > 0) await evaluateBaselineDrift(pool, cabinetId);
  await evaluateHealth(pool, cabinetId, new Date(), summary.first + summary.changed > 0 ? summary.latestObservedAt : null);
  return summary;
}

/** The configuration a cabinet reported last, by category (the items as reported; nothing is read from the cabinet). */
export async function currentConfig(db: Queryable, cabinetId: string, category?: Category) {
  const current = await currentItems(db, cabinetId, category ? [category] : undefined);
  return [...current].sort(([a], [b]) => (a < b ? -1 : 1)).map(([c, r]) => ({ category: c, hash: r.hash, items: r.items, truncated: r.truncated, observedAt: r.observedAt.toISOString(), firstObservedAt: r.changedAt.toISOString() }));
}

export interface ChangeFilter { category?: Category | undefined; days: number; q?: string | undefined; violations?: boolean | undefined; limit: number }

/** The change records, newest first, each with the window it is known to have happened in. */
export async function changesFor(db: Queryable, cabinetId: string, f: ChangeFilter) {
  const rows = (await db.query<{ id: string; category: Category; item_key: string; change: string; fields: unknown; not_before: Date | null; observed_at: Date; exact_at: Date | null; gap: boolean; via_platform: boolean; violates_baseline: boolean }>(
    `SELECT TOP (${Math.max(1, Math.min(500, Math.floor(f.limit)))}) id, category, item_key, change, fields, not_before, observed_at, exact_at, gap, via_platform, violates_baseline FROM config_changes
      WHERE cabinet_id = $1 AND observed_at > DATEADD(day, -$2, SYSUTCDATETIME()) AND (CAST($3 AS nvarchar(16)) IS NULL OR category = $3)
        AND (CAST($4 AS nvarchar(200)) IS NULL OR item_key LIKE $4 ESCAPE '\\') AND ($5 = 0 OR violates_baseline = 1)
      ORDER BY observed_at DESC, id DESC`, [cabinetId, f.days, f.category ?? null, f.q ? likeContains(f.q).slice(0, 200) : null, f.violations === true ? 1 : 0])).rows;
  return rows.map(r => ({ id: Number(r.id), category: r.category, itemKey: r.item_key, change: r.change, fields: r.fields, notBefore: r.not_before?.toISOString() ?? null, observedAt: r.observed_at.toISOString(),
    exactAt: r.exact_at?.toISOString() ?? null, gap: r.gap, viaPlatform: r.via_platform, violatesBaseline: r.violates_baseline }));
}

export { isCategory };

// ---- The fleet's differences from baselines -----------------------------------------------------------------------------------

export interface DifferenceScope { clientId?: string | undefined; siteId?: string | undefined }
const IN_SCOPE = "(CAST($1 AS nvarchar(36)) IS NULL OR s.client_id = TRY_CAST($1 AS uniqueidentifier)) AND (CAST($2 AS nvarchar(36)) IS NULL OR s.id = TRY_CAST($2 AS uniqueidentifier))";

/** The differences from baselines found anywhere in the fleet (or one client or site), most widespread first, with how many cabinets show each. */
export async function fleetDifferences(db: Queryable, scope: DifferenceScope) {
  const rows = (await db.query<{ category: string; item_key: string; field: string; cabinets: number; major: number; required: number }>(
    `SELECT TOP (500) d.category, d.item_key, d.field, COUNT(*) AS cabinets, SUM(CASE WHEN d.severity = 'major' THEN 1 ELSE 0 END) AS major, SUM(CASE WHEN d.[required] = 1 THEN 1 ELSE 0 END) AS [required]
       FROM cabinet_drift d JOIN cabinets k ON k.id = d.cabinet_id JOIN sites s ON s.id = k.site_id
      WHERE k.status = 'active' AND ${IN_SCOPE}
      GROUP BY d.category, d.item_key, d.field ORDER BY COUNT(*) DESC, d.category, d.item_key, d.field`, [scope.clientId ?? null, scope.siteId ?? null])).rows;
  const checked = (await db.query<{ n: number; withBaseline: number }>(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN h.state IN ('healthy', 'degraded') THEN 1 ELSE 0 END) AS withBaseline
       FROM cabinets k JOIN sites s ON s.id = k.site_id LEFT JOIN cabinet_health h ON h.cabinet_id = k.id
      WHERE k.status = 'active' AND EXISTS (SELECT 1 FROM config_current c WHERE c.cabinet_id = k.id) AND ${IN_SCOPE}`, [scope.clientId ?? null, scope.siteId ?? null])).rows[0]!;
  return {
    cabinetsReporting: Number(checked.n), cabinetsJudged: Number(checked.withBaseline ?? 0),
    groups: rows.map(r => ({ category: r.category, itemKey: r.item_key, field: r.field, cabinets: Number(r.cabinets), major: Number(r.major), required: Number(r.required) })),
  };
}

/** The cabinets that differ in one way, each with what the baseline expects and what it reports, and the cabinets that report the same item and do not differ. */
export async function fleetDifferenceGroup(db: Queryable, q: { category: string; itemKey: string; field?: string | undefined } & DifferenceScope) {
  const params = [q.clientId ?? null, q.siteId ?? null, q.category, q.itemKey, q.field ?? ""];
  const affected = (await db.query<{ id: string; name: string; site_id: string; site: string; client: string; model: string | null; expected: unknown; actual: unknown; mode: string; severity: string; first_seen: Date; online: boolean }>(
    `SELECT TOP (1000) k.id, k.name, s.id AS site_id, s.name AS site, c.name AS client, k.model, d.expected, d.actual, d.mode, d.severity, d.first_seen,
            CAST(CASE WHEN k.last_heartbeat_at > DATEADD(minute, -10, SYSUTCDATETIME()) THEN 1 ELSE 0 END AS bit) AS online
       FROM cabinet_drift d JOIN cabinets k ON k.id = d.cabinet_id JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
      WHERE k.status = 'active' AND d.category = $3 AND d.item_key = $4 AND d.field = $5 AND ${IN_SCOPE}
      ORDER BY c.name, s.name, k.name`, params)).rows;
  const total = (await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cabinet_drift d JOIN cabinets k ON k.id = d.cabinet_id JOIN sites s ON s.id = k.site_id
      WHERE k.status = 'active' AND d.category = $3 AND d.item_key = $4 AND d.field = $5 AND ${IN_SCOPE}`, params)).rows[0]!;
  const unaffected = (await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM config_current cc JOIN cabinets k ON k.id = cc.cabinet_id JOIN sites s ON s.id = k.site_id
      WHERE k.status = 'active' AND cc.category = $3 AND ${IN_SCOPE}
        AND NOT EXISTS (SELECT 1 FROM cabinet_drift d WHERE d.cabinet_id = k.id AND d.category = $3 AND d.item_key = $4 AND d.field = $5)`, params)).rows[0]!;
  const jsonValue = (raw: unknown): unknown => { if (typeof raw !== "string") return raw ?? null; try { return JSON.parse(raw) as unknown; } catch { return null; } };
  return {
    category: q.category, itemKey: q.itemKey, field: q.field ?? "", affected: Number(total.n), listed: affected.length, unaffected: Number(unaffected.n),
    cabinets: affected.map(a => ({ id: a.id, name: a.name, siteId: a.site_id, site: a.site, client: a.client, model: a.model, mode: a.mode, severity: a.severity, expected: jsonValue(a.expected), actual: jsonValue(a.actual),
      since: a.first_seen.toISOString(), online: a.online })),
  };
}
