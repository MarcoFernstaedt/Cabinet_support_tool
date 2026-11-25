// Crash investigation (docs/spec/13-roadmap.md phase 2): boots and reboot loops, blue screens with their stop codes, a
// timeline of what changed on a cabinet before it crashed, and the fleet view of a crash incident that compares the
// cabinets that crashed with the ones that did not. Everything here reads what the agents already sent (their change,
// error and service events, and heartbeats), so it still works when the cabinets that crashed can no longer boot.
// Findings are correlations and are labelled so; nothing here claims a root cause. No regular expressions.
import type { Pool, Queryable } from "../db/db.js";
import { closeSignatureAlert, upsertAlert } from "./alerts.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";
import { ISSUE } from "./rules.js";
import { checkRetentionCutoff, inBatches, RETENTION_BATCH, type BatchOptions } from "../db/batches.js";

// ---- Boots and reboot loops ------------------------------------------------------------------------------------------

/** Windows starting: Kernel-General 12 (the clock time the OS started) and EventLog 6005 (the event log service started). */
export const isBootRecord = (source: string, eventId: number): boolean =>
  (source.toLowerCase() === "microsoft-windows-kernel-general" && eventId === 12) || (source.toLowerCase() === "eventlog" && eventId === 6005);

/** Boots within this many minutes of each other are the same boot (an event and a heartbeat estimate of it). */
const SAME_BOOT_MINUTES = 3;
export const LOOP_BOOTS = 3;
export const LOOP_WINDOW_MINUTES = 60;
/** Running this long without a restart ends a reboot loop. */
export const LOOP_RECOVERED_SECONDS = 2 * 3600;

/** Whether this heartbeat is the one on which the cabinet passed LOOP_RECOVERED_SECONDS of uptime (the first heartbeat known, or a new boot, counts). */
export const crossedRecovery = (uptimeSeconds: number, previousUptime: number | null, newBoot: boolean): boolean =>
  uptimeSeconds >= LOOP_RECOVERED_SECONDS && (previousUptime === null || newBoot || previousUptime < LOOP_RECOVERED_SECONDS);

