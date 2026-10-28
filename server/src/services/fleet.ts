// The client, site and cabinet views (docs/spec/06-console-spec.md "Navigation hierarchy").
import type { Queryable } from "../db/db.js";
import { likeContains } from "./sql-like.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";
import { parseJson } from "./settings.js";
import { fleetScannerIds, fleetSyncPorts, scannerIdsFor as resolveScanner, scannerLevels, syncPortsForSite } from "./device-settings.js";
import { cabinetSync, LIVE_LINK, siteSyncCabinets } from "./sync-cabinets.js";
import { clientScanner, scannerUsedFor } from "./client-scanner.js";
import { fleetTimeZone } from "./time.js";
import { reapplyStatus } from "./replacement-reapply.js";

export { fleetScannerIds, fleetSyncPorts };

const online = (status: string, last: Date | null): boolean => status === "active" && last !== null && Date.now() - last.getTime() < OFFLINE_AFTER_MS;

export interface CabinetRow {
  id: string; name: string; role: string; status: string; online: boolean; lastHeartbeatAt: string | null;
  agentVersion: string | null; readOnly: boolean | null; hostname: string | null; openAlerts: number;
  /**
   * Which Windows the installed agent programs are built for, as the agent reports it ("windows-x64" / "windows-x86"), or
   * null for an agent built before cabinets reported one (docs/platform/second-architecture.md). This is the value an
   * update has to match. Null is unknown rather than a claim: for an update it counts as 64-bit, because 64-bit is the only
   * agent that has ever shipped and a 32-bit cabinet cannot exist without reporting one; the console shows nothing at all.
   */
  architecture: string | null;
  /** A simulated demo cabinet (docs/platform/demo.md). */
  demo: boolean;
  /** Its agent accepts upgrades whose programs are not code-signed (a development build); the console marks it. */
  unsignedUpgrades: boolean;
  /** A satellite with no live link to a sync cabinet: its enrollment is incomplete until one is assigned. */
  syncUnassigned: boolean;
  /** An active cabinet no approved baseline applies to yet (docs/spec/15-baselines-and-config.md "Baselines at enrollment"): "Baseline required". */
  baselineRequired: boolean;
}

interface CabinetDbRow { id: string; name: string; role: string; status: string; last_heartbeat_at: Date | null; agent_version: string | null; architecture: string | null; read_only: boolean | null; hostname: string | null; open_alerts: string | number; demo_scenario?: string | null; unsigned_upgrades?: boolean | number | null; sync_unassigned?: number | null }

function cabinetRow(r: CabinetDbRow, baselineRequired = false): CabinetRow {
  return { id: r.id, name: r.name, role: r.role, status: r.status, online: online(r.status, r.last_heartbeat_at), lastHeartbeatAt: r.last_heartbeat_at?.toISOString() ?? null,
    agentVersion: r.agent_version, architecture: r.architecture, readOnly: r.read_only, hostname: r.hostname, openAlerts: Number(r.open_alerts), demo: !!r.demo_scenario,
    unsignedUpgrades: !!r.unsigned_upgrades, syncUnassigned: r.sync_unassigned === 1, baselineRequired };
}

const OPEN_ALERTS = "(SELECT COUNT(*) FROM alerts a WHERE a.cabinet_id = k.id AND a.state <> 'resolved')";
const SYNC_UNASSIGNED = `CASE WHEN k.role = 'satellite' AND k.status = 'active' AND NOT ${LIVE_LINK} THEN 1 ELSE 0 END AS sync_unassigned`;
const CABINET_COLUMNS = `k.id, k.name, k.role, k.status, k.last_heartbeat_at, k.agent_version, k.architecture, k.read_only, k.hostname, k.demo_scenario, k.unsigned_upgrades, ${SYNC_UNASSIGNED}, ${OPEN_ALERTS} AS open_alerts`;
/** The columns a cabinet row is built from, without the open-alert count: a page of them has its counts read once, in one grouped query. */
const CABINET_FIELDS = `k.id, k.name, k.role, k.status, k.last_heartbeat_at, k.agent_version, k.architecture, k.read_only, k.hostname, k.demo_scenario, k.unsigned_upgrades, ${SYNC_UNASSIGNED}`;

/** How many cabinets of a site one page holds, and the most a caller may ask for: a site of thousands is read a page at a time. */
export const SITE_CABINET_PAGE = 200;
export const MAX_CABINET_PAGE = 500;

