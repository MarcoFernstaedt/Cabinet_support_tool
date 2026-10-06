// The client, site and cabinet views (docs/spec/06-console-spec.md "Navigation hierarchy").
import type { Queryable } from "../db/db.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";

const online = (status: string, last: Date | null): boolean => status === "active" && last !== null && Date.now() - last.getTime() < OFFLINE_AFTER_MS;

export interface CabinetRow {
  id: string; name: string; role: string; status: string; online: boolean; lastHeartbeatAt: string | null;
  agentVersion: string | null; readOnly: boolean | null; hostname: string | null;
}

function cabinetRow(r: { id: string; name: string; role: string; status: string; last_heartbeat_at: Date | null; agent_version: string | null; read_only: boolean | null; hostname: string | null }): CabinetRow {
  return { id: r.id, name: r.name, role: r.role, status: r.status, online: online(r.status, r.last_heartbeat_at), lastHeartbeatAt: r.last_heartbeat_at?.toISOString() ?? null,
    agentVersion: r.agent_version, readOnly: r.read_only, hostname: r.hostname };
}

const CABINET_COLUMNS = "k.id, k.name, k.role, k.status, k.last_heartbeat_at, k.agent_version, k.read_only, k.hostname";

export async function clients(db: Queryable) {
  const rows = (await db.query<{ id: string; name: string; sites: string; cabinets: string; offline: string }>(
    `SELECT c.id, c.name, count(DISTINCT s.id) AS sites,
            count(k.id) FILTER (WHERE k.status = 'active') AS cabinets,
            count(k.id) FILTER (WHERE k.status = 'active' AND (k.last_heartbeat_at IS NULL OR k.last_heartbeat_at < now() - make_interval(secs => $1))) AS offline
       FROM clients c LEFT JOIN sites s ON s.client_id = c.id LEFT JOIN cabinets k ON k.site_id = s.id
      GROUP BY c.id ORDER BY c.name`, [OFFLINE_AFTER_MS / 1000])).rows;
  return rows.map(r => ({ id: r.id, name: r.name, sites: Number(r.sites), cabinets: Number(r.cabinets), offline: Number(r.offline) }));
}

export async function client(db: Queryable, id: string) {
  const c = (await db.query<{ id: string; name: string; write_paused: boolean }>("SELECT id, name, write_paused FROM clients WHERE id = $1", [id])).rows[0];
  if (!c) return null;
  const sites = (await db.query<{ id: string; name: string; cabinets: string; offline: string }>(
    `SELECT s.id, s.name, count(k.id) FILTER (WHERE k.status = 'active') AS cabinets,
            count(k.id) FILTER (WHERE k.status = 'active' AND (k.last_heartbeat_at IS NULL OR k.last_heartbeat_at < now() - make_interval(secs => $2))) AS offline
       FROM sites s LEFT JOIN cabinets k ON k.site_id = s.id WHERE s.client_id = $1 GROUP BY s.id ORDER BY s.name`, [id, OFFLINE_AFTER_MS / 1000])).rows;
  return { id: c.id, name: c.name, writePaused: c.write_paused, sites: sites.map(s => ({ id: s.id, name: s.name, cabinets: Number(s.cabinets), offline: Number(s.offline) })) };
}

export async function site(db: Queryable, id: string) {
  const s = (await db.query<{ id: string; name: string; client_id: string; client_name: string; sync_address: string | null; sync_ports: number[] }>(
    `SELECT s.id, s.name, s.client_id, c.name AS client_name, s.sync_address, s.sync_ports FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = $1`, [id])).rows[0];
  if (!s) return null;
  const cabinets = (await db.query(`SELECT ${CABINET_COLUMNS} FROM cabinets k WHERE k.site_id = $1 AND k.status <> 'removed' ORDER BY k.name`, [id])).rows;
  return { id: s.id, name: s.name, client: { id: s.client_id, name: s.client_name }, sync: { address: s.sync_address, ports: s.sync_ports }, cabinets: cabinets.map(cabinetRow) };
}

export async function fleetScannerIds(db: Queryable): Promise<string[] | null> {
  const r = (await db.query<{ value: string[] }>("SELECT value FROM settings WHERE key = 'scanner.hardwareIds'")).rows[0];
  return r?.value ?? null;
}

export async function cabinet(db: Queryable, id: string) {
  const k = (await db.query(`SELECT ${CABINET_COLUMNS}, k.serial_number, k.uptime_seconds, k.clock_skew_seconds, k.scanner_hardware_ids, k.site_id,
                                    s.name AS site_name, c.id AS client_id, c.name AS client_name
                               FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id WHERE k.id = $1`, [id])).rows[0];
  if (!k) return null;
  const siblings = (await db.query(`SELECT ${CABINET_COLUMNS} FROM cabinets k WHERE k.site_id = $1 AND k.status <> 'removed' ORDER BY k.name`, [k.site_id])).rows;
  const fleet = await fleetScannerIds(db);
  return {
    ...cabinetRow(k), serialNumber: k.serial_number, uptimeSeconds: k.uptime_seconds === null ? null : Number(k.uptime_seconds), clockSkewSeconds: k.clock_skew_seconds,
    site: { id: k.site_id, name: k.site_name }, client: { id: k.client_id, name: k.client_name },
    scanner: { cabinetHardwareIds: k.scanner_hardware_ids as string[] | null, fleetHardwareIds: fleet, effective: (k.scanner_hardware_ids as string[] | null) ?? fleet },
    siblings: siblings.map(cabinetRow),
  };
}

/** Name search across clients, sites and cabinets. LIKE wildcards in the query are matched literally. */
export async function search(db: Queryable, q: string) {
  const like = "%" + q.replace(/[\\%_]/g, m => "\\" + m) + "%";
  const rows = (await db.query<{ kind: string; id: string; name: string; context: string }>(
    `(SELECT 'client' AS kind, id, name, '' AS context FROM clients WHERE name ILIKE $1 ORDER BY name LIMIT 10)
     UNION ALL
     (SELECT 'site', s.id, s.name, c.name FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.name ILIKE $1 ORDER BY s.name LIMIT 10)
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
