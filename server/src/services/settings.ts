// Console-managed settings: the scanner's hardware IDs (fleet and per cabinet) and each
// site's sync cabinet. Each change needs its step-up token and is audited with the action.
import { audit, lock, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { Refused } from "./errors.js";

/**
 * Writes one row of the settings table: replaces the value when the key exists, adds the row when it does not. Call it inside a
 * transaction: the key is locked by name until the transaction ends, so two writers of the same key cannot both insert it.
 */
export async function upsertSetting(db: Queryable, key: string, value: unknown, changedBy: string | null): Promise<void> {
  await lock(db, `settings:${key}`);
  const text = safeJson(value);
  await db.query("UPDATE settings SET [value] = $2, changed_by = $3, changed_at = SYSUTCDATETIME() WHERE [key] = $1", [key, text, changedBy]);
  // One statement decides and inserts, so a row cannot appear between the update and the insert.
  await db.query("INSERT INTO settings ([key], [value], changed_by) SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM settings WHERE [key] = $1)", [key, text, changedBy]);
}

/** A JSON column read under an alias the data layer does not know (it parses only the columns named in json-columns.ts): text in, value out. */
export function parseJson<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v as T;
  try { return JSON.parse(v) as T; } catch { return null; }
}

export async function setFleetScanner(pool: Pool, userId: string, ids: string[] | null, stepUpToken?: string): Promise<void> {
  await transaction(pool, async c => {
    if (stepUpToken) await consumeStepUpToken(c, stepUpToken, userId, "settings.scanner", "fleet");
    if (ids === null) await c.query("DELETE FROM settings WHERE [key] = 'scanner.hardwareIds'");
    else await upsertSetting(c, "scanner.hardwareIds", ids, userId);
    await audit(c, { actorKind: "user", actorId: userId, action: "settings.scanner", outcome: "succeeded", details: { hardwareIds: ids } });
  });
}