export interface Page { limit?: number; offset?: number }

const pageWindow = (page: Page): { limit: number; offset: number } => ({
  limit: Math.min(Math.max(Math.trunc(page.limit ?? SITE_CABINET_PAGE) || SITE_CABINET_PAGE, 1), MAX_CABINET_PAGE),
  offset: Math.max(Math.trunc(page.offset ?? 0) || 0, 0),
});

/**
 * One page of cabinet rows with their open-alert counts. The counts come from a single grouped query over that page's cabinets, instead of a
 * correlated count per row: the count is what makes a fleet-wide list grow with the site, and it is read once, for what is shown.
 */
async function pageRows(db: Queryable, rows: readonly CabinetDbRow[]): Promise<CabinetRow[]> {
  if (rows.length === 0) return [];
  const ids = rows.map(r => r.id);
  const counts = (await db.query<{ cabinet_id: string; n: string }>(
    `SELECT cabinet_id, COUNT(*) AS n FROM alerts WHERE state <> 'resolved' AND cabinet_id IN (${ids.map((_, i) => `$${i + 1}`).join(", ")}) GROUP BY cabinet_id`, ids)).rows;
  const openAlerts = new Map(counts.map(c => [c.cabinet_id, Number(c.n)]));
  const noBaseline = await cabinetsWithoutBaseline(db, ids);
  return rows.map(r => cabinetRow({ ...r, open_alerts: openAlerts.get(r.id) ?? 0 }, noBaseline.has(r.id.toLowerCase())));
}

/**
 * Of these cabinets, the active ones no approved baseline applies to (the lists' "Baseline required"). One statement for a page of
 * cabinets: each cabinet's five scopes are matched against the approved versions.
 */
async function cabinetsWithoutBaseline(db: Queryable, cabinetIds: readonly string[]): Promise<Set<string>> {
  if (cabinetIds.length === 0) return new Set();
  const rows = (await db.query<{ id: string }>(
    `SELECT k.id FROM cabinets k JOIN sites s ON s.id = k.site_id
      WHERE k.id IN (SELECT TRY_CAST([value] AS uniqueidentifier) FROM OPENJSON($1)) AND k.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM baselines b JOIN baseline_versions v ON v.baseline_id = b.id AND v.status = 'approved'
                         WHERE b.scope_kind = 'global'
                            OR (b.scope_kind = 'model' AND b.scope_id = k.model)
                            OR (b.scope_kind = 'client' AND b.scope_id = LOWER(CONVERT(nvarchar(36), s.client_id)))
                            OR (b.scope_kind = 'site' AND b.scope_id = LOWER(CONVERT(nvarchar(36), k.site_id)))
                            OR (b.scope_kind = 'cabinet' AND b.scope_id = LOWER(CONVERT(nvarchar(36), k.id))))`, [JSON.stringify(cabinetIds)])).rows;
  return new Set(rows.map(r => r.id.toLowerCase()));
}

/** How many cabinets a site has: the page says what it is a page of, so a truncated list is never taken for the whole one. */
async function cabinetCount(db: Queryable, siteId: string): Promise<number> {
  return Number((await db.query<{ n: string }>("SELECT COUNT(*) AS n FROM cabinets k WHERE k.site_id = $1 AND k.status <> 'removed'", [siteId])).rows[0]!.n);
}

export async function clients(db: Queryable) {
  const rows = (await db.query<{ id: string; name: string; demo: boolean; sites: string; cabinets: string; offline: string; open_alerts: string; open_major: string }>(
    `SELECT c.id, c.name, c.demo, COUNT(DISTINCT s.id) AS sites,
            SUM(CASE WHEN k.status = 'active' THEN 1 ELSE 0 END) AS cabinets,
            (SELECT COUNT(*) FROM alerts a JOIN cabinets k2 ON k2.id = a.cabinet_id JOIN sites s2 ON s2.id = k2.site_id WHERE s2.client_id = c.id AND a.state <> 'resolved' AND a.scope = 'fleet') AS open_alerts,
            (SELECT COUNT(*) FROM alerts a JOIN cabinets k2 ON k2.id = a.cabinet_id JOIN sites s2 ON s2.id = k2.site_id WHERE s2.client_id = c.id AND a.state <> 'resolved' AND a.scope = 'fleet' AND a.severity = 'major') AS open_major,
            SUM(CASE WHEN k.status = 'active' AND (k.last_heartbeat_at IS NULL OR k.last_heartbeat_at < DATEADD(second, -$1, SYSUTCDATETIME())) THEN 1 ELSE 0 END) AS offline
       FROM clients c LEFT JOIN sites s ON s.client_id = c.id AND s.removed_at IS NULL LEFT JOIN cabinets k ON k.site_id = s.id
      WHERE c.removed_at IS NULL GROUP BY c.id, c.name, c.demo ORDER BY c.name`, [OFFLINE_AFTER_MS / 1000])).rows;
  return rows.map(r => ({ id: r.id, name: r.name, demo: r.demo, sites: Number(r.sites), cabinets: Number(r.cabinets), offline: Number(r.offline),
    openAlerts: Number(r.open_alerts), openMajor: Number(r.open_major) }));
}

