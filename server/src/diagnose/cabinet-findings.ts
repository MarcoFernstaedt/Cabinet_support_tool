// "Diagnose this cabinet" (docs/spec/12-milestones-8-to-12.md "Milestone 12"): fixed checks, written as code with tests, that read the answers
// of a fixed set of safe reads and say what is wrong, the evidence, how sure they are, the fix, and what matters most. A read that did not
// answer is "could not check" and is never shown as healthy. Pure functions: no database, no network, no regular expressions. Everything that
// comes from the cabinet (device names, log lines) is untrusted text: it is cleaned and cut before it is stored or shown.
import type { DevicesListOutput, DiskSmartOutput, EventlogQueryOutput, PeripheralStatusOutput, ServicesListOutput, SystemInfoOutput,
  SystemPerformanceOutput, TimeStatusOutput, UpdatesStatusOutput, UsbPortsOutput } from "@mashura/cabinet-contracts/types";
import { findingKey } from "../services/known-fixes.js";
import type { Finding as NetworkFinding, FixAction as NetworkFixAction } from "./network-findings.js";
import { readModules } from "@mashura/cabinet-contracts/load";
import { parseModule, type DiagnosticModule } from "./module.js";

export type Area = "system" | "storage" | "performance" | "scanner" | "devices" | "services" | "updates" | "time" | "logs" | "network";
export const AREAS: readonly [Area, string][] = [["system", "System"], ["storage", "Drive health"], ["performance", "Performance"], ["scanner", "Fingerprint scanner"],
  ["devices", "Devices"], ["services", "Services"], ["updates", "Windows updates"], ["time", "Time"], ["logs", "Event logs"], ["network", "Network"]];
export type BundleSeverity = "problem" | "warning" | "info";
export type Certainty = "confirmed" | "probable" | "possible" | "not_checked";

/** A change the console offers beside a finding. It is only ever a catalog operation with its parameters; the person's role, the write pause and the cabinet decide whether it runs. */
export type BundleAction =
  | { kind: "operation"; operation: string; params: Record<string, unknown>; label: string; cabinetId: string; cabinetName: string }
  | { kind: "open"; section: string; label: string; cabinetId: string };

export interface BundleFinding {
  /** Unique in this diagnosis. */
  id: string;
  /** The stable name runbooks and known fixes attach to: the id without an instance number. */
  key: string;
  area: Area;
  source: "cabinet" | "network";
  severity: BundleSeverity;
  certainty: Certainty;
  title: string;
  evidence: string[];
  fix: string | null;
  /** How much it matters for the cabinet's work (0 to 100); breaks ties among findings of the same severity and certainty. */
  priority: number;
  /** The built-in issue type this finding is an instance of, if any. */
  issueTypeId?: string;
  action?: BundleAction;
  /** A network finding's own fix (the console already knows how to run these). */
  networkAction?: NetworkFixAction;
  /** The id of the finding that probably explains this one. */
  causedBy?: string;
  /** 1 for the most important. Set by rank(). */
  rank?: number;
}

/** What one read gave: its answer, or why there is none. A read that was not part of the run is absent. */
export type Read<T> = { ok: true; output: T } | { ok: false; failure: string };
export interface CabinetEvidence {
  cabinet: { id: string; name: string; role: string };
  /** The site's time zone (one of the seven the platform sets), if the site has one. */
  siteTimeZone: string | null;
  /** How far the clock may be off at the cabinet's site before it counts as off (D109); 120 seconds when not given. */
  clockToleranceSeconds?: number;
  /** When the reads were made. */
  now: number;
  /** false when the cabinet's client uses no fingerprint scanner: the scanner was not read, and is reported as not used. */
  scannerUsed?: boolean;
  info?: Read<SystemInfoOutput>;
  peripheral?: Read<PeripheralStatusOutput>;
  usb?: Read<UsbPortsOutput>;
  devices?: Read<DevicesListOutput>;
  smart?: Read<DiskSmartOutput>;
  updates?: Read<UpdatesStatusOutput>;
  services?: Read<ServicesListOutput>;
  performance?: Read<SystemPerformanceOutput>;
  time?: Read<TimeStatusOutput>;
  systemLog?: Read<EventlogQueryOutput>;
  appLog?: Read<EventlogQueryOutput>;
}

/** The built-in issue types (migrations/0001_baseline.sql) a finding can be an instance of. */
export const ISSUE_IDS = {
  scanner: "00000000-0000-4000-8000-000000000101", drive: "00000000-0000-4000-8000-000000000102", driver: "00000000-0000-4000-8000-000000000103",
  network: "00000000-0000-4000-8000-000000000104", update: "00000000-0000-4000-8000-000000000106", crash: "00000000-0000-4000-8000-000000000109",
  shutdown: "00000000-0000-4000-8000-000000000110", hardware: "00000000-0000-4000-8000-000000000111", service: "00000000-0000-4000-8000-000000000112",
  firewallPolicy: "00000000-0000-4000-8000-000000000113", serviceRestarted: "00000000-0000-4000-8000-000000000114", serviceFailing: "00000000-0000-4000-8000-000000000115",
  serviceWatch: "00000000-0000-4000-8000-000000000116", timeZone: "00000000-0000-4000-8000-000000000118", clock: "00000000-0000-4000-8000-000000000119",
  networkBaseline: "00000000-0000-4000-8000-000000000121", usbMissing: "00000000-0000-4000-8000-000000000122", diskSpace: "00000000-0000-4000-8000-000000000123",
} as const;

// ---- Safe handling of what the cabinet says --------------------------------------------------------------------------------------

/** Control characters become spaces, the text is trimmed and cut. Used on every string that came from the cabinet. */
export function clean(value: unknown, max = 200): string {
  if (typeof value !== "string") return "";
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    out += code < 32 || code === 127 || (code >= 0x80 && code < 0xa0) || code === 0x2028 || code === 0x2029 ? " " : ch;
    if (out.length > max * 2) break;
  }
  out = out.trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
/** A key runbooks and known fixes can attach to: lower-case letters, digits and hyphens, starting with a letter, at most 48 characters. */
export function safeKey(value: string): string {
  let out = "";
  for (const ch of value.toLowerCase()) out += (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "-" ? ch : "-";
  while (out.length > 0 && !(out[0]! >= "a" && out[0]! <= "z")) out = out.slice(1);
  return out.slice(0, 48) || "finding";
}
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const arr = <T>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);
const GB = 1024 ** 3;
const gb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;
const DAY = 86_400_000;
/** At most `n` evidence lines, each cleaned; a longer list ends in "and N more". */
function lines(items: string[], n = 8): string[] {
  const out = items.map(s => clean(s, 300)).filter(s => s.length > 0);
  return out.length <= n ? out : [...out.slice(0, n - 1), `…and ${out.length - n + 1} more`];
}

