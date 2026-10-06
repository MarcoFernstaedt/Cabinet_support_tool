// Console-managed settings: the scanner's hardware IDs (fleet and per cabinet) and each
// site's sync cabinet. Each change needs its step-up token and is audited with the action.
import type pg from "pg";
import { audit, safeJson, transaction } from "../db/db.js";
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

export async function setSiteSync(pool: pg.Pool, userId: string, siteId: string, address: string | null, ports: number[], stepUpToken: string): Promise<void> {
  if (address !== null && !isPrivateIpv4(address)) throw new Refused("invalid_address", 400, "the sync cabinet must have a private IPv4 address");
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, userId, "site.sync", siteId);
    const r = await c.query("UPDATE sites SET sync_address = $2, sync_ports = $3 WHERE id = $1", [siteId, address, ports]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such site");
    await audit(c, { actorKind: "user", actorId: userId, action: "site.sync", targetKind: "site", targetId: siteId, outcome: "succeeded", details: { address, ports } });
  });
}
