// Views every signed-in staff member uses. Administrators (Supervisor role) see
// exactly these same views and controls, plus the admin-only extras guarded by
// ctx.isAdmin. The Server enforces every permission; hiding is presentation only.
import { get, post, patch, put } from "./api.js";
import {
  h, clear, ago, dateTime, pct, bytes, duration, splitWords, healthBadge, chip, liveChip, statTile, card, facts,
  empty, loading, errorBox, table, pager, toast, formDialog,
} from "./ui.js";
import { percentChart } from "./chart.js";

const HEALTH = ["Healthy", "Warning", "Critical", "Offline", "Unknown"];
const ROLES = ["Sync", "Satellite", "Standalone"];
const n = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const cabinetName = c => c.friendlyName || c.displayName || c.hostname;

function pageHead(eyebrow, title, sub, actions) {
  return h("header", { class: "page-head" },
    h("div", null, eyebrow ? h("p", { class: "eyebrow" }, eyebrow) : null, h("h1", null, title), sub ? h("p", { class: "muted" }, sub) : null),
    actions ? h("div", { class: "page-actions" }, actions) : null);
}

function meter(label, value, { warn, crit, invert = false } = {}) {
  const v = typeof value === "number" && Number.isFinite(value) ? value : null;
  let tone = "ok";
  if (v !== null) {
    const bad = invert ? v <= crit : v >= crit, mid = invert ? v <= warn : v >= warn;
    tone = bad ? "crit" : mid ? "warn" : "ok";
  }
  const bar = h("div", { class: "meter-bar" }, h("span", { class: `meter-fill ${v === null ? "none" : tone}` }));
  if (v !== null) bar.firstChild.style.width = `${Math.min(100, Math.max(0, v))}%`;
  return h("div", { class: "meter" }, h("div", { class: "meter-top" }, h("span", null, label), h("strong", null, pct(v ?? undefined))), bar);
}

// --- Dashboard ------------------------------------------------------------------------
export async function dashboardView({ ctx }) {
  const [health, cabinets, alerts, actions] = await Promise.all([
    get("/api/fleet/health"),
    get("/api/cabinets", { pageSize: 200, isActive: true }),
    get("/api/connectivity-alerts", { pageSize: 5 }),
    get("/api/actions", { pageSize: 6 }),
  ]);
  const order = { Critical: 0, Offline: 1, Warning: 2, Unknown: 3, Healthy: 4 };
  // In Demo mode real cabinets are always listed first, whatever their health.
  const attention = cabinets.items.filter(c => c.health !== "Healthy" || c.source === "live")
    .sort((a, b) => (b.source === "live") - (a.source === "live") || order[a.health] - order[b.health]).slice(0, 8);
  const first = ctx.session.user.displayName.split(" ")[0];

  return h("div", { class: "page" },
    pageHead("Overview", `Good ${new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening"}, ${first}`,
      `Fleet snapshot generated ${ago(health.generatedUtc)}. Health reflects each cabinet's last check-in, not a live probe.`,
      h("button", { class: "btn", onclick: () => ctx.rerender() }, "↻ Refresh")),
    !ctx.isDemo && health.totalCabinets === 0 && health.pendingRegistrations === 0
      ? h("div", { class: "callout info" },
        h("span", null, h("strong", null, "No cabinets are connected yet. "),
          ctx.isAdmin ? "Install the Windows Agent on a cabinet PC or lab laptop; it will appear under Enrollment for approval." : "An administrator needs to install and approve an Agent first."),
        h("a", { href: "#/settings" }, ctx.isAdmin ? "Agent setup and Demo mode →" : "Try Demo mode in Settings →"))
      : null,
    ctx.isDemo && health.liveCabinets
      ? h("a", { class: "callout live", href: "#/cabinets" },
        h("span", null, h("strong", null, `${health.liveCabinets} real cabinet${health.liveCabinets === 1 ? "" : "s"} `), "shown alongside the sample fleet. Look for the ", h("strong", null, "● LIVE"), " badge — its data and diagnostics are real."),
        h("span", null, "Open cabinets →"))
      : null,
    ctx.isAdmin && health.pendingRegistrations > 0
      ? h("a", { class: "callout", href: "#/admin/enrollment" },
        h("strong", null, `${health.pendingRegistrations} cabinet${health.pendingRegistrations === 1 ? "" : "s"} waiting for enrollment approval`),
        h("span", null, "Review and assign them to a client and site →"))
      : null,
    h("div", { class: "stats" },
      statTile("Active cabinets", health.totalCabinets, { href: "#/cabinets" }),
      statTile("Healthy", health.healthy, { tone: "ok", href: "#/cabinets?health=Healthy" }),
      statTile("Warning", health.warning, { tone: "warn", href: "#/cabinets?health=Warning" }),
      statTile("Critical", health.critical, { tone: "crit", href: "#/cabinets?health=Critical" }),
      statTile("Offline", health.offline, { tone: "off", href: "#/cabinets?health=Offline" }),
      statTile("Unknown", health.unknown, { tone: "unknown", href: "#/cabinets?health=Unknown", note: `${health.noMeasurement} never measured` })),
    h("div", { class: "grid-2" },
      card("Needs attention", table({
        rows: attention, emptyText: health.totalCabinets ? "Every active cabinet is healthy." : "No cabinets to show yet.",
        onRow: c => ctx.navigate(`/cabinets/${c.id}`),
        columns: [
          { label: "Cabinet", render: c => h("span", { class: "row gap" }, h("a", { href: `#/cabinets/${c.id}` }, cabinetName(c)), liveChip(c)) },
          { label: "Site", render: c => `${c.clientName} · ${c.siteName}` },
          { label: "Health", render: c => healthBadge(c.health) },
          { label: "Last check-in", render: c => ago(c.lastCheckInUtc) },
        ],
      }), { actions: h("a", { href: "#/cabinets", class: "link" }, "All cabinets →") }),
      card("Fleet signals", facts([
        ["Pending Windows updates", `${n(health.withPendingUpdates, "cabinet")} (${health.withPendingSecurityUpdates} with security updates)`],
        ["Reboot pending", n(health.rebootPending, "cabinet")],
        ["Auto-start services stopped", n(health.withAutoStartServicesStopped, "cabinet")],
        ["Disks", `${health.disks.healthy} healthy · ${health.disks.watch} watch · ${health.disks.failing} failing · ${health.disks.unknown} unknown`],
        ["Sites with sync cabinet offline", String(health.sitesWithOfflineSyncCabinet)],
        ["Stale check-ins", `${health.stale} (older than ${health.staleAfterHours}h)`],
        ["Agent versions", health.agentVersions.length ? health.agentVersions.map(v => `${v.version ?? "unknown"} (${v.cabinetCount})`).join(", ") : "—"],
      ]))),
    h("div", { class: "grid-2" },
      card("Open connectivity alerts", table({
        rows: alerts.items, emptyText: "No open alerts.",
        columns: [
          { label: "Source", render: a => h("a", { href: `#/cabinets/${a.sourceCabinetId}` }, a.sourceName || "Cabinet") },
          { label: "Site", render: a => `${a.clientName} · ${a.siteName}` },
          { label: "Status", render: a => chip(a.status, a.status === "Open" ? "warn" : "") },
          { label: "Received", render: a => ago(a.receivedUtc) },
        ],
      }), { actions: h("a", { href: "#/alerts", class: "link" }, "All alerts →") }),
      card("Recent diagnostics", actionsTable(actions.items, { showCabinet: true }), { actions: h("a", { href: "#/activity", class: "link" }, "All activity →") })));
}

