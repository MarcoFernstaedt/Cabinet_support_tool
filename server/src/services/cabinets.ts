// Who is connecting, and what they report about themselves.
import { bootFromHeartbeat } from "./crashes.js";
import type { Heartbeat } from "../contracts.js";
import { audit, HOT_PATH_TIMEOUT_MS, notify, transaction, type Pool, type Queryable } from "../db/db.js";
import { AGENT_RENEW_DAYS, issueAgentCertificate } from "../pki/issuing.js";
import type { IssuingKey, IssuedCertificate } from "../pki/x509.js";
import { Refused } from "./errors.js";
import { isCanonicalIpv4, linkUnassigned } from "./sync-cabinets.js";
import { recordDriveReport } from "./drives.js";
import { effectiveScanner } from "./device-settings.js";
import { effectiveWatched } from "./watched-services.js";
import { rawEntry, resolveLevels, type ApprovedAppEntry, type SignedList } from "./approved-apps.js";
import { isPrivateIpv4, parseJson } from "./settings.js";
import { noteRevocation, REVOCATION_CHANNEL } from "../agent-api/revocations.js";
import { raiseSecurityAlert } from "./security.js";
import { ISSUE } from "./rules.js";
import { CLOCK_TOLERANCE_SECONDS, SITE_CLOCK_TOLERANCE_SQL } from "./cabinet-conditions.js";

export const OFFLINE_AFTER_MS = 5 * 60_000;

export interface AuthenticatedCabinet { id: string; serial: string; }

/**
 * A certificate serial as the platform stores and compares it: upper-case hex, 2 to 64 digits. One rule for every place that checks one
 * (decision-log D89): recording an issued certificate, authenticating a connection, and reading the serial a TLS peer presents. Our CA
 * issues 32 digits.
 */
export const CERTIFICATE_SERIAL = /^[0-9A-F]{2,64}$/;

/**
 * Accepts a connection only for a certificate this server issued, recorded
 * for an active cabinet, not revoked and not expired, whose subject names
 * that cabinet (docs/spec/05-server-spec.md: unknown or revoked serials are refused).
 * Also returns when the certificate expires, so a remembered acceptance never outlives it.
 */
export async function authenticate(db: Queryable, serialHex: string, subjectCabinetId: string): Promise<(AuthenticatedCabinet & { notAfter: Date }) | null> {
  if (typeof serialHex !== "string" || !CERTIFICATE_SERIAL.test(serialHex)) return null;
  const row = (await db.query<{ cabinet_id: string; first_use: number; not_after: Date }>(
    `SELECT c.cabinet_id, CASE WHEN c.first_used_at IS NULL THEN 1 ELSE 0 END AS first_use, c.not_after FROM cabinet_certificates c JOIN cabinets k ON k.id = c.cabinet_id
      WHERE c.serial = $1 AND c.revoked_at IS NULL AND c.not_after > SYSUTCDATETIME() AND k.status = 'active'`, [serialHex], { timeoutMs: HOT_PATH_TIMEOUT_MS })).rows[0];
  if (!row || row.cabinet_id !== subjectCabinetId) return null;
  if (row.first_use) {
    // The first connection with a renewed certificate retires the one it replaced (once per certificate, not per request), and tells
    // every server process, so a connection still using the retired certificate is checked again at once.
    const retired = Number((await db.query<{ retired: number }>(
      `DECLARE @used TABLE (renewed_from nvarchar(450) NULL);
       UPDATE cabinet_certificates SET first_used_at = SYSUTCDATETIME() OUTPUT inserted.renewed_from INTO @used WHERE serial = $1 AND first_used_at IS NULL;
       UPDATE cabinet_certificates SET revoked_at = SYSUTCDATETIME() WHERE serial IN (SELECT renewed_from FROM @used) AND revoked_at IS NULL;
       SELECT @@ROWCOUNT AS retired;`, [serialHex])).rows[0]?.retired ?? 0);
    if (retired > 0) await notify(db, REVOCATION_CHANNEL, row.cabinet_id);
    noteRevocation();
  }
  return { id: row.cabinet_id, serial: serialHex, notAfter: row.not_after };
}

