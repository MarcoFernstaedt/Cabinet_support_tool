// Time zone and clock (docs/spec/13-roadmap.md module 21). The zone a site's cabinets should use is the site's own, else its
// client's, else the fleet default (05-server-spec.md "Site policies"); each cabinet reports its zone and its clock offset in every heartbeat. A cabinet in the wrong zone, or whose clock is more than two
// minutes off, gets a minor alert, which closes on its own when the heartbeat shows it right again.
import { audit, transaction, type Pool, type Queryable } from "../db/db.js";
import { CLOSED_OUTPUT, closeAutomatically } from "./automatic-close.js";
import { upsertSetting } from "./settings.js";
import { Refused } from "./errors.js";
import { ISSUE } from "./rules.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";

export const TIME_ZONES = ["Eastern Standard Time", "Central Standard Time", "Mountain Standard Time", "US Mountain Standard Time",
  "Pacific Standard Time", "Alaskan Standard Time", "Hawaiian Standard Time"] as const;
export type TimeZoneId = (typeof TIME_ZONES)[number];
/** How far a clock may be from the server's before it counts as off. */
export const CLOCK_TOLERANCE_SECONDS = 120;

/** The settings row that holds the fleet default zone, as {"timeZone": ...}. */
const FLEET_ZONE_KEY = "time.zone";
/**
 * The zone that applies at site s (joined to its client cl): the site's own, else the client's, else the fleet default. Every
 * statement that judges or sets a cabinet's zone uses this, so the three levels are read the same way everywhere.
 */
export const SITE_ZONE_SQL = `COALESCE(s.time_zone, cl.time_zone, (SELECT JSON_VALUE([value], '$.timeZone') COLLATE DATABASE_DEFAULT FROM settings WHERE [key] = '${FLEET_ZONE_KEY}'))`;
const ZONE_WRONG = `k.time_zone_id IS NOT NULL AND ${SITE_ZONE_SQL} IS NOT NULL AND k.time_zone_id <> ${SITE_ZONE_SQL}`;
const CLOCK_OFF = `k.clock_skew_seconds IS NOT NULL AND ABS(k.clock_skew_seconds) > ${CLOCK_TOLERANCE_SECONDS}`;

type Scope = { cabinetId: string } | { siteId: string } | { clientId: string } | "all";