// --- Cabinets list ----------------------------------------------------------------------
export async function cabinetsView({ query, ctx }) {
  const page = Math.max(1, Number(query.page) || 1);
  const filters = { search: query.search ?? "", health: HEALTH.includes(query.health) ? query.health : "", role: ROLES.includes(query.role) ? query.role : "", inactive: query.inactive === "1" };
  const data = await get("/api/cabinets", {
    page, pageSize: 25, search: filters.search, health: filters.health, role: filters.role, isActive: filters.inactive ? undefined : true,
  });
  const go = changes => ctx.navigate("/cabinets", { search: filters.search, health: filters.health, role: filters.role, inactive: filters.inactive ? "1" : "", page: 1, ...changes });
  const search = h("input", { type: "search", value: filters.search, placeholder: "Name, hostname, client, site…", "aria-label": "Search cabinets", maxlength: 100 });
  const select = (label, values, value, key) => h("label", { class: "inline-field" }, h("span", null, label),
    h("select", { onchange: e => go({ [key]: e.target.value }) }, h("option", { value: "" }, "All"), values.map(v => h("option", { value: v, selected: v === value }, v))));

  return h("div", { class: "page" },
    pageHead("Workspace", "Cabinets", `${data.totalCount} cabinet${data.totalCount === 1 ? "" : "s"} match.`),
    h("form", { class: "toolbar", onsubmit: e => { e.preventDefault(); go({ search: search.value.trim() }); } },
      search, h("button", { class: "btn" }, "Search"),
      select("Health", HEALTH, filters.health, "health"),
      select("Role", ROLES, filters.role, "role"),
      h("label", { class: "inline-field check" }, h("input", { type: "checkbox", checked: filters.inactive, onchange: e => go({ inactive: e.target.checked ? "1" : "" }) }), h("span", null, "Include retired"))),
    card(null, [
      table({
        rows: data.items, caption: "Cabinets", emptyText: filters.search ? `No cabinets match “${filters.search}”.` : "No cabinets are enrolled yet. Approve a pending agent under Enrollment to add one.",
        onRow: c => ctx.navigate(`/cabinets/${c.id}`),
        columns: [
          { label: "Cabinet", render: c => h("div", { class: "cell-stack" }, h("span", { class: "row gap" }, h("a", { href: `#/cabinets/${c.id}` }, cabinetName(c)), liveChip(c)), h("small", null, c.hostname)) },
          { label: "Client · Site", render: c => h("div", { class: "cell-stack" }, h("span", null, c.clientName), h("small", null, [c.siteName, c.departmentName].filter(Boolean).join(" · "))) },
          { label: "Role", render: c => chip(c.role) },
          { label: "Health", render: c => c.isActive ? healthBadge(c.health) : chip("Retired", "muted") },
          { label: "CPU", cls: "num", render: c => pct(c.cpuPercent) },
          { label: "RAM", cls: "num", render: c => pct(c.ramUsedPercent) },
          { label: "Min free disk", cls: "num", render: c => pct(c.minFreeDiskPercent) },
          { label: "Last check-in", render: c => h("span", { title: dateTime(c.lastCheckInUtc) }, ago(c.lastCheckInUtc)) },
          { label: "Agent", render: c => c.agentVersion ?? "—" },
        ],
      }),
      pager(data.page, data.totalPages, p => go({ page: p })),
    ]));
}

