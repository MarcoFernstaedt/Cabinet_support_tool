// Watched services (docs/spec/12-milestones-8-to-12.md, milestone 10): the services a cabinet keeps running, set for the
// fleet, a client, a site or a cabinet. The most specific level with a list wins; null inherits, [] watches nothing.
// Tier 2 and up set them with a confirmation click; every change is audited. The list reaches the agent with each
// heartbeat answer, and the broker does the restarting.
import { audit, transaction, type Pool, type Queryable } from "../db/db.js";
import { Refused } from "./errors.js";
import { parseJson, upsertSetting } from "./settings.js";

export type WatchLevel = "fleet" | "client" | "site" | "cabinet";
/**
 * `role` is the widest level and is never set by hand (F7.R4, decision-log D34): it is the services the cabinet's role baseline requires
 * running, stored when that baseline is approved (roleWatched). As with every level, the most specific one with a list wins.
 */
export interface WatchLevels { cabinet: string[] | null; site: string[] | null; client: string[] | null; fleet: string[] | null; role: string[] | null;
  effective: string[]; source: WatchLevel | "role" | "none" }

const FLEET_KEY = "services.watched";
/** Where a role's watched services are kept, derived from its approved baseline. */
export const roleWatchKey = (role: string): string => `services.watched.role.${role}`;
/** A Windows service key name as the contract allows one (common.schema.json serviceName); anything else is not sent to a cabinet. */
const SERVICE_NAME = /^[A-Za-z0-9_.$-](?:[A-Za-z0-9_.$ -]{0,78}[A-Za-z0-9_.$-])?$/;
const MAX_WATCHED = 16;

/**
 * The services a role baseline requires running: required `services` items that are present, or matched without asking for them to be
 * stopped or disabled. Sorted, at most 16 (the heartbeat contract's limit), and only names the contract accepts.
 */
export function roleWatched(content: { items: { category: string; key: string; mode: string; required?: boolean; expect?: Record<string, unknown> | null }[] }): string[] {
  const names = content.items.filter(i => i.category === "services" && i.required === true && i.key.startsWith("service:")
      && (i.mode === "present" || (i.mode === "match" && i.expect?.state !== "stopped" && i.expect?.startType !== "disabled")))
    .map(i => i.key.slice("service:".length)).filter(n => SERVICE_NAME.test(n));
  return [...new Set(names)].sort((a, b) => a.localeCompare(b)).slice(0, MAX_WATCHED);
}

export async function watchLevels(db: Queryable, cabinetId: string): Promise<WatchLevels> {
  // The columns are named k, s, c, f here, which the data layer does not parse as JSON, so they are parsed below.
  const r = (await db.query<{ k: string | null; s: string | null; c: string | null; f: string | null; r: string | null }>(
    `SELECT k.watched_services AS k, s.watched_services AS s, c.watched_services AS c,
            (SELECT TOP (1) [value] FROM settings WHERE [key] = $2) AS f,
            (SELECT TOP (1) [value] FROM settings WHERE [key] = CONCAT('services.watched.role.', k.role)) AS r
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id WHERE k.id = $1`, [cabinetId, FLEET_KEY])).rows[0];
  if (!r) throw new Refused("not_found", 404, "no such cabinet");
  const fleet = parseJson<unknown>(r.f), role = parseJson<unknown>(r.r);
  return effectiveWatched({ cabinet: parseJson<string[]>(r.k), site: parseJson<string[]>(r.s), client: parseJson<string[]>(r.c),
    fleet: Array.isArray(fleet) ? fleet as string[] : null, role: Array.isArray(role) ? role as string[] : null });
}

/** The level that applies: the most specific one with a list (also used by the heartbeat, which reads the levels in its own statement). */
export function effectiveWatched(given: { cabinet: string[] | null; site: string[] | null; client: string[] | null; fleet: string[] | null; role?: string[] | null }): WatchLevels {
  const levels = { ...given, role: given.role ?? null };
  for (const level of ["cabinet", "site", "client", "fleet", "role"] as const)
    if (levels[level] !== null) return { ...levels, effective: levels[level]!, source: level };
  return { ...levels, effective: [], source: "none" };
}

/** Sets one level's list (null: inherit). The names were checked against the watched-services contract by the route. */
export async function setWatched(pool: Pool, userId: string, level: WatchLevel, id: string, names: string[] | null): Promise<void> {
  await transaction(pool, async c => {
    if (level === "fleet") {
      if (names === null) await c.query("DELETE FROM settings WHERE [key] = $1", [FLEET_KEY]);
      else await upsertSetting(c, FLEET_KEY, names, userId);
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