export async function recordBoot(db: Queryable, cabinetId: string, at: Date, source: "heartbeat" | "event"): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO cabinet_boots (cabinet_id, booted_at, source)
     SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM cabinet_boots WITH (UPDLOCK, HOLDLOCK) WHERE cabinet_id = $1
       AND booted_at BETWEEN DATEADD(minute, -$4, $2) AND DATEADD(minute, $4, $2))`, [cabinetId, at, source, SAME_BOOT_MINUTES]);
  if ((r.rowCount ?? 0) > 0) await checkRebootLoop(db, cabinetId);
  return (r.rowCount ?? 0) > 0;
}

/** 3 or more boots within an hour, recently: a major alert, raised once and counted up while it lasts. */
export async function checkRebootLoop(db: Queryable, cabinetId: string): Promise<boolean> {
  const r = (await db.query<{ n: number; last_boot: Date | null }>(
    `SELECT COUNT(*) AS n, MAX(booted_at) AS last_boot FROM cabinet_boots
      WHERE cabinet_id = $1 AND booted_at > DATEADD(minute, -$2, SYSUTCDATETIME())`, [cabinetId, LOOP_WINDOW_MINUTES])).rows[0]!;
  if (Number(r.n) < LOOP_BOOTS) return false;
  await raiseLoop(db, cabinetId, `${r.n} starts within an hour`, r.last_boot ?? new Date());
  return true;
}

async function raiseLoop(db: Queryable, cabinetId: string, what: string, seenAt: Date): Promise<void> {
  const issue = (await db.query<{ name: string; severity: string }>("SELECT name, severity FROM issue_types WHERE id = $1", [ISSUE.rebootLoop])).rows[0]!;
  await upsertAlert(db, { cabinetId, issueTypeId: ISSUE.rebootLoop, severity: issue.severity, signature: "reboot_loop", title: `${issue.name}: ${what}`,
    seenAt, ruleId: null, eventId: null });
}

/**
 * The heartbeat side: a new boot when the uptime went back (a boot time that moved by more than the same-boot window),
 * and a loop alert resolved once the cabinet has run for 2 hours. The resolve is looked at only on the heartbeat that crosses the 2 hours
 * (or the first one the server has), not on every heartbeat after it.
 */
export async function bootFromHeartbeat(db: Queryable, cabinetId: string, uptimeSeconds: number, previous: { uptimeSeconds: number | null; at: Date | null }): Promise<void> {
  const now = Date.now();
  const bootAt = now - uptimeSeconds * 1000;
  const previousBoot = previous.at && previous.uptimeSeconds !== null ? previous.at.getTime() - previous.uptimeSeconds * 1000 : null;
  const newBoot = previousBoot === null || Math.abs(bootAt - previousBoot) > SAME_BOOT_MINUTES * 60_000;
  if (newBoot) await recordBoot(db, cabinetId, new Date(bootAt), "heartbeat");
  if (crossedRecovery(uptimeSeconds, previous.uptimeSeconds, newBoot))
    await closeSignatureAlert(db, "reboot-loop", cabinetId, "reboot_loop", "Running for 2 hours without restarting.");
}

/**
 * The quiet side, from the minute job: a cabinet that started twice or more in the two hours before it went quiet, and was
 * heard last within 15 minutes of starting, is probably stuck restarting. A cabinet that simply went offline is not.
 */
export async function checkQuietLoops(pool: Pool): Promise<number> {
  const rows = (await pool.query<{ id: string; boots: number; last_at: Date }>(
    `SELECT k.id, (SELECT COUNT(*) FROM cabinet_boots b WHERE b.cabinet_id = k.id AND b.booted_at > DATEADD(hour, -2, k.last_heartbeat_at)) AS boots, k.last_heartbeat_at AS last_at
       FROM cabinets k
      WHERE k.status = 'active' AND k.last_heartbeat_at < DATEADD(second, -$1, SYSUTCDATETIME()) AND k.last_heartbeat_at > DATEADD(day, -1, SYSUTCDATETIME())
        AND k.uptime_seconds IS NOT NULL AND k.uptime_seconds < 900
        AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.cabinet_id = k.id AND a.signature = 'reboot_loop' AND a.state <> 'resolved')`, [OFFLINE_AFTER_MS / 1000])).rows;
  let raised = 0;
  for (const r of rows) if (Number(r.boots) >= 2) { await raiseLoop(pool, r.id, `started ${r.boots} times, then went quiet`, r.last_at); raised++; }
  return raised;
}

// ---- Stop codes ----------------------------------------------------------------------------------------------------------

/** Common stop codes: the name Windows gives them, and what they most often point at. A hint to look, never a verdict. */
export const STOP_CODES: Record<number, { name: string; hint: string }> = {
  0x0A: { name: "IRQL_NOT_LESS_OR_EQUAL", hint: "Usually a driver; sometimes memory." },
  0x1A: { name: "MEMORY_MANAGEMENT", hint: "Often memory hardware; sometimes a driver." },
  0x1E: { name: "KMODE_EXCEPTION_NOT_HANDLED", hint: "Usually a driver." },
  0x3B: { name: "SYSTEM_SERVICE_EXCEPTION", hint: "Usually a driver or security software." },
  0x50: { name: "PAGE_FAULT_IN_NONPAGED_AREA", hint: "A driver, memory, or a damaged system file." },
  0x77: { name: "KERNEL_STACK_INPAGE_ERROR", hint: "Reading from the disk failed: storage, controller or cable." },
  0x7A: { name: "KERNEL_DATA_INPAGE_ERROR", hint: "Reading from the disk failed: storage, controller or cable." },
  0x7B: { name: "INACCESSIBLE_BOOT_DEVICE", hint: "Windows cannot reach its boot drive: storage driver or controller change, or a failing drive." },
  0x7E: { name: "SYSTEM_THREAD_EXCEPTION_NOT_HANDLED", hint: "Usually a driver." },
  0x9F: { name: "DRIVER_POWER_STATE_FAILURE", hint: "A driver did not handle sleep or wake; often a recently updated driver." },
  0xA0: { name: "INTERNAL_POWER_ERROR", hint: "Power management; drivers or firmware." },
  0xC2: { name: "BAD_POOL_CALLER", hint: "Usually a driver." },
  0xD1: { name: "DRIVER_IRQL_NOT_LESS_OR_EQUAL", hint: "A driver, very often a recently installed or updated one." },
  0xEF: { name: "CRITICAL_PROCESS_DIED", hint: "A core Windows process stopped: damaged system files, storage, or a failed update." },
  0xF4: { name: "CRITICAL_OBJECT_TERMINATION", hint: "A core process ended: often storage problems." },
  0x101: { name: "CLOCK_WATCHDOG_TIMEOUT", hint: "Processor or firmware." },
  0x116: { name: "VIDEO_TDR_FAILURE", hint: "The graphics driver." },
  0x124: { name: "WHEA_UNCORRECTABLE_ERROR", hint: "Hardware reported a fatal error: processor, memory or a PCIe device." },
  0x133: { name: "DPC_WATCHDOG_VIOLATION", hint: "A driver, often storage (SATA or NVMe) or its firmware." },
  0x139: { name: "KERNEL_SECURITY_CHECK_FAILURE", hint: "A driver, or damaged memory." },
  0x154: { name: "UNEXPECTED_STORE_EXCEPTION", hint: "Storage or memory." },
  0x19: { name: "BAD_POOL_HEADER", hint: "Usually a driver." },
  0xC000021A: { name: "WINLOGON_FATAL_ERROR", hint: "A core process failed at start: damaged system files or a failed update." },
};

const isHex = (ch: string) => (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");

/** The stop code from a BugCheck 1001 message ("…The bugcheck was: 0x0000007e (0x…"), as a number; null if absent. */
export function stopCodeOf(message: string): number | null {
  const lower = message.toLowerCase();
  const marker = "bugcheck was: ";
  const at = lower.indexOf(marker);
  if (at < 0) return null;
  let i = at + marker.length;
  if (lower.slice(i, i + 2) !== "0x") return null;
  i += 2;
  let hex = "";
  while (i < message.length && hex.length < 8 && isHex(message[i]!)) hex += message[i++];
  if (hex.length === 0 || (i < message.length && isHex(message[i]!))) return null;
  return parseInt(hex, 16);
}
export const stopCodeText = (code: number) => `0x${code.toString(16).toUpperCase().padStart(8, "0")}`;
export function describeStopCode(code: number | null) {
  if (code === null) return { code: null, text: "unknown", name: null, hint: null };
  const known = STOP_CODES[code];
  return { code, text: stopCodeText(code), name: known?.name ?? null, hint: known?.hint ?? null };
}

// ---- What each record means ------------------------------------------------------------------------------------------

export type Category = "update_installed" | "update_started" | "update_failed" | "driver_installed" | "driver_failed" | "service_installed" | "service_failure"
  | "software_installed" | "software_removed" | "boot" | "shutdown" | "restart_requested" | "unexpected_shutdown" | "crash" | "storage" | "hardware"
  | "scanner" | "service" | "firewall" | "platform_change" | "error";

const CHANGE_CATEGORIES = new Set<Category>(["update_installed", "driver_installed", "service_installed", "software_installed", "software_removed"]);
const MAP: Record<string, { category: Category; label: string } | null> = {};
const put = (source: string, ids: number[], category: Category | null, label = "") => { for (const id of ids) MAP[`${source.toLowerCase()}|${id}`] = category ? { category, label } : null; };
put("Microsoft-Windows-WindowsUpdateClient", [19], "update_installed", "Update installed");
put("Microsoft-Windows-WindowsUpdateClient", [43], "update_started", "Update installation started");
put("Microsoft-Windows-WindowsUpdateClient", [20], "update_failed", "Update failed to install");
put("Microsoft-Windows-Kernel-General", [12], "boot", "Windows started");
put("Microsoft-Windows-Kernel-General", [13], "shutdown", "Windows shut down");
put("EventLog", [6005, 6006], null);   // the same boots and shutdowns as Kernel-General 12 and 13
put("EventLog", [6008], "unexpected_shutdown", "The previous shutdown was unexpected");
put("Microsoft-Windows-Kernel-Power", [41], "unexpected_shutdown", "Restarted without shutting down cleanly");
put("BugCheck", [1001], "crash", "Blue screen");
put("Microsoft-Windows-WER-SystemErrorReporting", [1001], "crash", "Blue screen");
put("User32", [1074], "restart_requested", "Restart or shutdown requested");
put("Service Control Manager", [7045], "service_installed", "Service installed");
put("Service Control Manager", [7000, 7009, 7011, 7023, 7031, 7034], "service_failure", "Service failed");
put("Microsoft-Windows-UserPnp", [20001, 20003], "driver_installed", "Driver installed");
put("Microsoft-Windows-Kernel-PnP", [219], "driver_failed", "Driver failed to load");
put("MsiInstaller", [11707, 1033], "software_installed", "Software installed");
put("MsiInstaller", [11724, 1034], "software_removed", "Software removed");
put("disk", [7, 11, 15, 51, 52, 153, 154], "storage", "Disk error");
put("Ntfs", [55], "storage", "File system error");
put("Microsoft-Windows-Ntfs", [55, 98, 140], "storage", "File system error");
for (const s of ["storahci", "stornvme", "iaStorA", "iaStorAVC", "iaStorAC"]) put(s, [129], "storage", "Storage controller reset");
put("Microsoft-Windows-WHEA-Logger", [17, 18, 19, 47], "hardware", "Hardware error (WHEA)");

const COMPARED = new Set<Category>([...CHANGE_CATEGORIES, "storage", "hardware", "update_failed", "driver_failed"]);
/** The (source|event ID) keys the incident comparison counts, and those whose message names the change. */
const COMPARED_KEYS = Object.entries(MAP).filter(([, m]) => m && COMPARED.has(m.category)).map(([k]) => k);
const MESSAGE_KEYS = Object.entries(MAP).filter(([, m]) => m && CHANGE_CATEGORIES.has(m.category)).map(([k]) => k);

interface Row { kind: string; source: { log: string; source: string; eventId: number } | null; message: string; fields: Record<string, string> | null }

export function categorize(r: Row): { category: Category; label: string } | null {
  // A SMART warning from an agent before D152 is not shown: the platform no longer reads drive health.
  if (r.kind === "smart_warning") return null;
  if (r.kind === "scanner") return { category: "scanner", label: "Fingerprint scanner" };
  if (r.kind === "service") return { category: "service", label: `Watched service ${r.fields?.change ?? "changed"}` };
  if (r.kind === "firewall_changed") return { category: "firewall", label: "Firewall changed" };
  if (!r.source) return { category: "error", label: r.kind };
  const m = MAP[`${r.source.source.toLowerCase()}|${r.source.eventId}`];
  if (m === null) return null;
  return m ?? { category: "error", label: `${r.source.source} ${r.source.eventId}` };
}

const after = (text: string, marker: string): string | null => {
  const i = text.toLowerCase().indexOf(marker.toLowerCase());
  return i < 0 ? null : text.slice(i + marker.length).trim();
};
const until = (text: string, marker: string): string => { const i = text.indexOf(marker); return (i < 0 ? text : text.slice(0, i)).trim(); };

/** What changed, as one comparable name: the update's title, the driver's INF, the product. */
export function changeKey(category: Category, message: string): string {
  let key: string | null = null;
  if (category === "update_installed") key = after(message, "following update:");
  else if (category === "driver_installed") { const d = after(message, "install driver "); key = d ? `Driver ${until(d, " for ")}` : null; }
  else if (category === "software_installed" || category === "software_removed") {
    const p = after(message, "Product:");
    key = p ? `${until(p, " -- ")} ${category === "software_installed" ? "installed" : "removed"}` : null;
  }
  return (key || message || category).slice(0, 160);
}

// ---- One cabinet: timeline and crashes ---------------------------------------------------------------------------------

export interface TimelineItem { at: string; category: Category; title: string; detail: string; stopCode?: ReturnType<typeof describeStopCode>; cause?: ShutdownCause }

/**
 * Why a cabinet restarted without shutting down cleanly (13-roadmap.md, phase 2 "power-loss classification"):
 * - bug_check: Windows stopped with a blue screen (Kernel-Power 41 names a bug-check code, or a blue screen was logged within minutes);
 * - forced_off: someone held the power button (Kernel-Power 41 records when the button was pressed);
 * - power_loss_or_hang: neither: the power went, or Windows froze and was reset. The event cannot tell these two apart.
 */
export type ShutdownCause = "bug_check" | "forced_off" | "power_loss_or_hang";
export const CAUSE_TEXT: Record<ShutdownCause, string> = {
  bug_check: "after a blue screen", forced_off: "the power button was held", power_loss_or_hang: "power lost, or Windows froze and was reset",
};
/** A blue screen is logged when Windows starts again, usually within a minute or two of its Kernel-Power 41. */
export const BUG_CHECK_PAIR_MS = 10 * 60_000;

/** A field that holds a number other than zero ("0x0", "0" and blanks are zero; anything unreadable is not a number). */
function nonZero(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  if (t.length === 0 || t.length > 24) return false;
  const n = t.startsWith("0x") ? Number.parseInt(t.slice(2), 16) : [...t].every(ch => ch >= "0" && ch <= "9") ? Number(t) : Number.NaN;
  return Number.isFinite(n) && n !== 0;
}

/** The cause the event's own fields give, when the agent sent them (Kernel-Power 41's BugcheckCode and PowerButtonTimestamp). */
export function causeFromFields(fields: Record<string, string> | null | undefined): ShutdownCause | null {
  if (!fields) return null;
  if (nonZero(fields.BugcheckCode)) return "bug_check";
  if (nonZero(fields.PowerButtonTimestamp)) return "forced_off";
  return null;
}

/** Gives every unexpected restart its cause: its own fields first, then a blue screen logged within minutes, else power or a hang. */
export function classifyShutdowns(items: TimelineItem[]): TimelineItem[] {
  const crashes = items.filter(i => i.category === "crash").map(i => Date.parse(i.at));
  for (const i of items) {
    if (i.category !== "unexpected_shutdown") continue;
    const at = Date.parse(i.at);
    const cause = i.cause ?? (crashes.some(c => Math.abs(c - at) <= BUG_CHECK_PAIR_MS) ? "bug_check" : "power_loss_or_hang");
    i.cause = cause;
    i.title = `${i.title}: ${CAUSE_TEXT[cause]}`;
  }
  return items;
}

// JSON_VALUE stops at 4000 characters and gives NULL beyond it, so the message is read with OPENJSON.
const messageOf = (alias: string) => `ISNULL((SELECT j.message FROM OPENJSON(${alias}.detail) WITH (message nvarchar(max) '$.message') j), '')`;
const EVENT_COLUMNS = `occurred_at, kind, source, ${messageOf("events")} AS message, JSON_QUERY(detail, '$.fields') AS fields_json`;
type EventRow = { occurred_at: Date; kind: string; source: Row["source"]; message: string; fields: Record<string, string> | null };
type EventRowRaw = Omit<EventRow, "fields"> & { fields_json: string | null };
function withFields<T extends EventRowRaw>(r: T): Omit<T, "fields_json"> & { fields: Record<string, string> | null } {
  const { fields_json, ...rest } = r;
  let fields: Record<string, string> | null = null;
  try { fields = fields_json ? JSON.parse(fields_json) as Record<string, string> : null; } catch { /* unreadable: no fields */ }
  return { ...rest, fields };
}

function toItem(r: EventRow): TimelineItem | null {
  const c = categorize(r);
  if (!c) return null;
  const item: TimelineItem = { at: r.occurred_at.toISOString(), category: c.category, title: c.label, detail: r.message };
  if (CHANGE_CATEGORIES.has(c.category)) item.title = `${c.label}: ${changeKey(c.category, r.message)}`;
  if (c.category === "unexpected_shutdown") { const cause = causeFromFields(r.fields); if (cause) item.cause = cause; }
  if (c.category === "crash") { const sc = describeStopCode(stopCodeOf(r.message)); item.stopCode = sc; item.title = `Blue screen ${sc.text}${sc.name ? ` ${sc.name}` : ""}`; }
  return item;
}

export async function timeline(db: Queryable, cabinetId: string, from: Date, to: Date): Promise<TimelineItem[]> {
  const events = (await db.query<EventRowRaw>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE cabinet_id = $1 AND occurred_at BETWEEN $2 AND $3 ORDER BY occurred_at DESC OFFSET 0 ROWS FETCH NEXT 2000 ROWS ONLY`, [cabinetId, from, to])).rows.map(withFields).reverse();
  const boots = (await db.query<{ booted_at: Date; source: string }>(
    "SELECT booted_at, source FROM cabinet_boots WHERE cabinet_id = $1 AND booted_at BETWEEN $2 AND $3", [cabinetId, from, to])).rows;
  const writes = (await db.query<{ issued_at: Date; operation: string; status: string; name: string }>(
    `SELECT c.issued_at, c.operation, c.status, u.name FROM commands c JOIN users u ON u.id = c.issued_by
      WHERE c.cabinet_id = $1 AND c.issued_at BETWEEN $2 AND $3 AND c.operation IN (${WRITE_OPS.map((_, i) => `$${i + 4}`).join(", ")})`,
    [cabinetId, from, to, ...WRITE_OPS])).rows;
  const items: TimelineItem[] = [];
  const bootEvents = new Set<number>();
  for (const e of events) {
    const item = toItem(e);
    if (!item) continue;
    if (item.category === "boot") bootEvents.add(Math.round(e.occurred_at.getTime() / 180_000));
    items.push(item);
  }
  // Boots seen only by the heartbeat (the cabinet did not report its own start, or reported it before the agent ran).
  for (const b of boots)
    if (b.source === "heartbeat" && !bootEvents.has(Math.round(b.booted_at.getTime() / 180_000)))
      items.push({ at: b.booted_at.toISOString(), category: "boot", title: "Windows started", detail: "Estimated from the agent's uptime." });
  for (const w of writes) items.push({ at: w.issued_at.toISOString(), category: "platform_change", title: `Platform change: ${w.operation}`, detail: `By ${w.name}; ${w.status}.` });
  return classifyShutdowns(items.sort((a, b) => a.at.localeCompare(b.at)));
}
const WRITE_OPS = ["firewall.setProfile", "firewall.setRule", "firewall.restore", "firewall.applyPolicy", "network.setIp", "network.setDns", "package.install", "driver.uninstall", "updates.uninstall", "service.control", "service.setStartType", "time.setZone", "time.sync", "network.renewLease", "network.flushDns", "system.restart", "process.end", "power.set"];