// --- Diagnostics (observation-only actions) ----------------------------------------------
const STATUS_TONE = { Completed: "ok", Dispatched: "info", Approved: "info", PendingApproval: "warn", Denied: "crit", Expired: "muted", Cancelled: "muted" };
function actionStatus(a) {
  if (a.status === "Completed" && a.resultStatus && a.resultStatus !== "Succeeded") return chip(splitWords(a.resultStatus), "crit");
  return chip(splitWords(a.status), STATUS_TONE[a.status] ?? "");
}
function actionsTable(rows, { showCabinet = false } = {}) {
  return table({
    rows, emptyText: "No diagnostics have been requested yet.",
    columns: [
      { label: "Diagnostic", render: a => splitWords(a.action) },
      showCabinet ? { label: "Cabinet", render: a => h("a", { href: `#/cabinets/${a.cabinetId}` }, a.cabinetHostname ?? "Cabinet") } : null,
      { label: "Requested by", render: a => a.requestedByDisplayName ?? "—" },
      { label: "Requested", render: a => h("span", { title: dateTime(a.requestedUtc) }, ago(a.requestedUtc)) },
      { label: "Status", render: actionStatus },
    ].filter(Boolean),
  });
}

const FRIENDLY_ACTION = {
  GetProcessList: { tab: "processes", label: "Refresh process list" },
  RunEventLogView: { tab: "events", label: "Run an event log view" },
};

async function requestDiagnostic(cabinet, ctx, preset) {
  const [catalog, views] = await Promise.all([get("/api/actions/catalog"), get("/api/event-log-views", { pageSize: 100 })]);
  const usable = catalog.filter(a => !a.requiresApproval && !a.isDisruptive && a.action !== "CollectEventLogs");
  if (!usable.length) return toast("No diagnostics are available for this cabinet.", "error");
  const fields = [
    { name: "action", label: "Diagnostic", type: "select", required: true, value: preset ?? usable[0].action, options: usable.map(a => ({ value: a.action, label: a.displayName })) },
    { name: "view", label: "Event log view (for “Run an event log view”)", type: "select", value: (views.items.find(v => v.displayName === "Recent errors and warnings") ?? views.items[0])?.id, options: views.items.map(v => ({ value: v.id, label: v.displayName })) },
    { name: "reason", label: "Reason", type: "textarea", required: true, placeholder: "e.g. Ticket 1042 – user reports dispensing UI freezing", maxlength: 500 },
    { name: "ticket", label: "Ticket reference", maxlength: 64 },
  ];
  const result = await formDialog({
    title: `Request diagnostic · ${cabinetName(cabinet)}`,
    intro: "Diagnostics are read-only observations. The agent collects them at its next poll; results appear on this page.",
    fields, submitLabel: "Request",
    submit: async v => post("/api/actions", {
      action: v.action, cabinetId: cabinet.id, reason: v.reason, ticketReference: v.ticket || undefined,
      parameters: v.action === "RunEventLogView" ? { eventLogViewId: v.view } : {},
    }),
  });
  if (!result || result === true) return;
  toast(`${splitWords(result.action)} requested. Waiting for the agent…`, "success");
  watchAction(result.id, cabinet, ctx);
  const target = FRIENDLY_ACTION[result.action]?.tab ?? "activity";
  ctx.navigate(`/cabinets/${cabinet.id}/${target}`);
}

const watching = new Set();
function watchAction(id, cabinet, ctx) {
  if (watching.has(id)) return;
  watching.add(id);
  let tries = 0;
  const tick = async () => {
    tries++;
    try {
      const a = await get(`/api/actions/${id}`);
      if (["Completed", "Denied", "Expired", "Cancelled"].includes(a.status)) {
        watching.delete(id);
        const ok = a.status === "Completed" && a.resultStatus === "Succeeded";
        toast(`${splitWords(a.action)} on ${cabinetName(cabinet)} ${ok ? "completed" : `ended: ${splitWords(a.resultStatus ?? a.status)}`}.`, ok ? "success" : "error");
        if (location.hash.includes(cabinet.id)) ctx.rerender();
        return;
      }
    } catch { /* keep polling briefly */ }
    if (tries < 60) setTimeout(tick, 3000); else watching.delete(id);
  };
  setTimeout(tick, 2000);
}

// --- Cabinet workspace --------------------------------------------------------------------
const TABS = [
  ["overview", "Overview"], ["performance", "Performance"], ["processes", "Processes"], ["services", "Services"],
  ["storage", "Storage"], ["network", "Network"], ["updates", "Updates"], ["events", "Events"], ["system", "System"], ["activity", "Activity"],
];

export async function cabinetView({ params: [id, tabParam], ctx }) {
  const tab = TABS.some(([k]) => k === tabParam) ? tabParam : "overview";
  const detail = await get(`/api/cabinets/${id}`);
  const c = detail.cabinet;
  const inv = detail.currentInventory;
  const panel = h("div", { class: "tab-panel", role: "tabpanel", id: "cabinet-panel", "aria-labelledby": `tab-${tab}` }, loading());
  const adminMenu = ctx.isAdmin && c.isActive ? [
    h("button", { class: "btn ghost", onclick: () => renameCabinet(c, ctx) }, "Rename"),
    h("button", { class: "btn ghost", onclick: () => setRole(c, ctx) }, "Change role"),
    h("button", { class: "btn ghost danger-text", onclick: () => retire(c, ctx) }, "Retire"),
  ] : [];

  const view = h("div", { class: "page" },
    h("nav", { class: "crumbs", "aria-label": "Breadcrumb" },
      h("a", { href: "#/cabinets" }, "Cabinets"), " / ",
      h("a", { href: `#/cabinets?search=${encodeURIComponent(c.clientName)}` }, c.clientName), " / ",
      h("a", { href: `#/sites/${c.siteId}` }, c.siteName), " / ", h("span", { "aria-current": "page" }, cabinetName(c))),
    h("header", { class: "cabinet-head" },
      h("div", { class: "cabinet-title" },
        h("h1", null, cabinetName(c)),
        h("div", { class: "row gap wrap" }, liveChip(detail), c.isActive ? healthBadge(c.health) : chip("Retired", "muted"), chip(c.role), c.departmentName ? chip(c.departmentName) : null,
          h("span", { class: "muted" }, `${c.hostname} · last check-in ${ago(c.lastCheckInUtc)}`))),
      h("div", { class: "page-actions" },
        c.isActive ? h("button", { class: "btn primary", onclick: () => requestDiagnostic(c, ctx) }, "Run diagnostic") : null,
        ...adminMenu)),
    h("div", { class: "tabs", role: "tablist", "aria-label": "Cabinet sections" },
      TABS.map(([key, label]) => h("a", { role: "tab", id: `tab-${key}`, href: `#/cabinets/${id}/${key}`, class: key === tab ? "active" : "", "aria-selected": key === tab ? "true" : "false", "aria-controls": "cabinet-panel" }, label))),
    panel);

  const renderers = { overview, performance, processes, services, storage, network, updates, events, system, activity };
  renderers[tab]({ detail, c, inv, ctx, id })
    .then(node => clear(panel).append(node))
    .catch(err => clear(panel).append(errorBox(err)));
  return view;
}