/** What Windows means by the device problem codes a support person meets most; any other code is shown as its number. */
const DEVICE_CODE: Record<number, string> = {
  1: "not configured correctly", 3: "driver may be corrupted or memory is low", 10: "the device cannot start", 12: "no free resources", 14: "needs a restart",
  18: "driver needs reinstalling", 19: "registry is damaged", 21: "Windows is removing the device", 22: "the device is disabled", 24: "the device is not present or its driver is not working",
  28: "no driver is installed", 31: "Windows cannot load a driver for it", 32: "its driver is disabled", 37: "the driver returned a failure", 39: "the driver is missing or corrupt",
  41: "Windows loaded the driver but cannot find the device", 43: "the device reported a problem and Windows stopped it", 45: "the device is not connected", 52: "the driver's signature cannot be verified",
};
const codeText = (code: number | null | undefined, text: string | null | undefined): string =>
  code === null || code === undefined ? "" : `code ${code}${DEVICE_CODE[code] ? ` (${DEVICE_CODE[code]})` : text ? ` (${clean(text, 80)})` : ""}`;

// ---- The checks --------------------------------------------------------------------------------------------------------------------------

export interface Part { findings: BundleFinding[]; ok: string | null }
export type Make = (x: Omit<BundleFinding, "key" | "source"> & { key?: string }) => BundleFinding;

/** Services that Windows and the cabinet need running. Compared by exact name (lower case); a stopped one set to start automatically is worth a look. */
const MUST_RUN: Record<string, string> = {
  dhcp: "DHCP Client", dnscache: "DNS Client", eventlog: "Windows Event Log", bfe: "Base Filtering Engine", mpssvc: "Windows Defender Firewall",
  w32time: "Windows Time", lanmanworkstation: "Workstation", winmgmt: "Windows Management Instrumentation", cryptsvc: "Cryptographic Services",
};

function system(e: CabinetEvidence, make: Make): Part {
  const r = e.info;
  if (!r) return { findings: [], ok: null };
  if (!r.ok) return { findings: [make({ id: "system-unread", area: "system", severity: "info", certainty: "not_checked", title: "Could not read the system information", evidence: lines([r.failure]), fix: "Run the diagnosis again; if it keeps failing, check the cabinet is online.", priority: 10 })], ok: null };
  const o = r.output, f: BundleFinding[] = [];
  if (o.readOnlyMode) f.push(make({ id: "read-only", area: "system", severity: "warning", certainty: "confirmed", title: "This cabinet is in read-only mode",
    evidence: ["The agent refuses every change on this cabinet, so the fixes offered below will be refused until it is installed without read-only mode."],
    fix: "Reads still work. To make changes, an Admin has to reinstall the agent without read-only mode.", priority: 70 }));
  const days = num(o.uptimeSeconds) / 86_400;
  if (days >= 45) f.push(make({ id: "uptime-long", area: "system", severity: "warning", certainty: "confirmed", title: `Windows has been running for ${Math.floor(days)} days`,
    evidence: [`Uptime is ${Math.floor(days)} days. Updates and driver changes wait for a restart, and a long-running Windows slows down and leaks memory.`],
    fix: "Restart the cabinet at a quiet time (System → Windows → Restart).", priority: 22 }));
  else if (num(o.uptimeSeconds) < 600) f.push(make({ id: "uptime-short", area: "system", severity: "info", certainty: "confirmed", title: `Windows started ${Math.max(1, Math.round(num(o.uptimeSeconds) / 60))} minutes ago`,
    evidence: ["Many services and devices are still starting in the first minutes; a problem seen now may clear by itself, and a restart may be what caused it."],
    fix: "Run the diagnosis again in a few minutes. If it restarted by itself, open Crashes and restarts.", priority: 40,
    action: { kind: "open", section: "crashes", label: "Open Crashes and restarts", cabinetId: e.cabinet.id } }));
  return { findings: f, ok: `${clean(o.osVersion, 60)}, up ${days >= 1 ? `${Math.floor(days)} days` : `${Math.round(num(o.uptimeSeconds) / 3600)} hours`}` };
}

function storage(e: CabinetEvidence, make: Make): Part {
  const r = e.smart;
  if (!r) return { findings: [], ok: null };
  if (!r.ok) return { findings: [make({ id: "drive-unread", area: "storage", severity: "info", certainty: "not_checked", title: "Could not read the drive health", evidence: lines([r.failure]), fix: null, priority: 20 })], ok: null };
  const drives = arr(r.output.drives);
  if (drives.length === 0) return { findings: [make({ id: "drive-none", area: "storage", severity: "info", certainty: "not_checked", title: "No drive reported health data",
    evidence: ["Some drives and controllers do not pass SMART data to Windows. Healthy is not assumed; look at the disk errors in the event logs."], fix: null, priority: 20 })], ok: null };
  const f: BundleFinding[] = [];
  drives.forEach((d, i) => {
    const name = clean(d.model, 60) || `Drive ${i + 1}`;
    const reasons: { level: BundleSeverity; text: string }[] = [];
    if (d.predictFailure === true) reasons.push({ level: "problem", text: "The drive's own self-monitoring predicts it will fail." });
    if (d.health === "failing") reasons.push({ level: "problem", text: "Windows reports the drive as failing." });
    else if (d.health === "warning") reasons.push({ level: "warning", text: "Windows reports a warning for the drive." });
    if (num(d.pendingSectors) > 0) reasons.push({ level: "problem", text: `${num(d.pendingSectors)} sectors are waiting to be reallocated.` });
    if (num(d.uncorrectableErrors) > 0) reasons.push({ level: "problem", text: `${num(d.uncorrectableErrors)} uncorrectable errors.` });
    if (num(d.reallocatedSectors) > 0) reasons.push({ level: "warning", text: `${num(d.reallocatedSectors)} sectors have been reallocated.` });
    if (d.wearPercent !== null && num(d.wearPercent) >= 90) reasons.push({ level: "warning", text: `${num(d.wearPercent)}% of the drive's rated life is used.` });
    if (d.temperatureCelsius !== null && num(d.temperatureCelsius) >= 70) reasons.push({ level: "warning", text: `The drive is at ${num(d.temperatureCelsius)} °C.` });
    if (reasons.length === 0) return;
    const bad = reasons.some(x => x.level === "problem");
    f.push(make({ id: `drive-${i + 1}`, key: "drive-health", area: "storage", severity: bad ? "problem" : "warning", certainty: d.predictFailure === true || d.health === "failing" ? "confirmed" : "probable",
      title: bad ? `${name} shows signs of failing` : `${name} needs watching`, evidence: lines(reasons.map(x => x.text)),
      fix: bad ? "Back up what matters and plan to replace the drive now, before it fails; a failing drive causes slowness, corrupted files and blue screens."
        : "Keep an eye on it: check again in a few days (the Drive health section shows the trend) and plan a replacement if the numbers grow.",
      priority: bad ? 98 : 55, issueTypeId: ISSUE_IDS.drive, action: { kind: "open", section: "drives", label: "Open Drive health", cabinetId: e.cabinet.id } }));
  });
  return { findings: f, ok: f.length === 0 ? `${drives.length} ${drives.length === 1 ? "drive" : "drives"}, none with a warning (a healthy reading is not a guarantee)` : null };
}