const DAY = 86_400_000;
export const BEFORE_HOURS = 72;

export async function cabinetCrashes(db: Queryable, cabinetId: string, days = 30) {
  const to = new Date(), from = new Date(to.getTime() - days * DAY);
  const all = await timeline(db, cabinetId, new Date(from.getTime() - BEFORE_HOURS * 3_600_000), to);
  const inWindow = all.filter(i => i.at >= from.toISOString());
  const crashes = inWindow.filter(i => i.category === "crash");
  const unexpected = inWindow.filter(i => i.category === "unexpected_shutdown");
  // The first blue screen or unexpected restart, whichever came first (a blue screen is preceded by its own Kernel-Power 41).
  const first = [crashes[0], unexpected[0]].filter((i): i is TimelineItem => !!i).sort((a, b) => a.at.localeCompare(b.at))[0] ?? null;
  const firstAt = first ? new Date(first.at) : null;
  const before = firstAt ? all.filter(i => new Date(i.at) < firstAt && firstAt.getTime() - new Date(i.at).getTime() <= BEFORE_HOURS * 3_600_000) : [];
  const loop = (await db.query<{ state: string; title: string; first_seen: Date; occurrences: number }>(
    "SELECT TOP (1) state, title, first_seen, occurrences FROM alerts WHERE cabinet_id = $1 AND signature = 'reboot_loop' ORDER BY first_seen DESC", [cabinetId])).rows[0];
  const stopCodes = new Map<string, { stopCode: ReturnType<typeof describeStopCode>; count: number }>();
  for (const c of crashes) { const k = c.stopCode!.text; stopCodes.set(k, { stopCode: c.stopCode!, count: (stopCodes.get(k)?.count ?? 0) + 1 }); }
  return {
    days, from: from.toISOString(), to: to.toISOString(),
    crashes: crashes.length, unexpectedShutdowns: unexpected.length,
    // Each unexpected restart by its cause (classifyShutdowns): a blue screen, the power button, or power lost / Windows frozen.
    shutdownCauses: { bugCheck: unexpected.filter(i => i.cause === "bug_check").length, forcedOff: unexpected.filter(i => i.cause === "forced_off").length,
      powerLossOrHang: unexpected.filter(i => i.cause === "power_loss_or_hang").length }, boots: inWindow.filter(i => i.category === "boot").length,
    stopCodes: [...stopCodes.values()].sort((a, b) => b.count - a.count),
    storageErrors: inWindow.filter(i => i.category === "storage").length, hardwareErrors: inWindow.filter(i => i.category === "hardware").length,
    rebootLoop: loop ? { open: loop.state !== "resolved", title: loop.title, since: loop.first_seen.toISOString() } : null,
    firstAt: firstAt?.toISOString() ?? null,
    beforeFirst: before.filter(i => !["boot", "shutdown", "update_started"].includes(i.category)),
    timeline: firstAt ? all.filter(i => new Date(i.at).getTime() >= firstAt.getTime() - BEFORE_HOURS * 3_600_000) : inWindow.slice(-300),
  };
}

