// Who is connecting, and what they report about themselves.
import { bootFromHeartbeat } from "./crashes.js";
import type { Heartbeat } from "../contracts.js";
import { audit, HOT_PATH_TIMEOUT_MS, notify, transaction, type Pool, type Queryable } from "../db/db.js";
import { AGENT_RENEW_DAYS, issueAgentCertificate } from "../pki/issuing.js";
import type { IssuingKey, IssuedCertificate } from "../pki/x509.js";
import { Refused } from "./errors.js";
import { recordDriveReport } from "./drives.js";
import { effectiveScanner } from "./device-settings.js";
import { effectiveWatched } from "./watched-services.js";
import { rawEntry, resolveLevels, type ApprovedAppEntry } from "./approved-apps.js";
import { parseJson } from "./settings.js";
import { noteRevocation, REVOCATION_CHANNEL } from "../agent-api/revocations.js";
import { raiseSecurityAlert } from "./security.js";
import { ISSUE } from "./rules.js";

export const OFFLINE_AFTER_MS = 5 * 60_000;
/** The same tolerance as services/time.ts CLOCK_TOLERANCE_SECONDS (kept here to avoid a circular import). */
const CLOCK_TOLERANCE = 120;

export interface AuthenticatedCabinet { id: string; serial: string; }

/**
 * Accepts a connection only for a certificate this server issued, recorded
 * for an active cabinet, not revoked and not expired, whose subject names
 * that cabinet (docs/spec/05-server-spec.md: unknown or revoked serials are refused).
 * Also returns when the certificate expires, so a remembered acceptance never outlives it.
 */
export async function authenticate(db: Queryable, serialHex: string, subjectCabinetId: string): Promise<(AuthenticatedCabinet & { notAfter: Date }) | null> {
  if (!/^[0-9A-F]{2,64}$/.test(serialHex)) return null;
  const row = (await db.query<{ cabinet_id: string; first_use: number; not_after: Date }>(
    `SELECT c.cabinet_id, CASE WHEN c.first_used_at IS NULL THEN 1 ELSE 0 END AS first_use, c.not_after FROM cabinet_certificates c JOIN cabinets k ON k.id = c.cabinet_id
      WHERE c.serial = $1 AND c.revoked_at IS NULL AND c.not_after > SYSUTCDATETIME() AND k.status = 'active'`, [serialHex], { timeoutMs: HOT_PATH_TIMEOUT_MS })).rows[0];
  if (!row || row.cabinet_id !== subjectCabinetId) return null;
  if (row.first_use) {
    // The first connection with a renewed certificate retires the one it replaced (once per certificate, not per request), and tells
    // every server process, so a connection still using the retired certificate is checked again at once.
    await db.query(
      `DECLARE @used TABLE (renewed_from nvarchar(450) NULL);
       UPDATE cabinet_certificates SET first_used_at = SYSUTCDATETIME() OUTPUT inserted.renewed_from INTO @used WHERE serial = $1 AND first_used_at IS NULL;
       UPDATE cabinet_certificates SET revoked_at = SYSUTCDATETIME() WHERE serial IN (SELECT renewed_from FROM @used) AND revoked_at IS NULL;
       IF @@ROWCOUNT > 0 INSERT INTO notifications (channel, payload) VALUES ($2, $3);`, [serialHex, REVOCATION_CHANNEL, row.cabinet_id]);
    noteRevocation();
  }
  return { id: row.cabinet_id, serial: serialHex, notAfter: row.not_after };
}

export interface HeartbeatOutcome {
  /** It had been silent past the offline threshold and has an open offline alert to resolve. */
  wasOffline: boolean; firewallChanged: boolean; timeCheck: boolean;
  /** The scanner hardware IDs the agent's watcher looks for (null: find it automatically), the services it keeps running, and the programs it may be asked to control. */
  scannerIds: string[] | null; watched: string[]; approved: ApprovedAppEntry[];
}

/**
 * Records a heartbeat, and its load sample (at most one per 15 minutes), and reads the settings the answer carries, in one round trip.
 * Returns whether the cabinet had been silent past the offline threshold (or never heard from), so offline alerts are only looked at then.
 */
