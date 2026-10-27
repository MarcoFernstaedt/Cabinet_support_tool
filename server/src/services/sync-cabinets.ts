// Sync cabinets and satellites (docs/spec/05-server-spec.md "Sync cabinets and satellites").
//
// A site may have several sync cabinets. Each one holds the address its satellites reach; each satellite names the sync cabinet it
// uses. A satellite's link counts only while it points at an active sync cabinet at the same site, so removing, demoting or moving a
// cabinet never leaves a satellite aimed somewhere it should not be: the satellite simply reads as incomplete until it is assigned.
//
// The address: taken from the sync cabinet's own reported network settings (the one private IPv4 address on its connected adapters)
// and followed when it changes, unless an Admin set one, which no report replaces. A report that names no single address (none, or
// several) keeps the last one: a sync cabinet that dropped off its network is exactly when satellites' tests should still aim at it.
import { consumeStepUpToken } from "../auth/stepup.js";
import { audit, transaction, type Pool, type Queryable } from "../db/db.js";
import { currentItems } from "./config-ingest.js";
import type { Item } from "./config-canonical.js";
import { Refused } from "./errors.js";
import { isPrivateIpv4 } from "./settings.js";

/** One adapter as either source reports it: whether it is connected, and its IPv4 addresses (bare, or with "/prefix"). */
export interface ReportedAdapter { connected: boolean; addresses: readonly string[] }

/**
 * The address a sync cabinet's satellites reach, from what it reports: the single private IPv4 address across its connected
 * adapters. None, or more than one, gives null: the platform does not guess which of several networks the satellites are on.
 */
export function lanAddress(adapters: readonly ReportedAdapter[]): string | null {
  const found = new Set<string>();
  for (const a of adapters) {
    if (a.connected !== true) continue;
    for (const entry of a.addresses) {
      if (typeof entry !== "string") continue;
      const slash = entry.indexOf("/");
      const address = slash < 0 ? entry : entry.slice(0, slash);
      if (isCanonicalIpv4(address) && isPrivateIpv4(address)) found.add(address);
    }
  }
  return found.size === 1 ? [...found][0]! : null;
}

/** Four decimal parts written the one way (no sign, spaces or leading zeros), so what is stored is exactly what is tested and shown. */
export function isCanonicalIpv4(address: string): boolean {
  const parts = address.split(".");
  return parts.length === 4 && parts.every(p => p.length >= 1 && p.length <= 3 && String(Number(p)) === p && Number(p) <= 255);
}

/** The adapters in a stored network configuration (config-canonical items "adapter:<name>"). Anything malformed counts as absent. */
export function adaptersFromItems(items: readonly Item[]): ReportedAdapter[] {
  const out: ReportedAdapter[] = [];
  for (const i of items) {
    if (!i.key.startsWith("adapter:")) continue;
    const addresses = i.values.addresses;
    out.push({ connected: i.values.connected === true, addresses: Array.isArray(addresses) ? addresses.filter((x): x is string => typeof x === "string") : [] });
  }
  return out;
}

/** The adapters in a network.config result, as the operation's contract shapes them. */
export function adaptersFromNetworkConfig(output: unknown): ReportedAdapter[] {
  const adapters = (output as { adapters?: unknown } | null)?.adapters;
  if (!Array.isArray(adapters)) return [];
  return adapters.map(a => {
    const x = (a !== null && typeof a === "object" ? a : {}) as { connected?: unknown; ipv4?: { addresses?: unknown } };
    const list = Array.isArray(x.ipv4?.addresses) ? x.ipv4!.addresses as unknown[] : [];
    return { connected: x.connected === true, addresses: list.map(e => (e as { address?: unknown })?.address).filter((s): s is string => typeof s === "string") };
  });
}

/**
 * Follows what a sync cabinet reports, in the caller's transaction. Changes nothing for a cabinet that is not an active sync cabinet,
 * whose address an Admin set, or when the report names no single address. A change is audited as the system's.
 */
export async function followReportedAddress(c: Queryable, cabinetId: string, address: string | null): Promise<boolean> {
  if (address === null) return false;
  const r = await c.query<{ before: string | null }>(
    `UPDATE cabinets SET sync_address = $2, sync_address_source = 'reported' OUTPUT deleted.sync_address AS before
      WHERE id = $1 AND role = 'sync' AND status = 'active' AND (sync_address_source IS NULL OR sync_address_source = 'reported')
        AND (sync_address IS NULL OR sync_address <> $2)`, [cabinetId, address]);
  if (r.rowCount !== 1) return false;
  await audit(c, { actorKind: "system", actorId: "sync-address", action: "cabinet.sync_address", targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded",
    details: { before: r.rows[0]!.before, address, source: "reported" } });
  return true;
}