const noInventory = () => empty("No inventory has been reported yet.", "The agent sends a full inventory shortly after approval and every few hours after that.");

async function overview({ detail, c, inv }) {
  const hb = detail.latestHeartbeat;
  const link = detail.syncCabinetLink;
  return h("div", { class: "grid-2" },
    card("Latest heartbeat", hb ? [
      h("div", { class: "meters" },
        meter("CPU", hb.cpuPercent, { warn: 90, crit: 101 }),
        meter("Memory used", hb.ramUsedPercent, { warn: 88, crit: 95 }),
        meter("Lowest free disk", hb.minFreeDiskPercent, { warn: 12, crit: 5, invert: true })),
      facts([
        ["Collected", `${dateTime(hb.collectedAtUtc)} (${ago(hb.collectedAtUtc)})`],
        ["Uptime", duration(hb.uptime)],
        ["Pending updates", hb.pendingUpdateCount ?? "—"],
        ["Reboot pending", hb.rebootPending == null ? "—" : hb.rebootPending ? "Yes" : "No"],
        ["User signed in", hb.anyUserLoggedOn == null ? "—" : hb.anyUserLoggedOn ? "Yes" : "No"],
        ["Worst disk health", hb.worstDiskHealth],
      ]),
    ] : empty("No heartbeat yet.", "Heartbeats start once the agent learns it was approved.")),
    card("Cabinet", facts([
      ["Client", c.clientName], ["Site", c.siteName], ["Department", c.departmentName], ["Role", c.role],
      ["Hostname", c.hostname], ["Machine ID", h("code", null, c.machineId)], ["Cabinet ID", h("code", null, c.id)],
      ["Agent version", c.agentVersion], ["Model / serial", [c.model, c.serialNumber].filter(Boolean).join(" · ") || "—"],
      ["Time zone", c.timeZoneId ?? inv?.system?.timeZoneId], ["Cabinet local time", detail.cabinetLocalTime ? new Date(detail.cabinetLocalTime).toLocaleString() : "—"],
      ["Operating system", inv?.system ? `${inv.system.osVersion ?? ""} ${inv.system.osBuild ?? ""}` : "—"],
    ])),
    card("Site topology", facts([
      ["Site", h("a", { href: `#/sites/${detail.site.id}` }, `${detail.site.clientName} · ${detail.site.siteName}`)],
      ["Cabinets at site", detail.site.cabinetCount],
      ["Sync cabinet", detail.site.syncCabinetId ? h("a", { href: `#/cabinets/${detail.site.syncCabinetId}` }, detail.site.syncCabinetHostname ?? "Sync cabinet") : "None designated"],
      link ? ["Last probe to sync", link.lastProbeReachable == null ? "Never probed" : `${link.lastProbeReachable ? "Reachable" : "Not reachable"} ${ago(link.lastProbeUtc)}`] : null,
    ])),
    card("Disk health (SMART)", detail.latestSmartReadings.length ? table({
      rows: detail.latestSmartReadings,
      columns: [
        { label: "Drive", render: s => s.driveModel ?? s.driveSerial },
        { label: "Health", render: s => chip(s.health, s.health === "Healthy" ? "ok" : s.health === "Failing" ? "crit" : s.health === "Watch" ? "warn" : "") },
        { label: "Temp", cls: "num", render: s => s.smart?.temperatureCelsius != null ? `${s.smart.temperatureCelsius} °C` : "—" },
        { label: "Observed", render: s => ago(s.timestampUtc) },
      ],
    }) : empty("No SMART readings reported.")));
}

async function performance({ id }) {
  const from = new Date(Date.now() - 24 * 3600_000).toISOString();
  const data = await get(`/api/cabinets/${id}/heartbeats`, { fromUtc: from, pageSize: 200 });
  const rows = data.items;
  const series = key => rows.map(r => ({ t: Date.parse(r.collectedAtUtc), v: r[key] }));
  return h("div", null,
    h("p", { class: "muted" }, `Heartbeats in the last 24 hours: ${data.totalCount}. Values are what the agent measured at each check-in.`),
    h("div", { class: "grid-3" },
      card(null, percentChart({ title: "CPU", points: series("cpuPercent"), threshold: 90 })),
      card(null, percentChart({ title: "Memory used", points: series("ramUsedPercent"), threshold: 88 })),
      card(null, percentChart({ title: "Lowest free disk", points: series("minFreeDiskPercent"), threshold: 12 }))),
    card("Recent heartbeats", table({
      rows: rows.slice(0, 25),
      columns: [
        { label: "Collected", render: r => dateTime(r.collectedAtUtc) },
        { label: "CPU", cls: "num", render: r => pct(r.cpuPercent) },
        { label: "Memory", cls: "num", render: r => pct(r.ramUsedPercent) },
        { label: "Free disk", cls: "num", render: r => pct(r.minFreeDiskPercent) },
        { label: "Updates", cls: "num", render: r => r.pendingUpdateCount ?? "—" },
        { label: "Uptime", render: r => duration(r.uptime) },
      ],
    })));
}