export interface HeartbeatOutcome {
  /** It had been silent past the offline threshold and has an open offline alert to resolve. */
  wasOffline: boolean; firewallChanged: boolean; timeCheck: boolean;
  /** The scanner hardware IDs the agent's watcher looks for (null: find it automatically), the services it keeps running, and the programs it may be asked to control. */
  scannerIds: string[] | null; watched: string[]; approved: ApprovedAppEntry[];
  /** Whether the cabinet's client uses a fingerprint scanner (client-scanner.ts); when it does not, the agent is told not to look for one. */
  scannerUsed: boolean;
  /** The same list as an Admin signed it, when it is signed (the agent checks it against its own list-signing key). */
  approvedSigned: SignedList | null;
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
    ks: string | null; ss: string | null; cs: string | null; fs: string | null; kw: string | null; sw: string | null; cw: string | null; fw: string | null; rw: string | null;
    ka: string | null; sa: string | null; ca: string | null; fa: string | null; scanner_used: boolean | number | null }>(
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
                architecture = COALESCE(CAST($14 AS nvarchar(16)), architecture), unsigned_upgrades = CAST($15 AS bit)
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
            r.firewall_changed, r.prev_uptime, r.prev_at, r.time_check, x.ks, x.ss, x.cs, x.fs, x.kw, x.sw, x.cw, x.fw, x.rw, x.ka, x.sa, x.ca, x.fa, x.scanner_used
       FROM (SELECT CAST(CASE WHEN @hb IS NULL OR @hb < DATEADD(second, -$6, SYSUTCDATETIME()) THEN 1 ELSE 0 END AS bit) AS was_offline,
                    CAST(CASE WHEN CAST($7 AS nvarchar(max)) IS NOT NULL AND @fw IS DISTINCT FROM CAST($7 AS nvarchar(max)) THEN 1 ELSE 0 END AS bit) AS firewall_changed,
                    @up AS prev_uptime, @upat AS prev_at,
                    CAST(CASE WHEN (CAST($8 AS nvarchar(64)) IS NOT NULL AND @tz IS DISTINCT FROM CAST($8 AS nvarchar(64)))
                           OR ABS(COALESCE(CAST($5 AS float), 0)) > tol.seconds OR ABS(COALESCE(@skew, 0)) > tol.seconds THEN 1 ELSE 0 END AS bit) AS time_check
               -- The tolerance at the cabinet's site (D109); $9, the built-in one, only if the cabinet's row is gone.
               FROM (SELECT COALESCE((SELECT ${SITE_CLOCK_TOLERANCE_SQL} FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id
                                      WHERE k.id = $1), $9) AS seconds) tol
              WHERE @found = 1) r
       CROSS JOIN (
         SELECT k.scanner_hardware_ids AS ks, s.scanner_hardware_ids AS ss, c.scanner_hardware_ids AS cs,
                (SELECT TOP (1) [value] FROM settings WHERE [key] = 'scanner.hardwareIds') AS fs,
                k.watched_services AS kw, s.watched_services AS sw, c.watched_services AS cw,
                (SELECT TOP (1) [value] FROM settings WHERE [key] = 'services.watched') AS fw,
                (SELECT TOP (1) [value] FROM settings WHERE [key] = CONCAT('services.watched.role.', k.role)) AS rw,
                k.approved_apps AS ka, s.approved_apps AS sa, c.approved_apps AS ca,
                (SELECT TOP (1) [value] FROM settings WHERE [key] = 'apps.approved') AS fa, c.fingerprint_scanner AS scanner_used
           FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id WHERE k.id = $1) x;`,
    [cabinetId, h.agentVersion, h.uptimeSeconds, h.readOnlyMode, h.clockSkewSeconds ?? null, OFFLINE_AFTER_MS / 1000,
     h.firewallProfiles ? JSON.stringify(h.firewallProfiles) : null, h.timeZoneId ?? null, CLOCK_TOLERANCE_SECONDS,
     h.health?.cpuPercent ?? null, h.health?.memoryUsedPercent ?? null, h.health?.diskFreePercent ?? null, ISSUE.offline,
     h.architecture ?? null, h.unsignedUpgrades === true ? 1 : 0], { timeoutMs: HOT_PATH_TIMEOUT_MS })).rows[0];
  // A boot when the uptime went back; a reboot loop is judged from the boots (crashes.ts).
  if (r && h.health?.drives && h.health.drives.length > 0) await recordDriveReport(db, cabinetId, h.health.drives);
  if (r) await bootFromHeartbeat(db, cabinetId, h.uptimeSeconds, { uptimeSeconds: r.prev_uptime === null ? null : Number(r.prev_uptime), at: r.prev_at });
  const scannerUsed = !(r?.scanner_used === false || r?.scanner_used === 0);
  const scanner = r ? effectiveScanner({ cabinet: parseJson<string[]>(r.ks), site: parseJson<string[]>(r.ss), client: parseJson<string[]>(r.cs), fleet: parseJson<string[]>(r.fs) }).effective : null;
  const fleetWatched = r ? parseJson<unknown>(r.fw) : null, roleWatched = r ? parseJson<unknown>(r.rw) : null;
  const watched = r ? effectiveWatched({ cabinet: parseJson<string[]>(r.kw), site: parseJson<string[]>(r.sw), client: parseJson<string[]>(r.cw),
    fleet: Array.isArray(fleetWatched) ? fleetWatched as string[] : null, role: Array.isArray(roleWatched) ? roleWatched as string[] : null }).effective : [];
  // The same levels resolve the approved programs the broker may control. A level whose stored list fails its own fingerprint, the
  // heartbeat contract's shape, or does not read as a list, resolves to an empty list (deny) rather than to the level above it, so a
  // damaged column can only narrow what the cabinet may do, and it cannot make the heartbeat answer fail its own contract.
  // The raw column values go in: resolveLevels parses and checks each one itself, the same way the control check does (appLevels), so a
  // damaged column is rejected (deny) here too, never read as "not set" and replaced by the broader level.
  const apps = r ? resolveLevels({ cabinet: r.ka, site: r.sa, client: r.ca, fleet: r.fa }) : null;
  // Only an approved service may be kept running: a watched service that is not on the approved list is not sent, so an agent built
  // before the watcher asked the list (which starts whatever it is told to watch) never starts it either.
  const approvedServices = new Set((apps?.effective?.entries ?? []).filter(e => e.kind === "service" && e.serviceName).map(e => e.serviceName!.toLowerCase()));
  const watchedApproved = watched.filter(name => approvedServices.has(name.toLowerCase()));
  return { wasOffline: !!r?.was_offline && !!r?.offline_open, firewallChanged: !!r?.firewall_changed, timeCheck: !!r?.time_check,
    // A client that uses no scanner sends no IDs either: there is nothing to look for.
    scannerIds: scannerUsed && scanner && scanner.length > 0 ? [...new Set(scanner)].slice(0, 16) : null, watched: watchedApproved, scannerUsed,
    approved: (apps?.effective?.entries ?? []).map(rawEntry), approvedSigned: apps?.effective?.signed ?? null };
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

/**
 * Records the certificate just issued to a cabinet at enrollment (F21.R2, decision-log D87). Enrollment calls it in the transaction
 * that approves the cabinet. The cabinet id, the serial and the expiry are checked before the database is touched.
 */
export async function recordIssuedCertificate(c: Queryable, cabinetId: string, serialHex: string, notAfter: Date): Promise<void> {
  if (typeof cabinetId !== "string" || !CABINET_ID.test(cabinetId)) throw new Error("a cabinet id is required to record its certificate");
  if (typeof serialHex !== "string" || !CERTIFICATE_SERIAL.test(serialHex)) throw new Error("a certificate serial in upper-case hex is required");
  if (!(notAfter instanceof Date) || Number.isNaN(notAfter.getTime())) throw new Error("a certificate expiry is required");
  await c.query("INSERT INTO cabinet_certificates (serial, cabinet_id, not_after) VALUES ($1, $2, $3)", [serialHex, cabinetId, notAfter]);
}

/**
 * Revokes every certificate a cabinet still has, so its next connection is refused: when it is revoked, and when it is replaced
 * (F21.R2, D87). The caller tells the other server processes (REVOCATION_CHANNEL) and audits, in the same transaction. Returns how many
 * were revoked. The cabinet id is checked before the database is touched.
 */
export async function revokeCabinetCertificates(c: Queryable, cabinetId: string): Promise<number> {
  if (typeof cabinetId !== "string" || !CABINET_ID.test(cabinetId)) throw new Error("a cabinet id is required to revoke its certificates");
  return (await c.query("UPDATE cabinet_certificates SET revoked_at = SYSUTCDATETIME() WHERE cabinet_id = $1 AND revoked_at IS NULL", [cabinetId])).rowCount ?? 0;
}

/** Revokes every certificate of a cabinet and marks it removed. Its next connection is refused. */
export async function revokeCabinet(pool: Pool, cabinetId: string, userId: string): Promise<void> {
  await transaction(pool, async c => {
    const r = await c.query<{ site_id: string }>("UPDATE cabinets SET status = 'removed' OUTPUT inserted.site_id WHERE id = $1 AND status <> 'removed'", [cabinetId]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such active cabinet");
    // A removed sync cabinet's satellites go to the site's only remaining sync cabinet, if there is exactly one; otherwise they wait for an Admin.
    await linkUnassigned(c, r.rows[0]!.site_id);
    await revokeCabinetCertificates(c, cabinetId);
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
    agent_version: string | null; architecture: string | null; hostname: string | null; read_only: boolean | null }>(
    `SELECT k.id, cl.name AS client, s.name AS site, k.name, k.role, k.status, k.last_heartbeat_at, k.agent_version, k.architecture, k.hostname, k.read_only
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id ORDER BY cl.name, s.name, k.name`)).rows
    .map(r => ({ id: r.id, client: r.client, site: r.site, name: r.name, role: r.role, status: r.status,
      online: r.status === "active" && r.last_heartbeat_at !== null && Date.now() - r.last_heartbeat_at.getTime() < OFFLINE_AFTER_MS,
      lastHeartbeatAt: r.last_heartbeat_at, agentVersion: r.agent_version, architecture: r.architecture, hostname: r.hostname, readOnly: r.read_only }));
}

const CABINET_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const CABINET_ROLES = ["sync", "satellite", "standalone"] as const;

/** A cabinet as an approval places it: its place, name and role, what it reported, and what it takes over from a cabinet it replaces. */
export interface NewCabinet {
  id: string; siteId: string; name: string; role: string;
  hostname: string; serialNumber: string | null; agentVersion: string; architecture: string | null;
  syncCabinetId: string | null; replacesCabinetId: string | null;
  /**
   * The replaced cabinet's own settings, as read from its row, or null. The connection reads these JSON columns back parsed (a list or an
   * object, whatever OldCabinet's type says) and writes a value back as its JSON text, so either form is taken.
   */
  scannerHardwareIds: string | null; watchedServices: string | null; filefactsPaths: string | null; inOffice: boolean;
  /** An Admin-set sync address carried over from the replaced sync cabinet: both null, or the address and "admin". */
  syncAddress: string | null; syncAddressSource: "admin" | null;
}

// The loosest cabinet name the approval's contract allows: 1 to 128 characters, none a control character or an angle bracket.
const CABINET_NAME = /^[^\u0000-\u001f\u007f<>]+$/u;
const ARCHITECTURES = ["windows-x64", "windows-x86"];
const isUuidOrNull = (v: unknown) => v === null || (typeof v === "string" && CABINET_ID.test(v));
const isTextOrNull = (v: unknown) => v === null || typeof v === "string";
const isStoredSetting = (v: unknown) => v === null || typeof v === "string" || Array.isArray(v) || (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype);

/**
 * Creates an active cabinet, the one place one is created (F21.R2, decision-log D128): enrollment calls it in the transaction that
 * approves the cabinet. A name is unique within its site (removed cabinets keep theirs); the check is in the insert itself, with a lock on
 * the rows it reads, so of two approvals at the same moment one inserts and the other is answered false. Every field is checked before the
 * database is touched; the caller checked the contract, the place, the role and the replaced cabinet.
 */
export async function insertCabinet(c: Queryable, k: NewCabinet): Promise<boolean> {
  if (typeof k !== "object" || k === null) throw new Error("a new cabinet is required");
  if (typeof k.id !== "string" || !CABINET_ID.test(k.id) || typeof k.siteId !== "string" || !CABINET_ID.test(k.siteId)) throw new Error("a new cabinet's id and site are uuids");
  if (typeof k.name !== "string" || [...k.name].length > 128 || !CABINET_NAME.test(k.name)) throw new Error("a cabinet name is 1 to 128 characters with no control characters or angle brackets");
  if (!(CABINET_ROLES as readonly unknown[]).includes(k.role)) throw new Error("a cabinet's role is sync, satellite or standalone");
  if (typeof k.hostname !== "string" || k.hostname.length < 1 || k.hostname.length > 255 || !isTextOrNull(k.serialNumber) || typeof k.agentVersion !== "string"
      || k.agentVersion.length > 64 || !(k.architecture === null || ARCHITECTURES.includes(k.architecture))) throw new Error("a new cabinet's reported facts are its hostname, serial, agent version and architecture");
  if (!isUuidOrNull(k.syncCabinetId) || !isUuidOrNull(k.replacesCabinetId)) throw new Error("a sync cabinet and a replaced cabinet are uuids or null");
  if (!isStoredSetting(k.scannerHardwareIds) || !isStoredSetting(k.watchedServices) || !isStoredSetting(k.filefactsPaths) || typeof k.inOffice !== "boolean")
    throw new Error("a replaced cabinet's settings are what its row held, or null");
  if (!(k.syncAddress === null && k.syncAddressSource === null)
      && !(typeof k.syncAddress === "string" && isCanonicalIpv4(k.syncAddress) && isPrivateIpv4(k.syncAddress) && k.syncAddressSource === "admin"))
    throw new Error("a carried-over sync address is a private IPv4 address an Admin set, or none");
  const r = await c.query(`INSERT INTO cabinets (id, site_id, name, role, status, hostname, serial_number, agent_version, architecture, sync_cabinet_id,
                   replaces_cabinet_id, scanner_hardware_ids, watched_services, filefacts_paths, in_office, sync_address, sync_address_source)
                 SELECT $1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
                 WHERE NOT EXISTS (SELECT 1 FROM cabinets WITH (UPDLOCK, HOLDLOCK) WHERE site_id = $2 AND name = $3)`,
    [k.id, k.siteId, k.name, k.role, k.hostname, k.serialNumber, k.agentVersion, k.architecture, k.syncCabinetId, k.replacesCabinetId,
     k.scannerHardwareIds, k.watchedServices, k.filefactsPaths, k.inOffice ? 1 : 0, k.syncAddress, k.syncAddressSource]);
  return r.rowCount === 1;
}

/**
 * Changes an active cabinet's role, and the sync columns that follow it, in the caller's transaction (F21.R2, decision-log D127): a
 * cabinet that stops being a satellite drops its link; one that stops being a sync cabinet drops its address; one that becomes a sync
 * cabinet starts from `reported`, the address it last reported, and one that already was keeps its own. The caller (admin.ts) checks the
 * code, links the site's waiting satellites and audits. The id, the role and the address are checked before the database is touched.
 * Answers the role it had and its site, or null when there is no such active cabinet.
 */
export async function changeCabinetRole(c: Queryable, id: string, role: string, reported: string | null): Promise<{ oldRole: string; siteId: string } | null> {
  if (typeof id !== "string" || !CABINET_ID.test(id)) throw new Error("a cabinet id is required to change its role");
  if (!(CABINET_ROLES as readonly unknown[]).includes(role)) throw new Error("a cabinet's role is sync, satellite or standalone");
  if (reported !== null && (typeof reported !== "string" || !isCanonicalIpv4(reported) || !isPrivateIpv4(reported)))
    throw new Error("a reported sync address is null or a private IPv4 address");
  const r = await c.query<{ old_role: string; site_id: string }>(
    `UPDATE cabinets SET role = $2,
            sync_cabinet_id = CASE WHEN $2 = 'satellite' THEN sync_cabinet_id ELSE NULL END,
            sync_address = CASE WHEN $2 = 'sync' AND role = 'sync' THEN sync_address WHEN $2 = 'sync' THEN $3 ELSE NULL END,
            sync_address_source = CASE WHEN $2 = 'sync' AND role = 'sync' THEN sync_address_source WHEN $2 = 'sync' AND $3 IS NOT NULL THEN 'reported' ELSE NULL END
     OUTPUT deleted.role AS old_role, inserted.site_id WHERE id = $1 AND status = 'active'`, [id, role, reported]);
  return r.rowCount === 1 ? { oldRole: r.rows[0]!.old_role, siteId: r.rows[0]!.site_id } : null;
}

/** Rows per statement: small enough that the row locks are held only briefly (2,000 made heartbeats wait at 8,000 cabinets). */
const CONTACT_CHUNK = 500;
/** A contact time as the presence batch writes it: Date.prototype.toISOString's own form, in UTC. */
const CONTACT_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Records when each active cabinet was last heard from, for the presence batch (agent-api/presence.ts; F21.R2, decision-log D126):
 * cabinets.last_heartbeat_at, which every "offline after 5 minutes" judgement reads, is never moved backwards, and a removed or pending
 * cabinet is not written. Written in statements of 500 rows. Every id and time is checked before the database is touched, so a bad entry
 * refuses the whole batch, as the database's own conversion error did. Returns the rows written.
 */
export async function recordContacts(c: Queryable, contacts: readonly { id: string; at: string }[]): Promise<number> {
  if (!Array.isArray(contacts)) throw new Error("contacts are a list of cabinet ids and times");
  for (const e of contacts) {
    if (typeof e !== "object" || e === null || typeof e.id !== "string" || !CABINET_ID.test(e.id)) throw new Error("a contact names a cabinet by its uuid");
    if (typeof e.at !== "string" || !CONTACT_AT.test(e.at) || Number.isNaN(Date.parse(e.at))) throw new Error("a contact time is an ISO 8601 UTC time");
  }
  let written = 0;
  for (let i = 0; i < contacts.length; i += CONTACT_CHUNK) {
    const r = await c.query(
      `UPDATE k SET last_heartbeat_at = j.[at]
         FROM cabinets k JOIN OPENJSON($1) WITH (id uniqueidentifier '$.id', [at] datetime2(3) '$.at') j ON k.id = j.id
        WHERE k.status = 'active' AND (k.last_heartbeat_at IS NULL OR k.last_heartbeat_at < j.[at])`,
      [JSON.stringify(contacts.slice(i, i + CONTACT_CHUNK).map(e => ({ id: e.id, at: e.at })))]);
    written += r.rowCount ?? 0;
  }
  return written;
}

/**
 * Removes these cabinets' raw health samples taken before `before`, once the caller has folded them into health_hourly in the same
 * transaction (F21.R2, decision-log D77): the nightly retention run is the only caller, and audits the run as retention.run with the count.
 * The ids and the time are checked before the database is touched.
 */
export async function dropRolledUpHealthSamples(c: Queryable, cabinetIds: readonly string[], before: Date, o: { timeoutMs: number }): Promise<number> {
  if (!Array.isArray(cabinetIds) || !cabinetIds.every(id => typeof id === "string" && CABINET_ID.test(id))) throw new Error("dropping health samples needs a list of cabinet ids");
  if (!(before instanceof Date) || Number.isNaN(before.getTime()) || before.getTime() > Date.now()) throw new Error("health samples are dropped only before a time that has already passed");
  if (!Number.isSafeInteger(o?.timeoutMs) || o.timeoutMs < 1) throw new Error("dropping health samples needs a timeout in whole milliseconds");
  if (cabinetIds.length === 0) return 0;
  return (await c.query("DELETE FROM health_samples WHERE cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1)) AND [at] < $2",
    [JSON.stringify(cabinetIds), before], { timeoutMs: o.timeoutMs })).rowCount ?? 0;
}
