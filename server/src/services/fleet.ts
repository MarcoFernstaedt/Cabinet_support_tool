// The client, site and cabinet views (docs/spec/06-console-spec.md "Navigation hierarchy").
import type { Queryable } from "../db/db.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";
import { fleetScannerIds, fleetSyncPorts, scannerIdsFor as resolveScanner, scannerLevels, syncForSite } from "./device-settings.js";

export { fleetScannerIds, fleetSyncPorts };

const online = (status: string, last: Date | null): boolean => status === "active" && last !== null && Date.now() - last.getTime() < OFFLINE_AFTER_MS;

export interface CabinetRow {
  id: string; name: string; role: string; status: string; online: boolean; lastHeartbeatAt: string | null;
  agentVersion: string | null; readOnly: boolean | null; hostname: string | null; openAlerts: number;
}

function cabinetRow(r: { id: string; name: string; role: string; status: string; last_heartbeat_at: Date | null; agent_version: string | null; read_only: boolean | null; hostname: string | null; open_alerts: string }): CabinetRow {
  return { id: r.id, name: r.name, role: r.role, status: r.status, online: online(r.status, r.last_heartbeat_at), lastHeartbeatAt: r.last_heartbeat_at?.toISOString() ?? null,
    agentVersion: r.agent_version, readOnly: r.read_only, hostname: r.hostname, openAlerts: Number(r.open_alerts) };
}

const OPEN_ALERTS = "(SELECT count(*) FROM alerts a WHERE a.cabinet_id = k.id AND a.state <> 'resolved')";
const CABINET_COLUMNS = `k.id, k.name, k.role, k.status, k.last_heartbeat_at, k.agent_version, k.read_only, k.hostname, ${OPEN_ALERTS} AS open_alerts`;

export async function clients(db: Queryable) {
  const rows = (await db.query<{ id: string; name: string; sites: string; cabinets: string; offline: string; open_alerts: string; open_major: string }>(
    `SELECT c.id, c.name, count(DISTINCT s.id) AS sites,
            count(k.id) FILTER (WHERE k.status = 'active') AS cabinets,
            (SELECT count(*) FROM alerts a JOIN cabinets k2 ON k2.id = a.cabinet_id JOIN sites s2 ON s2.id = k2.site_id WHERE s2.client_id = c.id AND a.state <> 'resolved') AS open_alerts,
            (SELECT count(*) FROM alerts a JOIN cabinets k2 ON k2.id = a.cabinet_id JOIN sites s2 ON s2.id = k2.site_id WHERE s2.client_id = c.id AND a.state <> 'resolved' AND a.severity = 'major') AS open_major,
            count(k.id) FILTER (WHERE k.status = 'active' AND (k.last_heartbeat_at IS NULL OR k.last_heartbeat_at < now() - make_interval(secs => $1))) AS offline
       FROM clients c LEFT JOIN sites s ON s.client_id = c.id AND s.removed_at IS NULL LEFT JOIN cabinets k ON k.site_id = s.id
      WHERE c.removed_at IS NULL GROUP BY c.id ORDER BY c.name`, [OFFLINE_AFTER_MS / 1000])).rows;
  return rows.map(r => ({ id: r.id, name: r.name, sites: Number(r.sites), cabinets: Number(r.cabinets), offline: Number(r.offline),
    openAlerts: Number(r.open_alerts), openMajor: Number(r.open_major) }));
}

export async function client(db: Queryable, id: string) {
  const c = (await db.query<{ id: string; name: string; write_paused: boolean; scanner_hardware_ids: string[] | null; sync_ports: number[] | null }>(
    "SELECT id, name, write_paused, scanner_hardware_ids, sync_ports FROM clients WHERE id = $1 AND removed_at IS NULL", [id])).rows[0];
  if (!c) return null;
  const sites = (await db.query<{ id: string; name: string; cabinets: string; offline: string; open_alerts: string; open_major: string }>(
    `SELECT s.id, s.name, count(k.id) FILTER (WHERE k.status = 'active') AS cabinets,
            (SELECT count(*) FROM alerts a JOIN cabinets k2 ON k2.id = a.cabinet_id WHERE k2.site_id = s.id AND a.state <> 'resolved') AS open_alerts,
            (SELECT count(*) FROM alerts a JOIN cabinets k2 ON k2.id = a.cabinet_id WHERE k2.site_id = s.id AND a.state <> 'resolved' AND a.severity = 'major') AS open_major,
            count(k.id) FILTER (WHERE k.status = 'active' AND (k.last_heartbeat_at IS NULL OR k.last_heartbeat_at < now() - make_interval(secs => $2))) AS offline
       FROM sites s LEFT JOIN cabinets k ON k.site_id = s.id WHERE s.client_id = $1 AND s.removed_at IS NULL GROUP BY s.id ORDER BY s.name`, [id, OFFLINE_AFTER_MS / 1000])).rows;
  const [fleetIds, fleetPorts] = [await fleetScannerIds(db), await fleetSyncPorts(db)];
  return { id: c.id, name: c.name, writePaused: c.write_paused,
    scanner: { hardwareIds: c.scanner_hardware_ids, fleetHardwareIds: fleetIds },
    syncPorts: { ports: c.sync_ports, fleetPorts },
    sites: sites.map(s => ({ id: s.id, name: s.name, cabinets: Number(s.cabinets), offline: Number(s.offline),
    openAlerts: Number(s.open_alerts), openMajor: Number(s.open_major) })) };
}