export async function recordHeartbeat(db: Queryable, cabinetId: string, h: Heartbeat): Promise<HeartbeatOutcome> {
  // The firewall profiles and time zone are kept only when reported (an older agent sends none); a change is compared with
  // the policy or the site's zone. The time alerts are checked again when the zone changed or the clock is, or was, off.
  // prev_at is when the previous uptime was reported (uptime_at), not the last contact: polls move last_heartbeat_at too.
  // The settings columns are named ks, ss, … here, which the data layer does not parse as JSON, so they are parsed below.
  const r = (await db.query<{ was_offline: number; offline_open: number; firewall_changed: number; prev_uptime: string | null; prev_at: Date | null; time_check: number;
    ks: string | null; ss: string | null; cs: string | null; fs: string | null; kw: string | null; sw: string | null; cw: string | null; fw: string | null;
    ka: string | null; sa: string | null; ca: string | null; fa: string | null }>(
    // No table variable: on SQL Server each one declared by an ad-hoc batch is created in tempdb, and at 10,000 cabinets those creations
    // queued on tempdb's metadata pages. The previous values are read into scalar variables under an update lock instead, in one short
    // transaction (TRY/CATCH, not XACT_ABORT, so nothing is left set on the pooled connection).
    `DECLARE @found bit = 0, @hb datetime2(3), @fw nvarchar(max), @up bigint, @upat datetime2(3), @tz nvarchar(64), @skew float;
     BEGIN TRY
       BEGIN TRANSACTION;
       SELECT @found = 1, @hb = last_heartbeat_at, @fw = firewall_profiles, @up = uptime_seconds, @upat = COALESCE(uptime_at, last_heartbeat_at),
              @tz = time_zone_id, @skew = clock_skew_seconds
         FROM cabinets WITH (UPDLOCK, ROWLOCK) WHERE id = $1;
       IF @found = 1
       BEGIN
         UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME(), uptime_at = SYSUTCDATETIME(), agent_version = $2, uptime_seconds = $3, read_only = $4, clock_skew_seconds = CAST($5 AS float),
                firewall_profiles = COALESCE(CAST($7 AS nvarchar(max)), firewall_profiles), time_zone_id = COALESCE(CAST($8 AS nvarchar(64)), time_zone_id),
                architecture = COALESCE(CAST($14 AS nvarchar(16)), architecture)
          WHERE id = $1;
         IF CAST($10 AS int) IS NOT NULL
           INSERT INTO health_samples (cabinet_id, [at], cpu_percent, memory_used_percent, disk_free_percent)
           SELECT $1, SYSUTCDATETIME(), $10, $11, $12 WHERE NOT EXISTS (SELECT 1 FROM health_samples WITH (UPDLOCK, HOLDLOCK) WHERE cabinet_id = $1 AND [at] > DATEADD(minute, -15, SYSUTCDATETIME()));
       END
       COMMIT TRANSACTION;
     END TRY
     BEGIN CATCH
       IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
       THROW;
     END CATCH;
     -- Whether an offline alert is open, so the heartbeat after a silence resolves it only when there is one to resolve.
     SELECT r.was_offline, CAST(CASE WHEN r.was_offline = 1 AND EXISTS (SELECT 1 FROM alerts WITH (FORCESEEK) WHERE cabinet_id = $1 AND issue_type_id = $13 AND state <> 'resolved') THEN 1 ELSE 0 END AS bit) AS offline_open,
            r.firewall_changed, r.prev_uptime, r.prev_at, r.time_check, x.ks, x.ss, x.cs, x.fs, x.kw, x.sw, x.cw, x.fw, x.ka, x.sa, x.ca, x.fa
       FROM (SELECT CAST(CASE WHEN @hb IS NULL OR @hb < DATEADD(second, -$6, SYSUTCDATETIME()) THEN 1 ELSE 0 END AS bit) AS was_offline,
                    CAST(CASE WHEN CAST($7 AS nvarchar(max)) IS NOT NULL AND @fw IS DISTINCT FROM CAST($7 AS nvarchar(max)) THEN 1 ELSE 0 END AS bit) AS firewall_changed,
                    @up AS prev_uptime, @upat AS prev_at,
                    CAST(CASE WHEN (CAST($8 AS nvarchar(64)) IS NOT NULL AND @tz IS DISTINCT FROM CAST($8 AS nvarchar(64)))
                           OR ABS(COALESCE(CAST($5 AS float), 0)) > $9 OR ABS(COALESCE(@skew, 0)) > $9 THEN 1 ELSE 0 END AS bit) AS time_check
              WHERE @found = 1) r
       CROSS JOIN (
         SELECT k.scanner_hardware_ids AS ks, s.scanner_hardware_ids AS ss, c.scanner_hardware_ids AS cs,
                (SELECT TOP (1) [value] FROM settings WHERE [key] = 'scanner.hardwareIds') AS fs,
                k.watched_services AS kw, s.watched_services AS sw, c.watched_services AS cw,
                (SELECT TOP (1) [value] FROM settings WHERE [key] = 'services.watched') AS fw,
                k.approved_apps AS ka, s.approved_apps AS sa, c.approved_apps AS ca,
                (SELECT TOP (1) [value] FROM settings WHERE [key] = 'apps.approved') AS fa
           FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id WHERE k.id = $1) x;`,
    [cabinetId, h.agentVersion, h.uptimeSeconds, h.readOnlyMode, h.clockSkewSeconds ?? null, OFFLINE_AFTER_MS / 1000,
     h.firewallProfiles ? JSON.stringify(h.firewallProfiles) : null, h.timeZoneId ?? null, CLOCK_TOLERANCE,
     h.health?.cpuPercent ?? null, h.health?.memoryUsedPercent ?? null, h.health?.diskFreePercent ?? null, ISSUE.offline,
     h.architecture ?? null], { timeoutMs: HOT_PATH_TIMEOUT_MS })).rows[0];
  // A boot when the uptime went back; a reboot loop is judged from the boots (crashes.ts).
  if (r && h.health?.drives && h.health.drives.length > 0) await recordDriveReport(db, cabinetId, h.health.drives);
  if (r) await bootFromHeartbeat(db, cabinetId, h.uptimeSeconds, { uptimeSeconds: r.prev_uptime === null ? null : Number(r.prev_uptime), at: r.prev_at });
  const scanner = r ? effectiveScanner({ cabinet: parseJson<string[]>(r.ks), site: parseJson<string[]>(r.ss), client: parseJson<string[]>(r.cs), fleet: parseJson<string[]>(r.fs) }).effective : null;
  const fleetWatched = r ? parseJson<unknown>(r.fw) : null;
  const watched = r ? effectiveWatched({ cabinet: parseJson<string[]>(r.kw), site: parseJson<string[]>(r.sw), client: parseJson<string[]>(r.cw),
    fleet: Array.isArray(fleetWatched) ? fleetWatched as string[] : null }).effective : [];
  // The same levels resolve the approved programs the broker may control. A level whose stored list fails its own fingerprint, or does not
  // read as a list, is skipped for the level above it, so a column edited outside the platform can only narrow what the cabinet may do.
  const apps = r ? resolveLevels({ cabinet: parseJson(r.ka), site: parseJson(r.sa), client: parseJson(r.ca), fleet: parseJson(r.fa) }) : null;
  return { wasOffline: !!r?.was_offline && !!r?.offline_open, firewallChanged: !!r?.firewall_changed, timeCheck: !!r?.time_check,
    scannerIds: scanner && scanner.length > 0 ? [...new Set(scanner)].slice(0, 16) : null, watched,
    approved: (apps?.effective?.entries ?? []).map(rawEntry) };
}