function performance(e: CabinetEvidence, make: Make): Part {
  const r = e.performance;
  if (!r) return { findings: [], ok: null };
  if (!r.ok) return { findings: [make({ id: "perf-unread", area: "performance", severity: "info", certainty: "not_checked", title: "Could not read processor, memory and drives", evidence: lines([r.failure]), fix: null, priority: 15 })], ok: null };
  const o = r.output, f: BundleFinding[] = [];
  for (const [i, v] of arr(o.volumes).entries()) {
    const size = num(v.sizeBytes), free = num(v.freeBytes);
    if (size <= 0) continue;
    const pct = (free / size) * 100, system = clean(v.drive, 8).toLowerCase().startsWith("c");
    const critical = pct < 5 || free < 2 * GB, low = pct < 10 || free < 10 * GB;
    if (!low) continue;
    f.push(make({ id: `disk-space-${i + 1}`, key: "disk-space", area: "performance", severity: critical ? "problem" : "warning", certainty: "confirmed",
      title: `${clean(v.drive, 8)} has only ${gb(free)} free (${Math.round(pct)}%)`,
      evidence: [`${clean(v.drive, 8)}${v.label ? ` "${clean(v.label, 40)}"` : ""} is ${gb(size)}; ${gb(free)} is free.`, system ? "Windows Update, logs and the cabinet application all need room on this drive and start failing when it fills." : "The application's data may be on this drive."],
      fix: "Free space: empty the recycle bin and temp folders, remove old installers and unused programs. Do not delete files the application uses.", priority: system ? 80 : 60, issueTypeId: ISSUE_IDS.diskSpace }));
  }
  const m = o.memory, total = num(m.totalBytes), avail = num(m.availableBytes);
  const memFree = total > 0 ? avail / total : 1;
  const paging = num(m.pagesPerSecond), commit = m.commitLimitBytes ? num(m.committedBytes) / num(m.commitLimitBytes) : 0;
  if (memFree < 0.1 || commit > 0.9) {
    const biggest = arr(o.byMemory)[0];
    f.push(make({ id: "memory-low", area: "performance", severity: memFree < 0.05 ? "problem" : "warning", certainty: "probable", title: `Memory is nearly full (${gb(avail)} free of ${gb(total)})`,
      evidence: lines([`${Math.round(memFree * 100)}% of memory is free.`, ...(commit > 0.9 ? [`Committed memory is ${Math.round(commit * 100)}% of the limit.`] : []),
        ...(paging > 200 ? [`Windows is paging ${Math.round(paging)} pages a second.`] : []), ...(biggest ? [`The program using the most is ${clean(biggest.name, 60)} (${gb(num(biggest.workingSetBytes))}).`] : [])]),
      fix: "Find what is using the memory (Processes); a program that grows without limit needs a restart or an update. A restart clears it for now.", priority: 62,
      action: { kind: "open", section: "processes", label: "Open Processes", cabinetId: e.cabinet.id } }));
  }
  const cpu = num(o.cpu.usedPercent);
  if (cpu >= 90) {
    const top = arr(o.byCpu)[0];
    f.push(make({ id: "cpu-high", area: "performance", severity: "warning", certainty: "possible", title: `The processor is ${Math.round(cpu)}% busy`,
      evidence: lines([`One sample, taken when the diagnosis ran. Read it twice, a few seconds apart, before deciding.`, ...(top ? [`The busiest program is ${clean(top.name, 60)} (${Math.round(num(top.cpuPercent))}%).`] : [])]),
      fix: "If it stays high, the busiest program is the place to look (Processes).", priority: 45, action: { kind: "open", section: "processes", label: "Open Processes", cabinetId: e.cabinet.id } }));
  }
  const busy = arr(o.physicalDisks).filter(d => num(d.busyPercent) >= 85);
  if (busy.length > 0)
    f.push(make({ id: "disk-busy", area: "performance", severity: "warning", certainty: "possible", title: "A drive is busy almost all the time",
      evidence: lines(busy.map(d => `${clean(d.name, 40)}: ${Math.round(num(d.busyPercent))}% busy, queue length ${num(d.queueLength)}.`)),
      fix: "A drive that is always busy with a long queue is struggling: check its health and the disk errors in the event logs.", priority: 50 }));
  return { findings: f, ok: f.length === 0 ? `Processor ${Math.round(cpu)}%, memory ${Math.round(memFree * 100)}% free, ${arr(o.volumes).length} drives with room` : null };
}