async function processes({ c, ctx, id }) {
  let latest = null;
  try { latest = await get(`/api/cabinets/${id}/process-results/latest`); } catch (err) { if (err.status !== 404) throw err; }
  const filter = h("input", { type: "search", placeholder: "Filter processes", "aria-label": "Filter processes" });
  const holder = h("div");
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = (latest?.processes ?? []).filter(p => !q || p.name.toLowerCase().includes(q)).sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0));
    clear(holder).append(table({ rows, emptyText: "No processes match.", columns: [
      { label: "Process", render: p => p.name }, { label: "PID", cls: "num", render: p => p.pid },
      { label: "CPU", cls: "num", render: p => pct(p.cpuPercent) }, { label: "Memory", cls: "num", render: p => bytes(p.workingSetBytes) },
      { label: "Threads", cls: "num", render: p => p.threadCount ?? "—" }, { label: "Handles", cls: "num", render: p => p.handleCount ?? "—" },
    ] }));
  };
  filter.addEventListener("input", draw);
  const refresh = c.isActive ? h("button", { class: "btn", onclick: () => requestDiagnostic(c, ctx, "GetProcessList") }, "↻ Refresh process list") : null;
  if (!latest) return card("Processes", [empty("No process list has been collected yet.", "Request one — the agent reads it on its next poll."), refresh]);
  if (latest.state === "pending") watchAction(latest.actionId, c, ctx);
  draw();
  return card("Processes", [
    h("div", { class: "toolbar" }, filter, h("span", { class: "muted" },
      latest.state === "pending" ? "Collection in progress…" : `Collected ${ago(latest.completedAtUtc)} · ${latest.processes.length} processes${latest.truncated ? " (truncated)" : ""}`), refresh),
    holder]);
}

async function services({ inv }) {
  if (!inv?.services) return noInventory();
  const filter = h("input", { type: "search", placeholder: "Filter services", "aria-label": "Filter services" });
  const stoppedOnly = h("input", { type: "checkbox" });
  const holder = h("div");
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = inv.services.filter(s => (!q || `${s.name} ${s.displayName ?? ""}`.toLowerCase().includes(q)) &&
      (!stoppedOnly.checked || (s.state !== "Running" && /Automatic/.test(s.startType))));
    clear(holder).append(table({ rows, emptyText: "No services match.", columns: [
      { label: "Service", render: s => h("div", { class: "cell-stack" }, h("span", null, s.displayName ?? s.name), h("small", null, s.name)) },
      { label: "State", render: s => chip(s.state, s.state === "Running" ? "ok" : s.state === "Stopped" ? (/Automatic/.test(s.startType) ? "crit" : "muted") : "warn") },
      { label: "Start type", render: s => splitWords(s.startType) },
      { label: "Runs as", render: s => s.runAsAccount ?? "—" },
    ] }));
  };
  filter.addEventListener("input", draw);
  stoppedOnly.addEventListener("change", draw);
  draw();
  return card("Services", [h("div", { class: "toolbar" }, filter, h("label", { class: "inline-field check" }, stoppedOnly, h("span", null, "Stopped auto-start only")),
    h("span", { class: "muted" }, `Inventory observed ${ago(inv.lastObservedUtc)}`)), holder]);
}

async function storage({ detail, inv }) {
  const disks = inv?.disks ?? [];
  return h("div", null,
    card("Volumes", disks.length ? h("div", { class: "volumes" }, disks.map(d => {
      const used = typeof d.freePercent === "number" ? 100 - d.freePercent : null;
      return h("div", { class: "volume" },
        h("div", { class: "row between" }, h("strong", null, `${d.driveLetter ?? "?"} ${d.label ? `(${d.label})` : ""}`), chip(d.healthStatus, d.healthStatus === "Healthy" ? "ok" : d.healthStatus === "Failing" ? "crit" : d.healthStatus === "Watch" ? "warn" : "")),
        meter("Used", used, { warn: 88, crit: 95 }),
        h("small", { class: "muted" }, `${bytes(d.freeBytes)} free of ${bytes(d.totalBytes)} · ${d.fileSystem ?? ""} · BitLocker: ${splitWords(d.bitLockerStatus)}`));
    })) : noInventory()),
    card("SMART readings", table({
      rows: detail.latestSmartReadings, emptyText: "No SMART readings reported.",
      columns: [
        { label: "Drive", render: s => h("div", { class: "cell-stack" }, h("span", null, s.driveModel ?? "Drive"), h("small", null, s.driveSerial)) },
        { label: "Health", render: s => chip(s.health) },
        { label: "Temperature", cls: "num", render: s => s.smart?.temperatureCelsius != null ? `${s.smart.temperatureCelsius} °C` : "—" },
        { label: "Power-on hours", cls: "num", render: s => s.smart?.powerOnHours ?? "—" },
        { label: "Reallocated", cls: "num", render: s => s.smart?.reallocatedSectorCount ?? "—" },
        { label: "Observed", render: s => dateTime(s.timestampUtc) },
      ],
    })));
}