// ---- The fleet: a crash incident ---------------------------------------------------------------------------------------

const CRASH_KEYS: [string, number][] = [["bugcheck", 1001], ["microsoft-windows-wer-systemerrorreporting", 1001], ["microsoft-windows-kernel-power", 41], ["eventlog", 6008]];
export const crashPredicate = (alias: string, first: number) =>
  "(" + CRASH_KEYS.map((_, i) => `(JSON_VALUE(${alias}.source, '$.source') = $${first + i * 2} AND TRY_CAST(JSON_VALUE(${alias}.source, '$.eventId') AS int) = $${first + i * 2 + 1})`).join(" OR ") + ")";
export const crashArgs = CRASH_KEYS.flat();

export interface IncidentFilter { from: Date; to: Date; clientId?: string | undefined }

export async function fleetCrashIncident(db: Queryable, f: IncidentFilter) {
  const clientFilter = f.clientId ? "AND s.client_id = $3" : "";
  const base = [f.from, f.to, ...(f.clientId ? [f.clientId] : [])];
  const n = base.length;
  // Every active cabinet in scope, and which of them crashed, shut down unexpectedly, or looped in the window.
  const population = (await db.query<{ id: string; name: string; site: string; client: string; agent_version: string | null; last_at: Date | null; demo: number }>(
    `SELECT k.id, k.name, s.name AS site, c.name AS client, k.agent_version, k.last_heartbeat_at AS last_at, CASE WHEN k.demo_scenario IS NOT NULL THEN 1 ELSE 0 END AS demo
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
      WHERE k.status = 'active' ${clientFilter}`, base)).rows;
  const ids = population.map(p => p.id);
  // The population is passed as a JSON array of ids; the dates are $1 and $2.
  const crashRows = (await db.query<EventRowRaw & { cabinet_id: string }>(
    `SELECT e.cabinet_id, e.occurred_at, e.kind, e.source, ${messageOf("e")} AS message, JSON_QUERY(e.detail, '$.fields') AS fields_json
       FROM events e WHERE e.cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($${n + 1})) AND e.occurred_at BETWEEN $1 AND $2 AND ${crashPredicate("e", n + 2)}`,
    [...base, ids, ...crashArgs])).rows.map(withFields);
  const loops = (await db.query<{ cabinet_id: string; first_seen: Date }>(
    `SELECT cabinet_id, MIN(first_seen) AS first_seen FROM alerts WHERE signature = 'reboot_loop' AND cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($3)) AND first_seen BETWEEN $1 AND $2 GROUP BY cabinet_id`,
    [f.from, f.to, ids])).rows;
  const bootCounts = new Map((await db.query<{ cabinet_id: string; n: string }>(
    "SELECT cabinet_id, COUNT(*) AS n FROM cabinet_boots WHERE cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($3)) AND booted_at BETWEEN $1 AND $2 GROUP BY cabinet_id", [f.from, f.to, ids])).rows.map(r => [r.cabinet_id, Number(r.n)]));

  interface Affected { id: string; firstAt: Date; crashes: number; unexpected: number; stopCodes: Map<string, ReturnType<typeof describeStopCode>>; loop: boolean }
  const affected = new Map<string, Affected>();
  const touch = (id: string, at: Date) => {
    const a = affected.get(id) ?? { id, firstAt: at, crashes: 0, unexpected: 0, stopCodes: new Map(), loop: false };
    if (at < a.firstAt) a.firstAt = at;
    affected.set(id, a);
    return a;
  };
  for (const r of crashRows) {
    const a = touch(r.cabinet_id, r.occurred_at);
    if (categorize(r)?.category === "crash") { a.crashes++; const sc = describeStopCode(stopCodeOf(r.message)); a.stopCodes.set(sc.text, sc); }
    else a.unexpected++;
  }
  for (const l of loops) touch(l.cabinet_id, l.first_seen).loop = true;

  const affectedCount = affected.size, unaffectedCount = population.length - affectedCount;
  const comparisons = await compareChanges(db, { ids, affected: new Map([...affected.values()].map(a => [a.id, a.firstAt])), from: f.from, to: f.to });

  const byId = new Map(population.map(p => [p.id, p]));
  const rows = [...affected.values()].sort((a, b) => a.firstAt.getTime() - b.firstAt.getTime()).map(a => {
    const p = byId.get(a.id)!;
    return { id: a.id, name: p.name, site: p.site, client: p.client, demo: p.demo === 1, firstAt: a.firstAt.toISOString(), crashes: a.crashes, unexpectedShutdowns: a.unexpected,
      boots: bootCounts.get(a.id) ?? 0, stopCodes: [...a.stopCodes.values()], rebootLoop: a.loop,
      online: !!p.last_at && Date.now() - p.last_at.getTime() < OFFLINE_AFTER_MS, lastHeardAt: p.last_at?.toISOString() ?? null, agentVersion: p.agent_version };
  });
  const stopCodes = new Map<string, { stopCode: ReturnType<typeof describeStopCode>; cabinets: number }>();
  for (const r of rows) for (const sc of r.stopCodes) stopCodes.set(sc.text, { stopCode: sc, cabinets: (stopCodes.get(sc.text)?.cabinets ?? 0) + 1 });
  // When it began: the first crash per cabinet, by hour.
  const onset = new Map<string, number>();
  for (const r of rows) { const h = r.firstAt.slice(0, 13) + ":00:00Z"; onset.set(h, (onset.get(h) ?? 0) + 1); }
  const groups = (pick: (p: (typeof population)[number]) => string) => {
    const m = new Map<string, { total: number; affected: number }>();
    for (const p of population) { const k = pick(p); const g = m.get(k) ?? { total: 0, affected: 0 }; g.total++; if (affected.has(p.id)) g.affected++; m.set(k, g); }
    return [...m.entries()].map(([name, g]) => ({ name, ...g })).filter(g => g.affected > 0).sort((a, b) => b.affected - a.affected);
  };
  return {
    from: f.from.toISOString(), to: f.to.toISOString(), cabinets: population.length, affected: affectedCount, unaffected: unaffectedCount,
    firstAt: rows[0]?.firstAt ?? null, lastAt: rows.length ? rows.reduce((m, r) => r.firstAt > m ? r.firstAt : m, rows[0]!.firstAt) : null,
    stillDown: rows.filter(r => !r.online).length, inRebootLoop: rows.filter(r => r.rebootLoop).length,
    stopCodes: [...stopCodes.values()].sort((a, b) => b.cabinets - a.cabinets),
    onset: [...onset.entries()].sort().map(([hour, cabinets]) => ({ hour, cabinets })),
    byClient: groups(p => p.client), bySite: groups(p => `${p.client} / ${p.site}`), byAgentVersion: groups(p => p.agent_version ?? "unknown"),
    comparisons, cabinetsAffected: rows,
  };
}

