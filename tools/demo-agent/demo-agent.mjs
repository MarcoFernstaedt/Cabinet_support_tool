#!/usr/bin/env node
// Simulated Cabinet Agents for demos and browser testing.
//
// Each simulated cabinet speaks the real Agent wire protocol to the real
// Cabinet Server: it registers, waits for an administrator to approve it in
// the web Console, then sends heartbeats and full inventories and answers
// observation-only diagnostics (process list, event log view). All telemetry
// is synthetic. Never point this at a production Server: it would create
// pending registrations there.
//
//   DEMO_AGENT_KEY=<shared secret> node tools/demo-agent/demo-agent.mjs
//
// Environment:
//   DEMO_SERVER             Server origin (default http://127.0.0.1:5009)
//   DEMO_AGENT_KEY          AgentAuth:SharedSecret configured on the Server (required)
//   DEMO_CABINETS           Comma-separated hostnames (default three cabinets)
//   DEMO_STATE              JSON file that keeps machine IDs stable across runs
//   DEMO_HEARTBEAT_SECONDS  Heartbeat interval (default 20)
//   DEMO_POLL_SECONDS       Registration/action poll interval (default 5)
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const env = process.env;
const SERVER = (env.DEMO_SERVER ?? "http://127.0.0.1:5009").replace(/\/$/, "");
const KEY = env.DEMO_AGENT_KEY;
const HOSTS = (env.DEMO_CABINETS ?? "VEG-PHX-CAB01,VEG-PHX-CAB02,VEG-CHD-CAB01").split(",").map(s => s.trim()).filter(Boolean);
const STATE = env.DEMO_STATE ?? new URL("./.demo-agent-state.json", import.meta.url).pathname;
const HEARTBEAT = Math.max(5, Number(env.DEMO_HEARTBEAT_SECONDS ?? 20)) * 1000;
const POLL = Math.max(2, Number(env.DEMO_POLL_SECONDS ?? 5)) * 1000;
const FULL_EVERY = 10 * 60_000;
const VERSION = "1.4.0-demo";

if (!KEY) { console.error("Set DEMO_AGENT_KEY to the Server's AgentAuth:SharedSecret."); process.exit(1); }
const remote = new URL(SERVER);
if (remote.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(remote.hostname)) {
  console.error("Refusing to send the agent key over plain HTTP to a non-loopback Server."); process.exit(1);
}

let state = {};
try { state = JSON.parse(readFileSync(STATE, "utf8")); } catch { /* first run */ }
const machineIdFor = host => (state[host] ??= `DEMO-${randomUUID()}`);
HOSTS.forEach(machineIdFor);
writeFileSync(STATE, JSON.stringify(state, null, 2));