async function network({ inv }) {
  const n = inv?.network;
  if (!n) return noInventory();
  const fw = v => v == null ? "—" : v ? chip("On", "ok") : chip("Off", "warn");
  return h("div", null,
    card("Connectivity", facts([
      ["Support server reachable", n.serverReachable == null ? "—" : n.serverReachable ? `Yes (${Math.round(n.serverLatencyMs ?? 0)} ms)` : "No"],
      ["Proxy", n.proxyConfigured ? n.proxyAddress ?? "Configured" : "None"],
      ["Firewall · Domain", fw(n.firewallDomainEnabled)], ["Firewall · Private", fw(n.firewallPrivateEnabled)], ["Firewall · Public", fw(n.firewallPublicEnabled)],
    ])),
    card("Adapters", table({
      rows: n.adapters ?? [], emptyText: "No adapters reported.",
      columns: [
        { label: "Adapter", render: a => h("div", { class: "cell-stack" }, h("span", null, a.name), h("small", null, a.description ?? "")) },
        { label: "Status", render: a => chip(splitWords(a.status), a.status === "Up" ? "ok" : "muted") },
        { label: "IP addresses", render: a => (a.ipAddresses ?? []).join(", ") || "—" },
        { label: "Gateway", render: a => (a.gateways ?? []).join(", ") || "—" },
        { label: "DNS", render: a => (a.dnsServers ?? []).join(", ") || "—" },
        { label: "DHCP", render: a => a.dhcpEnabled == null ? "—" : a.dhcpEnabled ? "Yes" : "No" },
        { label: "Speed", cls: "num", render: a => a.linkSpeedBps ? `${Math.round(a.linkSpeedBps / 1e6)} Mbps` : "—" },
      ],
    })));
}

async function updates({ inv }) {
  const u = inv?.windowsUpdate;
  if (!u) return noInventory();
  return h("div", null,
    card("Windows Update", facts([
      ["Pending updates", u.pendingUpdateCount ?? (u.pendingUpdates?.length ?? "—")],
      ["Reboot pending", u.rebootPending == null ? "—" : u.rebootPending ? "Yes" : "No"],
      ["Last successful install", dateTime(u.lastSuccessfulInstallUtc)],
      ["Managed by policy", u.isManagedByPolicy == null ? "—" : u.isManagedByPolicy ? "Yes" : "No"],
      ["Active hours", u.activeHoursStart ? `${u.activeHoursStart} – ${u.activeHoursEnd}` : "—"],
    ])),
    card("Pending", table({ rows: u.pendingUpdates ?? [], emptyText: "No pending updates.", columns: [
      { label: "Update", render: p => p.title ?? p.updateId }, { label: "Classification", render: p => splitWords(p.classification) },
      { label: "Security", render: p => p.isSecurity ? chip("Security", "warn") : "—" }, { label: "Size", cls: "num", render: p => bytes(p.sizeBytes) },
    ] })),
    card("History", table({ rows: u.history ?? [], emptyText: "No update history reported.", columns: [
      { label: "Update", render: p => p.title ?? "—" }, { label: "Result", render: p => chip(splitWords(p.resultCode), p.resultCode === "Succeeded" ? "ok" : p.resultCode === "Failed" ? "crit" : "") },
      { label: "Date", render: p => dateTime(p.dateUtc) },
    ] })));
}

async function events({ c, ctx, id }) {
  let latest = null;
  try { latest = await get(`/api/cabinets/${id}/event-log-results/latest`); } catch (err) { if (err.status !== 404) throw err; }
  const run = c.isActive ? h("button", { class: "btn", onclick: () => requestDiagnostic(c, ctx, "RunEventLogView") }, "Run event log view") : null;
  if (!latest) return card("Event logs", [empty("No event log view has been run on this cabinet yet.", "Event logs are collected on request so only what you need leaves the cabinet."), run]);
  if (latest.state === "pending") watchAction(latest.actionId, c, ctx);
  const level = h("select", { "aria-label": "Minimum level" }, ["All", "Warning", "Error", "Critical"].map(l => h("option", null, l)));
  const holder = h("div");
  const rank = { verbose: 0, information: 1, unknown: 1, warning: 2, error: 3, critical: 4 };
  const draw = () => {
    const min = { All: 0, Warning: 2, Error: 3, Critical: 4 }[level.value];
    clear(holder).append(table({
      rows: latest.entries.filter(e => (rank[e.level] ?? 0) >= min), emptyText: latest.state === "pending" ? "Waiting for the agent…" : "No events matched.",
      columns: [
        { label: "Time", render: e => dateTime(e.occurredAt) },
        { label: "Level", render: e => chip(e.level.charAt(0).toUpperCase() + e.level.slice(1), e.level === "error" || e.level === "critical" ? "crit" : e.level === "warning" ? "warn" : "") },
        { label: "Channel", render: e => e.channel }, { label: "Source", render: e => e.provider ?? "—" },
        { label: "ID", cls: "num", render: e => e.eventId }, { label: "Message", cls: "wrap", render: e => e.message ?? "" },
      ],
    }));
  };
  level.addEventListener("change", draw);
  draw();
  return card(`Event logs · ${latest.viewDisplayName}`, [
    h("div", { class: "toolbar" }, h("label", { class: "inline-field" }, h("span", null, "Level"), level),
      h("span", { class: "muted" }, latest.state === "pending" ? "Collection in progress…" : `Collected ${ago(latest.completedAtUtc)} · ${latest.entries.length} entries${latest.truncated ? " (truncated)" : ""} · ${latest.state}`), run),
    holder]);
}

async function system({ inv }) {
  const s = inv?.system;
  if (!s) return noInventory();
  return h("div", null,
    card("Operating system", facts([
      ["Hostname", s.hostname], ["OS", s.osVersion], ["Build", s.osBuild], ["Installed", dateTime(s.installDateUtc)],
      ["Last boot", dateTime(s.lastBootUtc)], ["Uptime", duration(s.uptime)], ["Time zone", s.timeZoneId],
      ["Domain / workgroup", `${s.domainOrWorkgroup ?? "—"}${s.isDomainJoined ? " (domain joined)" : ""}`],
      ["Signed-in users", s.loggedOnUserCount ?? "—"], ["Installed memory", bytes(inv.installedMemoryBytes)],
    ])),
    card("Installed software", table({ rows: s.installedSoftware ?? [], emptyText: "No software inventory reported.", columns: [
      { label: "Name", render: p => p.name }, { label: "Version", render: p => p.version ?? "—" }, { label: "Publisher", render: p => p.publisher ?? "—" },
    ] })));
}

