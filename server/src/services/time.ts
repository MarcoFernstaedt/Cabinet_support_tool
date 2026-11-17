// Time zone and clock (docs/spec/13-roadmap.md module 21). The zone a site's cabinets should use is the site's own, else its
// client's, else the fleet default (05-server-spec.md "Site policies"); each cabinet reports its zone and its clock offset in every heartbeat. A cabinet in the wrong zone, or whose clock is more than two
// minutes off, gets a minor alert, which closes on its own when the heartbeat shows it right again.
import { audit, transaction, type Pool, type Queryable } from "../db/db.js";
import { foldCabinetCondition, type CabinetScope } from "./alerts.js";
import { CLOCK_OFF_SQL, CLOCK_TOLERANCE_SECONDS, FLEET_ZONE_KEY, SITE_ZONE_SQL, ZONE_WRONG_SQL } from "./cabinet-conditions.js";
import { upsertSetting } from "./settings.js";
import { Refused } from "./errors.js";
import { ISSUE } from "./rules.js";

export const TIME_ZONES = ["Eastern Standard Time", "Central Standard Time", "Mountain Standard Time", "US Mountain Standard Time",
  "Pacific Standard Time", "Alaskan Standard Time", "Hawaiian Standard Time"] as const;
export type TimeZoneId = (typeof TIME_ZONES)[number];
// The conditions themselves live in cabinet-conditions.ts, where alerts.ts reads them too (D106); these stay importable from here.
export { CLOCK_TOLERANCE_SECONDS, SITE_ZONE_SQL };

/** Opens and closes the time zone and clock alerts for the cabinets in scope. Only cabinets heard from recently count. */
export async function evaluateTime(db: Queryable, scope: CabinetScope): Promise<{ opened: number; resolved: number }> {
  let opened = 0, resolved = 0;
  // One cabinet (a heartbeat): a lock-free read first says what is to be done; usually nothing, so no range-locking MERGE runs.
  const need = scope !== "all" && "cabinetId" in scope ? (await db.query<{ zone: boolean; clock: boolean; zone_open: boolean; clock_open: boolean }>(
    `SELECT CAST(CASE WHEN ${ZONE_WRONG_SQL} THEN 1 ELSE 0 END AS bit) AS zone, CAST(CASE WHEN ${CLOCK_OFF_SQL} THEN 1 ELSE 0 END AS bit) AS clock,
            CAST(CASE WHEN EXISTS (SELECT 1 FROM alerts WITH (FORCESEEK) WHERE cabinet_id = k.id AND issue_type_id = $2 AND state <> 'resolved') THEN 1 ELSE 0 END AS bit) AS zone_open,
            CAST(CASE WHEN EXISTS (SELECT 1 FROM alerts WITH (FORCESEEK) WHERE cabinet_id = k.id AND issue_type_id = $3 AND state <> 'resolved') THEN 1 ELSE 0 END AS bit) AS clock_open
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id WHERE k.id = $1 AND k.status = 'active'`,
    [scope.cabinetId, ISSUE.timeZone, ISSUE.clock])).rows[0] ?? { zone: false, clock: false, zone_open: false, clock_open: false } : null;
  // alerts.ts opens and closes them, by name (D106): the zone, then the clock, as before.
  for (const name of ["timeZone", "clock"] as const) {
    const [wrong, open] = need === null ? [true, true] : name === "timeZone" ? [need.zone, need.zone_open] : [need.clock, need.clock_open];
    const r = await foldCabinetCondition(db, name, scope, { open: wrong, close: open });
    opened += r.opened; resolved += r.resolved;
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
