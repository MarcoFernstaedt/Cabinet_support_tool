// System health (docs/platform/operations.md): what the host admin needs to know that the platform is healthy, read from SQL Server's own
// catalog views and the platform's tables. Nothing here reads the cabinet application's database or any cabinet's content. The checks
// raise operations alerts through the security alert mechanism (one open alert per kind), and clear the state-based ones when the
// condition is gone. No notification leaves the server: the alerts show in the console, and /health is for an external uptime check.
import { X509Certificate } from "node:crypto";
import { transaction, type Pool, type Queryable } from "../db/db.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";
import { autoResolveSecurityAlert, raiseSecurityAlert } from "./security.js";
import { isGauge } from "./ops-meter.js";

const GIB = 1024 ** 3;
const DAY = 86_400_000;

// ---- Database size ----------------------------------------------------------------------------------------------------------------

/** The size limit of one database for an edition, or null where there is no practical limit. SQL Server Express: 10 GB of data files (the log is not counted). */
export function editionLimitBytes(edition: string | null | undefined): number | null {
  return typeof edition === "string" && /express/i.test(edition) ? 10 * GIB : null;
}

export const DATABASE_WARN_PERCENT = 70, DATABASE_CRITICAL_PERCENT = 85;

export interface DatabaseFacts { edition: string | null; limitBytes: number | null; dataBytes: number; logBytes: number; percent: number | null }

export async function databaseFacts(db: Queryable, limitOverride?: number | null): Promise<DatabaseFacts> {
  const r = (await db.query<{ edition: string | null; data_bytes: string | number | null; log_bytes: string | number | null }>(
    `SELECT CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition,
            (SELECT SUM(CAST(size AS bigint)) * 8192 FROM sys.database_files WHERE type = 0) AS data_bytes,
            (SELECT SUM(CAST(size AS bigint)) * 8192 FROM sys.database_files WHERE type = 1) AS log_bytes`)).rows[0]!;
  const limitBytes = limitOverride !== undefined ? limitOverride : editionLimitBytes(r.edition);
  const dataBytes = Number(r.data_bytes ?? 0), logBytes = Number(r.log_bytes ?? 0);
  return { edition: r.edition, limitBytes, dataBytes, logBytes, percent: limitBytes ? Math.round((dataBytes / limitBytes) * 1000) / 10 : null };
}

// ---- Disk, backups -----------------------------------------------------------------------------------------------------------------

export interface VolumeFacts { mount: string; totalBytes: number; freeBytes: number; freePercent: number }
/** Free space on each volume that holds one of this database's files; null when the account may not look. */
export async function volumeFacts(db: Queryable): Promise<VolumeFacts[] | null> {
  try {
    const rows = (await db.query<{ mount: string; total: string | number; free: string | number }>(
      `SELECT DISTINCT v.volume_mount_point AS mount, v.total_bytes AS total, v.available_bytes AS free
         FROM sys.database_files f CROSS APPLY sys.dm_os_volume_stats(DB_ID(), f.file_id) v`)).rows;
    return rows.map(r => ({ mount: String(r.mount), totalBytes: Number(r.total), freeBytes: Number(r.free), freePercent: Number(r.total) > 0 ? Math.round((Number(r.free) / Number(r.total)) * 1000) / 10 : 0 }));
  } catch { return null; }
}
export const DISK_MIN_FREE_PERCENT = 10, DISK_MIN_FREE_BYTES = 5 * GIB;

export interface BackupFacts { readable: boolean; ageMinutes: number | null }
/** Age of the newest full or differential backup of this database, from msdb (server-local clock compared with itself); readable false when msdb is not readable. */
export async function backupFacts(db: Queryable): Promise<BackupFacts> {
  try {
    const r = (await db.query<{ age: number | string | null }>(
      "SELECT DATEDIFF(minute, MAX(backup_finish_date), GETDATE()) AS age FROM msdb.dbo.backupset WHERE database_name = DB_NAME() AND type IN ('D', 'I')")).rows[0];
    return { readable: true, ageMinutes: r?.age === null || r?.age === undefined ? null : Math.max(0, Number(r.age)) };
  } catch { return { readable: false, ageMinutes: null }; }
}
export const BACKUP_MAX_HOURS = 36;

// ---- Certificates, audit chain --------------------------------------------------------------------------------------------------------