export async function client(db: Queryable, id: string) {
  const c = (await db.query<{ id: string; name: string; demo: boolean; write_paused: boolean; scanner_hardware_ids: string[] | null; sync_ports: number[] | null; time_zone: string | null }>(
    "SELECT id, name, demo, write_paused, scanner_hardware_ids, sync_ports, time_zone FROM clients WHERE id = $1 AND removed_at IS NULL", [id])).rows[0];
  if (!c) return null;
  const sites = (await db.query<{ id: string; name: string; cabinets: string; offline: string; open_alerts: string; open_major: string }>(
    `SELECT s.id, s.name, SUM(CASE WHEN k.status = 'active' THEN 1 ELSE 0 END) AS cabinets,
            (SELECT COUNT(*) FROM alerts a JOIN cabinets k2 ON k2.id = a.cabinet_id WHERE k2.site_id = s.id AND a.state <> 'resolved' AND a.scope = 'fleet') AS open_alerts,
            (SELECT COUNT(*) FROM alerts a JOIN cabinets k2 ON k2.id = a.cabinet_id WHERE k2.site_id = s.id AND a.state <> 'resolved' AND a.scope = 'fleet' AND a.severity = 'major') AS open_major,
            SUM(CASE WHEN k.status = 'active' AND (k.last_heartbeat_at IS NULL OR k.last_heartbeat_at < DATEADD(second, -$2, SYSUTCDATETIME())) THEN 1 ELSE 0 END) AS offline
       FROM sites s LEFT JOIN cabinets k ON k.site_id = s.id WHERE s.client_id = $1 AND s.removed_at IS NULL GROUP BY s.id, s.name ORDER BY s.name`, [id, OFFLINE_AFTER_MS / 1000])).rows;
  const [fleetIds, fleetPorts] = [await fleetScannerIds(db), await fleetSyncPorts(db)];
  return { id: c.id, name: c.name, demo: c.demo, writePaused: c.write_paused,
    scanner: { hardwareIds: c.scanner_hardware_ids, fleetHardwareIds: fleetIds },
    syncPorts: { ports: c.sync_ports, fleetPorts },
    // The client's default zone for its sites, and the fleet's it falls back to.
    timeZone: { own: c.time_zone, fleet: await fleetTimeZone(db) },
    fingerprintScanner: await clientScanner(db, c.id),
    sites: sites.map(s => ({ id: s.id, name: s.name, cabinets: Number(s.cabinets), offline: Number(s.offline),
    openAlerts: Number(s.open_alerts), openMajor: Number(s.open_major) })) };
}

/**
 * A site, with one page of its cabinets. `cabinetCount` says how many cabinets the site has and `cabinetsPage.hasMore` whether this page is
 * the whole list, so a site with more cabinets than a page still answers quickly and says so.
 */
