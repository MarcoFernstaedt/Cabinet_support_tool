// Watched services (docs/spec/12-milestones-8-to-12.md, milestone 10): the services a cabinet keeps running, set for the
// fleet, a client, a site or a cabinet. The most specific level with a list wins; null inherits, [] watches nothing.
// Tier 2 and up set them with a confirmation click; every change is audited. The list reaches the agent with each
// heartbeat answer, and the broker does the restarting.
import type pg from "pg";
import { audit, safeJson, transaction, type Queryable } from "../db/db.js";
import { Refused } from "./errors.js";

export type WatchLevel = "fleet" | "client" | "site" | "cabinet";
export interface WatchLevels { cabinet: string[] | null; site: string[] | null; client: string[] | null; fleet: string[] | null; effective: string[]; source: WatchLevel | "none" }

const FLEET_KEY = "services.watched";

export async function watchLevels(db: Queryable, cabinetId: string): Promise<WatchLevels> {
  const r = (await db.query<{ k: string[] | null; s: string[] | null; c: string[] | null; f: string[] | null }>(
    `SELECT k.watched_services AS k, s.watched_services AS s, c.watched_services AS c,
            (SELECT value FROM settings WHERE key = '${FLEET_KEY}') AS f
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id WHERE k.id = $1`, [cabinetId])).rows[0];
  if (!r) throw new Refused("not_found", 404, "no such cabinet");
  const levels = { cabinet: r.k, site: r.s, client: r.c, fleet: Array.isArray(r.f) ? r.f : null };
  for (const level of ["cabinet", "site", "client", "fleet"] as const)
    if (levels[level] !== null) return { ...levels, effective: levels[level]!, source: level };
  return { ...levels, effective: [], source: "none" };
}

/** Sets one level's list (null: inherit). The names were checked against the watched-services contract by the route. */
export async function setWatched(pool: pg.Pool, userId: string, level: WatchLevel, id: string, names: string[] | null): Promise<void> {
  await transaction(pool, async c => {
    if (level === "fleet") {
      if (names === null) await c.query("DELETE FROM settings WHERE key = $1", [FLEET_KEY]);
      else await c.query(`INSERT INTO settings (key, value, changed_by) VALUES ($1, $2, $3)
                          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, changed_by = EXCLUDED.changed_by, changed_at = now()`, [FLEET_KEY, safeJson(names), userId]);
    } else {
      const table = { client: "clients", site: "sites", cabinet: "cabinets" }[level];
      const alive = level === "cabinet" ? "status <> 'removed'" : "removed_at IS NULL";
      const r = await c.query(`UPDATE ${table} SET watched_services = $2 WHERE id = $1 AND ${alive}`, [id, names]);
      if (r.rowCount !== 1) throw new Refused("not_found", 404, `no such ${level}`);
    }
    await audit(c, { actorKind: "user", actorId: userId, action: "watch.set", ...(level === "fleet" ? {} : { targetKind: level, targetId: id }),
      outcome: "succeeded", details: { level, names } });
  });
}