function scanner(e: CabinetEvidence, make: Make): Part {
  if (e.scannerUsed === false) return { findings: [], ok: "Not used by this client" };
  const r = e.peripheral;
  if (!r) return { findings: [], ok: null };
  if (!r.ok) return { findings: [make({ id: "scanner-unread", area: "scanner", severity: "info", certainty: "not_checked", title: "Could not check the fingerprint scanner", evidence: lines([r.failure]), fix: null, priority: 20 })], ok: null };
  const o = r.output, f: BundleFinding[] = [];
  if (!o.configured) return { findings: [], ok: "No scanner is expected on this cabinet" };
  const checks = arr(o.checks);
  const summaries = (level: string) => checks.filter(c => c.outcome === level).map(c => c.summary);
  const open = { kind: "open" as const, section: "scanner", label: "Open the fingerprint scanner section", cabinetId: e.cabinet.id };
  if (!o.connected) {
    f.push(make({ id: "scanner-missing", key: "scanner-missing", area: "scanner", severity: "problem", certainty: "confirmed", title: "The fingerprint scanner is not detected",
      evidence: lines([...summaries("fail"), ...summaries("warn")].concat(o.hardwareIds.length ? [`Expected hardware: ${o.hardwareIds.slice(0, 3).map(x => clean(x, 60)).join(", ")}.`] : [])),
      fix: "Reseat the USB cable at both ends, try another USB port (a rear one), then another cable. If Windows does not see it in any port, the scanner itself may have failed.",
      priority: 95, issueTypeId: ISSUE_IDS.scanner, action: open }));
  } else if (o.errorCode !== null && o.errorCode !== 0) {
    f.push(make({ id: "scanner-error", key: "scanner-error", area: "scanner", severity: "problem", certainty: "confirmed", title: `The fingerprint scanner is present but Windows reports a problem (${codeText(o.errorCode, o.errorText)})`,
      evidence: lines([`${clean(o.name, 80) || "The scanner"}: ${codeText(o.errorCode, o.errorText)}.`, ...summaries("fail")]),
      fix: o.errorCode === 43 || o.errorCode === 10 ? "Try another USB port. If it persists, reinstall the scanner's driver from the software library." : "Reinstall the scanner's driver from the software library, or roll back a recent driver change (Devices and drivers).",
      priority: 92, issueTypeId: ISSUE_IDS.scanner, action: open }));
  } else {
    const fails = summaries("fail"), warns = summaries("warn");
    if (fails.length > 0 || warns.length > 0)
      f.push(make({ id: "scanner-degraded", key: "scanner-degraded", area: "scanner", severity: fails.length > 0 ? "problem" : "warning", certainty: "probable",
        title: fails.length > 0 ? "The scanner is connected but fails its checks" : "The scanner is connected but something is off", evidence: lines([...fails, ...warns]),
        fix: "Follow the failing check: a scanner that drops off the USB bus is usually the cable or the port; one with a driver warning needs its driver reinstalled.", priority: 75, issueTypeId: ISSUE_IDS.scanner, action: open }));
  }
  return { findings: f, ok: f.length === 0 ? `${clean(o.name, 60) || "The scanner"} is connected and passes its checks` : null };
}

function usbPorts(e: CabinetEvidence, make: Make): Part {
  const r = e.usb;
  if (!r) return { findings: [], ok: null };
  if (!r.ok) return { findings: [], ok: null };
  const scannerIds = new Set(e.peripheral?.ok ? e.peripheral.output.hardwareIds.map(x => x.toLowerCase()) : []);
  const bad = arr(r.output.devices).filter(d => d.kind === "device" && d.present && d.errorCode !== null && d.errorCode !== 0 && !arr(d.hardwareIds).some(h => scannerIds.has(h.toLowerCase())));
  if (bad.length === 0) return { findings: [], ok: null };
  return { findings: [make({ id: "usb-failing", area: "devices", severity: "warning", certainty: "confirmed", title: `${bad.length === 1 ? "A USB device is" : `${bad.length} USB devices are`} failing to start`,
    evidence: lines(bad.map(d => `${clean(d.name, 80)}${d.location ? ` (${clean(d.location, 60)})` : ""}: ${codeText(d.errorCode, d.errorText)}.`)),
    fix: "Try another USB port; if it persists, reinstall the device's driver from the library.", priority: 52, issueTypeId: ISSUE_IDS.driver })], ok: null };
}

function devices(e: CabinetEvidence, make: Make): Part {
  const r = e.devices;
  if (!r) return { findings: [], ok: null };
  if (!r.ok) return { findings: [make({ id: "devices-unread", area: "devices", severity: "info", certainty: "not_checked", title: "Could not read the devices", evidence: lines([r.failure]), fix: null, priority: 15 })], ok: null };
  const scannerIds = new Set(e.peripheral?.ok ? e.peripheral.output.hardwareIds.map(x => x.toLowerCase()) : []);
  const bad = arr(r.output.devices).filter(d => d.errorCode !== null && d.errorCode !== 0 && !arr(d.hardwareIds).some(h => scannerIds.has(h.toLowerCase())));
  if (bad.length === 0) return { findings: [], ok: "Device Manager shows nothing wrong" };
  const core = bad.some(d => ["net", "diskdrive", "scsiadapter", "hdc", "biometric"].includes(clean(d.class, 40).toLowerCase()));
  return { findings: [make({ id: "devices-problem", area: "devices", severity: core ? "problem" : "warning", certainty: "confirmed", title: `${bad.length} ${bad.length === 1 ? "device has" : "devices have"} a problem in Device Manager`,
    evidence: lines(bad.map(d => `${clean(d.name, 80)}${d.class ? ` [${clean(d.class, 30)}]` : ""}: ${codeText(d.errorCode, d.errorText)}.`)),
    fix: "Reinstall the driver from the software library, or roll back a recent driver change (Devices and drivers). Check the date of the last driver install first.", priority: core ? 78 : 50, issueTypeId: ISSUE_IDS.driver,
    action: { kind: "open", section: "devices", label: "Open Devices and drivers", cabinetId: e.cabinet.id } })], ok: null };
}

