// Drive health over time. Each drive's own report arrives once a day with a heartbeat; the history is judged by the rules in trends.ts, an
// alert is raised when a drive reaches "act" or "urgent" (and only when its level rises), and the free space on the system drive is
// projected forward so a drive that is filling up is flagged weeks before it is full.
import type { DriveHealthReport } from "../contracts.js";
import { audit, type Queryable } from "../db/db.js";
import { upsertAlert } from "./alerts.js";
import { ISSUE } from "./rules.js";
import { assessDrive, daysUntilEmpty, higher, slopePerDay, type Assessment, type DriveSample, type Level } from "./trends.js";

const DAY = 86_400_000;
/** At most one sample per drive in this time, so a repeated report adds nothing. */
const MIN_GAP_HOURS = 12;

/** A drive's serial number when it has one; otherwise its model and position, so two drives without serial numbers never share a history. */
export const driveKey = (d: Pick<DriveHealthReport, "serialNumber" | "model">, index: number): string =>
  (d.serialNumber?.trim() ? d.serialNumber.trim() : `${d.model?.trim() || "drive"}#${index}`).slice(0, 256);

interface Row { drive_key: string; at: Date; model: string | null; serial_number: string | null; health: DriveSample["health"]; predict_failure: boolean | null; temperature_c: number | null;
  power_on_hours: string | null; reallocated: string | null; pending: string | null; uncorrectable: string | null; wear_percent: number | null }
const num = (v: string | null) => (v === null ? null : Number(v));
const toSample = (r: Row): DriveSample => ({ at: r.at.getTime(), health: r.health, predictFailure: r.predict_failure, temperature: r.temperature_c, reallocated: num(r.reallocated),
  pending: num(r.pending), uncorrectable: num(r.uncorrectable), wear: r.wear_percent });

/** Stores a cabinet's drive report, judges each drive's history and raises an alert for a drive that has become a concern. */
export async function recordDriveReport(db: Queryable, cabinetId: string, drives: readonly DriveHealthReport[]): Promise<void> {
  for (const [i, d] of drives.entries()) {
    const key = driveKey(d, i);
    const stored = await db.query(
      `INSERT INTO drive_samples (cabinet_id, drive_key, [at], model, serial_number, health, predict_failure, temperature_c, power_on_hours, reallocated, pending, uncorrectable, wear_percent)
       SELECT $1, $2, SYSUTCDATETIME(), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
        WHERE NOT EXISTS (SELECT 1 FROM drive_samples WHERE cabinet_id = $1 AND drive_key = $2 AND [at] > DATEADD(hour, -$13, SYSUTCDATETIME()))`,
      [cabinetId, key, d.model, d.serialNumber, d.health, d.predictFailure, d.temperatureCelsius, d.powerOnHours, d.reallocatedSectors, d.pendingSectors, d.uncorrectableErrors, d.wearPercent, MIN_GAP_HOURS]);
    if ((stored.rowCount ?? 0) > 0) await refreshDrive(db, cabinetId, key);
  }
  await diskForecast(db, cabinetId);
}

/** Judges one drive's stored history now, keeps the result, and raises or escalates the alert when the level rose. */
export async function refreshDrive(db: Queryable, cabinetId: string, key: string): Promise<Assessment> {
  const rows = (await db.query<Row>("SELECT * FROM drive_samples WHERE cabinet_id = $1 AND drive_key = $2 ORDER BY [at]", [cabinetId, key])).rows;
  const assessment = assessDrive(rows.map(toSample));
  const newest = rows[rows.length - 1];
  const previous = (await db.query<{ level: Level }>("SELECT [level] FROM drive_status WHERE cabinet_id = $1 AND drive_key = $2", [cabinetId, key])).rows[0]?.level ?? "ok";
  // The alert comes before the stored level, so if raising it fails the next report still sees the level as not yet raised and tries again.
  if ((assessment.level === "act" || assessment.level === "urgent") && higher(assessment.level, previous)) {
    await upsertAlert(db, { cabinetId, issueTypeId: ISSUE.drive, severity: assessment.level === "urgent" ? "major" : "minor", signature: `drive-trend:${key}`,
      title: `Drive failing: ${newest?.model ?? "a drive"}`.slice(0, 300), seenAt: new Date(), ruleId: null, eventId: null });
    await audit(db, { actorKind: "system", actorId: "drive-trends", action: "drive.concern", targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded",
      details: { drive: key, level: assessment.level, reasons: assessment.reasons.map(r => r.code) } });
  }
  await db.query(
    `MERGE drive_status WITH (HOLDLOCK) AS t USING (SELECT CAST($1 AS uniqueidentifier) AS cabinet_id, CAST($2 AS nvarchar(256)) AS drive_key) AS s
        ON t.cabinet_id = s.cabinet_id AND t.drive_key = s.drive_key
      WHEN MATCHED THEN UPDATE SET model = $3, [level] = $4, reasons = $5, projection = $6, assessed_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (cabinet_id, drive_key, model, [level], reasons, projection, assessed_at) VALUES ($1, $2, $3, $4, $5, $6, SYSUTCDATETIME());`,
    [cabinetId, key, newest?.model ?? null, assessment.level, JSON.stringify(assessment.reasons), JSON.stringify(assessment.projection)]);
  return assessment;
}

