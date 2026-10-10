// Time zone and clock (docs/spec/13-roadmap.md module 21). The site says which zone its cabinets should use; each cabinet
// reports its zone and its clock offset in every heartbeat. A cabinet in the wrong zone, or whose clock is more than two
// minutes off, gets a minor alert, which closes on its own when the heartbeat shows it right again.
import type pg from "pg";
import { audit, transaction, type Queryable } from "../db/db.js";
import { Refused } from "./errors.js";
import { ISSUE } from "./rules.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";

export const TIME_ZONES = ["Eastern Standard Time", "Central Standard Time", "Mountain Standard Time", "US Mountain Standard Time",
  "Pacific Standard Time", "Alaskan Standard Time", "Hawaiian Standard Time"] as const;
export type TimeZoneId = (typeof TIME_ZONES)[number];
/** How far a clock may be from the server's before it counts as off. */
export const CLOCK_TOLERANCE_SECONDS = 120;

const ZONE_WRONG = "k.time_zone_id IS NOT NULL AND s.time_zone IS NOT NULL AND k.time_zone_id <> s.time_zone";
const CLOCK_OFF = `k.clock_skew_seconds IS NOT NULL AND abs(k.clock_skew_seconds) > ${CLOCK_TOLERANCE_SECONDS}`;

type Scope = { cabinetId: string } | { siteId: string } | "all";

/** Opens and closes the time zone and clock alerts for the cabinets in scope. Only cabinets heard from recently count. */
export async function evaluateTime(db: Queryable, scope: Scope): Promise<{ opened: number; resolved: number }> {
  const [where, args] = scope === "all" ? ["true", []] : "cabinetId" in scope ? ["k.id = $4", [scope.cabinetId]] : ["k.site_id = $4", [scope.siteId]];
  let opened = 0, resolved = 0;
  for (const [issueId, condition, fixed] of [[ISSUE.timeZone, ZONE_WRONG, "The cabinet is in its site's time zone again."],
                                             [ISSUE.clock, CLOCK_OFF, "The cabinet's clock is within two minutes of the server's again."]] as const) {
    const issue = (await db.query<{ name: string; severity: string }>("SELECT name, severity FROM issue_types WHERE id = $1", [issueId])).rows[0];
    if (!issue) continue;
    const o = await db.query(
      `INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen)
       SELECT k.id, $1::uuid, $2, 'issue:' || $1::text, $3, now(), now() FROM cabinets k JOIN sites s ON s.id = k.site_id
        WHERE k.status = 'active' AND ${where} AND k.last_heartbeat_at > now() - make_interval(secs => ${OFFLINE_AFTER_MS / 1000}) AND ${condition}
       ON CONFLICT (cabinet_id, signature) WHERE state <> 'resolved' DO UPDATE SET last_seen = now()
       RETURNING (xmax = 0) AS created`, [issueId, issue.severity, issue.name, ...args]);
    opened += o.rows.filter(r => r.created).length;
    const r = await db.query(
      `UPDATE alerts a SET state = 'resolved', resolved_at = now(), resolution = $2
         FROM cabinets k JOIN sites s ON s.id = k.site_id
        WHERE a.cabinet_id = k.id AND a.issue_type_id = $1::uuid AND a.state <> 'resolved' AND ${where.replace("$4", "$3")}
          AND (k.status <> 'active' OR NOT (${condition}))`, [issueId, fixed, ...args]);
    resolved += r.rowCount ?? 0;
  }
  return { opened, resolved };
}

/** Sets (or clears, with null) the zone a site's cabinets should use; its cabinets are checked again at once. Tier 2 and up. */
export async function setSiteTimeZone(pool: pg.Pool, userId: string, siteId: string, zone: TimeZoneId | null): Promise<void> {
  await transaction(pool, async c => {
    const r = await c.query<{ before: string | null }>(
      "UPDATE sites n SET time_zone = $2 FROM sites o WHERE n.id = $1 AND o.id = n.id AND n.removed_at IS NULL RETURNING o.time_zone AS before", [siteId, zone]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such site");
    await audit(c, { actorKind: "user", actorId: userId, action: "site.time_zone", targetKind: "site", targetId: siteId, outcome: "succeeded",
      details: { before: r.rows[0]!.before, timeZone: zone } });
    await evaluateTime(c, { siteId });
  });
}

/** The time facts the console shows for one cabinet. */
export async function cabinetTime(db: Queryable, cabinetId: string) {
  const k = (await db.query<{ time_zone_id: string | null; clock_skew_seconds: number | null; site_zone: string | null; last: Date | null }>(
    `SELECT k.time_zone_id, k.clock_skew_seconds, s.time_zone AS site_zone, k.last_heartbeat_at AS last
       FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1`, [cabinetId])).rows[0];
  if (!k) return null;
  return {
    timeZoneId: k.time_zone_id, siteTimeZone: k.site_zone, clockSkewSeconds: k.clock_skew_seconds,
    zoneWrong: !!k.time_zone_id && !!k.site_zone && k.time_zone_id !== k.site_zone,
    clockOff: k.clock_skew_seconds !== null && Math.abs(k.clock_skew_seconds) > CLOCK_TOLERANCE_SECONDS,
    reportedAt: k.last?.toISOString() ?? null,
  };
}
