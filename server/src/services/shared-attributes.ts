// What the affected cabinets of a fleet incident or pattern have in common that the others do not (roadmap module 11, plan item 2.3,
// decision-log D157): the model, the Windows build, the BIOS version and the agent version, counted on both sides. The change
// comparison (compareChanges) says what happened before; this says what the cabinets are. Neither says what caused it.
import type { Queryable } from "../db/db.js";

export type Attribute = "model" | "windowsBuild" | "biosVersion" | "agentVersion";
export const ATTRIBUTE_NAMES: Record<Attribute, string> = { model: "Model", windowsBuild: "Windows build", biosVersion: "BIOS version", agentVersion: "Agent version" };

export interface SharedAttribute {
  attribute: Attribute; name: string; value: string;
  affected: number; affectedShare: number; unaffected: number; unaffectedShare: number; standsOut: boolean;
}

/** The most rows a comparison returns: the ones that stand out first. */
export const MAX_SHARED = 20;
const ATTRS: readonly Attribute[] = ["model", "windowsBuild", "biosVersion", "agentVersion"];

/**
 * Counts each attribute's values among the affected cabinets and the rest of `ids`. A value stands out under the same rule as a
 * change (D22): at least two cabinets affected, at least half of them have it, and at least 40 points more of them than of the others.
 * A value the cabinet has not reported is never counted, so "unknown" never stands out.
 */
export async function sharedAttributes(db: Queryable, o: { ids: readonly string[]; affected: ReadonlySet<string> }): Promise<SharedAttribute[]> {
  if (o.ids.length === 0) return [];
  // The Windows build from each cabinet's latest stored system.info answer, read through commands_latest_result.
  const rows = (await db.query<{ id: string; model: string | null; build: string | null; bios: string | null; agent: string | null }>(
    `DECLARE @ids TABLE (id uniqueidentifier PRIMARY KEY);
     INSERT INTO @ids SELECT DISTINCT CAST(value AS uniqueidentifier) FROM OPENJSON($1);
     SELECT k.id, NULLIF(LTRIM(RTRIM(CONCAT(k.manufacturer, ' ', k.model))), '') AS model, k.bios_version AS bios, k.agent_version AS agent,
            NULLIF(CAST(JSON_VALUE(info.result, '$.output.osBuild') AS nvarchar(64)), '') AS build
       FROM @ids i JOIN cabinets k ON k.id = i.id
       OUTER APPLY (SELECT TOP (1) c.result FROM commands c WITH (INDEX(commands_latest_result))
                     WHERE c.cabinet_id = k.id AND c.operation = 'system.info' AND c.status = 'succeeded' AND c.result IS NOT NULL ORDER BY c.result_at DESC) info`,
    [o.ids.map(id => id.toLowerCase())])).rows;
  const counts = new Map<string, { attribute: Attribute; value: string; affected: number; unaffected: number }>();
  let affectedTotal = 0, unaffectedTotal = 0;
  for (const r of rows) {
    const hit = o.affected.has(r.id.toLowerCase());
    if (hit) affectedTotal++; else unaffectedTotal++;
    const values: Record<Attribute, string | null> = { model: r.model, windowsBuild: r.build, biosVersion: r.bios, agentVersion: r.agent };
    for (const a of ATTRS) {
      const v = values[a]?.trim();
      if (!v) continue;
      const k = `${a}\u0000${v.toLowerCase()}`;
      const e = counts.get(k) ?? counts.set(k, { attribute: a, value: v, affected: 0, unaffected: 0 }).get(k)!;
      if (hit) e.affected++; else e.unaffected++;
    }
  }
  const share = (n: number, of: number) => of === 0 ? 0 : Math.round((n / of) * 1000) / 10;
  return [...counts.values()].filter(c => c.affected > 0).map(c => {
    const as = share(c.affected, affectedTotal), us = share(c.unaffected, unaffectedTotal);
    return { attribute: c.attribute, name: ATTRIBUTE_NAMES[c.attribute], value: c.value, affected: c.affected, affectedShare: as, unaffected: c.unaffected, unaffectedShare: us,
      standsOut: affectedTotal >= 2 && as >= 50 && as - us >= 40 };
  }).sort((a, b) => Number(b.standsOut) - Number(a.standsOut) || (b.affectedShare - b.unaffectedShare) - (a.affectedShare - a.unaffectedShare) || a.name.localeCompare(b.name))
    .slice(0, MAX_SHARED);
}