/**
 * Issues a fresh certificate for the same cabinet. Allowed only in the last AGENT_RENEW_DAYS of the current one, and
 * only once: a certificate whose successor has been used cannot renew again (a copy cannot keep extending itself), and
 * the successor's first use revokes it (see authenticate). A successor never used (the answer was lost on the way) is
 * revoked and replaced, so the agent can simply ask again.
 */
export async function renewCertificate(pool: Pool, key: IssuingKey, cabinet: AuthenticatedCabinet, csrPem: string): Promise<IssuedCertificate> {
  return transaction(pool, async c => {
    const current = (await c.query<{ not_after: Date }>("SELECT not_after FROM cabinet_certificates WITH (UPDLOCK, ROWLOCK) WHERE serial = $1", [cabinet.serial])).rows[0];
    if (!current) throw new Refused("certificate_refused", 401, "unknown certificate");
    if (current.not_after.getTime() - Date.now() > AGENT_RENEW_DAYS * 86_400_000)
      throw new Refused("renew_too_early", 409, "the current certificate is not yet due for renewal");
    const successors = (await c.query<{ serial: string; used: number }>(
      "SELECT serial, CASE WHEN first_used_at IS NOT NULL THEN 1 ELSE 0 END AS used FROM cabinet_certificates WITH (UPDLOCK, ROWLOCK) WHERE renewed_from = $1 AND revoked_at IS NULL", [cabinet.serial])).rows;
    if (successors.some(s => s.used)) throw new Refused("already_renewed", 409, "this certificate was already renewed and its successor is in use");
    if (successors.length > 0) {
      await c.query("UPDATE cabinet_certificates SET revoked_at = SYSUTCDATETIME() WHERE serial IN (SELECT value FROM OPENJSON($1))", [successors.map(s => s.serial)]);
      await notify(c, REVOCATION_CHANNEL, cabinet.id);
      noteRevocation();
    }
    const issued = await issueAgentCertificate(key, csrPem, cabinet.id);
    await c.query("INSERT INTO cabinet_certificates (serial, cabinet_id, not_after, renewed_from) VALUES ($1, $2, $3, $4)",
      [issued.serialHex, cabinet.id, issued.notAfter, cabinet.serial]);
    await audit(c, { actorKind: "agent", actorId: cabinet.id, action: "certificate.renew", targetKind: "cabinet", targetId: cabinet.id, outcome: "succeeded",
      details: { previousSerial: cabinet.serial, serial: issued.serialHex } });
    return issued;
  });
}

