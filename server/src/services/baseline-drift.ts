// Drift: where a cabinet's configuration differs from the baseline in force (docs/spec/15-baselines-and-config.md). "Should be",
// kept apart from "what changed" (config_changes) and "what it was when it worked" (healthy marks). A category the cabinet has not
// reported yet is unknown, never drift. Nothing here puts anything back: it only reports.
import { lock, transaction, type Pool, type Queryable } from "../db/db.js";
import { valueText, type Item } from "./config-canonical.js";
import { currentItems, type Category } from "./config-ingest.js";
import { resolveForCabinet, type Origin, type ResolvedItem } from "./baselines.js";

export interface DriftRow {
  category: string; itemKey: string; field: string; mode: "match" | "present" | "absent"; expected: unknown; actual: unknown;
  origin: Origin; severity: "minor" | "major"; required: boolean;
}

/** Pure: the drift between resolved expectations and the reported items by category. */
export function computeDrift(items: readonly ResolvedItem[], current: ReadonlyMap<string, readonly Item[]>): DriftRow[] {
  const out: DriftRow[] = [];
  const byKey = new Map<string, Map<string, Item>>();
  for (const [category, list] of current) byKey.set(category, new Map(list.map(i => [i.key, i])));
  for (const e of items) {
    const reported = byKey.get(e.category);
    if (!reported) continue; // never reported: unknown
    const have = reported.get(e.key);
    const base = { category: e.category, itemKey: e.key, origin: e.origin, severity: e.severity, required: e.required };
    if (e.mode === "present") { if (!have) out.push({ ...base, field: "", mode: "present", expected: true, actual: false }); continue; }
    if (e.mode === "absent") { if (have) out.push({ ...base, field: "", mode: "absent", expected: false, actual: true }); continue; }
    if (!have) { out.push({ ...base, field: "", mode: "match", expected: e.expect, actual: null }); continue; }
    for (const [field, want] of Object.entries(e.expect ?? {}))
      if (valueText(have.values[field]) !== valueText(want)) out.push({ ...base, field, mode: "match", expected: want, actual: have.values[field] ?? null });
  }
  return out;
}

/** A stored expected or actual value: any JSON value, so a scalar comes back as text to be parsed. */
const jsonValue = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw ?? null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
};

/**
 * Recomputes and stores the cabinet's drift in two statements however many rows there are; returns the rows. The first-seen time of
 * drift that is still there is kept, and drift that cleared is removed.
 */
export async function evaluateBaselineDrift(pool: Pool, cabinetId: string): Promise<DriftRow[]> {
  return transaction(pool, async c => {
    await lock(c, `drift:${cabinetId}`);
    const resolved = await resolveForCabinet(c, cabinetId);
    const current = await currentItems(c, cabinetId);
    const rows = computeDrift(resolved.items, new Map([...current].map(([k, v]) => [k, v.items])));
    const payload = rows.map(r => ({ category: r.category, itemKey: r.itemKey, field: r.field, mode: r.mode, expected: r.expected === undefined ? null : JSON.stringify(r.expected),
      actual: r.actual === undefined ? null : JSON.stringify(r.actual), origin: JSON.stringify(r.origin), severity: r.severity, required: r.required ? 1 : 0 }));
    const columns = "category nvarchar(16) '$.category', item_key nvarchar(200) '$.itemKey', field nvarchar(32) '$.field'";
    await c.query(
      `DELETE d FROM cabinet_drift d WHERE d.cabinet_id = $1
          AND NOT EXISTS (SELECT 1 FROM OPENJSON($2) WITH (${columns}) j WHERE j.category = d.category AND j.item_key = d.item_key AND j.field = d.field)`, [cabinetId, payload]);
    if (payload.length > 0)
      await c.query(
        `MERGE cabinet_drift WITH (HOLDLOCK) AS t
         USING (SELECT * FROM OPENJSON($2) WITH (${columns}, mode nvarchar(8) '$.mode', expected nvarchar(max) '$.expected', actual nvarchar(max) '$.actual',
                                                  origin nvarchar(max) '$.origin', severity nvarchar(8) '$.severity', [required] bit '$.required')) AS s
            ON t.cabinet_id = $1 AND t.category = s.category AND t.item_key = s.item_key AND t.field = s.field
          WHEN MATCHED THEN UPDATE SET mode = s.mode, expected = s.expected, actual = s.actual, origin = s.origin, severity = s.severity, [required] = s.[required], last_seen = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN INSERT (cabinet_id, category, item_key, field, mode, expected, actual, origin, severity, [required], first_seen, last_seen)
               VALUES ($1, s.category, s.item_key, s.field, s.mode, s.expected, s.actual, s.origin, s.severity, s.[required], SYSUTCDATETIME(), SYSUTCDATETIME());`, [cabinetId, payload]);
    // A change that left an item against its baseline is marked as violating it.
    await c.query(
      `UPDATE ch SET violates_baseline = CASE WHEN EXISTS (SELECT 1 FROM cabinet_drift d WHERE d.cabinet_id = ch.cabinet_id AND d.category = ch.category AND d.item_key = ch.item_key) THEN 1 ELSE 0 END
         FROM config_changes ch WHERE ch.cabinet_id = $1 AND ch.observed_at > DATEADD(day, -30, SYSUTCDATETIME())`, [cabinetId]);
    return rows;
  });
}

export async function driftFor(db: Queryable, cabinetId: string) {
  const rows = (await db.query<{ category: string; item_key: string; field: string; mode: string; expected: unknown; actual: unknown; origin: Origin; severity: string; required: boolean; first_seen: Date }>(
    `SELECT TOP (2000) category, item_key, field, mode, expected, actual, origin, severity, [required], first_seen FROM cabinet_drift WHERE cabinet_id = $1
      ORDER BY CASE WHEN severity = 'major' THEN 0 ELSE 1 END, category, item_key, field`, [cabinetId])).rows;
  return rows.map(r => ({ category: r.category, itemKey: r.item_key, field: r.field, mode: r.mode, expected: jsonValue(r.expected), actual: jsonValue(r.actual), origin: r.origin,
    severity: r.severity, required: r.required, firstSeen: r.first_seen.toISOString() }));
}

/** The active cabinets (that have reported a configuration) a baseline in this scope applies to. */
export async function cabinetsInScope(db: Queryable, scope: { kind: string; id: string | null }): Promise<string[]> {
  const base = "SELECT DISTINCT k.id FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN config_current c ON c.cabinet_id = k.id WHERE k.status = 'active'";
  const q: [string, unknown[]] = scope.kind === "global" ? [base, []] : scope.kind === "model" ? [`${base} AND k.model = $1`, [scope.id]]
    : scope.kind === "client" ? [`${base} AND s.client_id = $1`, [scope.id]] : scope.kind === "site" ? [`${base} AND k.site_id = $1`, [scope.id]] : [`${base} AND k.id = $1`, [scope.id]];
  return (await db.query<{ id: string }>(q[0], q[1])).rows.map(r => r.id);
}

export type { Category };