export async function setCabinetScanner(pool: Pool, userId: string, cabinetId: string, ids: string[] | null, stepUpToken?: string): Promise<void> {
  await transaction(pool, async c => {
    if (stepUpToken) await consumeStepUpToken(c, stepUpToken, userId, "cabinet.scanner", cabinetId);
    const r = await c.query("UPDATE cabinets SET scanner_hardware_ids = $2 WHERE id = $1 AND status <> 'removed'", [cabinetId, ids === null ? null : safeJson(ids)]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such cabinet");
    await audit(c, { actorKind: "user", actorId: userId, action: "cabinet.scanner", targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded", details: { hardwareIds: ids } });
  });
}

/** The server accepts only private IPv4 addresses for a sync cabinet; each cabinet also checks the address is on its own network. */
export function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** A site's sync cabinet address, and its own ports (null: use the client's, else the fleet's). */
export async function setSiteSync(pool: Pool, userId: string, siteId: string, address: string | null, ports: number[] | null, stepUpToken: string): Promise<void> {
  if (address !== null && !isPrivateIpv4(address)) throw new Refused("invalid_address", 400, "the sync cabinet must have a private IPv4 address");
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, userId, "site.sync", siteId);
    const r = await c.query("UPDATE sites SET sync_address = $2, sync_ports = $3 WHERE id = $1", [siteId, address, ports]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such site");
    await audit(c, { actorKind: "user", actorId: userId, action: "site.sync", targetKind: "site", targetId: siteId, outcome: "succeeded", details: { address, ports } });
  });
}

// ---- Platform settings (docs/spec/06-console-spec.md "Settings") ---------------------------

export interface PlatformSettings {
  offlineAlertDays: number;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  retention: { eventsDays: number; commandsDays: number; alertsDays: number; firewallDays: number; diagnosesDays: number; bootsDays: number; jobsDays: number };
  /** How the agents pace themselves (see AgentPacing); the heartbeat answer carries these. */
  agents: AgentPacing;
}

export const DEFAULT_SETTINGS: PlatformSettings = {
  offlineAlertDays: 5, sessionIdleMinutes: 30, sessionAbsoluteHours: 12,
  retention: { eventsDays: 90, commandsDays: 90, alertsDays: 365, firewallDays: 365, diagnosesDays: 30, bootsDays: 365, jobsDays: 365 },
  agents: { heartbeatSeconds: 300, pollSeconds: 25, eventsPaceMs: 2_000 },
};

/** Each setting's key in the settings table, with the range it must be in (the console contract checks the same ranges). */
const KEYS = {
  offlineAlertDays: ["alerts.offlineDays", 1, 90], sessionIdleMinutes: ["sessions.idleMinutes", 5, 240], sessionAbsoluteHours: ["sessions.absoluteHours", 1, 24],
  eventsDays: ["retention.eventsDays", 7, 3650], commandsDays: ["retention.commandsDays", 7, 3650], alertsDays: ["retention.alertsDays", 30, 3650],
  firewallDays: ["retention.firewallDays", 30, 3650], diagnosesDays: ["retention.diagnosesDays", 7, 365], bootsDays: ["retention.bootsDays", 30, 3650],
  jobsDays: ["retention.jobsDays", 30, 3650],
} as const;

export async function platformSettings(db: Queryable): Promise<PlatformSettings> {
  const rows = new Map((await db.query<{ key: string; value: unknown }>(
    "SELECT [key], [value] FROM settings WHERE [key] LIKE 'alerts.%' OR [key] LIKE 'sessions.%' OR [key] LIKE 'retention.%' OR [key] LIKE 'agents.%'")).rows.map(r => [r.key, r.value]));
  const num = (name: keyof typeof KEYS, fallback: number): number => {
    const [key, min, max] = KEYS[name];
    const v = rows.get(key);
    return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
  };
  const d = DEFAULT_SETTINGS;
  return {
    offlineAlertDays: num("offlineAlertDays", d.offlineAlertDays), sessionIdleMinutes: num("sessionIdleMinutes", d.sessionIdleMinutes),
    sessionAbsoluteHours: num("sessionAbsoluteHours", d.sessionAbsoluteHours),
    retention: { eventsDays: num("eventsDays", d.retention.eventsDays), commandsDays: num("commandsDays", d.retention.commandsDays),
      alertsDays: num("alertsDays", d.retention.alertsDays), firewallDays: num("firewallDays", d.retention.firewallDays),
      diagnosesDays: num("diagnosesDays", d.retention.diagnosesDays), bootsDays: num("bootsDays", d.retention.bootsDays), jobsDays: num("jobsDays", d.retention.jobsDays) },
    agents: pacingFrom(rows),
  };
}

/** The settings, read at most every few seconds: they are checked on every request (session timeouts). */
export class SettingsCache {
  private value: PlatformSettings | null = null;
  private at = 0;
  constructor(private readonly db: Queryable, private readonly ttlMs = 5_000) {}
  async get(): Promise<PlatformSettings> {
    if (!this.value || Date.now() - this.at > this.ttlMs) { this.value = await platformSettings(this.db); this.at = Date.now(); }
    return this.value;
  }
  invalidate(): void { this.value = null; }
}

// ---- Agent pacing (docs/spec/03-protocol.md "Protocol 1.1": server-directed intervals) ------

export interface AgentPacing { heartbeatSeconds: number; pollSeconds: number; eventsPaceMs: number }

export const DEFAULT_PACING: AgentPacing = { heartbeatSeconds: 300, pollSeconds: 25, eventsPaceMs: 2_000 };

/** Each pacing setting's key, with the range the heartbeat-response contract allows. */
const PACING_KEYS = {
  heartbeatSeconds: ["agents.heartbeatSeconds", 60, 900], pollSeconds: ["agents.pollSeconds", 15, 110], eventsPaceMs: ["agents.eventsPaceMs", 0, 60_000],
} as const;

/** The pacing from the settings rows: a whole number is clamped to the contract's range; anything else falls back to the default. */
function pacingFrom(rows: Map<string, unknown>): AgentPacing {
  const num = (name: keyof AgentPacing): number => {
    const [key, min, max] = PACING_KEYS[name];
    const v = rows.get(key);
    return typeof v === "number" && Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : DEFAULT_PACING[name];
  };
  return { heartbeatSeconds: num("heartbeatSeconds"), pollSeconds: num("pollSeconds"), eventsPaceMs: num("eventsPaceMs") };
}

/** The pacing the heartbeat answer carries: the settings table's values (clamped to the allowed ranges), else the defaults. */
export async function agentPacing(db: Queryable): Promise<AgentPacing> {
  return pacingFrom(new Map((await db.query<{ key: string; value: unknown }>("SELECT [key], [value] FROM settings WHERE [key] LIKE 'agents.%'")).rows.map(r => [r.key, r.value])));
}

/** Pacing read at most once a minute per process (every heartbeat answer carries it); the defaults while the database cannot answer. */
export class PacingCache {
  private value: AgentPacing = DEFAULT_PACING;
  private at = 0;
  private loading: Promise<void> | null = null;
  constructor(private readonly db: Queryable, private readonly ttlMs = 60_000) {}
  /** Never waits for the database once a value is known: a stale value is refreshed in the background. */
  async get(): Promise<AgentPacing> {
    if (Date.now() - this.at > this.ttlMs && !this.loading) {
      this.loading = agentPacing(this.db).then(v => { this.value = v; }, () => undefined).finally(() => { this.at = Date.now(); this.loading = null; });
      if (this.at === 0) await this.loading;
    }
    return this.value;
  }
}

export interface SettingsChange {
  offlineAlertDays?: number; sessionIdleMinutes?: number; sessionAbsoluteHours?: number;
  retention?: Partial<PlatformSettings["retention"]>;
  agents?: Partial<AgentPacing>;
}

export async function updatePlatformSettings(pool: Pool, adminId: string, change: SettingsChange, stepUpToken: string): Promise<PlatformSettings> {
  return transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "settings.update", "fleet");
    const before = await platformSettings(c);
    const writes: [string, unknown][] = [];
    for (const name of ["offlineAlertDays", "sessionIdleMinutes", "sessionAbsoluteHours"] as const)
      if (change[name] !== undefined) writes.push([KEYS[name][0], change[name]]);
    for (const name of ["eventsDays", "commandsDays", "alertsDays", "firewallDays", "diagnosesDays", "bootsDays", "jobsDays"] as const)
      if (change.retention?.[name] !== undefined) writes.push([KEYS[name][0], change.retention[name]]);
    for (const name of ["heartbeatSeconds", "pollSeconds", "eventsPaceMs"] as const) {
      const [key, min, max] = PACING_KEYS[name];
      const v = change.agents?.[name];
      if (v !== undefined) writes.push([key, Math.min(max, Math.max(min, v))]);
    }
    for (const [key, value] of writes) await upsertSetting(c, key, value, adminId);
    const after = await platformSettings(c);
    await audit(c, { actorKind: "user", actorId: adminId, action: "settings.update", outcome: "succeeded", details: { before, after } });
    return after;
  });
}