function services(e: CabinetEvidence, make: Make): Part {
  const r = e.services;
  if (!r) return { findings: [], ok: null };
  if (!r.ok) return { findings: [make({ id: "services-unread", area: "services", severity: "info", certainty: "not_checked", title: "Could not read the services", evidence: lines([r.failure]), fix: null, priority: 15 })], ok: null };
  const f: BundleFinding[] = [];
  const openServices = { kind: "open" as const, section: "services", label: "Open Services", cabinetId: e.cabinet.id };
  for (const [i, w] of arr(r.output.watched).entries()) {
    const name = clean(w.name, 80);
    if (w.state === "failing")
      f.push(make({ id: `service-failing-${i + 1}`, key: "service-failing", area: "services", severity: "problem", certainty: "confirmed", title: `${name} will not stay running`,
        evidence: lines([`The agent tried ${num(w.consecutiveFailures)} times to start the watched service ${name} and it stopped again.`, ...(w.lastError !== null && num(w.lastError) !== 0 ? [`Last Windows error code: ${num(w.lastError)}.`] : [])]),
        fix: "Read why Windows stopped it (Event logs → Service Control Manager). A service that dies right after starting usually has a missing dependency, a wrong account or a broken installation.",
        priority: 88, issueTypeId: ISSUE_IDS.serviceFailing, action: openServices }));
    else if (w.state === "missing" || w.state === "disabled" || w.state === "refused")
      f.push(make({ id: `service-watch-${i + 1}`, key: "service-watch", area: "services", severity: "warning", certainty: "confirmed", title: `Watched service ${name} is ${w.state === "missing" ? "not installed" : w.state === "disabled" ? "disabled" : "one the agent refuses to start"}`,
        evidence: [`The watch list names ${name}, and the agent cannot keep it running because it is ${w.state}.`],
        fix: w.state === "missing" ? "The watch list probably names the wrong service: correct it on the Services page, or reinstall the software that provides it." : "Enable the service (set its start type to automatic), then start it.",
        priority: 58, issueTypeId: ISSUE_IDS.serviceWatch, action: openServices }));
    else if (w.state === "restarted" && num(w.restartsToday) >= 3)
      f.push(make({ id: `service-restarts-${i + 1}`, key: "service-restarts", area: "services", severity: "warning", certainty: "probable", title: `${name} was restarted ${num(w.restartsToday)} times today`,
        evidence: [`The agent had to start ${name} again ${num(w.restartsToday)} times today. It runs, but something keeps stopping it.`],
        fix: "Repeated restarts hide a cause: look at the Service Control Manager events and the application's own log around the restart times.", priority: 54, issueTypeId: ISSUE_IDS.serviceRestarted, action: openServices }));
  }
  const young = e.info?.ok ? num(e.info.output.uptimeSeconds) < 600 : false;
  for (const s of arr(r.output.services)) {
    const key = clean(s.name, 80).toLowerCase();
    const label = MUST_RUN[key];
    if (!label || s.state !== "stopped") continue;
    const automatic = s.startType === "automatic" || (s.startType === "automatic_delayed" && !young);
    const name = clean(s.name, 80);
    if (automatic)
      f.push(make({ id: `service-stopped-${key}`.slice(0, 60), key: "service-stopped", area: "services", severity: "warning", certainty: "confirmed", title: `${label} (${name}) is stopped but set to start automatically`,
        evidence: [`${name} is set to start with Windows and is stopped. Things that depend on it (names, firewall, time, logs) can fail while it is down.`],
        fix: "Start it. If it stops again by itself, read why in the Service Control Manager events.", priority: 66, issueTypeId: ISSUE_IDS.service,
        action: { kind: "operation", operation: "service.control", params: { name, action: "start" }, label: `Start ${label}`, cabinetId: e.cabinet.id, cabinetName: e.cabinet.name } }));
    else if (s.startType === "disabled")
      f.push(make({ id: `service-disabled-${key}`.slice(0, 60), key: "service-disabled", area: "services", severity: "warning", certainty: "confirmed", title: `${label} (${name}) is disabled`,
        evidence: [`${name} cannot start while it is disabled. Somebody or something changed its start type.`],
        fix: "Set its start type back to automatic, then start it.", priority: 64, issueTypeId: ISSUE_IDS.service,
        action: { kind: "operation", operation: "service.setStartType", params: { name, startType: "automatic" }, label: `Set ${label} to start automatically`, cabinetId: e.cabinet.id, cabinetName: e.cabinet.name } }));
  }
  return { findings: f, ok: f.length === 0 ? `${arr(r.output.services).length} services read; none of the watched or essential ones is down` : null };
}

function updates(e: CabinetEvidence, make: Make, lowSystemSpace: string | null): Part {
  const r = e.updates;
  if (!r) return { findings: [], ok: null };
  if (!r.ok) return { findings: [make({ id: "updates-unread", area: "updates", severity: "info", certainty: "not_checked", title: "Could not read the update history", evidence: lines([r.failure]), fix: null, priority: 15 })], ok: null };
  const o = r.output, f: BundleFinding[] = [];
  const failed = arr(o.installed).filter(x => x.result === "failed" || x.result === "aborted");
  const open = { kind: "open" as const, section: "updates", label: "Open Windows updates", cabinetId: e.cabinet.id };
  if (o.lastInstallResult === "failed" || o.lastInstallResult === "aborted" || failed.length > 0)
    f.push(make({ id: "updates-failed", area: "updates", severity: "warning", certainty: "probable", title: "A Windows update failed to install",
      evidence: lines([...failed.slice(0, 5).map(x => `${clean(x.kb, 20) || clean(x.title, 80)}: ${x.result}${x.errorCode ? `, error 0x${(num(x.errorCode) >>> 0).toString(16)}` : ""}`),
        ...(o.lastInstallResult && o.lastInstallResult !== "succeeded" ? [`The last install attempt: ${o.lastInstallResult}.`] : [])]),
      fix: "Look up the error code. Low disk space, a stopped Windows Update service or a damaged update cache are the usual causes; install again after fixing it.",
      priority: 56, issueTypeId: ISSUE_IDS.update, ...(lowSystemSpace ? { causedBy: lowSystemSpace } : {}), action: open }));
  const security = arr(o.pending).filter(x => x.isSecurity).length;
  if (security > 0)
    f.push(make({ id: "updates-pending-security", area: "updates", severity: "info", certainty: "confirmed", title: `${security} security ${security === 1 ? "update is" : "updates are"} waiting`,
      evidence: lines(arr(o.pending).filter(x => x.isSecurity).slice(0, 5).map(x => clean(x.kb, 20) || clean(x.title, 80))), fix: "Install them at a quiet time (Windows updates).", priority: 25, action: open }));
  const last = o.lastInstallAt ? Date.parse(o.lastInstallAt) : NaN;
  if (Number.isFinite(last) && e.now - last > 60 * DAY)
    f.push(make({ id: "updates-stale", area: "updates", severity: "warning", certainty: "confirmed", title: `No Windows update installed for ${Math.floor((e.now - last) / DAY)} days`,
      evidence: [`The last install was ${new Date(last).toISOString().slice(0, 10)}.`], fix: "Check whether updates are blocked (a policy, a stopped service, no space) and install them at a quiet time.", priority: 30, action: open }));
  return { findings: f, ok: f.length === 0 ? `${arr(o.installed).length} recent updates, none failed` : null };
}

