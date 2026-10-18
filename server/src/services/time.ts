// Time zone and clock (docs/spec/13-roadmap.md module 21). The site says which zone its cabinets should use; each cabinet
// reports its zone and its clock offset in every heartbeat. A cabinet in the wrong zone, or whose clock is more than two
// minutes off, gets a minor alert, which closes on its own when the heartbeat shows it right again.
import { audit, transaction, type Pool, type Queryable } from "../db/db.js";
import { Refused } from "./errors.js";
import { ISSUE } from "./rules.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";

export const TIME_ZONES = ["Eastern Standard Time", "Central Standard Time", "Mountain Standard Time", "US Mountain Standard Time",
  "Pacific Standard Time", "Alaskan Standard Time", "Hawaiian Standard Time"] as const;
export type TimeZoneId = (typeof TIME_ZONES)[number];
/** How far a clock may be from the server's before it counts as off. */
export const CLOCK_TOLERANCE_SECONDS = 120;

const ZONE_WRONG = "k.time_zone_id IS NOT NULL AND s.time_zone IS NOT NULL AND k.time_zone_id <> s.time_zone";
const CLOCK_OFF = `k.clock_skew_seconds IS NOT NULL AND ABS(k.clock_skew_seconds) > ${CLOCK_TOLERANCE_SECONDS}`;

type Scope = { cabinetId: string } | { siteId: string } | "all";

/** Opens and closes the time zone and clock alerts for the cabinets in scope. Only cabinets heard from recently count. */
export async function evaluateTime(db: Queryable, scope: Scope): Promise<{ opened: number; resolved: number }> {
  // The scope's own id is the last parameter of each statement, so its number is given when the statement is written.
  const [whereAt, args] = scope === "all" ? [() => "1 = 1", []] : "cabinetId" in scope ? [(n: number) => `k.id = $${n}`, [scope.cabinetId]] : [(n: number) => `k.site_id = $${n}`, [scope.siteId]];
  let opened = 0, resolved = 0;
  // One cabinet (a heartbeat): a lock-free read first says what is to be done; usually nothing, so no range-locking MERGE runs.
  const need = "cabinetId" in (scope as object) ? (await db.query<{ zone: boolean; clock: boolean; zone_open: boolean; clock_open: boolean }>(
    `SELECT CAST(CASE WHEN ${ZONE_WRONG} THEN 1 ELSE 0 END AS bit) AS zone, CAST(CASE WHEN ${CLOCK_OFF} THEN 1 ELSE 0 END AS bit) AS clock,
            CAST(CASE WHEN EXISTS (SELECT 1 FROM alerts WHERE cabinet_id = k.id AND issue_type_id = $2 AND state <> 'resolved') THEN 1 ELSE 0 END AS bit) AS zone_open,
            CAST(CASE WHEN EXISTS (SELECT 1 FROM alerts WHERE cabinet_id = k.id AND issue_type_id = $3 AND state <> 'resolved') THEN 1 ELSE 0 END AS bit) AS clock_open
       FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1 AND k.status = 'active'`,
    [(scope as { cabinetId: string }).cabinetId, ISSUE.timeZone, ISSUE.clock])).rows[0] ?? { zone: false, clock: false, zone_open: false, clock_open: false } : null;
  for (const [issueId, condition, fixed] of [[ISSUE.timeZone, ZONE_WRONG, "The cabinet is in its site's time zone again."],
                                             [ISSUE.clock, CLOCK_OFF, "The cabinet's clock is within two minutes of the server's again."]] as const) {
    const [wrong, open] = need === null ? [true, true] : issueId === ISSUE.timeZone ? [need.zone, need.zone_open] : [need.clock, need.clock_open];
    if (!wrong && !open) continue;
    const issue = (await db.query<{ name: string; severity: string }>("SELECT name, severity FROM issue_types WHERE id = $1", [issueId])).rows[0];
    if (!issue) continue;
    // alerts has triggers (they announce new alerts), so what the MERGE did is read through a table variable.
    const o = !wrong ? { rows: [] as { act: string }[] } : await db.query<{ act: string }>(
      `DECLARE @o TABLE (act nvarchar(10));
       MERGE alerts WITH (HOLDLOCK) AS t
       USING (SELECT k.id AS cabinet_id FROM cabinets k JOIN sites s ON s.id = k.site_id
               WHERE k.status = 'active' AND ${whereAt(6)} AND k.last_heartbeat_at > DATEADD(second, -$4, SYSUTCDATETIME()) AND ${condition}) AS src
          ON t.cabinet_id = src.cabinet_id AND t.signature = $3 AND t.state <> 'resolved'
        WHEN MATCHED THEN UPDATE SET last_seen = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen)
             VALUES (src.cabinet_id, CAST($1 AS uniqueidentifier), $2, $3, $5, SYSUTCDATETIME(), SYSUTCDATETIME())
        OUTPUT $action INTO @o (act);
       SELECT act FROM @o;`, [issueId, issue.severity, `issue:${issueId}`, Math.round(OFFLINE_AFTER_MS / 1000), issue.name, ...args]);
    opened += o.rows.filter(r => r.act === "INSERT").length;
    const r = !open ? { rowCount: 0 } : await db.query(
      `UPDATE a SET state = 'resolved', resolved_at = SYSUTCDATETIME(), resolution = $2
         FROM alerts a JOIN cabinets k ON a.cabinet_id = k.id JOIN sites s ON s.id = k.site_id
        WHERE a.issue_type_id = CAST($1 AS uniqueidentifier) AND a.state <> 'resolved' AND ${whereAt(3)}
          AND (k.status <> 'active' OR NOT (${condition}))`, [issueId, fixed, ...args]);
    resolved += r.rowCount ?? 0;
  }
  return { opened, resolved };
}

/** Sets (or clears, with null) the zone a site's cabinets should use; its cabinets are checked again at once. Tier 2 and up. */
export async function setSiteTimeZone(pool: Pool, userId: string, siteId: string, zone: TimeZoneId | null): Promise<void> {
  await transaction(pool, async c => {
    const r = await c.query<{ old_zone: string | null }>(
      "UPDATE sites SET time_zone = $2 OUTPUT deleted.time_zone AS old_zone WHERE id = $1 AND removed_at IS NULL", [siteId, zone]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such site");
    await audit(c, { actorKind: "user", actorId: userId, action: "site.time_zone", targetKind: "site", targetId: siteId, outcome: "succeeded",
      details: { before: r.rows[0]!.old_zone, timeZone: zone } });
    await evaluateTime(c, { siteId });
  });
}

/** The time facts the console shows for one cabinet. */
export async function cabinetTime(db: Queryable, cabinetId: string) {
  const k = (await db.query<{ time_zone_id: string | null; clock_skew_seconds: number | null; site_zone: string | null; last_heartbeat_at: Date | null }>(
    `SELECT k.time_zone_id, k.clock_skew_seconds, s.time_zone AS site_zone, k.last_heartbeat_at
       FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1`, [cabinetId])).rows[0];
  if (!k) return null;
  return {
    timeZoneId: k.time_zone_id, siteTimeZone: k.site_zone, clockSkewSeconds: k.clock_skew_seconds,
    zoneWrong: !!k.time_zone_id && !!k.site_zone && k.time_zone_id !== k.site_zone,
    clockOff: k.clock_skew_seconds !== null && Math.abs(k.clock_skew_seconds) > CLOCK_TOLERANCE_SECONDS,
    reportedAt: k.last_heartbeat_at?.toISOString() ?? null,
  };
}
