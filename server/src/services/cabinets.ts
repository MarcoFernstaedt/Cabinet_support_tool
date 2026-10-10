// Who is connecting, and what they report about themselves.
import { bootFromHeartbeat } from "./crashes.js";
import type pg from "pg";
import type { Heartbeat } from "../contracts.js";
import { audit, transaction, type Queryable } from "../db/db.js";
import { AGENT_RENEW_DAYS, issueAgentCertificate } from "../pki/issuing.js";
import type { IssuingKey, IssuedCertificate } from "../pki/x509.js";
import { Refused } from "./errors.js";

export const OFFLINE_AFTER_MS = 5 * 60_000;

export interface AuthenticatedCabinet { id: string; serial: string; }

/**
 * Accepts a connection only for a certificate this server issued, recorded
 * for an active cabinet, not revoked and not expired, whose subject names
 * that cabinet (docs/spec/05-server-spec.md: unknown or revoked serials are refused).
 */
export async function authenticate(db: Queryable, serialHex: string, subjectCabinetId: string): Promise<AuthenticatedCabinet | null> {
  if (!/^[0-9A-F]{2,64}$/.test(serialHex)) return null;
  const row = (await db.query<{ cabinet_id: string; first_use: boolean }>(
    `SELECT c.cabinet_id, c.first_used_at IS NULL AS first_use FROM cabinet_certificates c JOIN cabinets k ON k.id = c.cabinet_id
      WHERE c.serial = $1 AND c.revoked_at IS NULL AND c.not_after > now() AND k.status = 'active'`, [serialHex])).rows[0];
  if (!row || row.cabinet_id !== subjectCabinetId) return null;
  if (row.first_use) {
    // The first connection with a renewed certificate retires the one it replaced (once per certificate, not per request).
    await db.query(
      `WITH used AS (UPDATE cabinet_certificates SET first_used_at = now() WHERE serial = $1 AND first_used_at IS NULL RETURNING renewed_from)
       UPDATE cabinet_certificates SET revoked_at = now() WHERE serial = (SELECT renewed_from FROM used) AND revoked_at IS NULL`, [serialHex]);
  }
  return { id: row.cabinet_id, serial: serialHex };
}

/** Records a heartbeat. Returns whether the cabinet had been silent past the offline threshold (or never heard from), so offline alerts are only looked at then. */
export async function recordHeartbeat(db: Queryable, cabinetId: string, h: Heartbeat): Promise<{ wasOffline: boolean; firewallChanged: boolean }> {
  // The firewall profiles are kept only when reported (an older agent sends none); a change is compared with the policy.
  const r = (await db.query<{ was_offline: boolean; firewall_changed: boolean; prev_uptime: string | null; prev_at: Date | null }>(
    `UPDATE cabinets k SET last_heartbeat_at = now(), agent_version = $2, uptime_seconds = $3, read_only = $4, clock_skew_seconds = $5,
            firewall_profiles = COALESCE($7::jsonb, k.firewall_profiles)
       FROM (SELECT last_heartbeat_at, firewall_profiles, uptime_seconds FROM cabinets WHERE id = $1) before
      WHERE k.id = $1
      RETURNING before.last_heartbeat_at IS NULL OR before.last_heartbeat_at < now() - make_interval(secs => $6) AS was_offline,
                $7::jsonb IS NOT NULL AND before.firewall_profiles IS DISTINCT FROM $7::jsonb AS firewall_changed,
                before.uptime_seconds AS prev_uptime, before.last_heartbeat_at AS prev_at`,
    [cabinetId, h.agentVersion, h.uptimeSeconds, h.readOnlyMode, h.clockSkewSeconds ?? null, OFFLINE_AFTER_MS / 1000,
     h.firewallProfiles ? JSON.stringify(h.firewallProfiles) : null])).rows[0];
  // A boot when the uptime went back; a reboot loop is judged from the boots (crashes.ts).
  if (r) await bootFromHeartbeat(db, cabinetId, h.uptimeSeconds, { uptimeSeconds: r.prev_uptime === null ? null : Number(r.prev_uptime), at: r.prev_at });
  return { wasOffline: r?.was_offline ?? false, firewallChanged: r?.firewall_changed ?? false };
}