/** Revokes every certificate of a cabinet and marks it removed. Its next connection is refused. */
export async function revokeCabinet(pool: Pool, cabinetId: string, userId: string): Promise<void> {
  await transaction(pool, async c => {
    const r = await c.query("UPDATE cabinets SET status = 'removed' WHERE id = $1 AND status <> 'removed'", [cabinetId]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such active cabinet");
    await c.query("UPDATE cabinet_certificates SET revoked_at = SYSUTCDATETIME() WHERE cabinet_id = $1 AND revoked_at IS NULL", [cabinetId]);
    // Every server process forgets the connections it had accepted, so the cabinet's next request is refused at once.
    await notify(c, REVOCATION_CHANNEL, cabinetId);
    await audit(c, { actorKind: "user", actorId: userId, action: "cabinet.revoke", targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded" });
  });
  noteRevocation();
}

/** Days before expiry when an active cabinet's unrenewed certificate raises a security alert (agents renew in the last 30 days). */
export const CERTIFICATE_WARNING_DAYS = 7;

/**
 * Active cabinets whose newest valid certificate expires within CERTIFICATE_WARNING_DAYS and has not been renewed: such a cabinet
 * (usually one switched off for weeks) will be cut off and need a new bootstrap token. One security alert per cabinet while it is open.
 */
export async function checkExpiringCertificates(pool: Pool): Promise<number> {
  const rows = (await pool.query<{ cabinet_id: string; name: string; not_after: Date }>(
    `SELECT k.id AS cabinet_id, k.name, m.not_after FROM cabinets k
       CROSS APPLY (SELECT MAX(c.not_after) AS not_after FROM cabinet_certificates c WHERE c.cabinet_id = k.id AND c.revoked_at IS NULL) m
      WHERE k.status = 'active' AND m.not_after > SYSUTCDATETIME() AND m.not_after <= DATEADD(day, $1, SYSUTCDATETIME())
        AND NOT EXISTS (SELECT 1 FROM security_alerts a WHERE a.signature = CONCAT('certificate_expiring|', LOWER(CONVERT(nvarchar(36), k.id))) AND a.state = 'open')`,
    [CERTIFICATE_WARNING_DAYS])).rows;
  for (const r of rows) {
    const days = Math.max(0, Math.ceil((r.not_after.getTime() - Date.now()) / 86_400_000));
    await transaction(pool, c => raiseSecurityAlert(c, { kind: "certificate", signature: `certificate_expiring|${r.cabinet_id}`, cabinetId: r.cabinet_id,
      title: `The certificate of ${r.name} expires in ${days} day${days === 1 ? "" : "s"} and has not been renewed`,
      detail: { reason: "expiring", notAfter: r.not_after.toISOString(), cabinetId: r.cabinet_id } }));
  }
  return rows.length;
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
