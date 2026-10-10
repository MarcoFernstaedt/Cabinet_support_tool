// What a simulated cabinet answers to each operation. Each answer starts from the operation's own valid contract example
// and is changed to fit the cabinet and its scenario; the server checks every answer against the output schema exactly as
// it does a real agent's (storeResult), so a demo answer can never show something a real cabinet could not.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA_DIR } from "@mashura/cabinet-contracts/load";
import type { Scenario } from "./fleet.js";

const EXAMPLES = join(dirname(SCHEMA_DIR), "examples", "operations");

export interface DemoContext {
  hostname: string; role: string; scenario: Scenario; subnet: string; index: number;
  firewallProfiles: { domain: boolean; private: boolean; public: boolean };
  /** The cabinet's own stored error events, newest first, so the event log matches its alerts. */
  events: { log: string; source: string; eventId: number; level: string; occurredAt: string; message: string; recordId: number }[];
  watchedServices: string[];
  now: Date;
}

const cache = new Map<string, unknown>();
/** A deep copy of one valid output example of the operation (the named file, else the first). */
export function example(operation: string, file?: string): any {
  const dir = join(EXAMPLES, operation, "output", "valid");
  const name = file ?? readdirSync(dir).filter(f => f.endsWith(".json")).sort()[0];
  if (!name) throw new Error(`no output example for ${operation}`);
  const key = `${operation}/${name}`;
  if (!cache.has(key)) cache.set(key, JSON.parse(readFileSync(join(dir, name), "utf8")));
  return structuredClone(cache.get(key));
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const ago = (ctx: DemoContext, minutes: number) => iso(new Date(ctx.now.getTime() - minutes * 60_000));
const address = (ctx: DemoContext) => `${ctx.subnet}.${20 + ctx.index}`;

export function demoOutput(operation: string, params: Record<string, any>, ctx: DemoContext): unknown {
  switch (operation) {
    case "system.info": {
      const o = example("system.info", "typical.json");
      return { ...o, hostname: ctx.hostname, cabinetRole: ctx.role, serialNumber: `5CG${ctx.subnet.replace(/\D/g, "").slice(-3)}${ctx.index}DMO`,
        uptimeSeconds: ctx.scenario === "bsod" ? 1260 : 86_400 * (3 + ctx.index), agentVersion: "1.4.2",
        osVersion: ctx.index % 2 ? "Windows 10 IoT Enterprise LTSC 2021" : "Windows 11 IoT Enterprise LTSC 2024", osBuild: ctx.index % 2 ? "19044.5011" : "26100.2033" };
    }
    case "peripheral.status": {
      const o = example("peripheral.status", "connected.json");
      if (ctx.scenario !== "scanner_disconnected") {
        o.checks = o.checks.map((c: any) => c.check === "recent_reconnects" ? { ...c, outcome: "pass", summary: "No disconnects in the last 24 hours." } : c);
        return o;
      }
      return { ...o, connected: false, status: null, errorCode: null, errorText: null, driver: o.driver, locationInfo: null,
        checks: [
          { check: "device_present", outcome: "fail", summary: "The fingerprint scanner is not connected. It was last seen 2 hours ago on Port_#0002.Hub_#0003." },
          { check: "driver_installed", outcome: "pass", summary: "Driver oem42.inf 3.1.0.7 is installed." },
          { check: "recent_reconnects", outcome: "warn", summary: "Disconnected and reconnected 7 times in the last 24 hours before it went away: check the cable and USB port." },
          { check: "usb_power_saving", outcome: "warn", summary: "USB selective suspend is enabled for this device; Windows may power it off when idle." },
          { check: "usb_controller_errors", outcome: "pass", summary: "No USB controller or hub reports a problem." },
          { check: "biometric_service", outcome: "pass", summary: "Windows Biometric Service is running." },
        ] };
    }
    case "devices.list": {
      const o = example("devices.list", "scanner-problem.json");
      const scanner = o.devices[0];
      const ok = { ...scanner, status: "OK", errorCode: null, errorText: null };
      const others = [
        { instanceId: "PCI\\VEN_8086&DEV_15BC&SUBSYS_843E1043&REV_00\\3&11583659&0&FE", class: "Net", name: "Intel(R) Ethernet Connection (7) I219-LM", status: "OK", errorCode: null, errorText: null,
          hardwareIds: ["PCI\\VEN_8086&DEV_15BC"], driver: { name: "oem7.inf", version: "12.19.2.45", provider: "Intel" } },
        { instanceId: "USB\\ROOT_HUB30\\4&2A1B3C4D&0&0", class: "USB", name: "USB Root Hub (USB 3.0)", status: "OK", errorCode: null, errorText: null,
          hardwareIds: ["USB\\ROOT_HUB30"], driver: { name: "usbhub3.inf", version: "10.0.19041.4355", provider: "Microsoft" } },
      ].map(d => ({ ...d, driver: { ...scanner.driver, ...d.driver } }));
      if (ctx.scenario === "scanner_disconnected") return { devices: others, truncated: false };
      if (params.problemsOnly) return { devices: [], truncated: false };
      return { devices: [ok, ...others], truncated: false };
    }
    case "firewall.state": {
      const o = example("firewall.state", "typical.json");
      o.profiles = o.profiles.map((p: any) => ({ ...p, enabled: ctx.firewallProfiles[p.profile as "domain"], reenableAt: null }));
      o.snapshots = [];
      return o;
    }
    case "services.list": {
      const o = example("services.list", "typical.json");
      const failing = ctx.scenario === "service_failing";
      const bio = { ...o.services[0], state: failing ? "stopped" : "running", processId: failing ? null : 4100 + ctx.index };
      const extra = [
        ["Spooler", "Print Spooler", "C:\\Windows\\System32\\spoolsv.exe"], ["W32Time", "Windows Time", "C:\\Windows\\system32\\svchost.exe"],
        ["Dnscache", "DNS Client", "C:\\Windows\\system32\\svchost.exe"], ["WbioSrvc", "Windows Biometric Service", "C:\\Windows\\system32\\svchost.exe"],
        ["wuauserv", "Windows Update", "C:\\Windows\\system32\\svchost.exe"],
      ].map(([name, displayName, path], i) => ({ name, displayName, state: name === "wuauserv" ? "stopped" : "running", startType: name === "wuauserv" ? "manual" : "automatic",
        account: "LocalSystem", processId: name === "wuauserv" ? null : 900 + i * 37, executablePath: path, description: null, recovery: null }));
      const watched = ctx.watchedServices.map(name => name.toLowerCase() === "bioscansvc"
        ? { name, state: failing ? "failing" : "running", serviceState: failing ? "stopped" : "running", restartsToday: failing ? 3 : 0,
            consecutiveFailures: failing ? 3 : 0, lastRestartAt: failing ? ago(ctx, 12) : null, lastError: failing ? 1053 : null, checkedAt: ago(ctx, 0) }
        : { name, state: "running", serviceState: "running", restartsToday: 0, consecutiveFailures: 0, lastRestartAt: null, lastError: null, checkedAt: ago(ctx, 0) });
      return { services: [bio, o.services[1], ...extra], watched };
    }
    case "service.control": {
      const o = example("service.control");
      return { ...o, name: params.name, action: params.action, before: ctx.scenario === "service_failing" && params.name.toLowerCase() === "bioscansvc" ? "stopped" : "running",
        after: params.action === "stop" ? "stopped" : "running" };
    }
    case "disk.smart": {
      const o = example("disk.smart", "two-drives.json");
      const drive = { ...o.drives[0], serialNumber: `S4X${ctx.index}DEMO`, powerOnHours: 9000 + ctx.index * 811 };
      if (ctx.scenario === "disk_failing")
        return { drives: [{ ...drive, health: "failing", predictFailure: true, reallocatedSectors: 184, pendingSectors: 12, uncorrectableErrors: 3, temperatureCelsius: 51, wearPercent: 91 }] };
      return { drives: [drive] };
    }
    case "updates.status": {
      const o = example("updates.status", "typical.json");
      if (ctx.scenario !== "update_failure") return o;
      return { ...o, lastInstallResult: "failed", lastInstallAt: ago(ctx, 60 * 26),
        installed: [{ title: "2026-10 Cumulative Update for Windows 10 Version 21H2 (KB5050011)", kb: "KB5050011", installedAt: ago(ctx, 60 * 26), result: "failed", errorCode: -2147023293 }, ...o.installed],
        pending: [{ title: "2026-10 Cumulative Update for Windows 10 Version 21H2 (KB5050011)", kb: "KB5050011", classification: "Security Updates", isSecurity: true }, ...o.pending] };
    }
    case "network.config": {
      const o = example("network.config", "one-adapter.json");
      const a = o.adapters[0];
      a.ipv4.addresses = [{ address: address(ctx), prefixLength: 24 }];
      a.ipv4.gateways = [`${ctx.subnet}.1`];
      a.dns.servers = ctx.scenario === "dns_errors" ? [`${ctx.subnet}.10`, "10.255.255.254"] : [`${ctx.subnet}.10`, `${ctx.subnet}.11`];
      a.macAddress = `00-1B-21-${(16 + ctx.index).toString(16).toUpperCase().padStart(2, "0")}-4F-5C`;
      a.ipv6Addresses = [];
      return o;
    }
    case "network.test": {
      const ok = { target: params.target, method: params.method, resolvedTarget: null, success: true, latencyMs: 1 + (ctx.index % 4), resolvedAddresses: [], error: null };
      const resolved = params.target === "gateway" ? `${ctx.subnet}.1` : params.target === "dns_server" ? `${ctx.subnet}.${10 + (params.dnsServerIndex ?? 0)}`
        : params.target === "sync_cabinet" ? (params.syncAddress ?? `${ctx.subnet}.20`) : null;
      if (ctx.scenario === "dns_errors" && (params.method === "dns" || (params.target === "dns_server" && (params.dnsServerIndex ?? 0) === 1)))
        return { ...ok, resolvedTarget: resolved, success: false, latencyMs: null, error: "No answer within 2 seconds." };
      if (ctx.scenario === "firewall_drift" && params.target === "sync_cabinet" && params.method === "tcp")
        return { ...ok, resolvedTarget: resolved, success: false, latencyMs: null, error: `Port ${params.port ?? 1433} did not answer within 3 seconds.` };
      return { ...ok, resolvedTarget: resolved, latencyMs: params.target === "platform_server" ? 38 + ctx.index : ok.latencyMs };
    }
    case "eventlog.query": {
      const o = example("eventlog.query", "page.json");
      const log = params.log ?? "System";
      const own = ctx.events.filter(e => e.log === log).filter(e => !params.levels || params.levels.includes(e.level));
      const background = log === "System" ? [
        { recordId: 120001, time: ago(ctx, 60 * 30), level: "information", source: "Microsoft-Windows-Kernel-General", eventId: 12, firstLine: "The operating system started." },
        { recordId: 120002, time: ago(ctx, 60 * 29), level: "information", source: "Service Control Manager", eventId: 7036, firstLine: "The Windows Biometric Service service entered the running state." },
        { recordId: 120003, time: ago(ctx, 60 * 5), level: "warning", source: "Microsoft-Windows-Time-Service", eventId: 129, firstLine: "NtpClient was unable to set a domain peer to use as a time source." },
      ].filter(e => !params.levels || params.levels.includes(e.level)) : [];
      const entries = [...own.map(e => ({ recordId: e.recordId, time: e.occurredAt, level: e.level, source: e.source, eventId: e.eventId, firstLine: e.message.slice(0, 200) })), ...background]
        .sort((a, b) => b.time.localeCompare(a.time)).slice(0, 50);
      return { ...o, log, entries, nextBeforeRecordId: null, truncated: false };
    }
    case "eventlog.channels": {
      const newest = (log: string) => ctx.events.find(e => e.log === log)?.occurredAt ?? ago(ctx, 4);
      const ch = (log: string, entryCount: number, enabled = true) => ({ log, enabled, entryCount: enabled ? entryCount : null, sizeBytes: enabled ? entryCount * 1150 : null,
        newestEntryAt: enabled ? newest(log) : null, available: true });
      return { channels: [ch("System", 18_000 + ctx.index * 911), ch("Application", 9_400 + ctx.index * 377), ch("Setup", 410),
        ch("Microsoft-Windows-DNS-Client/Operational", 2_300, ctx.scenario === "dns_errors"),
        ch("Microsoft-Windows-Biometrics/Operational", 1_250), ch("Microsoft-Windows-WindowsUpdateClient/Operational", 3_100)] };
    }
    case "firewall.applyPolicy": {
      const o = example("firewall.applyPolicy");
      const wanted = (p: string) => params.profiles?.[p] === undefined ? ctx.firewallProfiles[p as "domain"] : params.profiles[p] === "on" || params.profiles[p] === true;
      const row = (p: string, enabled: boolean) => ({ profile: p, enabled, defaultInbound: "block", defaultOutbound: "allow", reenableAt: null });
      const names = ["domain", "private", "public"];
      return { ...o, before: names.map(p => row(p, ctx.firewallProfiles[p as "domain"])), after: names.map(p => row(p, wanted(p))),
        changed: names.filter(p => ctx.firewallProfiles[p as "domain"] !== wanted(p)), snapshotId: crypto.randomUUID(), safetyNetDeadline: ago(ctx, -2) };
    }
    case "firewall.setProfile": {
      const o = example("firewall.setProfile");
      const enabled = params.enabled ?? params.state === "on";
      const row = (on: boolean) => ({ profile: params.profile, enabled: on, defaultInbound: "block", defaultOutbound: "allow", reenableAt: null });
      return { ...o, profile: params.profile, before: row(ctx.firewallProfiles[params.profile as "domain"]),
        after: { ...row(enabled), reenableAt: !enabled && params.durationMinutes ? ago(ctx, -params.durationMinutes) : null }, snapshotId: crypto.randomUUID(), safetyNetDeadline: ago(ctx, -2) };
    }
    default:
      return example(operation);
  }
}