/**
 * Issues a fresh certificate for the same cabinet. Allowed only in the last AGENT_RENEW_DAYS of the current one, and
 * only once: a certificate whose successor has been used cannot renew again (a copy cannot keep extending itself), and
 * the successor's first use revokes it (see authenticate). A successor never used (the answer was lost on the way) is
 * revoked and replaced, so the agent can simply ask again.
 */
export async function renewCertificate(pool: pg.Pool, key: IssuingKey, cabinet: AuthenticatedCabinet, csrPem: string): Promise<IssuedCertificate> {
  return transaction(pool, async c => {
    const current = (await c.query<{ not_after: Date }>("SELECT not_after FROM cabinet_certificates WHERE serial = $1 FOR UPDATE", [cabinet.serial])).rows[0];
    if (!current) throw new Refused("certificate_refused", 401, "unknown certificate");
    if (current.not_after.getTime() - Date.now() > AGENT_RENEW_DAYS * 86_400_000)
      throw new Refused("renew_too_early", 409, "the current certificate is not yet due for renewal");
    const successors = (await c.query<{ serial: string; used: boolean }>(
      "SELECT serial, first_used_at IS NOT NULL AS used FROM cabinet_certificates WHERE renewed_from = $1 AND revoked_at IS NULL FOR UPDATE", [cabinet.serial])).rows;
    if (successors.some(s => s.used)) throw new Refused("already_renewed", 409, "this certificate was already renewed and its successor is in use");
    if (successors.length > 0)
      await c.query("UPDATE cabinet_certificates SET revoked_at = now() WHERE serial = ANY($1::text[])", [successors.map(s => s.serial)]);
    const issued = await issueAgentCertificate(key, csrPem, cabinet.id);
    await c.query("INSERT INTO cabinet_certificates (serial, cabinet_id, not_after, renewed_from) VALUES ($1, $2, $3, $4)",
      [issued.serialHex, cabinet.id, issued.notAfter, cabinet.serial]);
    await audit(c, { actorKind: "agent", actorId: cabinet.id, action: "certificate.renew", targetKind: "cabinet", targetId: cabinet.id, outcome: "succeeded",
      details: { previousSerial: cabinet.serial, serial: issued.serialHex } });
    return issued;
  });
}

/** Revokes every certificate of a cabinet and marks it removed. Its next connection is refused. */
export async function revokeCabinet(pool: pg.Pool, cabinetId: string, userId: string): Promise<void> {
  await transaction(pool, async c => {
    const r = await c.query("UPDATE cabinets SET status = 'removed' WHERE id = $1 AND status <> 'removed'", [cabinetId]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such active cabinet");
    await c.query("UPDATE cabinet_certificates SET revoked_at = now() WHERE cabinet_id = $1 AND revoked_at IS NULL", [cabinetId]);
    await audit(c, { actorKind: "user", actorId: userId, action: "cabinet.revoke", targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded" });
  });
}

export interface CabinetSummary {
  id: string; client: string; site: string; name: string; role: string; status: string; online: boolean;
  lastHeartbeatAt: Date | null; agentVersion: string | null; hostname: string | null; readOnly: boolean | null;
}

export async function listCabinets(db: Queryable): Promise<CabinetSummary[]> {
  return (await db.query<{ id: string; client: string; site: string; name: string; role: string; status: string; last_heartbeat_at: Date | null;
    agent_version: string | null; hostname: string | null; read_only: boolean | null }>(
    `SELECT k.id, cl.name AS client, s.name AS site, k.name, k.role, k.status, k.last_heartbeat_at, k.agent_version, k.hostname, k.read_only
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id ORDER BY cl.name, s.name, k.name`)).rows
    .map(r => ({ id: r.id, client: r.client, site: r.site, name: r.name, role: r.role, status: r.status,
      online: r.status === "active" && r.last_heartbeat_at !== null && Date.now() - r.last_heartbeat_at.getTime() < OFFLINE_AFTER_MS,
      lastHeartbeatAt: r.last_heartbeat_at, agentVersion: r.agent_version, hostname: r.hostname, readOnly: r.read_only }));
}