/** Free space on the system drive projected from the last two weeks: an alert when it would be full within 30 days. */
async function diskForecast(db: Queryable, cabinetId: string): Promise<void> {
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
    await db.query(`UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME(), resolution = 'The system drive is no longer filling up.'
                     WHERE cabinet_id = $1 AND signature = 'disk-forecast' AND state <> 'resolved'`, [cabinetId]);
    return;
  }
  await upsertAlert(db, { cabinetId, issueTypeId: ISSUE.diskSpace, severity: days <= 7 ? "major" : "minor", signature: "disk-forecast",
    title: `The system drive is filling up: about ${Math.max(1, Math.round(days))} days until it is full`, seenAt: new Date(), ruleId: null, eventId: null });
}

export interface DriveReport {
  key: string; model: string | null; serialNumber: string | null; level: Level; reasons: { code: string; level: Level; text: string }[];
  projection: Assessment["projection"]; assessedAt: string;
  latest: { at: string; health: string; temperature: number | null; powerOnHours: number | null; reallocated: number | null; pending: number | null; uncorrectable: number | null; wear: number | null } | null;
  history: { at: string; reallocated: number | null; pending: number | null; wear: number | null; temperature: number | null }[];
}

/** Every drive of one cabinet with its level, reasons, projections and up to a year of history. */
export async function cabinetDrives(db: Queryable, cabinetId: string): Promise<DriveReport[]> {
  const status = (await db.query<{ drive_key: string; model: string | null; level: Level; reasons: DriveReport["reasons"]; projection: DriveReport["projection"]; assessed_at: Date }>(
    "SELECT * FROM drive_status WHERE cabinet_id = $1 ORDER BY CAST(drive_key AS nvarchar(256))", [cabinetId])).rows;
  const out: DriveReport[] = [];
  for (const s of status) {
    const rows = (await db.query<Row>("SELECT * FROM drive_samples WHERE cabinet_id = $1 AND drive_key = $2 ORDER BY [at]", [cabinetId, s.drive_key])).rows;
    const n = rows[rows.length - 1];
    out.push({
      key: s.drive_key, model: s.model, serialNumber: n?.serial_number ?? null, level: s.level, reasons: s.reasons, projection: s.projection, assessedAt: s.assessed_at.toISOString(),
      latest: n ? { at: n.at.toISOString(), health: n.health, temperature: n.temperature_c, powerOnHours: num(n.power_on_hours), reallocated: num(n.reallocated), pending: num(n.pending),
        uncorrectable: num(n.uncorrectable), wear: n.wear_percent } : null,
      history: rows.map(r => ({ at: r.at.toISOString(), reallocated: num(r.reallocated), pending: num(r.pending), wear: r.wear_percent, temperature: r.temperature_c })),
    });
  }
  return out;
}

export interface AtRisk { cabinetId: string; cabinet: string; site: string; client: string; demo: boolean; model: string | null; level: Level; reasons: string[]; assessedAt: string }

/** Drives across the fleet that are a concern (anything but "ok"), the worst first, at most 500. */
export async function drivesAtRisk(db: Queryable): Promise<AtRisk[]> {
  const rows = (await db.query<{ id: string; name: string; site: string; client: string; demo: boolean; model: string | null; level: Level; reasons: { text: string }[]; assessed_at: Date }>(
    `SELECT TOP (500) k.id, k.name, s.name AS site, c.name AS client, c.demo, d.model, d.[level], d.reasons, d.assessed_at
       FROM drive_status d JOIN cabinets k ON k.id = d.cabinet_id JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
      WHERE d.[level] <> 'ok' AND k.status = 'active'
      ORDER BY CASE d.[level] WHEN 'urgent' THEN 0 WHEN 'act' THEN 1 ELSE 2 END, c.name, s.name, k.name`)).rows;
  return rows.map(r => ({ cabinetId: r.id, cabinet: r.name, site: r.site, client: r.client, demo: r.demo, model: r.model, level: r.level, reasons: r.reasons.map(x => x.text), assessedAt: r.assessed_at.toISOString() }));
}
