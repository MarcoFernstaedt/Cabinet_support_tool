// The cabinet conditions alerts.ts opens and closes alerts for, as fixed SQL over cabinet k joined to its site s and client cl (F21.R2,
// decision-log D106). A condition is named, never passed in: alerts.ts builds every statement from these texts and a typed scope, so no
// caller hands it SQL. This module imports nothing, so it can be loaded first, last or from inside an import cycle (D104).

/** The settings row that holds the fleet default zone, as {"timeZone": ...}. */
export const FLEET_ZONE_KEY = "time.zone";

/**
 * The zone that applies at site s (joined to its client cl): the site's own, else the client's, else the fleet default. Every
 * statement that judges or sets a cabinet's zone uses this, so the three levels are read the same way everywhere.
 */
export const SITE_ZONE_SQL = `COALESCE(s.time_zone, cl.time_zone, (SELECT JSON_VALUE([value], '$.timeZone') COLLATE DATABASE_DEFAULT FROM settings WHERE [key] = '${FLEET_ZONE_KEY}'))`;

/** How far a clock may be from the server's before it counts as off. */
export const CLOCK_TOLERANCE_SECONDS = 120;

/** The cabinet is in a time zone other than the one its site, client or the fleet sets. */
export const ZONE_WRONG_SQL = `k.time_zone_id IS NOT NULL AND ${SITE_ZONE_SQL} IS NOT NULL AND k.time_zone_id <> ${SITE_ZONE_SQL}`;

/** The cabinet's clock is more than the tolerance from the server's. */
export const CLOCK_OFF_SQL = `k.clock_skew_seconds IS NOT NULL AND ABS(k.clock_skew_seconds) > ${CLOCK_TOLERANCE_SECONDS}`;