/** After a cabinet's network configuration changed: follow the address it now reports, if it is a sync cabinet that follows reports. */
export async function followStoredNetwork(pool: Pool, cabinetId: string): Promise<boolean> {
  const network = (await currentItems(pool, cabinetId, ["network"])).get("network");
  if (!network) return false;
  const address = lanAddress(adaptersFromItems(network.items));
  return address === null ? false : transaction(pool, c => followReportedAddress(c, cabinetId, address));
}

/** The SQL condition for "satellite k's link is live": its sync cabinet is an active sync cabinet at the same site. */
export const LIVE_LINK = "EXISTS (SELECT 1 FROM cabinets y WHERE y.id = k.sync_cabinet_id AND y.site_id = k.site_id AND y.role = 'sync' AND y.status = 'active')";

/**
 * Where a site has exactly one active sync cabinet, links every active satellite there whose link is not live to it, in the caller's
 * transaction. Run when a sync cabinet appears or goes, or a satellite does. Returns how many were linked; each is audited.
 */
export async function linkUnassigned(c: Queryable, siteId: string): Promise<number> {
  const syncs = (await c.query<{ id: string }>(
    "SELECT id FROM cabinets WITH (UPDLOCK, HOLDLOCK) WHERE site_id = $1 AND role = 'sync' AND status = 'active'", [siteId])).rows;
  if (syncs.length !== 1) return 0;
  const target = syncs[0]!.id;
  const linked = (await c.query<{ id: string }>(
    `UPDATE k SET k.sync_cabinet_id = $2 OUTPUT inserted.id FROM cabinets k
      WHERE k.site_id = $1 AND k.role = 'satellite' AND k.status = 'active' AND NOT ${LIVE_LINK}`, [siteId, target])).rows;
  for (const s of linked)
    await audit(c, { actorKind: "system", actorId: "sync-link", action: "cabinet.sync_cabinet", targetKind: "cabinet", targetId: s.id, outcome: "succeeded",
      details: { syncCabinetId: target, reason: "the site's only sync cabinet" } });
  return linked.length;
}

/** What a satellite reaches. "unassigned": no live link, so its enrollment is incomplete. "address_needed": linked, but its sync cabinet has no address yet. */
export type SatelliteState = "linked" | "unassigned" | "address_needed";

export interface SyncCabinetRef { id: string; name: string; address: string | null; addressSource: "reported" | "admin" | null }

export type CabinetSync =
  | { role: "satellite"; state: SatelliteState; syncCabinet: SyncCabinetRef | null }
  | { role: "sync"; address: string | null; addressSource: "reported" | "admin" | null; satellites: number }
  | { role: "standalone" };

/** A cabinet's place in its site's sync arrangement, as the cabinet page shows it. */
export async function cabinetSync(db: Queryable, cabinetId: string): Promise<CabinetSync | null> {
  const k = (await db.query<{ role: string; address: string | null; source: "reported" | "admin" | null; sid: string | null; sname: string | null; saddress: string | null; ssource: "reported" | "admin" | null; satellites: string }>(
    `SELECT k.role, k.sync_address AS address, k.sync_address_source AS source,
            y.id AS sid, y.name AS sname, y.sync_address AS saddress, y.sync_address_source AS ssource,
            (SELECT COUNT(*) FROM cabinets z WHERE z.sync_cabinet_id = k.id AND z.site_id = k.site_id AND z.role = 'satellite' AND z.status = 'active') AS satellites
       FROM cabinets k
       LEFT JOIN cabinets y ON y.id = k.sync_cabinet_id AND y.site_id = k.site_id AND y.role = 'sync' AND y.status = 'active'
      WHERE k.id = $1`, [cabinetId])).rows[0];
  if (!k) return null;
  if (k.role === "sync") return { role: "sync", address: k.address, addressSource: k.source, satellites: Number(k.satellites) };
  if (k.role !== "satellite") return { role: "standalone" };
  if (!k.sid) return { role: "satellite", state: "unassigned", syncCabinet: null };
  return { role: "satellite", state: k.saddress ? "linked" : "address_needed", syncCabinet: { id: k.sid, name: k.sname!, address: k.saddress, addressSource: k.ssource } };
}

