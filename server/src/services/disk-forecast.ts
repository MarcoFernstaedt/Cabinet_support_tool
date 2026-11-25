// Free space on the system drive, projected forward from the heartbeat's own samples, so a drive that is filling up is flagged weeks
// before it is full (decision-log D151). It used to run when a cabinet's daily SMART report arrived; SMART is removed, so the daily job
// runs it for every cabinet that sent a load sample in the last two days, one cabinet at a time.
import type { Pool, Queryable } from "../db/db.js";
import { closeSignatureAlert, upsertAlert } from "./alerts.js";
import { ISSUE } from "./rules.js";
import { daysUntilEmpty, slopePerDay } from "./trends.js";

const FORECAST_CLEARED = "The system drive is no longer filling up.";

/** Free space on the system drive projected from the last two weeks: an alert when it would be full within 30 days. */
export async function diskForecast(db: Queryable, cabinetId: string): Promise<void> {
  const rows = (await db.query<{ at: Date; free: number }>(
    // Samples of the last 48 hours, and the hourly averages they were rolled up to before that.
    `SELECT [at], [free] FROM (
       SELECT [at], CAST(disk_free_percent AS int) AS [free] FROM health_samples WHERE cabinet_id = $1 AND [at] > DATEADD(day, -14, SYSUTCDATETIME())
       UNION ALL
       SELECT DATEADD(minute, 30, CAST([hour] AS datetime2(3))), disk_free_avg FROM health_hourly WHERE cabinet_id = $1 AND [hour] > DATEADD(day, -14, SYSUTCDATETIME())) x
     ORDER BY [at]`, [cabinetId])).rows;
  if (rows.length < 48) return;
  const days = daysUntilEmpty(rows[rows.length - 1]!.free, slopePerDay(rows.map(r => ({ t: r.at.getTime(), v: r.free })), 48, 5));
  if (days === null || days > 30) {
    // The closure is audited in the same transaction as the change (F4), by alerts.ts through closeAutomatically (D98).
    await closeSignatureAlert(db, "drive-forecast", cabinetId, "disk-forecast", FORECAST_CLEARED);
    return;
  }
  await upsertAlert(db, { cabinetId, issueTypeId: ISSUE.diskSpace, severity: days <= 7 ? "major" : "minor", signature: "disk-forecast",
    title: `The system drive is filling up: about ${Math.max(1, Math.round(days))} days until it is full`, seenAt: new Date(), ruleId: null, eventId: null });
}

/** The forecast for every cabinet not removed that sent a load sample in the last two days (raw samples are kept 48 hours). */
export async function forecastFleet(pool: Pool, onError: (cabinetId: string) => void = () => {}): Promise<number> {
  const ids = (await pool.query<{ id: string }>(
    `SELECT k.id FROM cabinets k WHERE k.status <> 'removed'
        AND EXISTS (SELECT 1 FROM health_samples s WHERE s.cabinet_id = k.id AND s.[at] > DATEADD(day, -2, SYSUTCDATETIME()))
      ORDER BY k.id`)).rows.map(r => r.id);
  // One cabinet failing (a deadlock with its own heartbeat, say) is logged and the rest still run.
  for (const id of ids) await diskForecast(pool, id).catch(() => onError(id));
  return ids.length;
}