export async function site(db: Queryable, id: string, page: Page = {}) {
  const s = (await db.query<{ id: string; name: string; client_id: string; client_name: string; scanner_hardware_ids: string[] | null; client_scanner: string | null; time_zone: string | null; client_zone: string | null; network_baseline: unknown }>(
    `SELECT s.id, s.name, s.client_id, c.name AS client_name, s.scanner_hardware_ids, c.scanner_hardware_ids AS client_scanner, s.time_zone, c.time_zone AS client_zone, s.network_baseline
       FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = $1`, [id])).rows[0];
  if (!s) return null;
  const { limit, offset } = pageWindow(page);
  const cabinets = (await db.query<CabinetDbRow>(
    `SELECT ${CABINET_FIELDS}, 0 AS open_alerts FROM cabinets k WHERE k.site_id = $1 AND k.status <> 'removed' ORDER BY k.name OFFSET $2 ROWS FETCH NEXT $3 ROWS ONLY`,
    [id, offset, limit])).rows;
  const count = await cabinetCount(db, id);
  const ports = (await syncPortsForSite(db, id))!;
  const syncCabinets = await siteSyncCabinets(db, id);
  const fleetZone = s.time_zone || s.client_zone ? null : await fleetTimeZone(db);
  const zone = s.time_zone ? { zone: s.time_zone, source: "site" as const } : s.client_zone ? { zone: s.client_zone, source: "client" as const }
    : { zone: fleetZone, source: fleetZone ? "fleet" as const : null };
  return { id: s.id, name: s.name, client: { id: s.client_id, name: s.client_name }, timeZone: s.time_zone, networkBaseline: s.network_baseline,
    // The zone its cabinets are held to and where it comes from: the site's own, else the client's, else the fleet's (null: none is checked).
    timeZoneApplies: { zone: zone.zone, source: zone.source },
    sync: { ports: ports.site, effectivePorts: ports.effective, portsSource: ports.source, syncCabinets: syncCabinets.cabinets, unassignedSatellites: syncCabinets.unassigned },
    scanner: { hardwareIds: s.scanner_hardware_ids, clientHardwareIds: parseJson<string[]>(s.client_scanner), fleetHardwareIds: await fleetScannerIds(db) },
    cabinets: await pageRows(db, cabinets), cabinetCount: count, cabinetsPage: { limit, offset, hasMore: offset + cabinets.length < count } };
}

/** The scanner hardware IDs a cabinet's watcher should look for (cabinet, else site, else client, else fleet); null means find it automatically. */
export async function scannerIdsFor(db: Queryable, cabinetId: string): Promise<string[] | null> {
  const ids = await resolveScanner(db, cabinetId);
  return ids && ids.length > 0 ? [...new Set(ids)].slice(0, 16) : null;
}

export async function cabinet(db: Queryable, id: string, page: Page = {}) {
  const k = (await db.query<CabinetDbRow & { serial_number: string | null; manufacturer: string | null; model: string | null; uptime_seconds: string | null; clock_skew_seconds: number | null; site_id: string; site_name: string; client_id: string; client_name: string }>(`SELECT ${CABINET_COLUMNS}, k.serial_number, k.manufacturer, k.model, k.uptime_seconds, k.clock_skew_seconds, k.scanner_hardware_ids, k.site_id,
                                    s.name AS site_name, c.id AS client_id, c.name AS client_name
                               FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id WHERE k.id = $1`, [id])).rows[0];
  if (!k) return null;
  // The cabinets of the same site, one page at a time: a site of thousands does not make opening one cabinet read them all.
  const { limit, offset } = pageWindow(page);
  const siblings = (await db.query<CabinetDbRow>(
    `SELECT ${CABINET_FIELDS}, 0 AS open_alerts FROM cabinets k WHERE k.site_id = $1 AND k.status <> 'removed' ORDER BY k.name OFFSET $2 ROWS FETCH NEXT $3 ROWS ONLY`,
    [k.site_id, offset, limit])).rows;
  const siblingCount = await cabinetCount(db, k.site_id);
  const levels = await scannerLevels(db, id);
  // The last moment nothing was wrong: before the oldest open alert began; with none open, now if the cabinet is online, else when it was last heard from.
  const oldestOpen = (await db.query<{ since: Date | null }>("SELECT MIN(first_seen) AS since FROM alerts WITH (FORCESEEK) WHERE cabinet_id = $1 AND state <> 'resolved'", [id])).rows[0]?.since ?? null;
  const row = cabinetRow(k, (await cabinetsWithoutBaseline(db, [k.id])).has(k.id.toLowerCase()));
  const lastHealthyAt = oldestOpen ? oldestOpen.toISOString() : row.online ? new Date().toISOString() : k.last_heartbeat_at ? k.last_heartbeat_at.toISOString() : null;
  return {
    ...row, lastHealthyAt, serialNumber: k.serial_number, manufacturer: k.manufacturer, model: k.model, uptimeSeconds: k.uptime_seconds === null ? null : Number(k.uptime_seconds), clockSkewSeconds: k.clock_skew_seconds,
    site: { id: k.site_id, name: k.site_name }, client: { id: k.client_id, name: k.client_name },
    scanner: { cabinetHardwareIds: levels.cabinet, siteHardwareIds: levels.site, clientHardwareIds: levels.client, fleetHardwareIds: levels.fleet,
      effective: levels.effective, source: levels.source },
    sync: await cabinetSync(db, id),
    scannerUsed: await scannerUsedFor(db, id),
    siblings: await pageRows(db, siblings), siblingCount, siblingsPage: { limit, offset, hasMore: offset + siblings.length < siblingCount },
    ...(await replacementLinks(db, id)),
    // What a replacement put back on the machine, step by step (null when it replaced none).
    reapply: await reapplyStatus(db, id),
  };
}