/** Opens and closes the time zone and clock alerts for the cabinets in scope. Only cabinets heard from recently count. */
export async function evaluateTime(db: Queryable, scope: Scope): Promise<{ opened: number; resolved: number }> {
  // The scope's own id is the last parameter of each statement, so its number is given when the statement is written.
  const [whereAt, args] = scope === "all" ? [() => "1 = 1", []] : "cabinetId" in scope ? [(n: number) => `k.id = $${n}`, [scope.cabinetId]]
    : "siteId" in scope ? [(n: number) => `k.site_id = $${n}`, [scope.siteId]] : [(n: number) => `s.client_id = $${n}`, [scope.clientId]];
  let opened = 0, resolved = 0;
  // One cabinet (a heartbeat): a lock-free read first says what is to be done; usually nothing, so no range-locking MERGE runs.
  const need = scope !== "all" && "cabinetId" in scope ? (await db.query<{ zone: boolean; clock: boolean; zone_open: boolean; clock_open: boolean }>(
    `SELECT CAST(CASE WHEN ${ZONE_WRONG} THEN 1 ELSE 0 END AS bit) AS zone, CAST(CASE WHEN ${CLOCK_OFF} THEN 1 ELSE 0 END AS bit) AS clock,
            CAST(CASE WHEN EXISTS (SELECT 1 FROM alerts WITH (FORCESEEK) WHERE cabinet_id = k.id AND issue_type_id = $2 AND state <> 'resolved') THEN 1 ELSE 0 END AS bit) AS zone_open,
            CAST(CASE WHEN EXISTS (SELECT 1 FROM alerts WITH (FORCESEEK) WHERE cabinet_id = k.id AND issue_type_id = $3 AND state <> 'resolved') THEN 1 ELSE 0 END AS bit) AS clock_open
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id WHERE k.id = $1 AND k.status = 'active'`,
    [scope.cabinetId, ISSUE.timeZone, ISSUE.clock])).rows[0] ?? { zone: false, clock: false, zone_open: false, clock_open: false } : null;
  for (const [issueId, condition, fixed] of [[ISSUE.timeZone, ZONE_WRONG, "The cabinet is in its site's time zone again."],
                                             [ISSUE.clock, CLOCK_OFF, "The cabinet's clock is within two minutes of the server's again."]] as const) {
    const [wrong, open] = need === null ? [true, true] : issueId === ISSUE.timeZone ? [need.zone, need.zone_open] : [need.clock, need.clock_open];
    if (!wrong && !open) continue;
    const issue = (await db.query<{ name: string; severity: string }>("SELECT name, severity FROM issue_types WHERE id = $1", [issueId])).rows[0];
    if (!issue) continue;
    // alerts has triggers (they announce new alerts), so what the MERGE did is read through a table variable.
    const o = !wrong ? { rows: [] as { act: string }[] } : await db.query<{ act: string }>(
      `DECLARE @o TABLE (act nvarchar(10));
       MERGE alerts WITH (HOLDLOCK, FORCESEEK) AS t
       USING (SELECT k.id AS cabinet_id FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id
               WHERE k.status = 'active' AND ${whereAt(6)} AND k.last_heartbeat_at > DATEADD(second, -$4, SYSUTCDATETIME()) AND ${condition}) AS src
          ON t.cabinet_id = src.cabinet_id AND t.signature = $3 AND t.state <> 'resolved'
        WHEN MATCHED THEN UPDATE SET last_seen = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen)
             VALUES (src.cabinet_id, CAST($1 AS uniqueidentifier), $2, $3, $5, SYSUTCDATETIME(), SYSUTCDATETIME())
        OUTPUT $action INTO @o (act);
       SELECT act FROM @o;`, [issueId, issue.severity, `issue:${issueId}`, Math.round(OFFLINE_AFTER_MS / 1000), issue.name, ...args]);
    opened += o.rows.filter(r => r.act === "INSERT").length;
    const r = !open ? [] : await closeAutomatically(db, "time-check",
      `UPDATE a SET state = 'resolved', resolved_at = SYSUTCDATETIME(), resolution = $2 ${CLOSED_OUTPUT}
         FROM alerts a JOIN cabinets k ON a.cabinet_id = k.id JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id
        WHERE a.issue_type_id = CAST($1 AS uniqueidentifier) AND a.state <> 'resolved' AND ${whereAt(3)}
          AND (k.status <> 'active' OR NOT (${condition}))`, [issueId, fixed, ...args]);
    resolved += r.length;
  }
  return { opened, resolved };
}

/** The fleet default zone, or null when none is set. */
export async function fleetTimeZone(db: Queryable): Promise<TimeZoneId | null> {
  const v = (await db.query<{ z: string | null }>(`SELECT JSON_VALUE([value], '$.timeZone') AS z FROM settings WHERE [key] = '${FLEET_ZONE_KEY}'`)).rows[0]?.z ?? null;
  return v && (TIME_ZONES as readonly string[]).includes(v) ? v as TimeZoneId : null;
}

/** A site's own zone, its client's and the fleet's, and the one that applies with where it comes from. */
export async function siteTimeZone(db: Queryable, siteId: string) {
  const r = (await db.query<{ own: string | null; client: string | null }>(
    "SELECT s.time_zone AS own, cl.time_zone AS client FROM sites s JOIN clients cl ON cl.id = s.client_id WHERE s.id = $1 AND s.removed_at IS NULL", [siteId])).rows[0];
  if (!r) throw new Refused("not_found", 404, "no such site");
  const fleet = await fleetTimeZone(db);
  return { own: r.own, client: r.client, fleet, zone: r.own ?? r.client ?? fleet, source: r.own ? "site" as const : r.client ? "client" as const : fleet ? "fleet" as const : null };
}

