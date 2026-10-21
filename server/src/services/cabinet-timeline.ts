// One history per cabinet (docs/spec/15-baselines-and-config.md): health transitions, configuration changes, alerts, boots and the changes
// people made through the platform, newest first. Entries close to the start of the problem are marked "shortly before", which
// is all that can honestly be said: nothing here says one thing caused another. (The "What changed" tab answers a different question,
// from the events and updates Windows logged; this is the configuration the agent reported.)
import type { Queryable } from "../db/db.js";

export interface TimelineEntry {
  at: string; kind: "health" | "change" | "alert" | "boot" | "platform"; title: string; detail: string | null;
  /** For a configuration change: the window it is known to have happened in. */
  window: { notBefore: string | null; observedAt: string } | null; exactAt: string | null;
  viaPlatform?: boolean; violatesBaseline?: boolean; nearProblem: boolean; ref?: Record<string, unknown>;
}

export const NEAR_MINUTES = 60;
/** The operations that change a cabinet's configuration, as the history lists them when people ran them. */
const PLATFORM_OPERATIONS = ["network.setIp", "network.setDns", "network.renewLease", "firewall.setProfile", "firewall.applyPolicy", "firewall.setRule", "firewall.restore",
  "service.control", "service.setStartType", "time.setZone", "time.sync", "package.install", "driver.uninstall", "updates.uninstall"];

const show = (v: unknown) => v === null || v === undefined ? "none" : Array.isArray(v) ? v.join(", ") || "none" : String(v);
const describe = (fields: Record<string, { before: unknown; after: unknown }>) => Object.entries(fields).slice(0, 4)
  .map(([f, v]) => `${f}: ${show(v.before)} → ${show(v.after)}`).join("; ");

export async function timelineFor(db: Queryable, cabinetId: string, o: { days: number; q?: string | undefined; limit: number }): Promise<{ problemStartedBetween: { from: string | null; to: string } | null; entries: TimelineEntry[] }> {
  const health = (await db.query<{ state: string; degraded_since: Date | null; last_healthy_at: Date | null }>("SELECT state, degraded_since, last_healthy_at FROM cabinet_health WHERE cabinet_id = $1", [cabinetId])).rows[0];
  const problem = health?.degraded_since ?? null;
  const near = (from: Date, to: Date = from) => problem !== null && to.getTime() >= problem.getTime() - NEAR_MINUTES * 60_000 && from.getTime() <= problem.getTime();
  const days = Math.max(1, Math.min(90, Math.floor(o.days)));
  const entries: TimelineEntry[] = [];

  for (const r of (await db.query<{ at: Date; from_state: string | null; to_state: string; reasons: { text: string }[] }>(
    "SELECT TOP (100) [at], from_state, to_state, reasons FROM health_transitions WHERE cabinet_id = $1 AND [at] > DATEADD(day, -$2, SYSUTCDATETIME()) ORDER BY [at] DESC", [cabinetId, days])).rows)
    entries.push({ at: r.at.toISOString(), kind: "health", title: r.to_state === "healthy" ? "Cabinet healthy" : r.to_state === "degraded" ? "Cabinet degraded" : r.to_state === "offline" ? "Cabinet lost contact" : "Health unknown",
      detail: r.reasons.map(x => x.text).slice(0, 3).join(" ") || null, window: null, exactAt: null, nearProblem: false });

  for (const r of (await db.query<{ category: string; item_key: string; change: string; fields: Record<string, { before: unknown; after: unknown }>; not_before: Date | null; observed_at: Date; exact_at: Date | null; via_platform: boolean; violates_baseline: boolean }>(
    `SELECT TOP (400) category, item_key, change, fields, not_before, observed_at, exact_at, via_platform, violates_baseline FROM config_changes
      WHERE cabinet_id = $1 AND observed_at > DATEADD(day, -$2, SYSUTCDATETIME()) ORDER BY observed_at DESC`, [cabinetId, days])).rows)
    entries.push({ at: (r.exact_at ?? r.observed_at).toISOString(), kind: "change", title: `${r.category}: ${r.item_key} ${r.change}`, detail: describe(r.fields),
      window: { notBefore: r.not_before?.toISOString() ?? null, observedAt: r.observed_at.toISOString() }, exactAt: r.exact_at?.toISOString() ?? null, viaPlatform: r.via_platform, violatesBaseline: r.violates_baseline,
      nearProblem: near(r.exact_at ?? r.not_before ?? r.observed_at, r.exact_at ?? r.observed_at), ref: { category: r.category, itemKey: r.item_key } });

  for (const r of (await db.query<{ id: string; title: string; severity: string; first_seen: Date; scope: string; state: string }>(
    `SELECT TOP (100) id, CAST(title AS nvarchar(300)) AS title, severity, first_seen, scope, state FROM alerts
      WHERE cabinet_id = $1 AND first_seen > DATEADD(day, -$2, SYSUTCDATETIME()) ORDER BY first_seen DESC`, [cabinetId, days])).rows)
    entries.push({ at: r.first_seen.toISOString(), kind: "alert", title: `Alert: ${r.title}`, detail: `${r.severity}${r.scope === "cabinet" ? ", cabinet alert" : ""}, ${r.state}`, window: null, exactAt: null, nearProblem: near(r.first_seen), ref: { alertId: r.id } });

  for (const r of (await db.query<{ booted_at: Date }>("SELECT TOP (50) booted_at FROM cabinet_boots WHERE cabinet_id = $1 AND booted_at > DATEADD(day, -$2, SYSUTCDATETIME()) ORDER BY booted_at DESC", [cabinetId, days])).rows)
    entries.push({ at: r.booted_at.toISOString(), kind: "boot", title: "Windows started", detail: null, window: null, exactAt: null, nearProblem: near(r.booted_at) });

  for (const r of (await db.query<{ operation: string; result_at: Date; name: string }>(
    `SELECT TOP (100) c.operation, c.result_at, u.name FROM commands c JOIN users u ON u.id = c.issued_by
      WHERE c.cabinet_id = $1 AND c.result_at > DATEADD(day, -$2, SYSUTCDATETIME()) AND c.status = 'succeeded' AND c.operation IN (SELECT value FROM OPENJSON($3))
      ORDER BY c.result_at DESC`, [cabinetId, days, PLATFORM_OPERATIONS])).rows)
    entries.push({ at: r.result_at.toISOString(), kind: "platform", title: `Made through the platform: ${r.operation}`, detail: `By ${r.name}.`, window: null, exactAt: null, nearProblem: near(r.result_at) });

  const q = o.q?.trim().toLowerCase();
  const shown = entries.filter(e => !q || `${e.title} ${e.detail ?? ""}`.toLowerCase().includes(q)).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, o.limit);
  return { problemStartedBetween: problem ? { from: health?.last_healthy_at?.toISOString() ?? null, to: problem.toISOString() } : null, entries: shown };
}