function time(e: CabinetEvidence, make: Make): Part {
  const r = e.time;
  if (!r) return { findings: [], ok: null };
  if (!r.ok) return { findings: [make({ id: "time-unread", area: "time", severity: "info", certainty: "not_checked", title: "Could not read the time settings", evidence: lines([r.failure]), fix: null, priority: 15 })], ok: null };
  const o = r.output, f: BundleFinding[] = [];
  const utc = Date.parse(o.utcTime);
  const skew = Number.isFinite(utc) ? Math.round((utc - e.now) / 1000) : null;
  const act = (op: string, params: Record<string, unknown>, label: string): BundleAction => ({ kind: "operation", operation: op, params, label, cabinetId: e.cabinet.id, cabinetName: e.cabinet.name });
  if (o.timeService === "stopped" || o.timeService === "not_installed")
    f.push(make({ id: "time-service", area: "time", severity: "problem", certainty: "confirmed", title: `The Windows Time service is ${o.timeService === "stopped" ? "stopped" : "not installed"}`,
      evidence: ["Without it the clock drifts. Clocks that differ by more than a few minutes break sign-in and sync between machines."], fix: "Start the Windows Time service (Services → Windows Time), then sync the clock.", priority: 68, issueTypeId: ISSUE_IDS.clock }));
  if (skew !== null && Math.abs(skew) > (e.clockToleranceSeconds ?? 120))
    f.push(make({ id: "time-skew", area: "time", severity: "warning", certainty: "confirmed", title: `The clock is ${Math.abs(skew) >= 3600 ? `${Math.round(Math.abs(skew) / 3600)} hours` : Math.abs(skew) >= 120 ? `${Math.round(Math.abs(skew) / 60)} minutes` : `${Math.abs(skew)} seconds`} ${skew > 0 ? "ahead of" : "behind"} the server`,
      evidence: [`The cabinet says it is ${clean(o.utcTime, 30)} UTC; the server's clock differs by ${Math.abs(skew)} seconds.`],
      fix: "Sync the clock. If it drifts again, check the Windows Time source (or the battery on the motherboard).", priority: 70, issueTypeId: ISSUE_IDS.clock, action: act("time.sync", {}, "Sync the clock now") }));
  if (e.siteTimeZone && e.siteTimeZone !== o.timeZoneId)
    f.push(make({ id: "time-zone", area: "time", severity: "warning", certainty: "confirmed", title: "The cabinet is set to the wrong time zone",
      evidence: [`The cabinet uses ${clean(o.timeZoneId, 60)}; the site's zone is ${clean(e.siteTimeZone, 60)}. Schedules, logs and dispensing times show the wrong local time.`],
      fix: "Set the cabinet to the site's time zone.", priority: 60, issueTypeId: ISSUE_IDS.timeZone, action: act("time.setZone", { timeZoneId: e.siteTimeZone }, `Set the time zone to ${e.siteTimeZone}`) }));
  const lastSync = o.sync.lastSuccessfulSync ? Date.parse(o.sync.lastSuccessfulSync) : NaN;
  if (o.sync.state === "never_synced" && o.timeService === "running")
    f.push(make({ id: "time-never-synced", area: "time", severity: "warning", certainty: "probable", title: "The clock has never synced with a time source", evidence: ["Windows Time is running but has not completed a sync."],
      fix: "Sync the clock now; if it fails, the cabinet cannot reach its time source (check DNS and the firewall).", priority: 48, action: act("time.sync", {}, "Sync the clock now") }));
  else if (Number.isFinite(lastSync) && e.now - lastSync > 7 * DAY)
    f.push(make({ id: "time-sync-old", area: "time", severity: "warning", certainty: "possible", title: `The clock last synced ${Math.floor((e.now - lastSync) / DAY)} days ago`,
      evidence: [`Last successful sync: ${new Date(lastSync).toISOString().slice(0, 10)}${o.sync.source ? ` from ${clean(o.sync.source, 60)}` : ""}.`], fix: "Sync the clock now.", priority: 40, action: act("time.sync", {}, "Sync the clock now") }));
  return { findings: f, ok: f.length === 0 ? `${clean(o.timeZoneName, 60)}, clock within ${skew === null ? "?" : Math.abs(skew)} s of the server` : null };
}

/** Log lines that name a problem we know, matched by exact source and event ID. */
interface KnownEvent { sources: string[]; ids: number[]; key: string; title: string; severity: BundleSeverity; fix: string; priority: number; issue: string; area: Area; section?: string }
const KNOWN_EVENTS: KnownEvent[] = [
  { sources: ["microsoft-windows-kernel-power"], ids: [41], key: "log-unexpected-shutdown", title: "The cabinet shut down without warning", severity: "warning", priority: 74, issue: ISSUE_IDS.shutdown, area: "logs", section: "crashes",
    fix: "Kernel-Power 41 means power was lost or Windows froze. Ask the site about the power (a UPS, the plug, a switched outlet); if it repeats with power stable, look at the drive and memory." },
  { sources: ["bugcheck", "microsoft-windows-wer-systemerrorreporting"], ids: [1001], key: "log-blue-screen", title: "Windows stopped with a blue screen", severity: "problem", priority: 90, issue: ISSUE_IDS.crash, area: "logs", section: "crashes",
    fix: "Open Crashes and restarts: it names the stop code and what changed before the first crash. A recently installed driver or update is the first suspect." },
  { sources: ["disk"], ids: [7, 11, 15, 51, 52, 153, 154], key: "log-disk-errors", title: "Windows logged disk errors", severity: "problem", priority: 92, issue: ISSUE_IDS.drive, area: "storage", section: "drives",
    fix: "Disk errors back up a failing drive or cable. Check the drive health and back up what matters." },
  { sources: ["ntfs", "microsoft-windows-ntfs"], ids: [55, 98, 137, 140], key: "log-file-system", title: "Windows logged file system errors", severity: "problem", priority: 85, issue: ISSUE_IDS.drive, area: "storage", section: "drives",
    fix: "The file system found damage. Check the drive health; a scan of the volume is needed once the drive is known to be sound." },
  { sources: ["storahci", "stornvme"], ids: [129], key: "log-storage-reset", title: "The storage controller was reset", severity: "warning", priority: 70, issue: ISSUE_IDS.drive, area: "storage", section: "drives",
    fix: "A controller reset means a request to the drive timed out. Check the drive health and the cable." },
  { sources: ["microsoft-windows-whea-logger"], ids: [1, 17, 18, 19, 47], key: "log-hardware", title: "The hardware reported an error (WHEA)", severity: "problem", priority: 86, issue: ISSUE_IDS.hardware, area: "logs",
    fix: "WHEA errors come from the processor, memory or a PCIe device. Repeated ones point at failing hardware." },
  { sources: ["service control manager"], ids: [7000, 7001, 7009, 7011, 7022, 7023, 7024, 7031, 7032, 7034], key: "log-service-failures", title: "Services failed or timed out", severity: "warning", priority: 53, issue: ISSUE_IDS.service, area: "services", section: "services",
    fix: "Read which services and why (dependency, timeout, crash). Repeated timeouts can be the load itself." },
  { sources: ["microsoft-windows-windowsupdateclient"], ids: [20, 25, 31], key: "log-update-failures", title: "Windows Update logged failures", severity: "warning", priority: 45, issue: ISSUE_IDS.update, area: "updates", section: "updates",
    fix: "Look up the error code; low disk space or a stopped update service are the usual causes." },
  { sources: ["microsoft-windows-dns-client"], ids: [1014], key: "log-dns-timeouts", title: "Name lookups timed out", severity: "warning", priority: 58, issue: ISSUE_IDS.network, area: "network", section: "network",
    fix: "The DNS servers did not answer in time. Run the network checks and test each DNS server." },
];

