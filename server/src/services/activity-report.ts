// What a person did on cabinets, written as case notes to paste into a ticket: the changes they made, what they checked, the alerts they
// resolved and the fixes they saved. Nothing else: no page views, no log contents, no raw parameters. Always the caller's own activity.
import { audit, type Pool } from "../db/db.js";
import type { SessionUser } from "../auth/sessions.js";

type Row = { cabinet_id: string; cabinet: string; site: string; client: string; operation: string; params: Record<string, unknown>; status: string; issued_at: Date; error_code: string | null };

/** Reads that tell the story: grouped under one plain name each, so five event-log queries are one line. */
const CHECKED: Record<string, string> = {
  "system.info": "System information", "system.performance": "Performance", "processes.list": "Processes", "services.list": "Services",
  "eventlog.channels": "Event logs", "eventlog.query": "Event logs", "eventlog.get": "Event logs",
  "network.config": "Network adapters", "network.test": "Network tests", "network.trace": "Network path", "database.connectivity": "Database check", "network.listeners": "Listening ports", "system.security": "Security status", "system.hardware": "Hardware", "system.identity": "Identity and policy", "network.hosts": "Hosts file", "software.list": "Installed software", "startup.list": "Startup and tasks", "sessions.list": "Signed-in sessions", "shares.list": "Network shares", "reliability.list": "Reliability history", "disk.folders": "Folder sizes", "dns.cache": "DNS cache", "system.checkHealth": "Windows health check", "power.status": "Power settings", "usb.ports": "USB ports",
  "firewall.state": "Firewall", "disk.smart": "Drive health", "updates.status": "Windows updates", "devices.list": "Devices", "drivers.list": "Drivers",
  "peripheral.status": "Fingerprint scanner", "time.status": "Time", "files.list": "Files",
};

const clip = (s: unknown, n = 80) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n);
const on = (v: unknown) => (v === true || v === "on" ? "on" : "off");

/** One plain sentence per change. Only fields the contracts allow are read; anything unexpected is left out rather than printed. */
export function describeChange(operation: string, p: Record<string, unknown>, packageName?: string): string {
  switch (operation) {
    case "firewall.setProfile": return `Turned the ${clip(p.profile, 12)} firewall profile ${p.enabled === undefined ? clip(p.state, 4) : on(p.enabled)}${p.durationMinutes ? ` for ${Number(p.durationMinutes)} minutes` : ""}`;
    case "firewall.applyPolicy": return "Applied the firewall policy";
    case "firewall.setRule": return `${clip(p.mode, 10) === "create" ? "Added" : clip(p.mode, 10) === "delete" ? "Deleted" : "Changed"} firewall rule ${clip((p.rule as { name?: unknown } | undefined)?.name ?? p.name)}`;
    case "firewall.restore": return "Restored a saved firewall snapshot";
    case "network.setIp": return p.mode === "dhcp" ? "Set the adapter to DHCP" : `Set a fixed address ${clip(p.address, 15)}/${Number(p.prefixLength)}${p.gateway === undefined ? " with no gateway" : ` with gateway ${clip(p.gateway, 15)}`}`;
    case "network.setDns": return p.mode === "automatic" ? "Set DNS to automatic" : `Set DNS servers to ${Array.isArray(p.servers) ? p.servers.map(s => clip(s, 15)).join(", ") : "?"}`;
    case "network.renewLease": return p.release === true ? "Released and renewed the DHCP lease" : "Renewed the DHCP lease";
    case "system.restart": return p.mode === "cancel" ? "Cancelled a waiting restart or shutdown" : `${p.mode === "shutdown" ? "Shut the cabinet down" : "Restarted the cabinet"}${p.delaySeconds ? ` in ${Number(p.delaySeconds)} seconds` : " now"}`;
    case "process.end": return `Ended process ${clip(p.name, 64)} (ID ${Number(p.processId)})`;
    case "power.set": return `Turned ${p.setting === "fast_startup" ? "Fast Startup" : "USB selective suspend"} ${on(p.enabled)}`;
    case "network.flushDns": return "Flushed the DNS cache";
    case "service.setStartType": return `Set service ${clip(p.name, 64)} to ${clip(p.startType, 20).replace("_", " ")}`;
    case "service.control": return `${clip(p.action, 10)[0]?.toUpperCase() ?? ""}${clip(p.action, 10).slice(1)} service ${clip(p.name, 64)}`;
    case "time.setZone": return `Set the time zone to ${clip(p.timeZoneId, 48)}`;
    case "time.sync": return "Synced the clock";
    case "package.install": return `Installed package ${packageName ?? "from the software library"}`;
    case "driver.uninstall": return `Uninstalled driver ${clip(p.publishedName, 16)}`;
    case "updates.uninstall": return `Rolled back Windows update ${clip(p.kb, 12)}`;
    default: return operation;
  }
}

const OUTCOME: Record<string, string> = { succeeded: "done", failed: "failed", rejected: "refused by the cabinet", expired: "no answer from the cabinet", queued: "not delivered", delivered: "no result yet" };

const hhmm = (d: Date) => d.toISOString().slice(11, 16);

export interface ActivityReport { text: string; changes: number; checks: number; alerts: number; fixes: number; from: string; to: string }