export const CA_WARNING_DAYS = 60;
export function certificateExpiry(pem: string | undefined, now = Date.now()): { notAfter: string; daysLeft: number } | null {
  if (!pem) return null;
  try {
    const t = new Date(new X509Certificate(pem).validTo).getTime();
    return Number.isFinite(t) ? { notAfter: new Date(t).toISOString(), daysLeft: Math.floor((t - now) / DAY) } : null;
  } catch { return null; }
}

// ---- The summary -----------------------------------------------------------------------------------------------------------------------

export interface CounterRow { kind: string; code: string; last24h: number; last7d: number }

export const OPS_ALERT_KINDS = ["ops_database", "ops_disk", "ops_backup", "ops_errors", "ops_shed", "ops_migration", "ops_ca", "audit_chain", "certificate"] as const;

export interface HealthOptions { caCertificatePem?: string | undefined; limitBytes?: number | null | undefined; now?: Date }

export async function healthSummary(db: Queryable, o: HealthOptions = {}) {
  const now = o.now ?? new Date();
  const [database, volumes, backup] = [await databaseFacts(db, o.limitBytes), await volumeFacts(db), await backupFacts(db)];
  const counters = (await db.query<{ kind: string; code: string; d1: string | number; d7: string | number }>(
    `SELECT kind, code,
            CASE WHEN LEFT(kind, 2) = 'g_' THEN MAX(CASE WHEN [hour] >= DATEADD(hour, -24, $1) THEN [count] ELSE 0 END) ELSE SUM(CASE WHEN [hour] >= DATEADD(hour, -24, $1) THEN [count] ELSE 0 END) END AS d1,
            CASE WHEN LEFT(kind, 2) = 'g_' THEN MAX([count]) ELSE SUM([count]) END AS d7
       FROM ops_counters WHERE [hour] >= DATEADD(day, -7, $1) GROUP BY kind, code ORDER BY kind, code`, [now])).rows
    .map((r): CounterRow => ({ kind: r.kind, code: r.code, last24h: Number(r.d1), last7d: Number(r.d7) }));
  const cabinets = (await db.query<{ online: number; offline: number }>(
    `SELECT ISNULL(SUM(CASE WHEN last_heartbeat_at >= DATEADD(second, -$2, $1) THEN 1 ELSE 0 END), 0) AS online,
            ISNULL(SUM(CASE WHEN last_heartbeat_at IS NULL OR last_heartbeat_at < DATEADD(second, -$2, $1) THEN 1 ELSE 0 END), 0) AS offline
       FROM cabinets WHERE status = 'active' AND demo_scenario IS NULL`, [now, OFFLINE_AFTER_MS / 1000])).rows[0]!;
  const verify = (await db.query<{ at: Date; outcome: string; details: { entries?: number; mode?: string } }>(
    "SELECT TOP (1) [at], outcome, details FROM audit_log WHERE action = 'audit.verify' ORDER BY seq DESC")).rows[0];
  const verifyOk = (await db.query<{ at: Date }>("SELECT TOP (1) [at] FROM audit_log WHERE action = 'audit.verify' AND outcome = 'succeeded' ORDER BY seq DESC")).rows[0];
  const retention = (await db.query<{ at: Date; outcome: string }>("SELECT TOP (1) [at], outcome FROM audit_log WHERE action = 'retention.run' ORDER BY seq DESC")).rows[0];
  const nextCabinetCert = (await db.query<{ not_after: Date | null }>(
    `SELECT MIN(m.not_after) AS not_after FROM cabinets k CROSS APPLY (SELECT MAX(c.not_after) AS not_after FROM cabinet_certificates c WHERE c.cabinet_id = k.id AND c.revoked_at IS NULL) m
      WHERE k.status = 'active' AND m.not_after > $1`, [now])).rows[0]?.not_after ?? null;
  const alerts = (await db.query<{ id: string; kind: string; title: string; occurrences: number; first_seen: Date; last_seen: Date }>(
    `SELECT TOP (50) id, kind, title, occurrences, first_seen, last_seen FROM security_alerts
      WHERE state = 'open' AND kind IN (SELECT value FROM OPENJSON($1)) ORDER BY last_seen DESC`, [JSON.stringify(OPS_ALERT_KINDS)])).rows;
  const ca = certificateExpiry(o.caCertificatePem);
  return {
    generatedAt: now.toISOString(),
    database: { edition: database.edition, limitBytes: database.limitBytes, dataBytes: database.dataBytes, logBytes: database.logBytes, percent: database.percent,
      warnAtPercent: DATABASE_WARN_PERCENT, criticalAtPercent: DATABASE_CRITICAL_PERCENT },
    disk: volumes === null ? { readable: false, volumes: [] } : { readable: true, volumes },
    backup: { readable: backup.readable, ageHours: backup.ageMinutes === null ? null : Math.round((backup.ageMinutes / 60) * 10) / 10, maxHours: BACKUP_MAX_HOURS },
    certificates: { ca, nextCabinetCertificateNotAfter: nextCabinetCert ? nextCabinetCert.toISOString() : null },
    auditChain: { lastVerifiedAt: verifyOk ? verifyOk.at.toISOString() : null, lastRun: verify ? { at: verify.at.toISOString(), ok: verify.outcome === "succeeded", mode: verify.details?.mode ?? null } : null },
    retention: { lastRunAt: retention ? retention.at.toISOString() : null },
    cabinets: { online: Number(cabinets.online), offline: Number(cabinets.offline) },
    counters: counters.map(c => ({ ...c, gauge: isGauge(c.kind) })),
    alerts: alerts.map(a => ({ id: a.id, kind: a.kind, title: a.title, occurrences: a.occurrences, firstSeen: a.first_seen.toISOString(), lastSeen: a.last_seen.toISOString() })),
  };
}
export type HealthSummary = Awaited<ReturnType<typeof healthSummary>>;