function logs(e: CabinetEvidence, make: Make): Part {
  const f: BundleFinding[] = [];
  let read = 0;
  for (const [label, r] of [["System", e.systemLog], ["Application", e.appLog]] as const) {
    if (!r) continue;
    if (!r.ok) { f.push(make({ id: `log-unread-${label.toLowerCase()}`, key: "log-unread", area: "logs", severity: "info", certainty: "not_checked", title: `Could not read the ${label} log`, evidence: lines([r.failure]), fix: null, priority: 15 })); continue; }
    read++;
  }
  const entries = [...(e.systemLog?.ok ? arr(e.systemLog.output.entries) : []), ...(e.appLog?.ok ? arr(e.appLog.output.entries) : [])]
    .filter(x => x && (x.level === "error" || x.level === "critical"));
  if (read === 0) return { findings: f, ok: null };
  const used = new Set<number>();
  for (const k of KNOWN_EVENTS) {
    const hits = entries.map((x, i) => ({ x, i })).filter(({ x }) => k.sources.includes(clean(x.source, 80).toLowerCase()) && k.ids.includes(num(x.eventId)));
    if (hits.length === 0) continue;
    for (const { i } of hits) used.add(i);
    const count = hits.length;
    // One blue screen or one Kernel-Power 41 is a warning on its own; a repeat is a pattern.
    const severity: BundleSeverity = k.severity === "warning" && count >= 2 && k.key === "log-unexpected-shutdown" ? "problem" : k.severity;
    f.push(make({ id: k.key, key: k.key, area: k.area, severity, certainty: "confirmed", title: `${k.title}${count > 1 ? ` (${count} times in 24 hours)` : " (in the last 24 hours)"}`,
      evidence: lines(hits.slice(0, 4).map(({ x }) => `${clean(x.time, 25)} ${clean(x.source, 40)} event ${num(x.eventId)}: ${clean(x.firstLine, 160)}`)), fix: k.fix, priority: k.priority, issueTypeId: k.issue,
      ...(k.section ? { action: { kind: "open" as const, section: k.section, label: `Open ${k.section === "crashes" ? "Crashes and restarts" : k.section === "drives" ? "Drive health" : k.section === "updates" ? "Windows updates" : k.section === "services" ? "Services" : "Network"}`, cabinetId: e.cabinet.id } } : {}) }));
  }
  // Application crashes: the program's name is read from the first line, by looking for the label, not by a pattern.
  const crashes = entries.map((x, i) => ({ x, i })).filter(({ x }) => clean(x.source, 40).toLowerCase() === "application error" && num(x.eventId) === 1000);
  if (crashes.length > 0) {
    for (const { i } of crashes) used.add(i);
    const label = "Faulting application name: ";
    const names = new Map<string, number>();
    for (const { x } of crashes) {
      const line = clean(x.firstLine, 300), at = line.indexOf(label);
      const name = at >= 0 ? line.slice(at + label.length).split(",")[0]!.trim().slice(0, 60) : "a program";
      names.set(name || "a program", (names.get(name || "a program") ?? 0) + 1);
    }
    const top = [...names.entries()].sort((a, b) => b[1] - a[1]);
    f.push(make({ id: "log-app-crashes", key: "log-app-crashes", area: "logs", severity: crashes.length >= 3 ? "warning" : "info", certainty: "confirmed", title: `${top[0]![0]} crashed${crashes.length > 1 ? ` ${crashes.length} times` : ""} in the last 24 hours`,
      evidence: lines(top.map(([n, c]) => `${n}: ${c} ${c === 1 ? "crash" : "crashes"}`)), fix: "A program that crashes repeatedly needs an update or a reinstall; the faulting module that names the cause is on the cabinet's own event log, not in what the platform receives.", priority: 44 }));
  }
  const rest = entries.filter((_, i) => !used.has(i));
  if (rest.length > 0) {
    const groups = new Map<string, { n: number; line: string }>();
    for (const x of rest) {
      const k = `${clean(x.source, 60)}|${num(x.eventId)}`, g = groups.get(k);
      if (g) g.n++; else groups.set(k, { n: 1, line: clean(x.firstLine, 140) });
    }
    const top = [...groups.entries()].sort((a, b) => b[1].n - a[1].n);
    f.push(make({ id: "log-other-errors", key: "log-other-errors", area: "logs", severity: "info", certainty: "confirmed", title: `${rest.length} other ${rest.length === 1 ? "error" : "errors"} in the System and Application logs (last 24 hours)`,
      evidence: lines(top.slice(0, 5).map(([k, g]) => `${g.n} × ${k.split("|")[0]} event ${k.split("|")[1]}: ${g.line}`)),
      fix: "Open the event logs for the full entries. An error nobody has seen before can be mapped to an issue so it is recognized next time.", priority: 30,
      action: { kind: "open", section: "events", label: "Open Event logs", cabinetId: e.cabinet.id } }));
  }
  return { findings: f, ok: f.length === 0 && read > 0 ? "No errors or critical events in the last 24 hours" : null };
}

// ---- Putting it together ------------------------------------------------------------------------------------------------------------------

const SEVERITY_RANK: Record<BundleSeverity, number> = { problem: 0, warning: 1, info: 2 };
const CERTAINTY_RANK: Record<Certainty, number> = { confirmed: 0, probable: 1, possible: 2, not_checked: 3 };

/** Most important first: severity, then how sure, then the finding's own priority. Findings explained by another go after it. */
export function rank(findings: BundleFinding[]): BundleFinding[] {
  const sorted = [...findings].sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || Number(!!a.causedBy) - Number(!!b.causedBy) || CERTAINTY_RANK[a.certainty] - CERTAINTY_RANK[b.certainty]
    || b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sorted.map((f, i) => ({ ...f, rank: i + 1 }));
}

const NETWORK_PRIORITY: Record<string, number> = { link: 90, address: 88, gateway: 86, platform: 72, dns: 70, sync: 68, firewall: 50 };

/** A network diagnosis finding as a finding of this diagnosis. Passed findings ("ok") are not carried over. */
export function fromNetwork(f: NetworkFinding): BundleFinding | null {
  if (f.severity === "ok") return null;
  const key = findingKey(f.id);
  const issue = key.startsWith("baseline-") ? ISSUE_IDS.networkBaseline : key === "firewall" ? ISSUE_IDS.firewallPolicy : ISSUE_IDS.network;
  return { id: `net-${f.id}`.slice(0, 60), key: safeKey(key), area: "network", source: "network", severity: f.severity === "info" ? "info" : f.severity, certainty: f.certainty,
    title: clean(f.title, 200), evidence: lines(f.evidence), fix: f.fix ? clean(f.fix, 500) : null, priority: NETWORK_PRIORITY[f.layer] ?? 60, issueTypeId: issue,
    ...(f.action && f.action.kind !== "open" ? { networkAction: f.action } : {}),
    ...(f.action && f.action.kind === "open" ? { action: { kind: "open" as const, section: f.action.section, label: f.action.label, cabinetId: f.action.cabinetId } } : {}),
    ...(f.causedBy ? { causedBy: `net-${f.causedBy}`.slice(0, 60) } : {}) };
}

