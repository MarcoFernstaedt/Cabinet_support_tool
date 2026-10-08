// Console-managed settings: the scanner's hardware IDs (fleet and per cabinet) and each
// site's sync cabinet. Each change needs its step-up token and is audited with the action.
import type pg from "pg";
import { audit, safeJson, transaction, type Queryable } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { Refused } from "./errors.js";

export async function setFleetScanner(pool: pg.Pool, userId: string, ids: string[] | null, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, userId, "settings.scanner", "fleet");
    if (ids === null) await c.query("DELETE FROM settings WHERE key = 'scanner.hardwareIds'");
    else await c.query(`INSERT INTO settings (key, value, changed_by) VALUES ('scanner.hardwareIds', $1, $2)
                        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, changed_by = EXCLUDED.changed_by, changed_at = now()`, [safeJson(ids), userId]);
    await audit(c, { actorKind: "user", actorId: userId, action: "settings.scanner", outcome: "succeeded", details: { hardwareIds: ids } });
  });
}

export async function setCabinetScanner(pool: pg.Pool, userId: string, cabinetId: string, ids: string[] | null, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, userId, "cabinet.scanner", cabinetId);
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
export async function setSiteSync(pool: pg.Pool, userId: string, siteId: string, address: string | null, ports: number[] | null, stepUpToken: string): Promise<void> {
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
  requireTotpForAll: boolean;
  retention: { eventsDays: number; commandsDays: number; alertsDays: number; firewallDays: number };
}

export const DEFAULT_SETTINGS: PlatformSettings = {
  offlineAlertDays: 5, sessionIdleMinutes: 30, sessionAbsoluteHours: 12, requireTotpForAll: false,
  retention: { eventsDays: 90, commandsDays: 90, alertsDays: 365, firewallDays: 365 },
};

/** Each setting's key in the settings table, with the range it must be in (the console contract checks the same ranges). */
const KEYS = {
  offlineAlertDays: ["alerts.offlineDays", 1, 90], sessionIdleMinutes: ["sessions.idleMinutes", 5, 240], sessionAbsoluteHours: ["sessions.absoluteHours", 1, 24],
  eventsDays: ["retention.eventsDays", 7, 3650], commandsDays: ["retention.commandsDays", 7, 3650], alertsDays: ["retention.alertsDays", 30, 3650],
  firewallDays: ["retention.firewallDays", 30, 3650],
} as const;

export async function platformSettings(db: Queryable): Promise<PlatformSettings> {
  const rows = new Map((await db.query<{ key: string; value: unknown }>("SELECT key, value FROM settings WHERE key LIKE ANY ($1)",
    [["alerts.%", "sessions.%", "retention.%", "accounts.%"]])).rows.map(r => [r.key, r.value]));
  const num = (name: keyof typeof KEYS, fallback: number): number => {
    const [key, min, max] = KEYS[name];
    const v = rows.get(key);
    return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
  };
  const d = DEFAULT_SETTINGS;
  return {
    offlineAlertDays: num("offlineAlertDays", d.offlineAlertDays), sessionIdleMinutes: num("sessionIdleMinutes", d.sessionIdleMinutes),
    sessionAbsoluteHours: num("sessionAbsoluteHours", d.sessionAbsoluteHours), requireTotpForAll: rows.get("accounts.requireTotp") === true,
    retention: { eventsDays: num("eventsDays", d.retention.eventsDays), commandsDays: num("commandsDays", d.retention.commandsDays),
      alertsDays: num("alertsDays", d.retention.alertsDays), firewallDays: num("firewallDays", d.retention.firewallDays) },
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

export interface SettingsChange {
  offlineAlertDays?: number; sessionIdleMinutes?: number; sessionAbsoluteHours?: number; requireTotpForAll?: boolean;
  retention?: Partial<PlatformSettings["retention"]>;
}

export async function updatePlatformSettings(pool: pg.Pool, adminId: string, change: SettingsChange, stepUpToken: string): Promise<PlatformSettings> {
  return transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "settings.update", "fleet");
    const before = await platformSettings(c);
    const writes: [string, unknown][] = [];
    for (const name of ["offlineAlertDays", "sessionIdleMinutes", "sessionAbsoluteHours"] as const)
      if (change[name] !== undefined) writes.push([KEYS[name][0], change[name]]);
    for (const name of ["eventsDays", "commandsDays", "alertsDays", "firewallDays"] as const)
      if (change.retention?.[name] !== undefined) writes.push([KEYS[name][0], change.retention[name]]);
    if (change.requireTotpForAll !== undefined) writes.push(["accounts.requireTotp", change.requireTotpForAll]);
    for (const [key, value] of writes)
      await c.query(`INSERT INTO settings (key, value, changed_by) VALUES ($1, $2, $3)
                     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, changed_by = EXCLUDED.changed_by, changed_at = now()`, [key, safeJson(value), adminId]);
    const after = await platformSettings(c);
    await audit(c, { actorKind: "user", actorId: adminId, action: "settings.update", outcome: "succeeded", details: { before, after } });
    return after;
  });
}