// ---- The checks that raise alerts ------------------------------------------------------------------------------------------------

export interface CheckOptions { now?: number; caCertificatePem?: string | undefined; limitBytes?: number | null | undefined; thresholds?: { diskMinFreePercent?: number; diskMinFreeBytes?: number; backupMaxHours?: number } }

type StateKind = "ops_database" | "ops_disk" | "ops_backup" | "ops_ca";

/** Raises (or refreshes) the one open alert of a kind, or clears it when the condition is gone. */
async function settle(pool: Pool, kind: StateKind, problem: { title: string; detail: Record<string, unknown> } | null): Promise<void> {
  if (problem) { await transaction(pool, c => raiseSecurityAlert(c, { kind, signature: kind, title: problem.title, detail: problem.detail })); return; }
  // Resolving is security.ts's (D88).
  await transaction(pool, c => autoResolveSecurityAlert(c, kind, { actorId: "ops-check", details: { kind } }));
}

const gb = (b: number): string => (b / GIB).toFixed(1);

/**
 * Database and disk size, backup age and CA expiry. Each raises one open alert per kind while it holds and clears it when it no longer does.
 * Returns the kinds that are in alarm (for tests and the log).
 */
export async function runOpsChecks(pool: Pool, o: CheckOptions = {}): Promise<StateKind[]> {
  const alarms: StateKind[] = [];
  const t = o.thresholds ?? {};

  const db = await databaseFacts(pool, o.limitBytes);
  if (db.percent !== null && db.percent >= DATABASE_WARN_PERCENT) {
    const level = db.percent >= DATABASE_CRITICAL_PERCENT ? DATABASE_CRITICAL_PERCENT : DATABASE_WARN_PERCENT;
    alarms.push("ops_database");
    await settle(pool, "ops_database", { title: `The database is ${db.percent}% of its edition limit (${gb(db.dataBytes)} of ${gb(db.limitBytes!)} GB; alert level ${level}%)`,
      detail: { percent: db.percent, level, dataBytes: db.dataBytes, limitBytes: db.limitBytes, edition: db.edition } });
  } else await settle(pool, "ops_database", null);

  const volumes = await volumeFacts(pool);
  const low = (volumes ?? []).filter(v => v.freePercent < (t.diskMinFreePercent ?? DISK_MIN_FREE_PERCENT) || v.freeBytes < (t.diskMinFreeBytes ?? DISK_MIN_FREE_BYTES));
  if (low.length) {
    alarms.push("ops_disk");
    await settle(pool, "ops_disk", { title: `Low free disk space on the database server: ${low.map(v => `${v.mount} ${gb(v.freeBytes)} GB free (${v.freePercent}%)`).join(", ")}`,
      detail: { volumes: low } });
  } else await settle(pool, "ops_disk", null);

  const backup = await backupFacts(pool);
  const maxHours = t.backupMaxHours ?? BACKUP_MAX_HOURS;
  if (backup.readable && (backup.ageMinutes === null || backup.ageMinutes > maxHours * 60)) {
    alarms.push("ops_backup");
    await settle(pool, "ops_backup", { title: backup.ageMinutes === null ? "No backup of the platform database is recorded"
      : `The last backup of the platform database finished ${Math.round(backup.ageMinutes / 60)} hours ago (limit ${maxHours})`, detail: { ageMinutes: backup.ageMinutes, maxHours } });
  } else await settle(pool, "ops_backup", null);

  const ca = certificateExpiry(o.caCertificatePem, o.now);
  if (ca && ca.daysLeft <= CA_WARNING_DAYS) {
    alarms.push("ops_ca");
    await settle(pool, "ops_ca", { title: ca.daysLeft < 0 ? "The platform's certificate authority has expired" : `The platform's certificate authority expires in ${ca.daysLeft} days`, detail: ca });
  } else if (ca) await settle(pool, "ops_ca", null);
  return alarms;
}

