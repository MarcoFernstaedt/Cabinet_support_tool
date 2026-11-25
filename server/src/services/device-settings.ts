// Device settings that follow the client (requested after milestone 7): the fingerprint scanner's hardware IDs and the
// sync cabinet's TCP ports, each set at several levels with the most specific one applying.
//   Scanner IDs: the cabinet's own, else its site's, else its client's, else the fleet default; none set anywhere means
//   the agent finds the scanner itself (its Biometric device class). An ID may be a vendor prefix such as USB\VID_1234,
//   which matches every model from that vendor, so a client changing scanner model needs no change at all.
//   Sync ports: the site's own, else its client's, else the fleet default. The address is the satellite's own sync cabinet's
//   (sync-cabinets.ts).
// Every change needs its step-up token and is audited.
import { consumeStepUpToken } from "../auth/stepup.js";
import { audit, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { Refused } from "./errors.js";
import { parseJson, removeSetting, upsertSetting } from "./settings.js";
import { syncAddressFor } from "./sync-cabinets.js";

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

/** The sync ports that apply at a site, at every level, and where the ones in force come from. */
export interface SyncPorts { site: number[] | null; client: number[] | null; fleet: number[] | null; effective: number[]; source: PortsSource }
/** What a cabinet's sync tests aim at: its sync cabinet's address (null when it has none to reach) and the site's ports. */
export interface SyncLevels extends SyncPorts { address: string | null }

/** A site's sync ports: the site's own, else the client's, else the fleet's. */
export async function syncPortsForSite(db: Queryable, siteId: string): Promise<SyncPorts | null> {
  const row = (await db.query<{ s: string | null; c: string | null }>(
    `SELECT s.sync_ports AS s, c.sync_ports AS c FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = $1`, [siteId])).rows[0];
  if (!row) return null;
  const r = { s: parseJson<number[]>(row.s), c: parseJson<number[]>(row.c) };
  const fleet = await fleetSyncPorts(db);
  // A site or client with an explicit empty list means "no ports here", which still overrides what is above it.
  const pick = r.s !== null ? [r.s, "site"] : r.c !== null ? [r.c, "client"] : fleet !== null ? [fleet, "fleet"] : [[], "none"];
  return { site: r.s, client: r.c, fleet, effective: pick[0] as number[], source: pick[1] as PortsSource };
}

/** What a cabinet's sync tests use: a satellite's live sync cabinet's address (none for any other role), and its site's ports. */
export async function syncForCabinet(db: Queryable, cabinetId: string): Promise<SyncLevels | null> {
  const site = (await db.query<{ site_id: string }>("SELECT site_id FROM cabinets WHERE id = $1", [cabinetId])).rows[0]?.site_id;
  if (!site) return null;
  const ports = await syncPortsForSite(db, site);
  return ports ? { ...ports, address: await syncAddressFor(db, cabinetId) } : null;
}

// ---- Changes ---------------------------------------------------------------------------------------

type Level = "client" | "site";

const LEVEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Plug and Play hardware ID, as the contracts define it (common.schema.json hardwareId). */
const HARDWARE_ID = /^[A-Za-z0-9\\&_.#{}=,+ -]{1,200}$/;

/**
 * Writes a client's or a site's scanner hardware IDs (null: it inherits the level above), in the caller's transaction. This module owns
 * that column on both (F21.R2, decision-log D121): the console's scanner settings write it here, and so does switching a client's
 * fingerprint scanner on with IDs (client-scanner.ts). The level, the id and the list (the contract's rule: 1 to 16 distinct hardware IDs,
 * or null) are checked before the database is touched. Returns whether a live client or site took it.
 */
export async function writeScannerIds(c: Queryable, level: Level, id: string, ids: readonly string[] | null): Promise<boolean> {
  if (level !== "client" && level !== "site") throw new Error("scanner IDs belong to a client or a site here");
  if (typeof id !== "string" || !LEVEL_ID.test(id)) throw new Error(`the ${level} must be a uuid`);
  if (ids !== null && (!Array.isArray(ids) || ids.length < 1 || ids.length > 16 || new Set(ids).size !== ids.length
    || !ids.every(x => typeof x === "string" && HARDWARE_ID.test(x)))) throw new Error("scanner IDs are null or 1 to 16 distinct hardware IDs");
  const value = ids === null ? null : safeJson(ids);
  // One fixed statement per level, so the table each writes is in the text (table-ownership.test.ts reads it).
  const r = level === "client" ? await c.query("UPDATE clients SET scanner_hardware_ids = $2 WHERE id = $1 AND removed_at IS NULL", [id, value])
    : await c.query("UPDATE sites SET scanner_hardware_ids = $2 WHERE id = $1 AND removed_at IS NULL", [id, value]);
  return r.rowCount === 1;
}

/** A client's or a site's scanner hardware IDs (Tier 2 and Admin; null removes that level's setting). */
export async function setScanner(pool: Pool, userId: string, level: Level, id: string, ids: string[] | null, stepUpToken?: string): Promise<void> {
  await transaction(pool, async c => {
    if (stepUpToken) await consumeStepUpToken(c, stepUpToken, userId, `${level}.scanner`, id);
    if (!(await writeScannerIds(c, level, id, ids))) throw new Refused("not_found", 404, `no such ${level}`);
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
    if (ports === null) await removeSetting(c, "sync.ports");
    else await upsertSetting(c, "sync.ports", ports, userId);
    await audit(c, { actorKind: "user", actorId: userId, action: "settings.sync", outcome: "succeeded", details: { ports } });
  });
}
