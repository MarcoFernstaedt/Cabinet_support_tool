// Demo mode: an in-memory, per-session sample fleet in the shape of the
// Cabinet Server API.
//
// In Demo mode the Console shows these sample cabinets *together with* the
// real ones (see demoDispatch in console-server.mjs): requests about a sample
// item are answered here, requests about a real item go to the Server, and
// lists are merged. Changes to sample items (approvals, new staff, diagnostics,
// alert notes) live only in this session's sandbox and vanish at sign-out.
import { randomUUID } from "node:crypto";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const GB = 1024 ** 3;

// Deterministic noise so charts look plausible and stable between refreshes.
function noise(seed, n) {
  let x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453;
  return x - Math.floor(x);
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = v => Math.round(v * 10) / 10;
const iso = t => new Date(t).toISOString();

const SITES = [
  { client: "Valley Emergency Group", site: "Phoenix" },
  { client: "Valley Emergency Group", site: "Chandler" },
  { client: "Desert Regional Medical", site: "Tucson" },
];

const CABINETS = [
  { host: "PHX-PHARM-01", name: "Phoenix Pharmacy", site: 0, role: "Sync", dept: "Pharmacy", cpu: 22, ram: 54, disk: 61, updates: 1 },
  { host: "PHX-ICU-02", name: "Phoenix ICU", site: 0, role: "Satellite", dept: "ICU", cpu: 31, ram: 91, disk: 47, updates: 3 },
  { host: "PHX-ED-03", name: "Phoenix Emergency", site: 0, role: "Satellite", dept: "Emergency", cpu: 17, ram: 48, disk: 9, updates: 18 },
  { host: "CHD-PHARM-01", name: "Chandler Pharmacy", site: 1, role: "Sync", dept: "Pharmacy", cpu: 14, ram: 42, disk: 72, updates: 0 },
  { host: "CHD-SURG-02", name: "Chandler Surgery", site: 1, role: "Satellite", dept: "Surgery", cpu: 26, ram: 57, disk: 55, updates: 2, failingDisk: true },
  { host: "TUC-ONC-01", name: "Tucson Oncology", site: 2, role: "Standalone", dept: "Oncology", cpu: 19, ram: 50, disk: 66, updates: 4, offlineSince: 7 * HOUR },
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
const PROCESSES = ["System", "smss.exe", "csrss.exe", "wininit.exe", "services.exe", "lsass.exe", "svchost.exe", "explorer.exe",
  "MashuraCabinetUI.exe", "MashuraDispenseHost.exe", "MashuraSyncAgent.exe", "CabinetPlatform.Agent.exe", "spoolsv.exe", "dwm.exe", "SearchHost.exe", "msedge.exe"];
const EVENT_SOURCES = [
  ["Application", "MashuraCabinetService", 1000, "error", "The dispensing database connection was reset by the sync cabinet. Retrying in 30 seconds."],
  ["Application", "Application Error", 1000, "error", "Faulting application name: MashuraCabinetUI.exe, version 7.3.2.0. Exception code: 0xc0000005."],
  ["System", "Service Control Manager", 7036, "information", "The Mashura Sync Service service entered the running state."],
  ["Application", "MashuraSyncService", 4101, "warning", "Sync with the site database took 41 seconds (threshold 15 seconds)."],
  ["System", "Microsoft-Windows-Kernel-Power", 41, "critical", "The system has rebooted without cleanly shutting down first."],
  ["Application", "Windows Error Reporting", 1001, "information", "Fault bucket 2231452263, type 4. Event Name: APPCRASH."],
  ["System", "Disk", 153, "warning", "The IO operation at logical block address 0x2f1a0 for Disk 0 was retried."],
  ["Application", "MashuraDispenseController", 2002, "warning", "Drawer 4 sensor reported an unexpected state; dispense was paused for 3 seconds."],
];

const CATALOG = [
  ["GetProcessList", "View process list", "Reads the cabinet's current process list, outside the check-in cadence."],
  ["RunEventLogView", "Run an event log view", "Runs one saved, named event log filter on the cabinet and returns what matched."],
  ["GetScheduledUpdates", "View scheduled updates", "Reads what the cabinet has scheduled to install."],
  ["InspectFirewall", "Inspect Windows firewall", "Reads bounded profile and rule metadata."],
  ["GetDisplayDiagnostics", "View display modes", "Reads bounded OS display modes."],
].map(([action, displayName, description]) => ({ action, displayName, description, minimumRole: "Tier1", requiresApproval: false, isDisruptive: false, timeoutSeconds: 120, allowedParameterKeys: [], allowedPorts: [], maintenanceWindowOnly: false, blockedIfUserLoggedOn: false, targetsAnotherCabinet: false, batchable: false }));

const VIEWS = [
  { id: "4f6c2b0e-7a1d-4c55-9b0e-1d2e3f405060", displayName: "CUBEX application errors", description: "Errors and critical events from the cabinet application.", logNames: ["Application"], channelNames: [], sources: [], eventIds: [], minimumLevel: "Warning", defaultWindowHours: 24, maximumEntries: 200 },
  { id: "5a7d3c1f-8b2e-4d66-8c1f-2e3f40516171", displayName: "Unexpected shutdowns and disk retries", description: "Kernel-Power 41 and disk retry warnings.", logNames: ["System"], channelNames: [], sources: [], eventIds: [], minimumLevel: "Warning", defaultWindowHours: 72, maximumEntries: 200 },
];

const problem = (status, title, detail) => [status, { status, title, ...(detail ? { detail } : {}) }];
const notFound = () => problem(404, "Not found");

function paged(items, query, defaultSize = 50) {
  const page = Math.max(1, Number(query.get("page")) || 1);
  const pageSize = clamp(Number(query.get("pageSize")) || defaultSize, 1, 200);
  const totalCount = items.length;
  const totalPages = Math.ceil(totalCount / pageSize);
  return { items: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, totalCount, totalPages, hasMore: page < totalPages };
}

const text = (v, max = 255) => typeof v === "string" && v.trim().length > 0 && v.trim().length <= max ? v.trim() : null;

export function createDemoSandbox({ user, clock = () => Date.now() }) {
  const start = clock();
  const sites = SITES.map(s => ({ ...s, id: randomUUID() }));
  const cabinets = CABINETS.map((c, index) => ({
    ...c, index, id: randomUUID(), machineId: `DEMO-${randomUUID()}`, siteId: sites[c.site].id, active: true,
    friendlyName: c.name, enrolledAt: start - (30 + index * 11) * DAY, bootedAt: start - (2 + index * 3) * DAY - index * 3 * HOUR,
  }));
  const me = { id: user.id, username: user.username, displayName: user.displayName, role: user.role };
  const users = [
    { ...me, active: true, created: start - 120 * DAY, lastLogin: start, mustChange: false },
    { id: randomUUID(), username: "pshah", displayName: "Priya Shah", role: "Tier2", active: true, created: start - 90 * DAY, lastLogin: start - 2 * HOUR, mustChange: false },
    { id: randomUUID(), username: "jlee", displayName: "Jordan Lee", role: "Tier1", active: true, created: start - 60 * DAY, lastLogin: start - 26 * HOUR, mustChange: false },
    { id: randomUUID(), username: "amorgan", displayName: "Alex Morgan", role: "Supervisor", active: true, created: start - 200 * DAY, lastLogin: start - 3 * DAY, mustChange: false },
    { id: randomUUID(), username: "cnguyen", displayName: "Casey Nguyen", role: "Tier1", active: false, created: start - 300 * DAY, lastLogin: start - 40 * DAY, mustChange: false },
  ];
  const registrations = [
    { id: randomUUID(), machineId: `DEMO-${randomUUID()}`, hostname: "MESA-PHARM-01", osVersion: "Windows 10 IoT Enterprise LTSC 2021", agentVersion: "1.4.0", firstSeen: start - 25 * MIN, status: "Pending" },
    { id: randomUUID(), machineId: `DEMO-${randomUUID()}`, hostname: "MESA-ED-02", osVersion: "Windows 11 IoT Enterprise LTSC 2024", agentVersion: "1.4.0", firstSeen: start - 9 * MIN, status: "Pending" },
  ];
  const byHost = h => cabinets.find(c => c.host === h);
  const alerts = [
    { id: randomUUID(), source: byHost("PHX-ICU-02"), target: byHost("PHX-PHARM-01"), received: start - 38 * MIN, status: "Open", ok: 4, fail: 9 },
    { id: randomUUID(), source: byHost("CHD-SURG-02"), target: byHost("CHD-PHARM-01"), received: start - 5 * HOUR, status: "Acknowledged", ok: 11, fail: 4 },
  ];
  const actions = [];
  const audit = [];
  // Saved event log views. In Demo mode the real Server's views replace these,
  // so one view list works for both sample and real cabinets.
  let views = VIEWS;
  const viewById = id => views.find(v => v.id === id) ?? VIEWS.find(v => v.id === id);
  const actorName = () => me.displayName;

  function log(event, { cabinet, result = "Success", reason, actor = "user" } = {}) {
    audit.unshift({
      id: randomUUID(), timestampUtc: iso(clock()),
      actorType: actor === "agent" ? "Agent" : actor === "system" ? "System" : "User",
      actorId: actor === "agent" ? cabinet?.machineId ?? "agent" : actor === "system" ? "system" : me.id,
      actorDisplayName: actor === "agent" ? cabinet?.host : actor === "system" ? "Server" : actorName(),
      eventKind: actor === "user" ? "Caused" : "Observed", event, cabinetId: cabinet?.id ?? null, cabinetHostname: cabinet?.host ?? null,
      result, reason: reason ?? null, details: null,
    });
  }
  // Seed some history.
  for (const [ago, event, host, reason, actor] of [
    [3 * DAY, "ApproveRegistration", "CHD-SURG-02", "Machine ID verified with on-site technician", "user"],
    [26 * HOUR, "Login", null, null, "user"],
    [5 * HOUR, "AcknowledgeConnectivityAlert", "CHD-SURG-02", "Facilities checking the switch in OR corridor", "user"],
    [7 * HOUR, "AgentCheckIn", "TUC-ONC-01", "Last contact before the cabinet went offline", "agent"],
    [40 * MIN, "AgentCheckIn", "PHX-ICU-02", null, "agent"],
  ]) {
    log(event, { cabinet: host ? byHost(host) : null, reason, actor });
    audit[0].timestampUtc = iso(start - ago);
  }
  audit.sort((a, b) => b.timestampUtc.localeCompare(a.timestampUtc));

  // --- Telemetry --------------------------------------------------------------
  const lastContact = c => (c.offlineSince ? start - c.offlineSince : clock() - (c.index * 37_000) % (4 * MIN));
  function sampleAt(c, t) {
    const n = Math.floor(t / (15 * MIN));
    const wave = Math.sin((t / (6 * HOUR)) + c.index);
    return {
      cpu: round(clamp(c.cpu + wave * 9 + (noise(c.index + 1, n) - 0.5) * 14, 1, 99)),
      ram: round(clamp(c.ram + wave * 2 + (noise(c.index + 7, n) - 0.5) * 3, 5, 99)),
      disk: round(clamp(c.disk - (start - t) / DAY * -0.05 + (noise(c.index + 13, n) - 0.5) * 0.3, 1, 99)),
    };
  }
  function health(c) {
    if (!c.active) return "Unknown";
    if (c.offlineSince) return "Offline";
    const s = sampleAt(c, lastContact(c));
    if (c.failingDisk || s.disk <= 5 || s.ram >= 95) return "Critical";
    if (s.disk <= 12 || s.ram >= 88 || s.cpu >= 90 || c.updates >= 15) return "Warning";
    return "Healthy";
  }
  const siteOf = c => sites.find(s => s.id === c.siteId);
  function summary(c) {
    const t = lastContact(c), s = sampleAt(c, t), site = siteOf(c);
    return {
      friendlyName: c.friendlyName, displayName: c.friendlyName || c.host, id: c.id, machineId: c.machineId, hostname: c.host,
      clientName: site.client, siteName: site.site, siteId: site.id, departmentName: c.dept ?? null, role: c.role,
      model: "Mashura MedStation 4000", serialNumber: `MS4K-${2400 + c.index * 17}`, isActive: c.active,
      lastCheckInUtc: iso(t), latestHeartbeatCollectedAtUtc: iso(t - 900), latestHeartbeatReceivedAtUtc: iso(t),
      agentVersion: "1.4.0", timeZoneId: "US Mountain Standard Time", health: health(c),
      cpuPercent: s.cpu, ramUsedPercent: s.ram, minFreeDiskPercent: s.disk, pendingUpdateCount: c.updates, rebootPending: c.updates > 10,
      worstDiskHealth: c.failingDisk ? "Failing" : "Healthy", anyUserLoggedOn: true, clockDrift: "00:00:01.2000000",
    };
  }
  const heartbeat = (c, t) => {
    const s = sampleAt(c, t);
    return { id: randomUUID(), receivedUtc: iso(t), collectedAtUtc: iso(t - 900), agentVersion: "1.4.0", uptime: uptime(c, t),
      cpuPercent: s.cpu, ramUsedPercent: s.ram, minFreeDiskPercent: s.disk, worstDiskHealth: c.failingDisk ? "Failing" : "Healthy",
      anyUserLoggedOn: true, pendingUpdateCount: c.updates, rebootPending: c.updates > 10, clockDrift: "00:00:01.2000000", sectionErrors: {}, isAggregated: false };
  };
  function uptime(c, t) {
    const s = Math.max(0, Math.floor((t - c.bootedAt) / 1000));
    return `${Math.floor(s / 86400)}.${String(Math.floor(s / 3600) % 24).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  function siteSummary(site) {
    const members = cabinets.filter(c => c.siteId === site.id && c.active);
    const sync = members.find(c => c.role === "Sync");
    const order = ["Healthy", "Unknown", "Warning", "Offline", "Critical"];
    const worst = members.map(health).sort((a, b) => order.indexOf(b) - order.indexOf(a))[0] ?? "Unknown";
    return { id: site.id, clientName: site.client, siteName: site.site, syncCabinetId: sync?.id ?? null, syncCabinetHostname: sync?.host ?? null,
      syncCabinetHealth: sync ? health(sync) : null, cabinetCount: members.length, unhealthyCabinetCount: members.filter(c => health(c) !== "Healthy").length,
      worstHealth: worst, syncReachability: null };
  }
  function inventory(c) {
    const t = lastContact(c), s = sampleAt(c, t);
    return {
      id: randomUUID(), firstObservedUtc: iso(c.enrolledAt), lastObservedUtc: iso(t - 2 * HOUR), contentHash: "demo",
      system: { hostname: c.host, osVersion: "Windows 10 IoT Enterprise LTSC 2021", osBuild: "19044.4651", installDateUtc: iso(c.enrolledAt - 20 * DAY),
        lastBootUtc: iso(c.bootedAt), uptime: uptime(c, t), timeZoneId: "US Mountain Standard Time", systemTimeUtc: iso(t), domainOrWorkgroup: "CLINICAL",
        isDomainJoined: true, anyUserLoggedOn: true, loggedOnUserCount: 1,
        installedSoftware: [
          { name: "Mashura Cabinet Suite", version: "7.3.2", publisher: "Mashura" },
          { name: "Mashura Cabinet Agent", version: "1.4.0", publisher: "Mashura" },
          { name: "Microsoft Edge", version: "129.0.2792.65", publisher: "Microsoft Corporation" },
          { name: "Zebra Printer Driver", version: "8.4.1", publisher: "Zebra Technologies" },
          { name: "Microsoft Visual C++ 2015-2022 Redistributable (x64)", version: "14.40.33810", publisher: "Microsoft Corporation" },
        ] },
      services: SERVICES.map(([name, displayName, state, startType]) => ({ name, displayName, state: c.host === "PHX-ED-03" && name === "MashuraSyncService" ? "Stopped" : state, startType, runAsAccount: "LocalSystem" })),
      network: { adapters: [{ name: "Ethernet", description: "Intel(R) Ethernet Connection I219-LM", macAddress: `00-1B-21-3A-0${c.index}-4F`, status: "Up", linkSpeedBps: 1e9,
        ipAddresses: [`192.0.2.${21 + c.index}`], subnetMasks: ["255.255.255.0"], gateways: ["192.0.2.1"], dnsServers: ["192.0.2.10", "192.0.2.11"], dhcpEnabled: false }],
        proxyConfigured: false, firewallDomainEnabled: true, firewallPrivateEnabled: true, firewallPublicEnabled: c.index !== 1, serverReachable: !c.offlineSince, serverLatencyMs: 24 + c.index * 3 },
      windowsUpdate: { pendingUpdateCount: c.updates, rebootPending: c.updates > 10, lastSuccessfulInstallUtc: iso(start - (9 + c.index) * DAY), isManagedByPolicy: true,
        activeHoursStart: "06:00:00", activeHoursEnd: "22:00:00",
        pendingUpdates: Array.from({ length: Math.min(c.updates, 6) }, (_, i) => ({ updateId: `demo-${c.index}-${i}`,
          title: i === 0 ? "2026-09 Cumulative Update for Windows 10 Version 21H2 (KB5049999)" : `Security Intelligence Update for Microsoft Defender (Version 1.419.${300 + i})`,
          classification: i === 0 ? "SecurityUpdate" : "DefinitionUpdate", isSecurity: i === 0, sizeBytes: (i === 0 ? 612 : 48) * 1024 ** 2 })),
        history: [{ title: "2026-08 Cumulative Update for Windows 10 Version 21H2", resultCode: "Succeeded", dateUtc: iso(start - (9 + c.index) * DAY) },
          { title: "2026-07 .NET Framework Update", resultCode: c.index === 2 ? "Failed" : "Succeeded", dateUtc: iso(start - 33 * DAY), errorCode: c.index === 2 ? -2145124329 : null }] },
      disks: [{ driveLetter: "C:", label: "OS", fileSystem: "NTFS", totalBytes: 256 * GB, freeBytes: Math.round(256 * GB * s.disk / 100), freePercent: s.disk,
        bitLockerStatus: "EncryptedUnlocked", healthStatus: c.failingDisk ? "Failing" : "Healthy" }],
      installedMemoryBytes: 16 * GB, startupPrograms: [], sectionErrors: {},
    };
  }
  const smart = c => [{ id: randomUUID(), driveSerial: `DEMO-SSD-${1000 + c.index}`, driveModel: "Samsung PM991a 256GB", timestampUtc: iso(lastContact(c) - HOUR),
    health: c.failingDisk ? "Failing" : "Healthy", source: "StorageReliabilityCounter", isAggregated: false,
    smart: { source: "StorageReliabilityCounter", temperatureCelsius: 36 + c.index, powerOnHours: 9800 + c.index * 1500, wear: 3 + c.index * 2,
      reallocatedSectorCount: c.failingDisk ? 212 : 0, pendingSectorCount: c.failingDisk ? 18 : 0 } }];

  function detail(c) {
    const site = siteSummary(siteOf(c));
    const sync = cabinets.find(x => x.siteId === c.siteId && x.role === "Sync" && x.active);
    return {
      cabinet: summary(c),
      path: { cabinetId: c.id, clientName: site.clientName, siteName: site.siteName, siteId: site.id, departmentName: c.dept, cabinetName: c.friendlyName || c.host, role: c.role,
        display: `${site.clientName} › ${site.siteName} › ${c.friendlyName || c.host} (${c.role})` },
      site,
      syncCabinetLink: sync && sync !== c ? { syncCabinetId: sync.id, syncCabinetHostname: sync.host, syncCabinetHealth: health(sync), syncCabinetLastCheckInUtc: iso(lastContact(sync)),
        lastProbeReachable: !alerts.some(a => a.source === c && a.status !== "Resolved"), lastProbeUtc: iso(lastContact(c) - 4 * MIN), lastProbeLatencyMs: 2.4 } : null,
      latestHeartbeat: heartbeat(c, lastContact(c)),
      currentInventory: inventory(c),
      latestSmartReadings: smart(c),
      cabinetLocalTime: iso(clock() - 7 * HOUR).replace("Z", "-07:00"),
    };
  }

  // --- Diagnostics -------------------------------------------------------------
  function actionView(a) {
    const c = cabinets.find(x => x.id === a.cabinetId);
    const now = clock();
    let status = "Dispatched", resultStatus = null, completedUtc = null;
    if (c.offlineSince) { if (now > a.requested + 30 * MIN) status = "Expired"; }
    else if (now >= a.requested + 4000) { status = "Completed"; resultStatus = "Succeeded"; completedUtc = iso(a.requested + 4000); }
    return {
      id: a.id, action: a.action, cabinetId: c.id, cabinetHostname: c.host, clientName: siteOf(c).client, siteName: siteOf(c).site,
      requestedByUserId: a.by.id, requestedByDisplayName: a.by.displayName, requestedUtc: iso(a.requested), parameters: a.parameters,
      reason: a.reason, ticketReference: a.ticket ?? null, status, resultStatus, approvedUtc: iso(a.requested), dispatchedUtc: iso(a.requested + 1500),
      completedUtc, expiresUtc: iso(a.requested + 30 * MIN), safetyChecksOverridden: false,
      resultOutput: status === "Completed" ? "Collected (demo data)." : null,
    };
  }
  function processResult(c, a) {
    const v = actionView(a);
    const state = v.status === "Completed" ? "complete" : v.status === "Expired" ? "failed" : "pending";
    const procs = state !== "complete" ? [] : PROCESSES.map((name, i) => ({
      name, pid: 4 + i * 412 + c.index * 8,
      cpuPercent: round(name.startsWith("Mashura") ? 3 + noise(i, a.requested) * 12 : noise(i + 50, a.requested) * 1.5),
      workingSetBytes: Math.round((name.startsWith("Mashura") ? 180 : name === "msedge.exe" ? 240 : 22) * 1024 ** 2 * (0.6 + noise(i + 9, a.requested))),
      threadCount: 4 + (i * 7) % 40, handleCount: 120 + (i * 97) % 1800,
    }));
    return { cabinetId: c.id, actionId: a.id, state, requestedAtUtc: v.requestedUtc, completedAtUtc: v.completedUtc, truncated: false, processes: procs };
  }
  function eventResult(c, a) {
    const v = actionView(a);
    const view = viewById(a.parameters.eventLogViewId) ?? VIEWS[0];
    const state = v.status === "Completed" ? "complete" : v.status === "Expired" ? "failed" : "pending";
    const channels = (view.logNames?.length ? view.logNames : ["Application", "System"]).map(String);
    const entries = state !== "complete" ? [] : Array.from({ length: 14 }, (_, i) => EVENT_SOURCES[(i * 3 + c.index) % EVENT_SOURCES.length])
      .filter(([channel]) => channels.includes(channel))
      .map(([channel, provider, eventId, level, message], i) => ({ channel, provider, level, eventId, occurredAt: iso(a.requested - (i + 1) * 53 * MIN), message }));
    return { cabinetId: c.id, actionId: a.id, state, requestedAtUtc: v.requestedUtc, completedAtUtc: v.completedUtc, viewId: view.id, viewDisplayName: view.displayName,
      requestedChannels: channels, requestedProviders: [], channelReads: state === "complete" ? channels.map(ch => ({ channelName: ch, outcome: "readable", recordsRead: entries.length, truncated: false })) : [],
      truncated: false, entries };
  }
  // Pre-seed one process list and one event view on the first cabinet so those tabs are not empty.
  for (const [action, parameters] of [["GetProcessList", {}], ["RunEventLogView", { eventLogViewId: VIEWS[0].id }]])
    actions.push({ id: randomUUID(), action, cabinetId: cabinets[1].id, parameters, reason: "Ticket 1042 – ICU cabinet UI freezing", by: users[1], requested: start - 50 * MIN });

  const userDto = u => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, hasElevatedSql: false, hasHardwareActuation: false,
    isActive: u.active, mustChangePassword: u.mustChange, createdUtc: iso(u.created), createdByUserId: null, lastLoginUtc: u.lastLogin ? iso(u.lastLogin) : null,
    isLockedOut: false, lockedUntilUtc: null });
  const registrationDto = r => ({ id: r.id, machineId: r.machineId, hostname: r.hostname, osVersion: r.osVersion, agentVersion: r.agentVersion,
    firstSeenUtc: iso(r.firstSeen), lastSeenUtc: iso(r.status === "Pending" ? clock() - 20_000 : r.decided), status: r.status,
    decidedByUserId: r.decided ? me.id : null, decidedUtc: r.decided ? iso(r.decided) : null });
  const alertDto = a => ({ id: a.id, sourceCabinetId: a.source.id, targetCabinetId: a.target.id, evidenceId: a.id, siteId: a.source.siteId,
    clientName: siteOf(a.source).client, siteName: siteOf(a.source).site, sourceName: a.source.friendlyName || a.source.host, observedUtc: iso(a.received - MIN),
    receivedUtc: iso(a.received), status: a.status, incidentEvidence: { id: a.id, sourceCabinetId: a.source.id, targetCabinetId: a.target.id, successCount: a.ok, failureCount: a.fail, errorCount: 0,
      firstObservedUtc: iso(a.received - 20 * MIN), lastObservedUtc: iso(a.received - MIN) } });

  // --- Router ------------------------------------------------------------------------
  const G = "([0-9a-fA-F-]{36})";
  const routes = [];
  const on = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replaceAll("{id}", G)}$`), fn });
  const cab = id => cabinets.find(c => c.id === id);
  const activeCabs = () => cabinets.filter(c => c.active);

  on("GET", "/api/auth/me", () => [200, userDto(users[0])]);
  on("GET", "/api/fleet/health", () => {
    const list = activeCabs(), hs = list.map(health);
    const count = h => hs.filter(x => x === h).length;
    return [200, {
      totalCabinets: list.length, healthy: count("Healthy"), warning: count("Warning"), critical: count("Critical"), offline: count("Offline"), unknown: count("Unknown"),
      inactive: cabinets.length - list.length, pendingRegistrations: registrations.filter(r => r.status === "Pending").length, actionsAwaitingApproval: 0,
      sitesWithOfflineSyncCabinet: sites.filter(s => { const sync = list.find(c => c.siteId === s.id && c.role === "Sync"); return sync && health(sync) === "Offline"; }).length,
      stale: list.filter(c => c.offlineSince && c.offlineSince > 24 * HOUR).length, staleAfterHours: 24, noMeasurement: 0, staleMeasurement: 0, measurementStaleAfterHours: 24,
      withPendingUpdates: list.filter(c => c.updates > 0).length, withPendingSecurityUpdates: list.filter(c => c.updates > 0).length, rebootPending: list.filter(c => c.updates > 10).length,
      withAutoStartServicesStopped: list.filter(c => c.host === "PHX-ED-03").length,
      disks: { healthy: list.filter(c => !c.failingDisk).length, watch: 0, failing: list.filter(c => c.failingDisk).length, unknown: 0 },
      agentVersions: [{ version: "1.4.0", cabinetCount: list.length }], generatedUtc: iso(clock()),
    }];
  });
  on("GET", "/api/fleet/sites", q => {
    const term = (q.get("search") ?? "").toLowerCase();
    return [200, paged(sites.filter(s => !term || `${s.client} ${s.site}`.toLowerCase().includes(term)).map(siteSummary), q)];
  });
  on("GET", "/api/fleet/sites/{id}", (q, b, [id]) => {
    const site = sites.find(s => s.id === id);
    if (!site) return notFound();
    const members = cabinets.filter(c => c.siteId === id && c.active);
    return [200, { site: siteSummary(site), cabinets: members.map(summary), cabinetPaths: [], satelliteLinks: [] }];
  });
  on("GET", "/api/cabinets", q => {
    const term = (q.get("search") ?? "").toLowerCase(), h = q.get("health"), role = q.get("role"), active = q.get("isActive"), siteId = q.get("siteId");
    const rows = cabinets.filter(c => active !== "true" || c.active).map(summary).filter(s =>
      (!term || `${s.displayName} ${s.hostname} ${s.clientName} ${s.siteName} ${s.departmentName}`.toLowerCase().includes(term)) &&
      (!h || s.health === h) && (!role || s.role === role) && (!siteId || s.siteId === siteId));
    return [200, paged(rows, q)];
  });
  on("GET", "/api/cabinets/{id}", (q, b, [id]) => cab(id) ? [200, detail(cab(id))] : notFound());
  on("GET", "/api/cabinets/{id}/heartbeats", (q, b, [id]) => {
    const c = cab(id);
    if (!c) return notFound();
    const from = Date.parse(q.get("fromUtc") ?? "") || clock() - DAY;
    const items = [];
    for (let t = lastContact(c); t >= from; t -= 15 * MIN) items.push(heartbeat(c, t));
    return [200, paged(items, q)];
  });
  on("GET", "/api/cabinets/{id}/inventory", (q, b, [id]) => cab(id) ? [200, paged([inventory(cab(id))], q)] : notFound());
  on("GET", "/api/cabinets/{id}/smart", (q, b, [id]) => cab(id) ? [200, paged(smart(cab(id)), q)] : notFound());
  on("GET", "/api/cabinets/{id}/storage", (q, b, [id]) => cab(id) ? [200, { cabinetId: id, asOfUtc: iso(clock()), heartbeat: null, volumes: [], smart: [] }] : notFound());
  const latest = (id, kind, fn) => {
    const c = cab(id);
    if (!c) return notFound();
    const a = actions.filter(x => x.cabinetId === id && x.action === kind).sort((x, y) => y.requested - x.requested)[0];
    return a ? [200, fn(c, a)] : notFound();
  };
  const byAction = (id, aid, kind, fn) => {
    const c = cab(id), a = actions.find(x => x.id === aid && x.cabinetId === id && x.action === kind);
    return c && a ? [200, fn(c, a)] : notFound();
  };
  on("GET", "/api/cabinets/{id}/process-results/latest", (q, b, [id]) => latest(id, "GetProcessList", processResult));
  on("GET", "/api/cabinets/{id}/process-results/{id}", (q, b, [id, aid]) => byAction(id, aid, "GetProcessList", processResult));
  on("GET", "/api/cabinets/{id}/event-log-results/latest", (q, b, [id]) => latest(id, "RunEventLogView", eventResult));
  on("GET", "/api/cabinets/{id}/event-log-results/{id}", (q, b, [id, aid]) => byAction(id, aid, "RunEventLogView", eventResult));
  on("GET", "/api/connectivity/cabinets/{id}", (q, b, [id]) => cab(id) ? [200, { sourceCabinetId: id, links: [], recentEvidence: [] }] : notFound());
  on("GET", "/api/search/cabinets", q => {
    const term = (q.get("term") ?? "").toLowerCase();
    return [200, paged(activeCabs().map(summary).filter(s => !term || `${s.displayName} ${s.hostname} ${s.clientName} ${s.siteName}`.toLowerCase().includes(term)), q)];
  });
  on("GET", "/api/search/clients", q => [200, paged([...new Set(sites.map(s => s.client))].map(name => ({ id: randomUUID(), name })), q)]);
  on("GET", "/api/search/clients/{id}", () => notFound());
  on("GET", "/api/search/recent", () => [200, []]);
  on("GET", "/api/actions/catalog", () => [200, CATALOG]);
  on("GET", "/api/actions/pending-approval", q => [200, paged([], q)]);
  on("GET", "/api/actions", q => {
    const id = q.get("cabinetId"), status = q.get("status");
    const rows = actions.slice().sort((a, b) => b.requested - a.requested).map(actionView).filter(v => (!id || v.cabinetId === id) && (!status || v.status === status));
    return [200, paged(rows, q)];
  });
  on("GET", "/api/actions/{id}", (q, b, [id]) => { const a = actions.find(x => x.id === id); return a ? [200, actionView(a)] : notFound(); });
  on("POST", "/api/actions", (q, b) => {
    const c = cab(b?.cabinetId), reason = text(b?.reason, 2000);
    if (!c || !c.active) return problem(404, "Cabinet not found.");
    if (!CATALOG.some(x => x.action === b.action)) return problem(400, "That diagnostic is not available.");
    if (!reason) return problem(400, "A reason is required.");
    const parameters = b.action === "RunEventLogView" ? { eventLogViewId: viewById(String(b.parameters?.eventLogViewId ?? "").toLowerCase())?.id ?? views[0].id } : {};
    const a = { id: randomUUID(), action: b.action, cabinetId: c.id, parameters, reason, ticket: text(b.ticketReference, 64), by: users[0], requested: clock() };
    actions.push(a);
    log("RequestAction", { cabinet: c, reason });
    return [201, actionView(a)];
  });
  on("GET", "/api/event-log-views", q => [200, paged(views, q)]);
  on("GET", "/api/connectivity-alerts", q => {
    const siteId = q.get("siteId"), includeResolved = q.get("includeResolved") === "true";
    return [200, paged(alerts.filter(a => (includeResolved || a.status !== "Resolved") && (!siteId || a.source.siteId === siteId)).sort((a, b) => b.received - a.received).map(alertDto), q)];
  });
  on("GET", "/api/connectivity-alerts/site/{id}/summary", (q, b, [id]) => {
    const list = alerts.filter(a => a.source.siteId === id), n = s => list.filter(a => a.status === s).length;
    return [200, { siteId: id, open: n("Open"), acknowledged: n("Acknowledged"), resolved: n("Resolved"), total: list.length, asOfUtc: iso(clock()) }];
  });
  for (const kind of ["acknowledge", "resolve"]) on("POST", `/api/connectivity-alerts/{id}/${kind}`, (q, b, [id]) => {
    const a = alerts.find(x => x.id === id), note = text(b?.note, 1000);
    if (!a) return notFound();
    if (!note) return problem(400, "A note is required.");
    if (a.status === "Resolved" || (kind === "acknowledge" && a.status !== "Open")) return problem(409, "The alert has already moved on. Refresh and try again.");
    a.status = kind === "acknowledge" ? "Acknowledged" : "Resolved";
    log(kind === "acknowledge" ? "AcknowledgeConnectivityAlert" : "ResolveConnectivityAlert", { cabinet: a.source, reason: note });
    return [200, alertDto(a)];
  });
  on("GET", "/api/audit", q => {
    const id = q.get("cabinetId"), result = q.get("result");
    return [200, paged(audit.filter(e => (!id || e.cabinetId === id) && (!result || e.result === result)), q)];
  });
  on("GET", "/api/registrations/pending", q => {
    const status = q.get("status") ?? "Pending";
    return [200, paged(registrations.filter(r => r.status === status).map(registrationDto), q)];
  });
  on("POST", "/api/registrations/{id}/approve", (q, b, [id]) => {
    const r = registrations.find(x => x.id === id);
    if (!r) return notFound();
    if (r.status !== "Pending") return problem(409, "This registration has already been decided.");
    const client = text(b?.clientName), siteName = text(b?.siteName);
    if (!client || !siteName || !["Sync", "Satellite", "Standalone"].includes(b?.role)) return problem(400, "Client, site and role are required.");
    let site = sites.find(s => s.client.toLowerCase() === client.toLowerCase() && s.site.toLowerCase() === siteName.toLowerCase());
    if (!site) { site = { id: randomUUID(), client, site: siteName }; sites.push(site); }
    if (b.role === "Sync" && cabinets.some(c => c.siteId === site.id && c.active && c.role === "Sync"))
      return problem(409, "That site already has a Sync cabinet.", "Choose Satellite, or change the existing Sync cabinet's role first.");
    r.status = "Approved"; r.decided = clock();
    const index = cabinets.length;
    const c = { host: r.hostname, name: text(b.friendlyName, 120) ?? r.hostname, friendlyName: text(b.friendlyName, 120) ?? r.hostname, index, id: randomUUID(), machineId: r.machineId,
      siteId: site.id, role: b.role, dept: text(b.departmentName), active: true, cpu: 15, ram: 45, disk: 70, updates: 1, enrolledAt: clock(), bootedAt: clock() - DAY };
    cabinets.push(c);
    log("ApproveRegistration", { cabinet: c, reason: text(b.approvalReason, 2000) });
    return [200, registrationDto(r)];
  });
  on("POST", "/api/registrations/{id}/reject", (q, b, [id]) => {
    const r = registrations.find(x => x.id === id);
    if (!r) return notFound();
    if (r.status !== "Pending") return problem(409, "This registration has already been decided.");
    const reason = text(b?.reason, 2000);
    if (!reason) return problem(400, "A reason is required.");
    r.status = "Rejected"; r.decided = clock();
    log("RejectRegistration", { reason });
    return [204];
  });
  on("GET", "/api/users", q => [200, paged(users.map(userDto), q)]);
  on("POST", "/api/users", (q, b) => {
    const username = text(b?.username, 64), displayName = text(b?.displayName, 120);
    if (!username || !/^[A-Za-z0-9._-]+$/.test(username)) return problem(400, "Usernames must use ASCII letters, digits, dot, dash or underscore.");
    if (!displayName) return problem(400, "A display name is required.");
    if (!["Tier1", "Tier2", "Supervisor"].includes(b?.role)) return problem(400, "Role is not valid.");
    if (typeof b.initialPassword !== "string" || b.initialPassword.length < 12) return problem(400, "The temporary password must be at least 12 characters.");
    if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) return problem(409, "That username is already taken.");
    const u = { id: randomUUID(), username, displayName, role: b.role, active: true, created: clock(), lastLogin: null, mustChange: true };
    users.push(u);
    log("CreateUser", { reason: `Created ${username} (${b.role})` });
    return [201, userDto(u)];
  });
  on("PATCH", "/api/users/{id}", (q, b, [id]) => {
    const u = users.find(x => x.id === id);
    if (!u) return notFound();
    if (u.id === me.id && b?.role && b.role !== u.role) return problem(400, "You cannot change your own role.");
    if (u.id === me.id && b?.isActive === false) return problem(400, "You cannot deactivate your own account.");
    if (b?.role && !["Tier1", "Tier2", "Supervisor"].includes(b.role)) return problem(400, "Role is not valid.");
    if (text(b?.displayName, 120)) u.displayName = b.displayName.trim();
    if (b?.role) u.role = b.role;
    if (typeof b?.isActive === "boolean") u.active = b.isActive;
    log("UpdateUser", { reason: `Updated ${u.username}` });
    return [200, userDto(u)];
  });
  on("POST", "/api/users/{id}/revoke-sessions", (q, b, [id]) => {
    const u = users.find(x => x.id === id);
    if (!u) return notFound();
    if (!text(b?.reason, 2000)) return problem(400, "A reason is required.");
    log("RevokeUserSessions", { reason: b.reason });
    return [204];
  });
  on("PATCH", "/api/cabinets/{id}/name", (q, b, [id]) => {
    const c = cab(id), name = text(b?.friendlyName, 120);
    if (!c) return notFound();
    if (!name || !text(b?.reason, 2000)) return problem(400, "A name and reason are required.");
    c.friendlyName = name;
    log("RenameCabinet", { cabinet: c, reason: b.reason });
    return [200, summary(c)];
  });
  on("PUT", "/api/cabinets/{id}/role", (q, b, [id]) => {
    const c = cab(id);
    if (!c) return notFound();
    if (!["Sync", "Satellite", "Standalone"].includes(b?.role) || !text(b?.reason, 2000)) return problem(400, "A role and reason are required.");
    if (b.role === "Sync" && cabinets.some(x => x !== c && x.siteId === c.siteId && x.active && x.role === "Sync")) return problem(409, "That site already has a Sync cabinet.");
    c.role = b.role;
    log("SetCabinetRole", { cabinet: c, reason: b.reason });
    return [200, summary(c)];
  });
  on("POST", "/api/cabinets/{id}/retire", (q, b, [id]) => {
    const c = cab(id);
    if (!c) return notFound();
    if (!text(b?.reason, 2000)) return problem(400, "A reason is required.");
    c.active = false;
    log("RetireCabinet", { cabinet: c, reason: b.reason });
    return [204];
  });

  const owned = () => [cabinets, sites, actions, alerts, registrations, users.slice(1), VIEWS].flatMap(list => list.map(x => x.id));
  return {
    // True when an ID belongs to this sandbox. The signed-in user's own
    // account is real, so it is never owned here.
    owns: id => owned().includes(String(id).toLowerCase()),
    useViews(list) {
      const valid = list.filter(v => typeof v?.id === "string" && typeof v.displayName === "string");
      if (valid.length) views = valid.map(v => ({ ...v, id: v.id.toLowerCase() }));
    },
    handle(method, path, query, body) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(path);
        if (m) return r.fn(query, body, m.slice(1).map(s => s.toLowerCase()));
      }
      return notFound();
    },
  };
}