async function activity({ id }) {
  const [actions, audit] = await Promise.all([get("/api/actions", { cabinetId: id, pageSize: 20 }), get("/api/audit", { cabinetId: id, pageSize: 20 })]);
  return h("div", { class: "grid-2" }, card("Diagnostics on this cabinet", actionsTable(actions.items)), card("Audit trail", auditTable(audit.items, false)));
}

// --- Cabinet administration (administrators only; enforced by the Server) -------------------
async function renameCabinet(c, ctx) {
  const ok = await formDialog({
    title: "Rename cabinet", submitLabel: "Rename",
    fields: [{ name: "friendlyName", label: "Display name", required: true, value: c.friendlyName ?? "", maxlength: 120 }, { name: "reason", label: "Reason", type: "textarea", required: true }],
    submit: v => patch(`/api/cabinets/${c.id}/name`, v),
  });
  if (ok) { toast("Cabinet renamed.", "success"); ctx.rerender(); }
}
async function setRole(c, ctx) {
  const ok = await formDialog({
    title: "Change cabinet role", submitLabel: "Change role",
    intro: "A site has at most one Sync cabinet; satellites sync through it.",
    fields: [{ name: "role", label: "Role", type: "select", value: c.role, options: ROLES }, { name: "reason", label: "Reason", type: "textarea", required: true }],
    submit: v => put(`/api/cabinets/${c.id}/role`, v),
  });
  if (ok) { toast("Role updated.", "success"); ctx.rerender(); }
}
async function retire(c, ctx) {
  const ok = await formDialog({
    title: `Retire ${cabinetName(c)}?`, danger: true, submitLabel: "Retire cabinet",
    intro: "The cabinet loses operational access and cannot re-register. History is kept. This cannot be undone from the Console.",
    fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }],
    submit: v => post(`/api/cabinets/${c.id}/retire`, v),
  });
  if (ok) { toast("Cabinet retired.", "success"); ctx.rerender(); }
}

// --- Sites -----------------------------------------------------------------------------------
export async function sitesView({ query, ctx }) {
  const page = Math.max(1, Number(query.page) || 1);
  const data = await get("/api/fleet/sites", { page, pageSize: 25, search: query.search });
  return h("div", { class: "page" },
    pageHead("Workspace", "Sites", "Each site normally has one Sync cabinet holding the location database, with satellites syncing to it."),
    card(null, [table({
      rows: data.items, emptyText: "No sites yet. Sites are created when an administrator approves a cabinet.",
      onRow: s => ctx.navigate(`/sites/${s.id}`),
      columns: [
        { label: "Client", render: s => s.clientName }, { label: "Site", render: s => h("a", { href: `#/sites/${s.id}` }, s.siteName) },
        { label: "Cabinets", cls: "num", render: s => s.cabinetCount },
        { label: "Not healthy", cls: "num", render: s => s.unhealthyCabinetCount },
        { label: "Worst health", render: s => healthBadge(s.worstHealth) },
        { label: "Sync cabinet", render: s => s.syncCabinetId ? h("span", null, s.syncCabinetHostname ?? "", " ", healthBadge(s.syncCabinetHealth ?? "Unknown")) : "—" },
      ],
    }), pager(data.page, data.totalPages, p => ctx.navigate("/sites", { page: p }))]));
}

export async function siteView({ params: [id], ctx }) {
  const [d, alerts] = await Promise.all([get(`/api/fleet/sites/${id}`), get("/api/connectivity-alerts", { siteId: id, pageSize: 20 })]);
  return h("div", { class: "page" },
    h("nav", { class: "crumbs" }, h("a", { href: "#/sites" }, "Sites"), " / ", h("span", null, `${d.site.clientName} · ${d.site.siteName}`)),
    pageHead(d.site.clientName, d.site.siteName, `${d.site.cabinetCount} cabinets · worst health ${d.site.worstHealth}`),
    card("Cabinets", table({
      rows: d.cabinets, onRow: c => ctx.navigate(`/cabinets/${c.id}`),
      columns: [
        { label: "Cabinet", render: c => h("a", { href: `#/cabinets/${c.id}` }, cabinetName(c)) }, { label: "Role", render: c => chip(c.role) },
        { label: "Health", render: c => healthBadge(c.health) }, { label: "CPU", cls: "num", render: c => pct(c.cpuPercent) },
        { label: "RAM", cls: "num", render: c => pct(c.ramUsedPercent) }, { label: "Last check-in", render: c => ago(c.lastCheckInUtc) },
      ],
    })),
    card("Connectivity alerts", alertsTable(alerts.items, ctx)));
}