/** The cabinet this one replaced, and the one that replaced it (05-server-spec.md "Replacing a cabinet"); null when there is none. */
async function replacementLinks(db: Queryable, id: string) {
  const r = (await db.query<{ old_id: string | null; old_name: string | null; new_id: string | null; new_name: string | null }>(
    `SELECT o.id AS old_id, o.name AS old_name, n.id AS new_id, n.name AS new_name
       FROM cabinets k LEFT JOIN cabinets o ON o.id = k.replaces_cabinet_id LEFT JOIN cabinets n ON n.replaces_cabinet_id = k.id WHERE k.id = $1`, [id])).rows[0];
  return { replaces: r?.old_id ? { id: r.old_id, name: r.old_name! } : null, replacedBy: r?.new_id ? { id: r.new_id, name: r.new_name! } : null };
}

/** A cabinet to show a new person around: a real one before a simulated one, one that is online before one that is not. Null when there is none. */
export async function firstCabinet(db: Queryable): Promise<{ id: string; name: string } | null> {
  const r = (await db.query<{ id: string; name: string }>(
    `SELECT TOP (1) k.id, k.name FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
      WHERE k.status = 'active' AND c.removed_at IS NULL AND s.removed_at IS NULL
      ORDER BY c.demo, CASE WHEN k.last_heartbeat_at IS NULL OR k.last_heartbeat_at < DATEADD(minute, -5, SYSUTCDATETIME()) THEN 1 ELSE 0 END, c.name, s.name, k.name`)).rows[0];
  return r ?? null;
}

/** Name search across clients, sites and cabinets. LIKE wildcards in the query are matched literally. */
export async function search(db: Queryable, q: string) {
  const like = likeContains(q);
  const rows = (await db.query<{ kind: string; id: string; name: string; context: string }>(
    `SELECT kind, id, name, context FROM (
       SELECT 1 AS ord, kind, id, name, context FROM (SELECT TOP (10) 'client' AS kind, id, name, N'' AS context FROM clients WHERE removed_at IS NULL AND name LIKE $1 ESCAPE '\\' ORDER BY name) a
       UNION ALL
       SELECT 2, kind, id, name, context FROM (SELECT TOP (10) 'site' AS kind, s.id, s.name, c.name AS context FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.removed_at IS NULL AND s.name LIKE $1 ESCAPE '\\' ORDER BY s.name) b
       UNION ALL
       SELECT 3, kind, id, name, context FROM (SELECT TOP (20) 'cabinet' AS kind, k.id, k.name, CONCAT(c.name, ' / ', s.name) AS context FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
         WHERE k.status <> 'removed' AND (k.name LIKE $1 ESCAPE '\\' OR k.hostname LIKE $1 ESCAPE '\\') ORDER BY k.name) d
     ) u ORDER BY ord, name`, [like])).rows;
  return rows;
}

export async function commandHistory(db: Queryable, cabinetId: string, limit = 50) {
  return (await db.query<{ id: string; operation: string; status: string; issued_at: Date; result_at: Date | null; username: string; params: unknown; error_code: string | null }>(
    `SELECT TOP ($2) c.id, c.operation, c.status, c.issued_at, c.result_at, u.username, c.params, JSON_VALUE(c.result, '$.error.code') AS error_code
       FROM commands c JOIN users u ON u.id = c.issued_by WHERE c.cabinet_id = $1 ORDER BY c.issued_at DESC`, [cabinetId, limit])).rows
    .map(r => ({ id: r.id, operation: r.operation, status: r.status, issuedAt: r.issued_at.toISOString(), resultAt: r.result_at?.toISOString() ?? null,
      issuedBy: r.username, params: r.params, errorCode: r.error_code }));
}
