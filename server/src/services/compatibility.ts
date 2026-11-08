// Which Windows the fleet runs (F20, decision-log D55): the active cabinets counted by edition, build family and architecture, from the
// latest system.info each one answered (the version text it reports, and its build) and the architecture recorded when it was approved.
// The report says what the platform knows and what it does not: cabinets never read are counted apart, and the update source (Windows
// Update, WSUS, none) is not read by any operation yet. A real-cabinet smoke test per build family is outside what a server can show.
// Demo cabinets are left out. Nothing here asks a cabinet anything.
import type { Queryable } from "../db/db.js";

export interface CompatibilityRow {
  /** The version text the cabinet reports, edition included ("Windows 10 IoT Enterprise LTSC 2021"), or null when it reported none. */
  edition: string | null;
  /** The build before its first dot ("19044" from "19044.5011"): one family of Windows, whatever its monthly update. */
  buildFamily: string | null;
  architecture: string | null;
  cabinets: number;
  /** The lowest and highest full build seen in the family: how far apart its updates are. */
  lowestBuild: string | null; highestBuild: string | null;
  lastReadAt: string;
}
export interface CompatibilityReport { rows: CompatibilityRow[]; cabinetsInFleet: number; cabinetsRead: number; notRead: number; updateSource: "not_read" }

/** At most this many groups; a fleet with more distinct Windows than this has a bigger problem than the list being cut. */
export const MAX_GROUPS = 200;

export async function compatibilityReport(db: Queryable): Promise<CompatibilityReport> {
  const rows = (await db.query<{ edition: string | null; family: string | null; architecture: string | null; cabinets: number; low: number | null; high: number | null; last_read: Date }>(
    `WITH latest AS (
       SELECT x.cabinet_id, x.result_at, x.result FROM (
         SELECT cm.cabinet_id, cm.result_at, cm.result, ROW_NUMBER() OVER (PARTITION BY cm.cabinet_id ORDER BY cm.result_at DESC) AS rn
           FROM commands cm JOIN cabinets k ON k.id = cm.cabinet_id
          WHERE cm.operation = 'system.info' AND cm.status = 'succeeded' AND cm.result IS NOT NULL AND k.status = 'active' AND k.demo_scenario IS NULL) x
        WHERE x.rn = 1),
     facts AS (
       SELECT l.result_at, k.architecture,
              NULLIF(CAST(JSON_VALUE(l.result, '$.output.osVersion') AS nvarchar(200)), '') AS edition,
              NULLIF(CAST(JSON_VALUE(l.result, '$.output.osBuild') AS nvarchar(64)), '') AS build
         FROM latest l JOIN cabinets k ON k.id = l.cabinet_id),
     split AS (
       -- The family before the first dot; the update revision after it, compared as a number (19044.999 is older than 19044.5011).
       SELECT result_at, architecture, edition, build,
              CASE WHEN build IS NULL THEN NULL ELSE LEFT(build, CHARINDEX('.', build + '.') - 1) END AS family,
              TRY_CAST(CASE WHEN CHARINDEX('.', build) > 0 THEN SUBSTRING(build, CHARINDEX('.', build) + 1, 20) END AS int) AS rev
         FROM facts)
     SELECT TOP (${MAX_GROUPS}) edition, family, architecture, COUNT(*) AS cabinets, MIN(rev) AS low, MAX(rev) AS high, MAX(result_at) AS last_read
       FROM split
      GROUP BY edition, family, architecture
      ORDER BY COUNT(*) DESC, edition, family, architecture`)).rows;
  const fleet = (await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM cabinets WHERE status = 'active' AND demo_scenario IS NULL")).rows[0]!;
  const read = rows.reduce((n, r) => n + Number(r.cabinets), 0);
  return {
    rows: rows.map(r => ({ edition: r.edition, buildFamily: r.family, architecture: r.architecture, cabinets: Number(r.cabinets), lowestBuild: r.low === null ? null : `${r.family}.${r.low}`, highestBuild: r.high === null ? null : `${r.family}.${r.high}`, lastReadAt: r.last_read.toISOString() })),
    cabinetsInFleet: Number(fleet.n), cabinetsRead: read, notRead: Math.max(0, Number(fleet.n) - read), updateSource: "not_read",
  };
}
