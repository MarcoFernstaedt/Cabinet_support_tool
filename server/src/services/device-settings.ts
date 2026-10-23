// Device settings that follow the client (requested after milestone 7): the fingerprint scanner's hardware IDs and the
// sync cabinet's TCP ports, each set at several levels with the most specific one applying.
//   Scanner IDs: the cabinet's own, else its site's, else its client's, else the fleet default; none set anywhere means
//   the agent finds the scanner itself (its Biometric device class). An ID may be a vendor prefix such as USB\VID_1234,
//   which matches every model from that vendor, so a client changing scanner model needs no change at all.
//   Sync ports: the site's own, else its client's, else the fleet default. The sync address stays per site.
// Every change needs its step-up token and is audited.
import { consumeStepUpToken } from "../auth/stepup.js";
import { audit, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { Refused } from "./errors.js";
import { isPrivateIpv4, parseJson, upsertSetting } from "./settings.js";

export type ScannerSource = "cabinet" | "site" | "client" | "fleet" | "automatic";
export type PortsSource = "site" | "client" | "fleet" | "none";

export interface ScannerLevels {
  cabinet: string[] | null; site: string[] | null; client: string[] | null; fleet: string[] | null;
  effective: string[] | null; source: ScannerSource;
}

const firstSet = <T>(...levels: [T[] | null, string][]): [T[] | null, string | null] => {
  for (const [v, name] of levels) if (v && v.length > 0) return [v, name];
  return [null, null];
};

async function fleetSetting<T>(db: Queryable, key: string): Promise<T | null> {
  return ((await db.query<{ value: T }>("SELECT [value] FROM settings WHERE [key] = $1", [key])).rows[0]?.value) ?? null;
}

export const fleetScannerIds = (db: Queryable) => fleetSetting<string[]>(db, "scanner.hardwareIds");
export const fleetSyncPorts = (db: Queryable) => fleetSetting<number[]>(db, "sync.ports");

/** Every level of a cabinet's scanner setting, and the one that applies. */
export async function scannerLevels(db: Queryable, cabinetId: string): Promise<ScannerLevels> {
  // One query: it runs for every heartbeat of every cabinet.
  // The columns are named k, s, c, f here, which the data layer does not parse as JSON, so they are parsed below.
  const r = (await db.query<{ k: string | null; s: string | null; c: string | null; f: string | null }>(
    `SELECT k.scanner_hardware_ids AS k, s.scanner_hardware_ids AS s, c.scanner_hardware_ids AS c,
            (SELECT TOP (1) [value] FROM settings WHERE [key] = 'scanner.hardwareIds') AS f
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id WHERE k.id = $1`, [cabinetId])).rows[0];
  return effectiveScanner({ cabinet: parseJson<string[]>(r?.k), site: parseJson<string[]>(r?.s), client: parseJson<string[]>(r?.c), fleet: parseJson<string[]>(r?.f) });
}

/** The level that applies: the most specific non-empty list (also used by the heartbeat, which reads the levels in its own statement). */
export function effectiveScanner(levels: { cabinet: string[] | null; site: string[] | null; client: string[] | null; fleet: string[] | null }): ScannerLevels {
  const [effective, source] = firstSet([levels.cabinet, "cabinet"], [levels.site, "site"], [levels.client, "client"], [levels.fleet, "fleet"]);
  return { ...levels, effective, source: (source ?? "automatic") as ScannerSource };
}

/** The scanner hardware IDs a cabinet's watcher should look for; null means "find it automatically". */
export async function scannerIdsFor(db: Queryable, cabinetId: string): Promise<string[] | null> {
  return (await scannerLevels(db, cabinetId)).effective;
}

export interface SyncLevels { address: string | null; site: number[] | null; client: number[] | null; fleet: number[] | null; effective: number[]; source: PortsSource }

/** A site's sync cabinet: its address, and the ports that apply with where they come from. */
export async function syncForSite(db: Queryable, siteId: string): Promise<SyncLevels | null> {
  const row = (await db.query<{ address: string | null; s: string | null; c: string | null }>(
    `SELECT s.sync_address AS address, s.sync_ports AS s, c.sync_ports AS c FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = $1`, [siteId])).rows[0];
  if (!row) return null;
  const r = { address: row.address, s: parseJson<number[]>(row.s), c: parseJson<number[]>(row.c) };
  const fleet = await fleetSyncPorts(db);
  // A site or client with an explicit empty list means "no ports here", which still overrides what is above it.
  const pick = r.s !== null ? [r.s, "site"] : r.c !== null ? [r.c, "client"] : fleet !== null ? [fleet, "fleet"] : [[], "none"];
  return { address: r.address, site: r.s, client: r.c, fleet, effective: pick[0] as number[], source: pick[1] as PortsSource };
}

/** The most sync ports a site may be given: the same limit pathhealth-targets.ts and the agent's own validator use. */
export const SITE_SYNC_PORTS_MAX = 4;

export interface SiteSync { address: string; ports: number[] | null }

/**
 * Validates and writes a site's sync cabinet in the caller's transaction, into the same columns `syncForSite` reads
 * (`sites.sync_address`, `sites.sync_ports`). The address rule is settings.ts's own (`setSiteSync` uses it too), so the
 * console's site settings and an approval cannot disagree about what a sync cabinet address is.
 *
 * This runs inside the caller's transaction on purpose: an approval that fails after it (a duplicated cabinet name, a
 * certificate that cannot be issued) leaves no sync address behind.
 */
export async function writeSiteSync(c: Queryable, userId: string, siteId: string, sync: SiteSync): Promise<void> {
  // A sync cabinet is reached on the site's own network, so only RFC 1918 addresses are accepted; each cabinet checks again
  // that the address is on one of its own networks before it connects.
  if (!isPrivateIpv4(sync.address)) {
    throw new Refused("invalid_address", 400, "the sync cabinet's address must be a private IPv4 address: 10.x.x.x, 172.16-31.x.x or 192.168.x.x");
  }
  const ports = sync.ports ?? null;
  if (ports !== null) {
    if (ports.length > SITE_SYNC_PORTS_MAX) throw new Refused("invalid_ports", 400, `a site can have at most ${SITE_SYNC_PORTS_MAX} sync ports`);
    for (const port of ports) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Refused("invalid_ports", 400, "a sync port must be a whole number from 1 to 65535");
    if (new Set(ports).size !== ports.length) throw new Refused("invalid_ports", 400, "the same sync port is listed twice");
  }
  const r = await c.query("UPDATE sites SET sync_address = $2, sync_ports = $3 WHERE id = $1 AND removed_at IS NULL", [siteId, sync.address, ports]);
  if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such site");
  await audit(c, { actorKind: "user", actorId: userId, action: "site.sync", targetKind: "site", targetId: siteId, outcome: "succeeded", details: { address: sync.address, ports } });
}

export async function syncForCabinet(db: Queryable, cabinetId: string): Promise<SyncLevels | null> {
  const site = (await db.query<{ site_id: string }>("SELECT site_id FROM cabinets WHERE id = $1", [cabinetId])).rows[0]?.site_id;
  return site ? syncForSite(db, site) : null;
}

// ---- Changes ---------------------------------------------------------------------------------------

type Level = "client" | "site";
const TABLE: Record<Level, string> = { client: "clients", site: "sites" };

/** A client's or a site's scanner hardware IDs (Tier 2 and Admin; null removes that level's setting). */
export async function setScanner(pool: Pool, userId: string, level: Level, id: string, ids: string[] | null, stepUpToken?: string): Promise<void> {
  await transaction(pool, async c => {
    if (stepUpToken) await consumeStepUpToken(c, stepUpToken, userId, `${level}.scanner`, id);
    const r = await c.query(`UPDATE ${TABLE[level]} SET scanner_hardware_ids = $2 WHERE id = $1 AND removed_at IS NULL`, [id, ids === null ? null : safeJson(ids)]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, `no such ${level}`);
    await audit(c, { actorKind: "user", actorId: userId, action: `${level}.scanner`, targetKind: level, targetId: id, outcome: "succeeded", details: { hardwareIds: ids } });
  });
}

/** A client's default sync ports (Admin; null removes the client's setting and uses the fleet default). */
export async function setClientSyncPorts(pool: Pool, userId: string, clientId: string, ports: number[] | null, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, userId, "client.sync", clientId);
    const r = await c.query("UPDATE clients SET sync_ports = $2 WHERE id = $1 AND removed_at IS NULL", [clientId, ports]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such client");
    await audit(c, { actorKind: "user", actorId: userId, action: "client.sync", targetKind: "client", targetId: clientId, outcome: "succeeded", details: { ports } });
  });
}

/** The fleet's default sync ports (Admin). */
export async function setFleetSyncPorts(pool: Pool, userId: string, ports: number[] | null, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, userId, "settings.sync", "fleet");
    if (ports === null) await c.query("DELETE FROM settings WHERE [key] = 'sync.ports'");
    else await upsertSetting(c, "sync.ports", ports, userId);
    await audit(c, { actorKind: "user", actorId: userId, action: "settings.sync", outcome: "succeeded", details: { ports } });
  });
}