/** Sets (or clears) a client's default zone; its cabinets are checked again at once. Tier 2 and up, like a site's. */
export async function setClientTimeZone(pool: Pool, userId: string, clientId: string, zone: TimeZoneId | null): Promise<void> {
  await transaction(pool, async c => {
    const r = await c.query<{ old_zone: string | null }>(
      "UPDATE clients SET time_zone = $2 OUTPUT deleted.time_zone AS old_zone WHERE id = $1 AND removed_at IS NULL", [clientId, zone]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such client");
    await audit(c, { actorKind: "user", actorId: userId, action: "client.time_zone", targetKind: "client", targetId: clientId, outcome: "succeeded",
      details: { before: r.rows[0]!.old_zone, timeZone: zone } });
    await evaluateTime(c, { clientId });
  });
}

/** Sets (or clears) the fleet default zone; every cabinet is checked again. Admin. */
export async function setFleetTimeZone(pool: Pool, userId: string, zone: TimeZoneId | null): Promise<void> {
  await transaction(pool, async c => {
    const before = await fleetTimeZone(c);
    if (zone === null) await c.query(`DELETE FROM settings WHERE [key] = '${FLEET_ZONE_KEY}'`);
    else await upsertSetting(c, FLEET_ZONE_KEY, { timeZone: zone }, userId);
    await audit(c, { actorKind: "user", actorId: userId, action: "fleet.time_zone", outcome: "succeeded", details: { before, timeZone: zone } });
    await evaluateTime(c, "all");
  });
}

/** Sets (or clears, with null) the zone a site's cabinets should use; its cabinets are checked again at once. Tier 2 and up. */
export async function setSiteTimeZone(pool: Pool, userId: string, siteId: string, zone: TimeZoneId | null): Promise<void> {
  await transaction(pool, c => writeSiteTimeZone(c, userId, siteId, zone));
}

/** Writes a site's zone in the caller's transaction, audits it and checks the site's cabinets again (the caller checked the role). */
export async function writeSiteTimeZone(c: Queryable, userId: string, siteId: string, zone: TimeZoneId | null): Promise<void> {
  const r = await c.query<{ old_zone: string | null }>(
    "UPDATE sites SET time_zone = $2 OUTPUT deleted.time_zone AS old_zone WHERE id = $1 AND removed_at IS NULL", [siteId, zone]);
  if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such site");
  await audit(c, { actorKind: "user", actorId: userId, action: "site.time_zone", targetKind: "site", targetId: siteId, outcome: "succeeded",
    details: { before: r.rows[0]!.old_zone, timeZone: zone } });
  await evaluateTime(c, { siteId });
}

/** The time facts the console shows for one cabinet. */
export async function cabinetTime(db: Queryable, cabinetId: string) {
  const k = (await db.query<{ time_zone_id: string | null; clock_skew_seconds: number | null; site_zone: string | null; last_heartbeat_at: Date | null }>(
    `SELECT k.time_zone_id, k.clock_skew_seconds, ${SITE_ZONE_SQL} AS site_zone, k.last_heartbeat_at
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id WHERE k.id = $1`, [cabinetId])).rows[0];
  if (!k) return null;
  return {
    timeZoneId: k.time_zone_id, siteTimeZone: k.site_zone, clockSkewSeconds: k.clock_skew_seconds,
    zoneWrong: !!k.time_zone_id && !!k.site_zone && k.time_zone_id !== k.site_zone,
    clockOff: k.clock_skew_seconds !== null && Math.abs(k.clock_skew_seconds) > CLOCK_TOLERANCE_SECONDS,
    reportedAt: k.last_heartbeat_at?.toISOString() ?? null,
  };
}