export async function activityReport(pool: Pool, user: SessionUser, q: { cabinetId?: string; hours: number }, now = new Date()): Promise<ActivityReport> {
  const from = new Date(now.getTime() - q.hours * 3_600_000);
  const scope = q.cabinetId ? "AND c.cabinet_id = $4" : "";
  const params: unknown[] = [user.userId, from, now, ...(q.cabinetId ? [q.cabinetId] : [])];
  const commands = (await pool.query<Row>(
    `SELECT TOP (5000) c.cabinet_id, k.name AS cabinet, s.name AS site, cl.name AS client, c.operation, c.params, c.status, c.issued_at, JSON_VALUE(c.result, '$.error.code') AS error_code
       FROM commands c JOIN cabinets k ON k.id = c.cabinet_id JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id
      WHERE c.issued_by = $1 AND c.issued_at >= $2 AND c.issued_at <= $3 ${scope} ORDER BY c.issued_at`, params)).rows;
  // Only well-formed GUIDs go to the database (a command's parameters are checked when it is issued, but this is the last line of defence).
  const packageIds = [...new Set(commands.filter(c => c.operation === "package.install").map(c => String(c.params.packageId ?? "").toLowerCase()))]
    .filter(x => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x));
  const packages = new Map<string, string>();
  if (packageIds.length) for (const r of (await pool.query<{ id: string; name: string; version: string }>("SELECT id, name, version FROM packages WHERE id IN (SELECT CAST([value] AS uniqueidentifier) FROM OPENJSON($1))", [packageIds])).rows) packages.set(r.id, clip(`${r.name} ${r.version}`, 200));
  const alerts = (await pool.query<{ cabinet_id: string; cabinet: string; title: string; resolution: string | null; at: Date; kind: string }>(
    `SELECT a.cabinet_id, k.name AS cabinet, a.title, a.resolution, COALESCE(a.resolved_at, a.claimed_at) AS [at], CASE WHEN a.resolved_by = $1 THEN 'resolved' ELSE 'claimed' END AS kind
       FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id
      WHERE ((a.resolved_by = $1 AND a.resolved_at BETWEEN $2 AND $3) OR (a.claimed_by = $1 AND a.state = 'claimed' AND a.claimed_at BETWEEN $2 AND $3)) ${q.cabinetId ? "AND a.cabinet_id = $4" : ""}
      ORDER BY [at]`, params)).rows;
  const fixes = (await pool.query<{ title: string; solution: string; status: string; at: Date; cabinet_id: string | null; cabinet: string | null }>(
    `SELECT f.title, f.solution, f.status, f.created_at AS [at], f.cabinet_id, k.name AS cabinet FROM known_fixes f LEFT JOIN cabinets k ON k.id = f.cabinet_id
      WHERE f.created_by = $1 AND f.created_at BETWEEN $2 AND $3 AND f.removed_at IS NULL ${q.cabinetId ? "AND f.cabinet_id = $4" : ""} ORDER BY f.created_at`, params)).rows;

  const writes = commands.filter(c => !(c.operation in CHECKED));
  const reads = commands.filter(c => c.operation in CHECKED);
  const byCabinet = new Map<string, { name: string; place: string }>();
  for (const c of commands) byCabinet.set(c.cabinet_id, { name: c.cabinet, place: `${c.client} / ${c.site}` });
  for (const a of alerts) if (!byCabinet.has(a.cabinet_id)) byCabinet.set(a.cabinet_id, { name: a.cabinet, place: "" });

  const lines: string[] = [`Case notes by ${clip(user.name, 80)}, ${from.toISOString().slice(0, 16).replace("T", " ")} to ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`];
  if (byCabinet.size === 0 && fixes.length === 0) lines.push("", "Nothing was done in this period.");
  for (const [id, cab] of byCabinet) {
    lines.push("", `${clip(cab.name, 128)}${cab.place ? ` (${clip(cab.place, 260)})` : ""}`);
    const checked = [...new Set(reads.filter(c => c.cabinet_id === id).map(c => CHECKED[c.operation]!))];
    if (checked.length) lines.push(`  Checked: ${checked.join(", ")}`);
    const changes = writes.filter(c => c.cabinet_id === id);
    if (changes.length) {
      lines.push("  Changes:");
      for (const c of changes) lines.push(`  - ${hhmm(c.issued_at)} ${describeChange(c.operation, c.params, packages.get(String(c.params.packageId ?? "").toLowerCase()))}: ${OUTCOME[c.status] ?? c.status}${c.status === "failed" && c.error_code ? ` (${clip(c.error_code, 40)})` : ""}`);
    }
    for (const a of alerts.filter(x => x.cabinet_id === id)) lines.push(`  ${a.kind === "resolved" ? "Resolved" : "Working on"} alert: ${clip(a.title, 120)}${a.resolution ? ` (${clip(a.resolution, 400)})` : ""}`);
    for (const f of fixes.filter(x => x.cabinet_id === id)) lines.push(`  Saved fix: ${clip(f.title, 120)}: ${clip(f.solution, 400)}${f.status === "pending" ? " (waiting for approval)" : ""}`);
  }
  const loose = fixes.filter(f => !f.cabinet_id);
  for (const f of loose) lines.push("", `Saved fix: ${clip(f.title, 120)}: ${clip(f.solution, 400)}`);
  const report = { text: lines.join("\n"), changes: writes.length, checks: new Set(reads.map(c => CHECKED[c.operation])).size, alerts: alerts.length, fixes: fixes.length, from: from.toISOString(), to: now.toISOString() };
  await audit(pool, { actorKind: "user", actorId: user.userId, action: "report.activity", ...(q.cabinetId ? { targetKind: "cabinet" as const, targetId: q.cabinetId } : {}), outcome: "succeeded", details: { hours: q.hours, changes: report.changes } });
  return report;
}
