// What a simulated cabinet answers to each operation. Each answer starts from the operation's own valid contract example
// and is changed to fit the cabinet and its scenario; the server checks every answer against the output schema exactly as
// it does a real agent's (storeResult), so a demo answer can never show something a real cabinet could not.
import { applySetDns, applySetIp, dnsAnswers, reachesGateway, type DemoNet } from "./network.js";
import type { NetworkBaseline } from "../diagnose/network-findings.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  /** Start types set from the console on this simulated cabinet, by lower-case service name. */
  startTypes: Record<string, string>;
  /** Whether the site's sync cabinet (another cabinet) has a firewall profile on, so its ports do not answer. */
  syncBlocked: boolean;
  now: Date;
  /** The cabinet's Windows time zone and how far its clock is from the server's, as its heartbeat reports them. */
  timeZoneId: string;
  clockSkewSeconds: number;
  /** The cabinet's own network settings and its site's baseline (what the site's network really is). */
  net: DemoNet;
  baseline: NetworkBaseline;
}

/** Whether the contract examples the simulated cabinets answer from are on disk (a deployment must ship them). */
export const examplesAvailable = (): boolean => existsSync(EXAMPLES);

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

/** Standard UTC offset (minutes), display name, and whether the zone observes United States daylight saving. */
const ZONES: Record<string, [number, string, boolean]> = {
  "Eastern Standard Time": [-300, "(UTC-05:00) Eastern Time (US & Canada)", true], "Central Standard Time": [-360, "(UTC-06:00) Central Time (US & Canada)", true],
  "Mountain Standard Time": [-420, "(UTC-07:00) Mountain Time (US & Canada)", true], "US Mountain Standard Time": [-420, "(UTC-07:00) Arizona", false],
  "Pacific Standard Time": [-480, "(UTC-08:00) Pacific Time (US & Canada)", true], "Alaskan Standard Time": [-540, "(UTC-09:00) Alaska", true],
  "Hawaiian Standard Time": [-600, "(UTC-10:00) Hawaii", false],
};
/** United States daylight saving: from the second Sunday in March to the first Sunday in November (at 2:00 local, here taken as 2:00 standard). */
function usDaylightSaving(utc: Date, standardOffset: number): boolean {
  const local = new Date(utc.getTime() + standardOffset * 60_000);
  const y = local.getUTCFullYear();
  const nthSunday = (month: number, n: number) => { const d = new Date(Date.UTC(y, month, 1)); return 1 + ((7 - d.getUTCDay()) % 7) + (n - 1) * 7; };
  const start = Date.UTC(y, 2, nthSunday(2, 2), 2), end = Date.UTC(y, 10, nthSunday(10, 1), 1);
  return local.getTime() >= start && local.getTime() < end;
}
const noMs = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** time.status as a real cabinet in this zone, with this clock offset, would answer it. */
function timeStatus(ctx: DemoContext) {
  const [standard, name, observes] = ZONES[ctx.timeZoneId] ?? [-300, ctx.timeZoneId, true];
  const clock = new Date(ctx.now.getTime() + ctx.clockSkewSeconds * 1000);
  const dst = observes && usDaylightSaving(clock, standard);
  const offset = standard + (dst ? 60 : 0);
  return { timeZoneId: ctx.timeZoneId, timeZoneName: name, utcOffsetMinutes: offset, daylightSavingNow: dst,
    localTime: new Date(clock.getTime() + offset * 60_000).toISOString().slice(0, 19), utcTime: noMs(clock), timeService: "running",
    sync: { state: "synced", source: "time.windows.com,0x9",
      lastSuccessfulSync: noMs(new Date(ctx.now.getTime() - (ctx.scenario === "clock_drift" ? 19 * 86_400_000 : 3 * 3_600_000))) },
    policyManaged: false };
}

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
      if (ctx.scenario !== "scanner_disconnected" && ctx.scenario !== "scanner_flapping" && ctx.scenario !== "usb_missing") {
        o.checks = o.checks.map((c: any) => c.check === "recent_reconnects" ? { ...c, outcome: "pass", summary: "No disconnects in the last 24 hours." } : c);
        return o;
      }
      if (ctx.scenario === "usb_missing") return { ...o, connected: false, status: null, errorCode: null, errorText: null, driver: o.driver, locationInfo: null,
        checks: [
          { check: "device_present", outcome: "fail", summary: "Nothing is detected on any of this cabinet's 3 USB ports. The scanner was expected on Port_#0002.Hub_#0003 and was last seen 3 hours ago." },
          { check: "driver_installed", outcome: "pass", summary: "Driver oem42.inf 3.1.0.7 is installed." },
          { check: "recent_reconnects", outcome: "pass", summary: "No disconnects before it went away: it was unplugged, or its cable came out." },
          { check: "usb_controller_errors", outcome: "pass", summary: "No USB controller or hub reports a problem, so the ports themselves look fine." },
          { check: "biometric_service", outcome: "pass", summary: "Windows Biometric Service is running." },
        ] };
      return { ...o, connected: false, status: null, errorCode: null, errorText: null, driver: o.driver, locationInfo: null,
        checks: [
          { check: "device_present", outcome: "fail", summary: "The fingerprint scanner is not connected. It was last seen 2 hours ago on Port_#0002.Hub_#0003." },
          { check: "driver_installed", outcome: "pass", summary: "Driver oem42.inf 3.1.0.7 is installed." },
          { check: "recent_reconnects", outcome: "warn", summary: ctx.scenario === "scanner_flapping" ? "Disconnected and reconnected 2 times in the last 24 hours, and it has now gone away for good: 3 drops in all." : "Disconnected and reconnected 7 times in the last 24 hours before it went away: check the cable and USB port." },
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
      if (ctx.scenario === "scanner_disconnected" || ctx.scenario === "scanner_flapping" || ctx.scenario === "usb_missing") return { devices: others, truncated: false };
      if (params.problemsOnly) return { devices: [], truncated: false };
      return { devices: [ok, ...others], truncated: false };
    }
    case "usb.ports": {
      // The USB tree behind the monitor: the scanner on port 2 of hub 3, and what Windows still remembers of it when it is gone.
      const down = ctx.scenario === "scanner_disconnected" || ctx.scenario === "scanner_flapping" || ctx.scenario === "usb_missing";
      const dev = (instanceId: string, name: string, kind: "hub" | "device", hub: number | null, port: number | null, over: Record<string, unknown> = {}) => ({
        instanceId, name, kind, location: hub === null ? null : `Port_#${String(port).padStart(4, "0")}.Hub_#${String(hub).padStart(4, "0")}`, hubNumber: hub, portNumber: port,
        present: true, status: "OK", errorCode: null, errorText: null, hardwareIds: [instanceId.split("\\").slice(0, 2).join("\\")], ...over });
      const devices = [
        dev("USB\\ROOT_HUB30\\4&2A1B3C4D&0&0", "USB Root Hub (USB 3.0)", "hub", null, null),
        dev("USB\\VID_0BDA&PID_5411\\5&2F3A1B&0&1", "Generic USB Hub", "hub", 1, 1),
        dev("USB\\VID_046D&PID_C31C\\5&2F3A1B&0&3", "USB Input Device", "device", 3, 3),
        dev("USB\\VID_27C6&PID_5395\\6&2B1A3C&0&2", "Goodix Fingerprint Device", "device", 3, 2,
          down ? { present: false, status: "Not connected" } : {}),
        ...(ctx.scenario === "scanner_flapping" ? [dev("USB\\VID_0000&PID_0002\\5&2F3A1B&0&4", "Unknown USB Device (Device Descriptor Request Failed)", "device", 3, 4,
          { status: "Error", errorCode: 43, errorText: "Windows stopped this device because it reported problems. Unplug it, wait ten seconds and plug it into a different USB port.", hardwareIds: [] })] : []),
      ];
      return { takenAt: noMs(ctx.now), devices, truncated: false };
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
      const start = (name: string, fallback: string) => ctx.startTypes[name.toLowerCase()] ?? fallback;
      const bio = { ...o.services[0], startType: start(o.services[0].name, o.services[0].startType), state: failing ? "stopped" : "running", processId: failing ? null : 4100 + ctx.index };
      const extra = [
        ["Spooler", "Print Spooler", "C:\\Windows\\System32\\spoolsv.exe"], ["W32Time", "Windows Time", "C:\\Windows\\system32\\svchost.exe"],
        ["Dnscache", "DNS Client", "C:\\Windows\\system32\\svchost.exe"], ["WbioSrvc", "Windows Biometric Service", "C:\\Windows\\system32\\svchost.exe"],
        ["wuauserv", "Windows Update", "C:\\Windows\\system32\\svchost.exe"], ["BioUpdateSvc", "Biometric Update Service", "C:\\Program Files\\Biometrics\\update.exe"],
      ].map(([name, displayName, path], i) => { name = name!;
        const type = start(name!, name === "wuauserv" ? "manual" : name === "BioUpdateSvc" ? "disabled" : "automatic");
        const running = name !== "wuauserv" && !(name === "BioUpdateSvc" && type === "disabled");
        return { name, displayName, state: running ? "running" : "stopped", startType: type, account: "LocalSystem", processId: running ? 900 + i * 37 : null, executablePath: path, description: null, recovery: null };
      });
      const watched = ctx.watchedServices.map(name => name.toLowerCase() === "bioscansvc"
        ? { name, state: failing ? "failing" : "running", serviceState: failing ? "stopped" : "running", restartsToday: failing ? 3 : 0,
            consecutiveFailures: failing ? 3 : 0, lastRestartAt: failing ? ago(ctx, 12) : null, lastError: failing ? 1053 : null, checkedAt: ago(ctx, 0) }
        : { name, state: "running", serviceState: "running", restartsToday: 0, consecutiveFailures: 0, lastRestartAt: null, lastError: null, checkedAt: ago(ctx, 0) });
      return { services: [bio, o.services[1], ...extra], watched };
    }
    case "time.status": return timeStatus(ctx);
    case "time.setZone": return { before: ctx.timeZoneId, after: params.timeZoneId };
    case "time.sync": {
      const last = new Date(ctx.now.getTime() - 3 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
      return { result: "synced", message: "Windows Time synchronized the clock with time.windows.com,0x9.", lastSuccessfulSyncBefore: last,
        lastSuccessfulSyncAfter: ctx.now.toISOString().replace(/\.\d{3}Z$/, "Z") };
    }
    case "service.setStartType": {
      const known: Record<string, string> = { wuauserv: "manual", bioupdatesvc: "disabled" };
      const name = String(params.name).toLowerCase();
      return { name: params.name, before: ctx.startTypes[name] ?? known[name] ?? "automatic", after: params.startType };
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
      const a = o.adapters[0], n = ctx.net;
      a.connected = n.linkUp; a.linkSpeedBps = n.linkUp ? n.speedBps : null;
      a.ipv4 = { dhcp: n.mode === "dhcp", addresses: [{ address: n.address, prefixLength: n.prefixLength }], gateways: n.gateway ? [n.gateway] : [] };
      a.dns = { automatic: n.dnsAutomatic, servers: [...n.dns] };
      a.macAddress = `00-1B-21-${(16 + ctx.index).toString(16).toUpperCase().padStart(2, "0")}-4F-5C`;
      a.ipv6Addresses = n.linkUp ? [`fe80::${(0x21b + ctx.index).toString(16)}:4fff:fe5c:${(100 + ctx.index).toString(16)}`] : [];
      // The full read: the DHCP lease, the size limit, the card's counters, the routes and the ARP table.
      const hasLease = n.mode === "dhcp" && !n.address.startsWith("169.254.");
      const flaky = ctx.scenario === "net_flaky", slow = ctx.scenario === "net_link_slow";
      a.details = {
        dhcpServer: hasLease ? `${ctx.subnet}.2` : null,
        leaseObtained: hasLease ? ago(ctx, 8 * 60) : null, leaseExpires: hasLease ? iso(new Date(ctx.now.getTime() + 16 * 3_600_000)) : null,
        mtu: 1500,
        interfaceMetric: 25, adminStatus: "up", netbios: "default",
        driver: { provider: "Intel", version: "12.19.1.37", date: "2022-03-14T00:00:00Z" },
        networkProfile: n.linkUp ? { name: "clinic.example", category: ctx.firewallProfiles.domain ? "domain" : "private" } : null,
        statistics: { bytesReceived: 8_123_456_789 + ctx.index * 1_000_000, bytesSent: 2_123_456_789 + ctx.index * 500_000,
          receiveErrors: flaky ? 4_812 : slow ? 37 : 0, sendErrors: flaky ? 96 : 0, receiveDiscards: flaky ? 912 : 3, sendDiscards: 0 },
      };
      const mac = (last: number) => `AC-1F-6B-${ctx.subnet.split(".").map(x => Number(x).toString(16).toUpperCase().padStart(2, "0")).slice(1, 3).join("-")}-${last.toString(16).toUpperCase().padStart(2, "0")}`;
      o.routes = n.gateway ? [{ destination: "0.0.0.0", prefixLength: 0, nextHop: n.gateway, metric: 25, interfaceIndex: a.interfaceIndex },
        { destination: ctx.subnet + ".0", prefixLength: n.prefixLength, nextHop: "0.0.0.0", metric: 281, interfaceIndex: a.interfaceIndex }] : [];
      o.neighbors = !n.linkUp || !n.gateway ? [] : [
        { interfaceIndex: a.interfaceIndex, address: n.gateway, macAddress: reachesGateway(n, ctx.baseline) ? mac(1) : null, state: reachesGateway(n, ctx.baseline) ? (flaky ? "stale" : "reachable") : "incomplete" },
        ...(ctx.role === "sync" ? [] : [{ interfaceIndex: a.interfaceIndex, address: `${ctx.subnet}.20`, macAddress: mac(20), state: "stale" }])];
      o.proxy = { winHttp: null, userProxyEnabled: null, userProxyServer: null };
      // Some cabinets also have the cash drawer link: an Ethernet adapter on an unidentified network with a fixed address and no gateway.
      // Its counters grow with the clock so two readings seconds apart show traffic.
      if (ctx.index % 3 === 0 || ctx.role === "sync") {
        const secs = Math.floor(Date.now() / 1000) % 100_000;
        o.adapters.push({ ...JSON.parse(JSON.stringify(a)), interfaceIndex: a.interfaceIndex + 1, name: "Ethernet 2", description: "USB Ethernet Adapter (drawer link)",
          connected: true, linkSpeedBps: 100_000_000, macAddress: `00-E0-4C-68-${(16 + ctx.index).toString(16).toUpperCase().padStart(2, "0")}-A1`, ipv6Addresses: [],
          ipv4: { dhcp: false, addresses: [{ address: `172.20.1.${10 + ctx.index}`, prefixLength: 24 }], gateways: [] }, dns: { automatic: false, servers: [] }, dnsSuffix: null,
          details: { dhcpServer: null, leaseObtained: null, leaseExpires: null, mtu: 1500, interfaceMetric: 50, adminStatus: "up", netbios: "default",
            driver: { provider: "Realtek", version: "10.50.0.1", date: "2021-06-09T00:00:00Z" }, networkProfile: { name: "Unidentified network", category: "public" },
            statistics: { bytesReceived: 40_000_000 + secs * 900, bytesSent: 12_000_000 + secs * 400, receiveErrors: 0, sendErrors: 0, receiveDiscards: 0, sendDiscards: 0 } } });
      }
      return o;
    }
    case "network.test": {
      const n = ctx.net, b = ctx.baseline, up = reachesGateway(n, b);
      const ok = { target: params.target, method: params.method, resolvedTarget: null, success: true, latencyMs: 1 + (ctx.index % 4), resolvedAddresses: [], error: null };
      const fail = (resolvedTarget: string | null, error: string) => ({ ...ok, resolvedTarget, success: false, latencyMs: null, error });
      const server = n.dns[params.dnsServerIndex ?? 0];
      const resolved = params.target === "gateway" ? n.gateway : params.target === "dns_server" ? server ?? null
        : params.target === "sync_cabinet" ? (params.syncAddress ?? `${ctx.subnet}.20`) : null;
      const series = (r: any) => {
        if ((params.method !== "ping" && params.method !== "tcp") || !(params.count > 1)) return r;
        const sent = params.count;
        if (!r.success) return { ...r, statistics: { sent, received: 0, lossPercent: 100, minMs: null, avgMs: null, maxMs: null, jitterMs: null } };
        const flaky = ctx.scenario === "net_flaky" && (params.target === "gateway" || (params.target === "sync_cabinet" && params.method === "tcp"));
        const received = flaky ? Math.max(1, sent - Math.ceil(sent / 4)) : sent;
        const avg = flaky ? 24.3 : r.latencyMs ?? 1;
        return { ...r, latencyMs: avg, statistics: { sent, received, lossPercent: Math.round(1000 * (sent - received) / sent) / 10,
          minMs: flaky ? 1.8 : Math.max(0.2, avg - 0.4), avgMs: avg, maxMs: flaky ? 61.2 : avg + 0.5, jitterMs: flaky ? 18.4 : 0.2 } };
      };
      if (!n.linkUp) return fail(resolved, "The network cable is unplugged.");
      if (params.target === "gateway") return series(n.gateway === null ? fail(null, "No default gateway is set.") : up ? { ...ok, resolvedTarget: resolved } : fail(resolved, "No answer within 2 seconds."));
      if (params.target === "dns_server") return server === undefined ? fail(null, "No DNS server is set.") : dnsAnswers(n, b, server) ? { ...ok, resolvedTarget: resolved } : fail(resolved, "No answer within 2 seconds.");
      if (params.target === "platform_server") return up && n.dns.some(s => dnsAnswers(n, b, s)) ? { ...ok, latencyMs: 38 + ctx.index } : fail(null, "The name could not be resolved.");
      if (params.target === "sync_cabinet" && !up) return series(fail(resolved, params.method === "tcp" ? `Port ${params.port ?? 1433} did not answer within 3 seconds.` : "No answer within 2 seconds."));
      if (ctx.syncBlocked && params.target === "sync_cabinet" && params.method === "tcp") return series(fail(resolved, `Port ${params.port ?? 1433} did not answer within 3 seconds.`));
      return series({ ...ok, resolvedTarget: resolved });
    }
    case "network.trace": {
      const n = ctx.net, b = ctx.baseline, up = reachesGateway(n, b);
      const rtt = (base: number) => [0, 1, 2].map(i => Math.round((base + (ctx.index % 3) * 0.1 + i * 0.1) * 10) / 10);
      const silent = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ hop: from + i, address: null, rttMs: [null, null, null] }));
      const target = params.target === "gateway" ? n.gateway : params.target === "sync_cabinet" ? (params.syncAddress ?? `${ctx.subnet}.20`)
        : params.target === "platform_server" ? "203.0.113.10" : n.dns[params.dnsServerIndex ?? 0] ?? null;
      if (!n.linkUp || target === null || !up) return { target: params.target, resolvedTarget: target, reached: false, hops: silent(1, 4), error: "No reply after hop 0." };
      const flaky = ctx.scenario === "net_flaky";
      const first = { hop: 1, address: b.gateway, rttMs: flaky ? [0.9, null, 21.4] : rtt(0.5) };
      if (params.target === "gateway") return { target: params.target, resolvedTarget: target, reached: true, hops: [first], error: null };
      if (params.target === "dns_server" || params.target === "sync_cabinet") return { target: params.target, resolvedTarget: target, reached: true, hops: [{ ...first, address: target, rttMs: flaky ? [1.2, null, 25.6] : rtt(0.6) }], error: null };
      return { target: params.target, resolvedTarget: target, reached: true, error: null,
        hops: [first, { hop: 2, address: "100.64.0.1", rttMs: rtt(4.2) }, { hop: 3, address: "198.51.100.9", rttMs: rtt(8.7) }, { hop: 4, address: target, rttMs: rtt(12.1 + (ctx.index % 5)) }] };
    }
    case "system.performance": {
      const o = example("system.performance", "typical.json");
      const slow = ctx.scenario === "service_failing", diskFull = ctx.scenario === "disk_space_low";
      const gb = 1024 ** 3, wobble = (ctx.index % 5) * 1.5;
      const cpu = slow ? 93.2 : 14 + wobble;
      const total = o.memory.totalBytes, free = slow ? Math.round(0.4 * gb) : Math.round((3.2 - (ctx.index % 3) * 0.3) * gb);
      const proc = (name: string, id: number, cpuPercent: number, mb: number) => ({ name, id, cpuPercent, workingSetBytes: mb * 1024 * 1024 });
      return { ...o, takenAt: noMs(ctx.now),
        cpu: { ...o.cpu, usedPercent: cpu, queueLength: slow ? 6 : 0 },
        memory: { ...o.memory, totalBytes: total, availableBytes: free, pagesPerSecond: slow ? 410 : 2.5 },
        volumes: o.volumes.map((v: any) => ({ ...v, freeBytes: diskFull ? Math.round(0.6 * gb) : v.freeBytes })),
        physicalDisks: o.physicalDisks.map((d: any) => ({ ...d, busyPercent: slow ? 97 : 6 + wobble, queueLength: slow ? 8.4 : 0.1 })),
        byCpu: slow ? [proc("MsMpEng", 3120, 71.5, 380), proc("CabinetApp", 4412, 12.4, 640), proc("svchost", 1180, 4.1, 96)] : [proc("CabinetApp", 4412, 9.4 + wobble, 412), proc("sqlservr", 2100, 3.1, 1200)],
        byMemory: slow ? [proc("sqlservr", 2100, 2, 3400), proc("CabinetApp", 4412, 12.4, 640), proc("MsMpEng", 3120, 71.5, 380)] : [proc("sqlservr", 2100, 3.1, 1200), proc("CabinetApp", 4412, 9.4, 412)] };
    }
    case "network.listeners": {
      const o = example("network.listeners", "typical.json");
      const appUp = !ctx.syncBlocked;
      const listeners = appUp ? o.listeners : o.listeners.filter((l: any) => l.port !== 1433);
      return { ...o, takenAt: noMs(ctx.now), listeners, counts: { ...o.counts, listening: listeners.length },
        established: ctx.net.linkUp ? o.established.map((e: any) => ({ ...e, remoteAddress: `${ctx.subnet}.20` })) : [],
        };
    }
    case "network.setIp": {
      const next = applySetIp(ctx.net, ctx.baseline, ctx.subnet, ctx.index, params as never);
      const ip = (n: DemoNet) => ({ dhcp: n.mode === "dhcp", addresses: [{ address: n.address, prefixLength: n.prefixLength }], gateways: n.gateway ? [n.gateway] : [] });
      return { interfaceIndex: params.interfaceIndex, before: ip(ctx.net), after: ip(next), safetyNetDeadline: noMs(new Date(ctx.now.getTime() + 120_000)) };
    }
    case "network.renewLease": {
      const fixed = ctx.net.mode === "dhcp";
      const after = !fixed ? ctx.net.address : ctx.scenario === "net_dhcp_failed" ? `${ctx.subnet}.${100 + ctx.index}` : ctx.net.address;
      return { interfaceIndex: params.interfaceIndex, result: !fixed ? "not_dhcp" : "renewed",
        message: !fixed ? "This adapter has a fixed address, so there is no lease to renew." : "The DHCP server gave a lease.", addressBefore: ctx.net.address, addressAfter: after };
    }
    case "network.setDns": {
      const next = applySetDns(ctx.net, ctx.baseline, params as never);
      return { interfaceIndex: params.interfaceIndex, before: { automatic: ctx.net.dnsAutomatic, servers: ctx.net.dns }, after: { automatic: next.dnsAutomatic, servers: next.dns },
        safetyNetDeadline: noMs(new Date(ctx.now.getTime() + 120_000)) };
    }
    case "eventlog.query": {
      const o = example("eventlog.query", "page.json");
      const log = params.log ?? "System";
      const own = ctx.events.filter(e => e.log === log).filter(e => !params.levels || params.levels.includes(e.level)).filter(e => !params.source || e.source === params.source);
      const background = log === "System" ? [
        { recordId: 120001, time: ago(ctx, 60 * 30), level: "information", source: "Microsoft-Windows-Kernel-General", eventId: 12, firstLine: "The operating system started." },
        { recordId: 120002, time: ago(ctx, 60 * 29), level: "information", source: "Service Control Manager", eventId: 7036, firstLine: "The Windows Biometric Service service entered the running state." },
        { recordId: 120003, time: ago(ctx, 60 * 5), level: "warning", source: "Microsoft-Windows-Time-Service", eventId: 129, firstLine: "NtpClient was unable to set a domain peer to use as a time source." },
      ].filter(e => !params.levels || params.levels.includes(e.level)).filter(e => !params.source || e.source === params.source) : [];
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