/** One change or error compared between the affected cabinets and the others: how many of each had it, and whether it stands out. */
export interface ChangeComparison { category: Category; change: string; affected: number; affectedShare: number; unaffected: number; unaffectedShare: number; standsOut: boolean }

/**
 * What changed: on each affected cabinet in the 72 hours before its problem began; on the others, in the same span around the window.
 * A change that at least half the affected cabinets had, and at least 40 points more of them than the others, stands out. Shared by
 * the fleet crash incident and fleet patterns (decision-log D22).
 */
export async function compareChanges(db: Queryable, o: { ids: readonly string[]; affected: ReadonlyMap<string, Date>; from: Date; to: Date }): Promise<ChangeComparison[]> {
  const lookFrom = new Date(o.from.getTime() - BEFORE_HOURS * 3_600_000);
  // Aggregated in SQL: only the event types the comparison uses, only inside each cabinet's span, one row per distinct change.
  // An error message is dropped (its key is fixed), so a flood of disk errors is one row per cabinet, not thousands.
  const spans = [...o.affected.entries()].map(([id, firstAt]) => ({ id, firstAt }));
  const changeRows = (await db.query<{ cabinet_id: string; kind: string; has_source: number; src: string | null; event_id: number | null; message: string }>(
    `SELECT DISTINCT TOP (100000) e.cabinet_id, e.kind, CASE WHEN e.source IS NULL THEN 0 ELSE 1 END AS has_source,
            JSON_VALUE(e.source, '$.source') AS src, TRY_CAST(JSON_VALUE(e.source, '$.eventId') AS int) AS event_id,
            CASE WHEN e.kind = 'change' AND LOWER(JSON_VALUE(e.source, '$.source')) + '|' + JSON_VALUE(e.source, '$.eventId') IN (SELECT value FROM OPENJSON($5)) THEN ${messageOf("e")} ELSE '' END AS message
       FROM events e LEFT JOIN OPENJSON($4) WITH (id uniqueidentifier '$.id', first_at datetime2(3) '$.firstAt') f ON f.id = e.cabinet_id
      WHERE e.cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($3)) AND e.occurred_at BETWEEN $1 AND $2
        AND (f.id IS NULL OR (e.occurred_at <= f.first_at AND e.occurred_at >= DATEADD(hour, -${BEFORE_HOURS}, f.first_at)))
        AND e.kind IN ('change', 'error') AND LOWER(JSON_VALUE(e.source, '$.source')) + '|' + JSON_VALUE(e.source, '$.eventId') IN (SELECT value FROM OPENJSON($6))`,
    [lookFrom, o.to, o.ids, spans.map(a => ({ id: a.id, firstAt: a.firstAt.toISOString() })), MESSAGE_KEYS, COMPARED_KEYS])).rows;
  const changes = changeRows.map(r => ({ cabinet_id: r.cabinet_id, kind: r.kind, message: r.message,
    source: r.has_source === 1 ? { log: "", source: r.src ?? "", eventId: r.event_id ?? 0 } : null as Row["source"] }));
  const keyed = new Map<string, { category: Category; key: string; affected: Set<string>; unaffected: Set<string> }>();
  for (const ch of changes) {
    const c = categorize({ kind: ch.kind, source: ch.source, message: ch.message, fields: null });
    if (!c) continue;
    const a = o.affected.has(ch.cabinet_id);
    let k: string | null = null;
    if (CHANGE_CATEGORIES.has(c.category)) k = `${c.label}: ${changeKey(c.category, ch.message)}`;
    else if (c.category === "storage") k = "Storage errors (disk, file system or controller)";
    else if (c.category === "hardware") k = "Hardware errors (WHEA)";
    else if (c.category === "update_failed") k = "A Windows update failed";
    else if (c.category === "driver_failed") k = "A driver failed to load";
    if (!k) continue;
    const entry = keyed.get(k) ?? keyed.set(k, { category: c.category, key: k, affected: new Set(), unaffected: new Set() }).get(k)!;
    (a ? entry.affected : entry.unaffected).add(ch.cabinet_id);
  }
  const affectedCount = o.affected.size, unaffectedCount = o.ids.length - affectedCount;
  const share = (n: number, of: number) => of === 0 ? 0 : Math.round((n / of) * 1000) / 10;
  return [...keyed.values()].map(e => {
    const as = share(e.affected.size, affectedCount), us = share(e.unaffected.size, unaffectedCount);
    return { category: e.category, change: e.key, affected: e.affected.size, affectedShare: as, unaffected: e.unaffected.size, unaffectedShare: us,
      standsOut: affectedCount >= 2 && as >= 50 && as - us >= 40 };
  }).filter(c => c.affected > 0).sort((a, b) => Number(b.standsOut) - Number(a.standsOut) || (b.affectedShare - b.unaffectedShare) - (a.affectedShare - a.unaffectedShare)).slice(0, 40);

}

/** Removes boot records from before `cutoff`, in batches, each batch audited (retention, decision-log D74). A cut-off that is not a past time is refused; a repeat removes nothing more. */
export async function pruneOldBoots(db: Queryable, cutoff: Date, o: BatchOptions = RETENTION_BATCH): Promise<number> {
  checkRetentionCutoff(cutoff);
  return inBatches(db, "DELETE TOP ($1) FROM cabinet_boots WHERE booted_at < $2", [cutoff], o, { table: "cabinet_boots", cutoff });
}

