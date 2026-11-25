// Whether a service entry on an approved-programs list can match anything (plan item 2.7, decision-log D149). The agent controls a
// service only when its key name is on the list AND the program its image path names is the program the entry names
// (agent ServiceRules.RegisteredProgram, ApprovedApps.RefuseServiceControl). An entry can therefore be saved and still approve
// nothing on any cabinet. This reads each cabinet's own last services.list answer, the same executablePath the agent compares, and
// counts, per entry, the cabinets in the level's scope that reported, those with a service of that key name, and those where that
// service also runs the named program. It only informs the editor: the server and the agent still decide every request.
import type { Queryable } from "../db/db.js";
import { entryPath, type AppLevel, type ApprovedApp } from "./approved-apps.js";

/** One service entry against the cabinets of its level: how many reported their services, have the key name, and run its program. */
export interface ServiceEntryCheck {
  key: string;
  /** Cabinets in the scope whose last services.list answer is stored. */
  reported: number;
  /** Of those, the ones with a service of this key name. */
  named: number;
  /** Of those, the ones where that service runs the entry's program: the cabinets the entry works on today. */
  matched: number;
}

/** The cabinets a level covers, as a condition on cabinets k; $1 is the level's id. Constants only. */
const SCOPE: Record<AppLevel, string> = {
  fleet: "1 = 1",
  client: "k.site_id IN (SELECT id FROM sites WHERE client_id = $1)",
  site: "k.site_id = $1",
  cabinet: "k.id = $1",
};

/** The check for each service entry of a list; applications are not checked (no inventory names every program a cabinet could start). */
export async function serviceEntryChecks(db: Queryable, level: AppLevel, id: string | null, entries: readonly ApprovedApp[]): Promise<ServiceEntryCheck[]> {
  const services = entries.filter(e => e.kind === "service" && e.serviceName !== null);
  if (services.length === 0) return [];
  const wanted = JSON.stringify(services.map(e => ({ k: e.key, s: e.serviceName, p: entryPath(e) })));
  // The latest stored answer per cabinet comes through commands_latest_result; names and paths compare without case, as the agent does.
  const rows = (await db.query<{ k: string; reported: number; named: number; matched: number }>(
    `WITH latest AS (
       SELECT k.id, r.result FROM cabinets k
        CROSS APPLY (SELECT TOP (1) c.result FROM commands c WHERE c.cabinet_id = k.id AND c.operation = 'services.list' AND c.status = 'succeeded'
                       AND c.result IS NOT NULL ORDER BY c.result_at DESC) r
        WHERE k.status <> 'removed' AND ${SCOPE[level]})
     SELECT e.k,
            (SELECT COUNT(*) FROM latest) AS reported,
            COUNT(DISTINCT CASE WHEN sv.name IS NOT NULL THEN l.id END) AS named,
            COUNT(DISTINCT CASE WHEN sv.path = e.p THEN l.id END) AS matched
       FROM OPENJSON($2) WITH (k nvarchar(64) '$.k', s nvarchar(80) '$.s', p nvarchar(600) '$.p') e
       LEFT JOIN latest l ON 1 = 1
       OUTER APPLY (SELECT TOP (1) x.name, x.path FROM OPENJSON(l.result, '$.output.services')
                      WITH (name nvarchar(80) '$.name', path nvarchar(520) '$.executablePath') x WHERE x.name = e.s) sv
      GROUP BY e.k`, [id, wanted])).rows;
  const byKey = new Map(rows.map(r => [r.k, r]));
  return services.map(e => {
    const r = byKey.get(e.key);
    return { key: e.key, reported: Number(r?.reported ?? 0), named: Number(r?.named ?? 0), matched: Number(r?.matched ?? 0) };
  });
}