// ---- The checks as modules (docs/spec/18-built-designs.md §2, item 4) -------------------------------------------------------

/** What a rule sees besides the evidence: the findings of the modules that ran before it in this diagnosis. */
export interface RuleContext { findings: readonly BundleFinding[] }
export type CabinetRule = (e: CabinetEvidence, make: Make, ctx: RuleContext) => Part;

/** The server rules the cabinet modules name (contracts/diagnostics/modules/cabinet-*.json). A module naming any other rule is refused. */
export const CABINET_RULES: Readonly<Record<string, CabinetRule>> = {
  "cabinet.system": (e, make) => system(e, make),
  "cabinet.storage": (e, make) => storage(e, make),
  "cabinet.performance": (e, make) => performance(e, make),
  "cabinet.scanner": (e, make) => scanner(e, make),
  "cabinet.devices": (e, make) => devices(e, make),
  "cabinet.usbPorts": (e, make) => usbPorts(e, make),
  "cabinet.services": (e, make) => services(e, make),
  // A failed update that a nearly full system drive explains points at it (cabinet-updates depends on cabinet-performance in the registry).
  "cabinet.updates": (e, make, ctx) => updates(e, make, ctx.findings.find(f => f.key === "disk-space" && f.title.toLowerCase().startsWith("c"))?.id ?? null),
  "cabinet.time": (e, make) => time(e, make),
  "cabinet.logs": (e, make) => logs(e, make),
};

/** The order the cabinet modules run in, and so the order their areas are listed. */
const CABINET_MODULE_ORDER = ["cabinet-system", "cabinet-storage", "cabinet-performance", "cabinet-scanner", "cabinet-devices", "cabinet-services", "cabinet-updates", "cabinet-time", "cabinet-logs"];
let cabinetModuleCache: readonly DiagnosticModule[] | null = null;
/** The cabinet modules, read and checked once (a module that fails its checks stops the diagnosis rather than running half). */
export function cabinetModules(): readonly DiagnosticModule[] {
  if (cabinetModuleCache) return cabinetModuleCache;
  const rules = new Set(Object.keys(CABINET_RULES));
  const byId = new Map(readModules().filter(f => f.file.startsWith("cabinet-")).map(f => { const m = parseModule(f.data, rules); return [m.id, m] as const; }));
  cabinetModuleCache = CABINET_MODULE_ORDER.map(id => { const m = byId.get(id); if (!m) throw new Error(`the ${id} module is missing`); return m; });
  if (byId.size !== CABINET_MODULE_ORDER.length) throw new Error("a cabinet module is not in the run order");
  return cabinetModuleCache;
}

/** Runs one module's rule steps in order; their findings are one part (the first step's healthy text speaks for the module). */
function runModule(m: DiagnosticModule, e: CabinetEvidence, make: Make, ctx: { findings: BundleFinding[] }): Part {
  let part: Part | null = null;
  for (const step of m.procedure) {
    if (step.kind !== "rule") continue;
    const p = CABINET_RULES[step.rule!]!(e, make, ctx);
    ctx.findings.push(...p.findings);
    part = part ? mergeParts(part, p) : p;
  }
  return part ?? { findings: [], ok: null };
}

export interface AreaSummary { area: Area; label: string; state: "ok" | "warning" | "problem" | "unknown"; summary: string }

export interface CabinetFindings { findings: BundleFinding[]; areas: AreaSummary[]; headline: string }

/**
 * Reads the evidence and says what is wrong, most important first. `network` is the network diagnosis run alongside (absent when it did
 * not run or failed: its area is then "unknown", never healthy).
 */
export function cabinetFindings(e: CabinetEvidence, network?: { findings: NetworkFinding[] } | { failure: string }): CabinetFindings {
  const make: Make = x => {
    const key = safeKey(x.key ?? findingKey(x.id));
    return { ...x, key, source: "cabinet", title: clean(x.title, 200), evidence: lines(x.evidence), fix: x.fix ? clean(x.fix, 600) : null };
  };
  const ctx = { findings: [] as BundleFinding[] };
  const parts: [Area, Part][] = cabinetModules().map(m => [m.area, runModule(m, e, make, ctx)]);
  const all: BundleFinding[] = parts.flatMap(([, p]) => p.findings);
  const asked: Record<Area, boolean> = { system: !!e.info, storage: !!e.smart, performance: !!e.performance, scanner: !!e.peripheral || e.scannerUsed === false, devices: !!e.devices || !!e.usb, services: !!e.services,
    updates: !!e.updates, time: !!e.time, logs: !!e.systemLog || !!e.appLog, network: network !== undefined };
  if (network && "findings" in network) for (const nf of network.findings) { const b = fromNetwork(nf); if (b) all.push(b); }
  else if (network && "failure" in network) all.push(make({ id: "network-unread", area: "network", severity: "info", certainty: "not_checked", title: "The network checks did not finish", evidence: lines([network.failure]), fix: "Run the diagnosis again, or run Diagnose network on the Network page.", priority: 30 }));
  const ranked = rank(all);

  const areas: AreaSummary[] = AREAS.filter(([a]) => asked[a]).map(([area, label]) => {
    const mine = ranked.filter(f => f.area === area);
    const unread = mine.length > 0 && mine.every(f => f.certainty === "not_checked");
    const state = mine.some(f => f.severity === "problem") ? "problem" : mine.some(f => f.severity === "warning") ? "warning" : unread ? "unknown" : area === "network" && network && "failure" in network ? "unknown" : "ok";
    const okText = parts.find(([a]) => a === area)?.[1].ok ?? (area === "network" ? "No network problems found" : null);
    const worst = mine[0];
    return { area, label, state, summary: state === "ok" ? okText ?? "Nothing wrong found" : worst ? worst.title : "Not checked" };
  });
  const problems = ranked.filter(f => f.severity === "problem" && !f.causedBy), warnings = ranked.filter(f => f.severity === "warning" && !f.causedBy);
  const headline = problems.length + warnings.length === 0 ? "No problems found in what was checked."
    : `${problems.length} ${problems.length === 1 ? "problem" : "problems"}, ${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}. Start with: ${(problems[0] ?? warnings[0])!.title}`;
  return { findings: ranked, areas, headline };
}

function mergeParts(a: Part, b: Part): Part {
  return { findings: [...a.findings, ...b.findings], ok: a.ok };
}