/** Runs the checks soon after start and then every 10 minutes; a failed run is logged and tried again. */
export function scheduleOpsChecks(pool: Pool, log: (message: string) => void, o: CheckOptions = {}, everyMs = 600_000, runIf: () => Promise<boolean> = async () => true): () => void {
  // With more than one server instance, only the holder of the job's lease runs it (F21.R1, job-lease.ts).
  const run = () => { void runIf().catch(() => false).then(ok => ok ? runOpsChecks(pool, o) : []).catch(() => log("Operations checks failed to run.")); };
  const first = setTimeout(run, 30_000);
  const timer = setInterval(run, everyMs);
  first.unref(); timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}

// ---- Plain text, for the `status` command -------------------------------------------------------------------------------------------

const size = (b: number): string => (b >= GIB ? `${(b / GIB).toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`);

export function formatHealth(h: HealthSummary): string[] {
  const out: string[] = [`System health at ${h.generatedAt}`, ""];
  const d = h.database;
  out.push(`Database      ${size(d.dataBytes)} data, ${size(d.logBytes)} log` + (d.limitBytes ? `; ${d.percent}% of the ${size(d.limitBytes)} limit (${d.edition ?? "unknown edition"}; alerts at ${d.warnAtPercent}% and ${d.criticalAtPercent}%)` : `; no size limit for ${d.edition ?? "this edition"}`));
  out.push(h.disk.readable ? `Disk          ${h.disk.volumes.map(v => `${v.mount} ${size(v.freeBytes)} free of ${size(v.totalBytes)} (${v.freePercent}%)`).join("; ") || "no volumes reported"}` : "Disk          unknown (the database account may not read volume statistics)");
  out.push(!h.backup.readable ? "Backup        unknown (msdb is not readable by the database account)" : h.backup.ageHours === null ? "Backup        none recorded" : `Backup        last finished ${h.backup.ageHours} hours ago (alert after ${h.backup.maxHours})`);
  out.push(`Certificates  CA ${h.certificates.ca ? `expires ${h.certificates.ca.notAfter} (${h.certificates.ca.daysLeft} days)` : "unknown"}; next cabinet certificate ${h.certificates.nextCabinetCertificateNotAfter ?? "none"}`);
  out.push(`Audit chain   last verified ${h.auditChain.lastVerifiedAt ?? "never"}${h.auditChain.lastRun && !h.auditChain.lastRun.ok ? "; THE LAST CHECK FOUND A BREAK" : ""}`);
  out.push(`Retention     last run ${h.retention.lastRunAt ?? "never"}`);
  out.push(`Cabinets      ${h.cabinets.online} online, ${h.cabinets.offline} offline`);
  out.push("", "Counters (last 24 hours / last 7 days; the g_ rows are highest values in milliseconds)");
  if (h.counters.length === 0) out.push("  none yet");
  for (const c of h.counters) out.push(`  ${c.kind.padEnd(20)} ${c.code.padEnd(48)} ${String(c.last24h).padStart(10)} ${String(c.last7d).padStart(10)}`);
  out.push("", h.alerts.length ? `Open operations alerts (${h.alerts.length})` : "No open operations alerts.");
  for (const a of h.alerts) out.push(`  [${a.kind}] ${a.title} (${a.occurrences}x, since ${a.firstSeen})`);
  return out;
}
