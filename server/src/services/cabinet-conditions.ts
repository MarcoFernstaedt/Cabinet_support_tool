// The cabinet conditions alerts.ts opens and closes alerts for, as fixed SQL over cabinet k joined to its site s and client cl (F21.R2,
// decision-log D106, D107). A condition is named, never passed in: alerts.ts builds every statement from these texts and a typed scope, so no
// caller hands it SQL. This module imports nothing, so it can be loaded first, last or from inside an import cycle (D104).

/** The settings row that holds the fleet default zone, as {"timeZone": ...}. */
export const FLEET_ZONE_KEY = "time.zone";

/**
 * The zone that applies at site s (joined to its client cl): the site's own, else the client's, else the fleet default. Every
 * statement that judges or sets a cabinet's zone uses this, so the three levels are read the same way everywhere.
 */
export const SITE_ZONE_SQL = `COALESCE(s.time_zone, cl.time_zone, (SELECT JSON_VALUE([value], '$.timeZone') COLLATE DATABASE_DEFAULT FROM settings WHERE [key] = '${FLEET_ZONE_KEY}'))`;

/** The settings row that holds the fleet clock tolerance, as {"seconds": n}. */
export const FLEET_CLOCK_TOLERANCE_KEY = "time.clockTolerance";

/**
 * How far a clock may be from the server's before it counts as off, when no site, client or fleet setting says otherwise; also the
 * highest tolerance any level may set (D109): the agent refuses a command issued more than two minutes ahead of its own clock
 * (03-protocol.md), so a looser tolerance would hide a clock that already breaks commands.
 */
export const CLOCK_TOLERANCE_SECONDS = 120;
/** The lowest tolerance a level may set. */
export const CLOCK_TOLERANCE_MIN_SECONDS = 10;

/** Whether a value is a tolerance a level may set: a whole number of seconds from the lowest to the highest. */
export const isClockTolerance = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= CLOCK_TOLERANCE_MIN_SECONDS && v <= CLOCK_TOLERANCE_SECONDS;

/**
 * The fleet's tolerance as stored, or null when none is stored or what is stored is not a tolerance a level may set (a row edited
 * outside the platform is ignored, so the built-in 120 applies rather than a value no level could have set).
 */
const FLEET_CLOCK_TOLERANCE_SQL = `(SELECT CASE WHEN f.v BETWEEN ${CLOCK_TOLERANCE_MIN_SECONDS} AND ${CLOCK_TOLERANCE_SECONDS} THEN f.v END
     FROM (SELECT TRY_CAST(CASE WHEN ISJSON([value]) = 1 THEN JSON_VALUE([value], '$.seconds') END AS int) AS v FROM settings WHERE [key] = '${FLEET_CLOCK_TOLERANCE_KEY}') f)`;

/** The fleet's stored tolerance as a scalar read, for the code that reports it. */
export const FLEET_CLOCK_TOLERANCE_READ_SQL = `SELECT ${FLEET_CLOCK_TOLERANCE_SQL} AS seconds`;

/**
 * The clock tolerance that applies at site s (joined to its client cl): the site's own, else the client's, else the fleet's, else 120
 * seconds. Every statement that judges a cabinet's clock uses this, so the levels are read the same way everywhere.
 */
export const SITE_CLOCK_TOLERANCE_SQL = `COALESCE(s.clock_tolerance_seconds, cl.clock_tolerance_seconds, ${FLEET_CLOCK_TOLERANCE_SQL}, ${CLOCK_TOLERANCE_SECONDS})`;

/** The cabinet is in a time zone other than the one its site, client or the fleet sets. */
export const ZONE_WRONG_SQL = `k.time_zone_id IS NOT NULL AND ${SITE_ZONE_SQL} IS NOT NULL AND k.time_zone_id <> ${SITE_ZONE_SQL}`;

/** The cabinet's clock is more than its site's tolerance from the server's. */
export const CLOCK_OFF_SQL = `k.clock_skew_seconds IS NOT NULL AND ABS(k.clock_skew_seconds) > ${SITE_CLOCK_TOLERANCE_SQL}`;

/** The three Windows firewall profiles a policy sets on or off. */
export const FIREWALL_PROFILES = ["domain", "private", "public"] as const;

/** The policy that applies to cabinet k (joined to its site s and client cl), as JSON text; placeholder `$n` is the fleet policy. */
export const firewallPolicySql = (n: number): string => `COALESCE(s.firewall_policy, cl.firewall_policy, $${n})`;

/**
 * Whether cabinet k differs from its policy; placeholder `$n` is the fleet policy (JSON text). A profile the cabinet did not report as
 * true or false counts as different, as PostgreSQL's IS DISTINCT FROM did. Only the three fixed profile names go into the text.
 */
export const firewallDiffersSql = (n: number): string => `k.firewall_profiles IS NOT NULL AND (${FIREWALL_PROFILES.map(profile =>
  `(CASE WHEN JSON_VALUE(${firewallPolicySql(n)}, '$.${profile}') = 'on' THEN 1 ELSE 0 END)
     <> ISNULL(CASE JSON_VALUE(k.firewall_profiles, '$.${profile}') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END, 2)`).join("\n  OR ")})`;