/** A site's sync cabinets, and how many of its satellites have no live link. */
export async function siteSyncCabinets(db: Queryable, siteId: string): Promise<{ cabinets: (SyncCabinetRef & { satellites: number })[]; unassigned: number }> {
  const cabinets = (await db.query<{ id: string; name: string; address: string | null; source: "reported" | "admin" | null; satellites: string }>(
    `SELECT k.id, k.name, k.sync_address AS address, k.sync_address_source AS source,
            (SELECT COUNT(*) FROM cabinets z WHERE z.sync_cabinet_id = k.id AND z.site_id = k.site_id AND z.role = 'satellite' AND z.status = 'active') AS satellites
       FROM cabinets k WHERE k.site_id = $1 AND k.role = 'sync' AND k.status = 'active' ORDER BY k.name`, [siteId])).rows;
  const unassigned = Number((await db.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM cabinets k WHERE k.site_id = $1 AND k.role = 'satellite' AND k.status = 'active' AND NOT ${LIVE_LINK}`, [siteId])).rows[0]!.n);
  return { cabinets: cabinets.map(r => ({ id: r.id, name: r.name, address: r.address, addressSource: r.source, satellites: Number(r.satellites) })), unassigned };
}

/** The address a cabinet's sync tests aim at: its live sync cabinet's, for a satellite; nothing for any other role. */
export async function syncAddressFor(db: Queryable, cabinetId: string): Promise<string | null> {
  return (await db.query<{ address: string | null }>(
    `SELECT y.sync_address AS address FROM cabinets k
       JOIN cabinets y ON y.id = k.sync_cabinet_id AND y.site_id = k.site_id AND y.role = 'sync' AND y.status = 'active'
      WHERE k.id = $1 AND k.role = 'satellite'`, [cabinetId])).rows[0]?.address ?? null;
}

const notSatellite = () => new Refused("not_a_satellite", 409, "only an active satellite is assigned to a sync cabinet",
  { reason: "Only an active satellite is assigned to a sync cabinet. Change the cabinet's role to satellite first." });
export const invalidSyncCabinet = () => new Refused("invalid_sync_cabinet", 409, "that is not an active sync cabinet at this cabinet's site",
  { reason: "Choose an active sync cabinet at the same site." });

/** Checks, under lock in the caller's transaction, that a cabinet is an active sync cabinet at the given site. */
export async function assertSyncCabinetAt(c: Queryable, syncCabinetId: string, siteId: string): Promise<void> {
  const ok = (await c.query("SELECT 1 AS ok FROM cabinets WITH (UPDLOCK, HOLDLOCK) WHERE id = $1 AND site_id = $2 AND role = 'sync' AND status = 'active'",
    [syncCabinetId, siteId])).rows[0];
  if (!ok) throw invalidSyncCabinet();
}

/** Assigns a satellite to a sync cabinet at its own site, or unassigns it (Admin, authenticator code). */
export async function setSyncCabinet(pool: Pool, adminId: string, satelliteId: string, syncCabinetId: string | null, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "cabinet.sync_cabinet", satelliteId);
    const k = (await c.query<{ site_id: string; before: string | null }>(
      "SELECT site_id, sync_cabinet_id AS before FROM cabinets WITH (UPDLOCK, ROWLOCK) WHERE id = $1 AND role = 'satellite' AND status = 'active'", [satelliteId])).rows[0];
    if (!k) throw notSatellite();
    if (syncCabinetId !== null) await assertSyncCabinetAt(c, syncCabinetId, k.site_id);
    await c.query("UPDATE cabinets SET sync_cabinet_id = $2 WHERE id = $1", [satelliteId, syncCabinetId]);
    await audit(c, { actorKind: "user", actorId: adminId, action: "cabinet.sync_cabinet", targetKind: "cabinet", targetId: satelliteId, outcome: "succeeded",
      details: { before: k.before, syncCabinetId } });
  });
}

/**
 * Sets the address a sync cabinet's satellites reach (Admin, authenticator code). An address set here is kept until an Admin changes
 * it; null goes back to following the cabinet's own report, taking what it reported last at once.
 */
export async function setSyncAddress(pool: Pool, adminId: string, syncCabinetId: string, address: string | null, stepUpToken: string): Promise<void> {
  if (address !== null && !isPrivateIpv4(address))
    throw new Refused("invalid_address", 400, "the sync cabinet's address must be a private IPv4 address: 10.x.x.x, 172.16-31.x.x or 192.168.x.x");
  // Read before the transaction: the stored configuration is the cabinet's report, not something this change can alter.
  const reported = address === null ? await reportedAddress(pool, syncCabinetId) : null;
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "cabinet.sync_address", syncCabinetId);
    const next = address ?? reported;
    const r = await c.query<{ before: string | null }>(
      `UPDATE cabinets SET sync_address = $2, sync_address_source = $3 OUTPUT deleted.sync_address AS before
        WHERE id = $1 AND role = 'sync' AND status = 'active'`, [syncCabinetId, next, next === null ? null : address === null ? "reported" : "admin"]);
    if (r.rowCount !== 1) throw new Refused("not_a_sync_cabinet", 409, "only an active sync cabinet has a sync address",
      { reason: "Only an active sync cabinet has a sync address. Change the cabinet's role to sync first." });
    await audit(c, { actorKind: "user", actorId: adminId, action: "cabinet.sync_address", targetKind: "cabinet", targetId: syncCabinetId, outcome: "succeeded",
      details: { before: r.rows[0]!.before, address: next, source: address === null ? "reported" : "admin" } });
  });
}

/** The address a cabinet's stored network configuration names, if it names exactly one. */
export async function reportedAddress(db: Queryable, cabinetId: string): Promise<string | null> {
  const network = (await currentItems(db, cabinetId, ["network"])).get("network");
  return network ? lanAddress(adaptersFromItems(network.items)) : null;
}