export async function site(db: Queryable, id: string) {
  const s = (await db.query<{ id: string; name: string; client_id: string; client_name: string; scanner_hardware_ids: string[] | null; client_scanner: string[] | null }>(
    `SELECT s.id, s.name, s.client_id, c.name AS client_name, s.scanner_hardware_ids, c.scanner_hardware_ids AS client_scanner
       FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = $1`, [id])).rows[0];
  if (!s) return null;
  const cabinets = (await db.query(`SELECT ${CABINET_COLUMNS} FROM cabinets k WHERE k.site_id = $1 AND k.status <> 'removed' ORDER BY k.name`, [id])).rows;
  const sync = (await syncForSite(db, id))!;
  return { id: s.id, name: s.name, client: { id: s.client_id, name: s.client_name },
    sync: { address: sync.address, ports: sync.site, effectivePorts: sync.effective, portsSource: sync.source },
    scanner: { hardwareIds: s.scanner_hardware_ids, clientHardwareIds: s.client_scanner, fleetHardwareIds: await fleetScannerIds(db) },
    cabinets: cabinets.map(cabinetRow) };
}

/** The scanner hardware IDs a cabinet's watcher should look for (cabinet, else site, else client, else fleet); null means find it automatically. */
export async function scannerIdsFor(db: Queryable, cabinetId: string): Promise<string[] | null> {
  const ids = await resolveScanner(db, cabinetId);
  return ids && ids.length > 0 ? [...new Set(ids)].slice(0, 16) : null;
}

export async function cabinet(db: Queryable, id: string) {
  const k = (await db.query(`SELECT ${CABINET_COLUMNS}, k.serial_number, k.uptime_seconds, k.clock_skew_seconds, k.scanner_hardware_ids, k.site_id,
                                    s.name AS site_name, c.id AS client_id, c.name AS client_name
                               FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id WHERE k.id = $1`, [id])).rows[0];
  if (!k) return null;
  const siblings = (await db.query(`SELECT ${CABINET_COLUMNS} FROM cabinets k WHERE k.site_id = $1 AND k.status <> 'removed' ORDER BY k.name`, [k.site_id])).rows;
  const levels = await scannerLevels(db, id);
  return {
    ...cabinetRow(k), serialNumber: k.serial_number, uptimeSeconds: k.uptime_seconds === null ? null : Number(k.uptime_seconds), clockSkewSeconds: k.clock_skew_seconds,
    site: { id: k.site_id, name: k.site_name }, client: { id: k.client_id, name: k.client_name },
    scanner: { cabinetHardwareIds: levels.cabinet, siteHardwareIds: levels.site, clientHardwareIds: levels.client, fleetHardwareIds: levels.fleet,
      effective: levels.effective, source: levels.source },
    siblings: siblings.map(cabinetRow),
  };
}

/** Name search across clients, sites and cabinets. LIKE wildcards in the query are matched literally. */
export async function search(db: Queryable, q: string) {
  const like = "%" + q.replace(/[\\%_]/g, m => "\\" + m) + "%";
  const rows = (await db.query<{ kind: string; id: string; name: string; context: string }>(
    `(SELECT 'client' AS kind, id, name, '' AS context FROM clients WHERE removed_at IS NULL AND name ILIKE $1 ORDER BY name LIMIT 10)
     UNION ALL
     (SELECT 'site', s.id, s.name, c.name FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.removed_at IS NULL AND s.name ILIKE $1 ORDER BY s.name LIMIT 10)
     UNION ALL
     (SELECT 'cabinet', k.id, k.name, c.name || ' / ' || s.name FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
       WHERE k.status <> 'removed' AND (k.name ILIKE $1 OR k.hostname ILIKE $1) ORDER BY k.name LIMIT 20)`, [like])).rows;
  return rows;
}

export async function commandHistory(db: Queryable, cabinetId: string, limit = 50) {
  return (await db.query<{ id: string; operation: string; status: string; issued_at: Date; result_at: Date | null; username: string; params: unknown; error_code: string | null }>(
    `SELECT c.id, c.operation, c.status, c.issued_at, c.result_at, u.username, c.params, c.result->'error'->>'code' AS error_code
       FROM commands c JOIN users u ON u.id = c.issued_by WHERE c.cabinet_id = $1 ORDER BY c.issued_at DESC LIMIT $2`, [cabinetId, limit])).rows
    .map(r => ({ id: r.id, operation: r.operation, status: r.status, issuedAt: r.issued_at.toISOString(), resultAt: r.result_at?.toISOString() ?? null,
      issuedBy: r.username, params: r.params, errorCode: r.error_code }));
}