// --- Alerts -----------------------------------------------------------------------------------
function alertsTable(rows, ctx) {
  const annotate = async (a, kind) => {
    const ok = await formDialog({
      title: `${kind === "acknowledge" ? "Acknowledge" : "Resolve"} alert`, submitLabel: kind === "acknowledge" ? "Acknowledge" : "Resolve",
      intro: kind === "resolve" ? "Resolving records your conclusion; it does not prove the link recovered." : "Acknowledging tells the team someone is on it.",
      fields: [{ name: "note", label: "Note", type: "textarea", required: true, maxlength: 1000 }],
      submit: v => post(`/api/connectivity-alerts/${a.id}/${kind}`, { sourceCabinetId: a.sourceCabinetId, note: v.note }),
    });
    if (ok) { toast(`Alert ${kind === "acknowledge" ? "acknowledged" : "resolved"}.`, "success"); ctx.refreshBadges(); ctx.rerender(); }
  };
  return table({
    rows, emptyText: "No connectivity alerts.",
    columns: [
      { label: "Source cabinet", render: a => h("span", { class: "row gap" }, h("a", { href: `#/cabinets/${a.sourceCabinetId}` }, a.sourceName || "Cabinet"), liveChip(a)) },
      { label: "Target", render: a => h("a", { href: `#/cabinets/${a.targetCabinetId}` }, "Sync cabinet") },
      { label: "Site", render: a => `${a.clientName} · ${a.siteName}` },
      { label: "Evidence", render: a => a.incidentEvidence ? `${a.incidentEvidence.failureCount} no-reply / ${a.incidentEvidence.successCount} replies` : "—" },
      { label: "Status", render: a => chip(a.status, a.status === "Open" ? "warn" : a.status === "Resolved" ? "ok" : "info") },
      { label: "Received", render: a => ago(a.receivedUtc) },
      { label: "", render: a => a.status === "Resolved" ? null : h("div", { class: "row gap" },
        a.status === "Open" ? h("button", { class: "btn small", onclick: () => annotate(a, "acknowledge") }, "Acknowledge") : null,
        h("button", { class: "btn small", onclick: () => annotate(a, "resolve") }, "Resolve")) },
    ],
  });
}

export async function alertsView({ query, ctx }) {
  const page = Math.max(1, Number(query.page) || 1);
  const includeResolved = query.resolved === "1";
  const data = await get("/api/connectivity-alerts", { page, pageSize: 25, includeResolved });
  return h("div", { class: "page" },
    pageHead("Workspace", "Connectivity alerts", "Raised when a satellite cabinet repeatedly cannot reach its site's sync cabinet. A missed ping alone does not prove a firewall cause."),
    h("div", { class: "toolbar" }, h("label", { class: "inline-field check" },
      h("input", { type: "checkbox", checked: includeResolved, onchange: e => ctx.navigate("/alerts", { resolved: e.target.checked ? "1" : "" }) }), h("span", null, "Include resolved"))),
    card(null, [alertsTable(data.items, ctx), pager(data.page, data.totalPages, p => ctx.navigate("/alerts", { page: p, resolved: includeResolved ? "1" : "" }))]));
}

// --- Diagnostics activity -------------------------------------------------------------------
export async function activityView({ query, ctx }) {
  const page = Math.max(1, Number(query.page) || 1);
  const status = ["Dispatched", "Completed", "Expired", "Approved"].includes(query.status) ? query.status : "";
  const data = await get("/api/actions", { page, pageSize: 25, status });
  return h("div", { class: "page" },
    pageHead("Workspace", "Diagnostics activity", "Every diagnostic requested by the support team, newest first."),
    h("div", { class: "toolbar" }, h("label", { class: "inline-field" }, h("span", null, "Status"),
      h("select", { onchange: e => ctx.navigate("/activity", { status: e.target.value }) }, h("option", { value: "" }, "All"),
        ["Dispatched", "Completed", "Expired"].map(s => h("option", { value: s, selected: s === status }, s))))),
    card(null, [actionsTable(data.items, { showCabinet: true }), pager(data.page, data.totalPages, p => ctx.navigate("/activity", { page: p, status }))]));
}

// --- Audit -------------------------------------------------------------------------------------
function auditTable(rows, showCabinet = true) {
  return table({
    rows, emptyText: "No audit entries.",
    columns: [
      { label: "Time", render: a => h("span", { title: dateTime(a.timestampUtc) }, dateTime(a.timestampUtc)) },
      { label: "Actor", render: a => h("div", { class: "cell-stack" }, h("span", null, a.actorDisplayName ?? a.actorId), h("small", null, a.actorType)) },
      { label: "Event", render: a => splitWords(a.event) },
      showCabinet ? { label: "Cabinet", render: a => a.cabinetId ? h("a", { href: `#/cabinets/${a.cabinetId}` }, a.cabinetHostname ?? "Cabinet") : "—" } : null,
      { label: "Result", render: a => chip(a.result, a.result === "Success" ? "ok" : a.result === "Denied" ? "crit" : "warn") },
      { label: "Reason", cls: "wrap", render: a => a.reason ?? "" },
    ].filter(Boolean),
  });
}

export async function auditView({ query, ctx }) {
  const page = Math.max(1, Number(query.page) || 1);
  const result = ["Success", "Failure", "Denied"].includes(query.result) ? query.result : "";
  const actorType = ["User", "Agent", "System"].includes(query.actor) ? query.actor : "";
  const data = await get("/api/audit", { page, pageSize: 50, result });
  const rows = actorType ? data.items.filter(a => a.actorType === actorType) : data.items;
  const go = changes => ctx.navigate("/audit", { result, actor: actorType, page: 1, ...changes });
  return h("div", { class: "page" },
    pageHead("Compliance", "Audit log", "Every sign-in, view, decision and agent event, as recorded by the support server."),
    h("div", { class: "toolbar" },
      h("label", { class: "inline-field" }, h("span", null, "Result"), h("select", { onchange: e => go({ result: e.target.value }) }, h("option", { value: "" }, "All"), ["Success", "Failure", "Denied"].map(r => h("option", { selected: r === result }, r)))),
      h("label", { class: "inline-field" }, h("span", null, "Actor"), h("select", { onchange: e => go({ actor: e.target.value }) }, h("option", { value: "" }, "All"), ["User", "Agent", "System"].map(r => h("option", { selected: r === actorType }, r))))),
    card(null, [auditTable(rows), pager(data.page, data.totalPages, p => go({ page: p }))]));
}
