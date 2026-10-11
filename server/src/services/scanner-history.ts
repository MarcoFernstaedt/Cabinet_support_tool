// How a cabinet's fingerprint scanner has behaved lately, and what changed on the cabinet just before it started: the scanner's own
// disconnects and recoveries from the events the agent sent, and any driver installed (or Windows update applied) in the 72 hours
// before the first drop in the last day. It lists what happened in order and says what is worth checking first; it does not claim a cause.
import type { Queryable } from "../db/db.js";
import { categorize, changeKey } from "./crashes.js";

const HOUR = 3_600_000;
const BEFORE_HOURS = 72;

export interface ScannerEpisode { at: string; state: "disconnected" | "recovered" | "device_error" | "driver_missing" }
export interface ScannerChange { at: string; kind: "driver" | "update"; title: string; relatedToScanner: boolean; hoursBeforeFirstDrop: number }
export interface ScannerHistory {
  now: string; drops24h: number; drops7d: number; episodes: ScannerEpisode[]; offNow: boolean; firstDropAt: string | null; changes: ScannerChange[]; lead: string | null;
}

type Row = { occurred_at: Date; kind: string; source: { log: string; source: string; eventId: number } | null; message: string; device: { hardwareIds?: string[]; state?: string; name?: string } | null };

const DROPS = new Set(["disconnected", "device_error", "driver_missing"]);

export async function scannerHistory(db: Queryable, cabinetId: string, now = new Date()): Promise<ScannerHistory> {
  const from = new Date(now.getTime() - (7 * 24 + BEFORE_HOURS) * HOUR);
  const rows = (await db.query<Row>(
    `SELECT occurred_at, kind, source, COALESCE(detail->>'message', '') AS message, device FROM events
      WHERE cabinet_id = $1 AND occurred_at BETWEEN $2 AND $3 AND (kind = 'scanner' OR kind = 'change') ORDER BY occurred_at`, [cabinetId, from, now])).rows;

  const scannerEvents = rows.filter(r => r.kind === "scanner" && r.device?.state);
  const episodes: ScannerEpisode[] = scannerEvents.filter(r => r.occurred_at >= new Date(now.getTime() - 7 * 24 * HOUR))
    .map(r => ({ at: r.occurred_at.toISOString(), state: r.device!.state as ScannerEpisode["state"] }));
  const drops = episodes.filter(e => DROPS.has(e.state));
  const dayAgo = now.getTime() - 24 * HOUR;
  const drops24h = drops.filter(d => new Date(d.at).getTime() >= dayAgo);
  const last = episodes[episodes.length - 1];
  const first = drops24h[0] ?? null;
  const firstAt = first ? new Date(first.at) : null;

  const ids = new Set(scannerEvents.flatMap(r => r.device?.hardwareIds ?? []).map(h => h.toLowerCase()));
  const names = scannerEvents.map(r => r.device?.name?.toLowerCase()).filter((n): n is string => !!n);
  const mentionsScanner = (text: string) => {
    const t = text.toLowerCase();
    return [...ids].some(i => t.includes(i.split("&")[0]!)) || names.some(n => t.includes(n)) || t.includes("fingerprint") || t.includes("biometric");
  };

  const changes: ScannerChange[] = [];
  if (firstAt) for (const r of rows) {
    if (r.kind !== "change" || r.occurred_at >= firstAt || firstAt.getTime() - r.occurred_at.getTime() > BEFORE_HOURS * HOUR) continue;
    const c = categorize({ kind: r.kind, source: r.source, message: r.message, fields: null });
    if (c?.category !== "driver_installed" && c?.category !== "update_installed") continue;
    changes.push({ at: r.occurred_at.toISOString(), kind: c.category === "driver_installed" ? "driver" : "update", title: changeKey(c.category, r.message),
      relatedToScanner: c.category === "driver_installed" && mentionsScanner(r.message), hoursBeforeFirstDrop: Math.round((firstAt.getTime() - r.occurred_at.getTime()) / HOUR * 10) / 10 });
  }

  let lead: string | null = null;
  if (first) {
    const driver = changes.filter(c => c.kind === "driver").sort((a, b) => a.hoursBeforeFirstDrop - b.hoursBeforeFirstDrop)[0];
    const times = drops24h.length === 1 ? "once" : `${drops24h.length} times`;
    if (driver) {
      const when = driver.hoursBeforeFirstDrop < 1 ? "less than an hour" : `about ${Math.round(driver.hoursBeforeFirstDrop)} hour${Math.round(driver.hoursBeforeFirstDrop) === 1 ? "" : "s"}`;
      lead = `The scanner has dropped off ${times} in the last 24 hours. ${driver.relatedToScanner ? "A driver for it" : "A driver"} (${(driver.title.startsWith("Driver ") ? driver.title.slice(7) : driver.title)}) was installed ${when} before the first drop. `
        + "That is the last change made on this cabinet before it started, so check it first. It may still be the cable or the port.";
    } else lead = `The scanner has dropped off ${times} in the last 24 hours, and nothing was installed on the cabinet in the 3 days before. Look at the cable, the USB port and power saving.`;
  }
  return { now: now.toISOString(), drops24h: drops24h.length, drops7d: drops.length, episodes, offNow: !!last && DROPS.has(last.state), firstDropAt: first?.at ?? null, changes, lead };
}
