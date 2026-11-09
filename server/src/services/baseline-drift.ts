// Drift: where a cabinet's configuration differs from the baseline in force (docs/spec/15-baselines-and-config.md). "Should be",
// kept apart from "what changed" (config_changes) and "what it was when it worked" (healthy marks). A category the cabinet has not
// reported yet is unknown, never drift. Nothing here puts anything back: it only reports.
import { lock, transaction, type Pool, type Queryable } from "../db/db.js";
import { valueText, type Item } from "./config-canonical.js";
import { currentItems, markBaselineViolations, type Category } from "./config-ingest.js";
import { resolveForCabinet, type Origin, type ResolvedItem } from "./baselines.js";
import { upsertAlert } from "./alerts.js";
import { closeAutomatically, CLOSED_OUTPUT } from "./automatic-close.js";
import { ISSUE } from "./rules.js";

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
    await checkFirmware(c, cabinetId, rows);
    // A change that left an item against its baseline is marked as violating it.
    await markBaselineViolations(c, cabinetId);
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
  const q: [string, unknown[]] = scope.kind === "global" ? [base, []] : scope.kind === "role" ? [`${base} AND k.role = $1`, [scope.id]] : scope.kind === "model" ? [`${base} AND k.model = $1`, [scope.id]]
    : scope.kind === "client" ? [`${base} AND s.client_id = $1`, [scope.id]] : scope.kind === "site" ? [`${base} AND k.site_id = $1`, [scope.id]] : [`${base} AND k.id = $1`, [scope.id]];
  return (await db.query<{ id: string }>(q[0], q[1])).rows.map(r => r.id);
}

export type { Category };

/** The hardware item's firmware fields a baseline can expect (F19.R7). */
export const FIRMWARE_FIELDS = ["biosVersion", "biosDate"] as const;
export const FIRMWARE_SIGNATURE = "firmware-drift";
const show = (v: unknown) => v === null || v === undefined ? "unknown" : String(v);

/** The alert's title: what the cabinet reports against what its baseline expects, field by field. */
export function firmwareTitle(drift: readonly DriftRow[]): string {
  return `Firmware differs from its model's expectation: ${drift.map(d => `${d.field === "biosDate" ? "BIOS date" : "BIOS"} ${show(d.actual)}, expected ${show(d.expected)}`).join("; ")}`;
}

/**
 * Firmware that differs from its baseline is a named, minor alert (F19.R7, decision-log D48): the drift already says it; this makes
 * someone look. Opened or updated while the drift is there, closed automatically (audited) once it is not. Never fixed by the platform.
 */
async function checkFirmware(c: Queryable, cabinetId: string, rows: readonly DriftRow[]): Promise<void> {
  // The hardware item is in the system category (config-ingest.ts), under the key "hardware".
  const firmware = rows.filter(r => r.category === "system" && r.itemKey === "hardware" && (FIRMWARE_FIELDS as readonly string[]).includes(r.field));
  if (firmware.length > 0) {
    const title = firmwareTitle(firmware);
    const { id } = await upsertAlert(c, { cabinetId, issueTypeId: ISSUE.firmwareDrift, severity: "minor", signature: FIRMWARE_SIGNATURE, title, seenAt: new Date(), ruleId: null, eventId: null });
    await c.query("UPDATE alerts SET title = $2 WHERE id = $1 AND title <> $2", [id, title]);
    return;
  }
  await closeAutomatically(c, "firmware-drift",
    `UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME(), resolution = $2 ${CLOSED_OUTPUT}
      WHERE cabinet_id = $1 AND signature = $3 AND state <> 'resolved'`,
    [cabinetId, "The cabinet's firmware matches its model's expectation again (seen in its configuration).", FIRMWARE_SIGNATURE]);
}