const log = (host, msg) => console.log(`[agent ${host}] ${new Date().toLocaleTimeString()} ${msg}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (base, spread) => Math.max(0, base + (Math.random() * 2 - 1) * spread);
const round = v => Math.round(v * 10) / 10;

async function call(c, method, path, body) {
  const res = await fetch(SERVER + path, {
    method,
    headers: { "Content-Type": "application/json", "X-Mashura-Agent-Key": KEY, "X-Mashura-Machine-Id": c.machineId },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, data };
}

// Each cabinet gets a personality so the fleet shows a realistic mix.
const PROFILES = [
  { cpu: 18, ram: 46, disk: 58, updates: 2, note: "healthy" },
  { cpu: 35, ram: 90, disk: 41, updates: 4, note: "memory pressure (Warning)" },
  { cpu: 12, ram: 38, disk: 9, updates: 17, note: "low disk + many updates (Warning)" },
  { cpu: 22, ram: 52, disk: 64, updates: 0, note: "healthy" },
];

const SERVICES = [
  ["MashuraCabinetAgent", "Mashura Cabinet Agent", "Running", "Automatic"],
  ["MashuraCabinetService", "Mashura Cabinet Service", "Running", "Automatic"],
  ["MashuraDispenseController", "Mashura Dispense Controller", "Running", "Automatic"],
  ["MashuraSyncService", "Mashura Sync Service", "Running", "AutomaticDelayed"],
  ["Spooler", "Print Spooler", "Running", "Automatic"],
  ["W32Time", "Windows Time", "Running", "Manual"],
  ["Dnscache", "DNS Client", "Running", "Automatic"],
  ["wuauserv", "Windows Update", "Stopped", "Manual"],
  ["BITS", "Background Intelligent Transfer Service", "Running", "AutomaticDelayed"],
  ["WSearch", "Windows Search", "Stopped", "Disabled"],
];
const PROCESSES = ["System", "smss.exe", "csrss.exe", "wininit.exe", "services.exe", "lsass.exe", "svchost.exe", "svchost.exe", "svchost.exe",
  "explorer.exe", "MashuraCabinetUI.exe", "MashuraDispenseHost.exe", "MashuraSyncAgent.exe", "CabinetPlatform.Agent.exe", "spoolsv.exe", "dwm.exe", "SearchHost.exe", "msedge.exe"];

function sample(c) {
  const p = c.profile;
  c.cpu = round(Math.min(99, Math.max(1, jitter(p.cpu, 8))));
  c.ram = round(Math.min(99, Math.max(5, jitter(p.ram, 3))));
  c.diskFree = round(Math.max(1, p.disk + jitter(0, 0.4)));
}

function payload(c, full) {
  sample(c);
  const now = new Date();
  const total = 256 * 1024 ** 3;
  const disks = [
    { driveLetter: "C:", label: "OS", fileSystem: "NTFS", totalBytes: total, freeBytes: Math.round(total * c.diskFree / 100), freePercent: c.diskFree,
      bitLockerStatus: "EncryptedUnlocked", healthStatus: "Healthy",
      smart: full ? { source: "StorageReliabilityCounter", temperatureCelsius: Math.round(jitter(38, 3)), powerOnHours: 14_210 + c.index * 900, wear: 4 + c.index,
        reallocatedSectorCount: 0, pendingSectorCount: 0, serialNumber: `DEMO-SSD-${c.index + 1}000${c.index}`, model: "Demo NVMe 256GB" } : undefined },
  ];
  const base = {
    agentVersion: VERSION, cabinetId: c.cabinetId, machineId: c.machineId, collectedAtUtc: now.toISOString(),
    performance: { cpuTotalPercent: c.cpu, ramUsedPercent: c.ram, ramTotalBytes: 16 * 1024 ** 3, ramAvailableBytes: Math.round(16 * 1024 ** 3 * (1 - c.ram / 100)) },
    disks,
    windowsUpdate: { pendingUpdateCount: c.profile.updates, rebootPending: c.profile.updates > 10 },
    system: { hostname: c.host, systemTimeUtc: now.toISOString(), anyUserLoggedOn: true, loggedOnUserCount: 1, uptime: uptime(c) },
  };
  if (!full) return base;
  return {
    ...base,
    system: {
      ...base.system, osVersion: "Windows 10 IoT Enterprise LTSC 2021", osBuild: "19044.4651", timeZoneId: c.index === 2 ? "US Mountain Standard Time" : "US Mountain Standard Time",
      installDateUtc: "2025-03-14T16:00:00Z", lastBootUtc: c.bootedAt.toISOString(), domainOrWorkgroup: "VEG-CLINICAL", isDomainJoined: true,
      installedSoftware: [
        { name: "Mashura Cabinet Suite", version: "7.3.2", publisher: "Mashura" },
        { name: "Mashura Cabinet Agent", version: VERSION, publisher: "Mashura" },
        { name: "Microsoft Edge", version: "129.0.2792.65", publisher: "Microsoft Corporation" },
        { name: "Zebra Printer Driver", version: "8.4.1", publisher: "Zebra Technologies" },
      ],
    },
    services: SERVICES.map(([name, displayName, st, startType]) => ({ name, displayName, state: st, startType, runAsAccount: "LocalSystem" })),
    network: {
      adapters: [{ name: "Ethernet", description: "Intel(R) Ethernet Connection I219-LM", macAddress: `00-1B-21-00-00-0${c.index}`, status: "Up", linkSpeedBps: 1_000_000_000,
        ipAddresses: [`192.0.2.${21 + c.index}`], subnetMasks: ["255.255.255.0"], gateways: ["192.0.2.1"], dnsServers: ["192.0.2.10", "192.0.2.11"], dhcpEnabled: false }],
      proxyConfigured: false, firewallDomainEnabled: true, firewallPrivateEnabled: true, firewallPublicEnabled: true, serverReachable: true, serverLatencyMs: round(jitter(28, 6)),
    },
    windowsUpdate: {
      ...base.windowsUpdate,
      lastSuccessfulInstallUtc: new Date(Date.now() - 9 * 86400_000).toISOString(),
      pendingUpdates: Array.from({ length: Math.min(c.profile.updates, 6) }, (_, i) => ({
        updateId: `demo-update-${c.index}-${i}`, title: i === 0 ? "2026-09 Cumulative Update for Windows 10 (KB5049999)" : `Demo update ${i + 1}`,
        classification: i === 0 ? "SecurityUpdate" : "Update", isSecurity: i === 0, sizeBytes: (40 + i * 13) * 1024 ** 2 })),
      history: [{ title: "2026-08 Cumulative Update for Windows 10", resultCode: "Succeeded", dateUtc: new Date(Date.now() - 9 * 86400_000).toISOString() },
        { title: "Microsoft Defender Antivirus definition update", resultCode: "Succeeded", dateUtc: new Date(Date.now() - 2 * 86400_000).toISOString() }],
    },
  };
}

function uptime(c) {
  const s = Math.floor((Date.now() - c.bootedAt) / 1000);
  const d = Math.floor(s / 86400), hh = String(Math.floor(s / 3600) % 24).padStart(2, "0"), mm = String(Math.floor(s / 60) % 60).padStart(2, "0"), ss = String(s % 60).padStart(2, "0");
  return `${d}.${hh}:${mm}:${ss}`;
}

function processList(c) {
  let pid = 4;
  return PROCESSES.map((name, i) => ({
    name, pid: (pid += 4 + i * 8),
    cpuPercent: round(name.startsWith("Mashura") ? jitter(c.cpu / 3, 2) : Math.max(0, jitter(0.6, 0.6))),
    workingSetBytes: Math.round((name.startsWith("Mashura") ? 180 : 24) * 1024 ** 2 * (0.6 + Math.random())),
    threadCount: 4 + (i * 7) % 40, handleCount: 120 + (i * 97) % 1800,
  }));
}

function eventView(action) {
  const def = JSON.parse(action.parameters.eventLogViewDefinition);
  const channels = [...(def.logNames ?? []).map(String), ...(def.channelNames ?? [])];
  const sources = def.sources?.length ? def.sources : ["Application Error", "Service Control Manager", "MashuraCabinetService"];
  // Honour the view's minimum level the way the real Agent's query does.
  const rank = { Verbose: 1, Information: 2, Warning: 3, Error: 4, Critical: 5 };
  const levels = ["Error", "Warning", "Information", "Critical"].filter(l => rank[l] >= (rank[def.minimumLevel] ?? 0));
  const max = Math.min(def.maximumEntries ?? 50, 12);
  const entries = Array.from({ length: max }, (_, i) => {
    const channel = channels[i % channels.length];
    const source = sources[i % sources.length];
    return {
      ...(["Application", "System", "Security"].includes(channel) ? { logName: channel } : { channelName: channel }),
      source, eventId: [1000, 7036, 4101, 1001][i % 4], level: levels[i % levels.length],
      timeCreatedUtc: new Date(Date.now() - (i + 1) * 47 * 60_000).toISOString(),
      message: `Synthetic demo event ${i + 1} from ${source}. No real cabinet was queried.`,
    };
  });
  return {
    viewId: def.viewId, viewDisplayName: def.displayName, windowHours: def.windowHours, truncated: false, entries,
    channelReads: channels.map(name => ({ name, access: "Readable", recordsRead: entries.filter(e => (e.logName ?? e.channelName) === name).length, truncated: false })),
  };
}

async function handleAction(c, action) {
  const started = new Date().toISOString();
  let result;
  if (action.action === "GetProcessList") {
    result = { status: "Succeeded", output: "Process list collected (synthetic).", collectedData: JSON.stringify(processList(c)) };
  } else if (action.action === "RunEventLogView") {
    result = { status: "Succeeded", output: "Event log view collected (synthetic).", collectedData: JSON.stringify(eventView(action)) };
  } else {
    result = { status: "Failed", output: `${action.action} is not simulated by the demo agent.` };
  }
  await sleep(1500); // a little realism in the UI
  const r = await call(c, "POST", "/api/agent/actions/result", { requestId: action.id, startedAtUtc: started, completedAtUtc: new Date().toISOString(), exitCode: 0, ...result });
  log(c.host, `${action.action} → ${result.status} (server ${r.status})`);
}

async function run(c) {
  log(c.host, `starting (machine ${c.machineId}, profile: ${c.profile.note})`);
  let announced = false;
  for (;;) {
    try {
      const r = await call(c, "POST", "/api/agent/register", { machineId: c.machineId, hostname: c.host, osVersion: "Windows 10 IoT Enterprise LTSC 2021", agentVersion: VERSION });
      if (r.status === 200 && r.data?.status === "Approved" && r.data.cabinetId) { c.cabinetId = r.data.cabinetId; break; }
      if (r.status === 200 && r.data?.status === "Rejected") { log(c.host, "registration was rejected by an administrator; stopping."); return; }
      if (!announced && r.status === 200) { log(c.host, "registered — waiting for an administrator to approve it in the Console."); announced = true; }
      if (r.status !== 200) log(c.host, `register returned HTTP ${r.status}`);
    } catch (e) { log(c.host, `server unreachable: ${e.message}`); }
    await sleep(POLL);
  }
  log(c.host, `approved as cabinet ${c.cabinetId}. Sending inventory and heartbeats.`);
  let lastFull = 0, lastBeat = 0;
  for (;;) {
    try {
      const now = Date.now();
      if (now - lastFull >= FULL_EVERY) {
        const r = await call(c, "POST", "/api/agent/checkin/full", payload(c, true));
        if (r.status === 403) { log(c.host, "the Server refused this cabinet (retired?); stopping."); return; }
        if (r.status !== 200) log(c.host, `full check-in HTTP ${r.status} ${JSON.stringify(r.data)?.slice(0, 200)}`);
        lastFull = lastBeat = now;
      } else if (now - lastBeat >= HEARTBEAT) {
        const r = await call(c, "POST", "/api/agent/checkin", payload(c, false));
        if (r.status === 403) { log(c.host, "the Server refused this cabinet (retired?); stopping."); return; }
        if (r.status !== 200) log(c.host, `heartbeat HTTP ${r.status}`);
        lastBeat = now;
      }
      const a = await call(c, "GET", "/api/agent/actions");
      if (a.status === 200 && Array.isArray(a.data)) for (const action of a.data) await handleAction(c, action);
    } catch (e) { log(c.host, `error: ${e.message}`); }
    await sleep(POLL);
  }
}

const cabinets = HOSTS.map((host, index) => ({ host, index, machineId: state[host], profile: PROFILES[index % PROFILES.length], bootedAt: new Date(Date.now() - (3 + index * 5) * 86400_000) }));
console.log(`Simulating ${cabinets.length} cabinet agent(s) against ${SERVER}. Approve them under Administration → Enrollment.`);
await Promise.all(cabinets.map(run));
