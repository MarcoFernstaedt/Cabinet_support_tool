import { validGuid } from "./read-only-pages.mjs";

const html = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const time = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const text = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
const number = (value, max) => value === null || (Number.isFinite(value) && value >= 0 && value <= max);
const count = (value, max) => value === null || (Number.isSafeInteger(value) && value >= 0 && value <= max);
const allowed = new Set(["name", "pid", "cpuPercent", "workingSetBytes", "threadCount", "handleCount"]);
const states = new Set(["pending", "failed", "complete"]);
const serviceStates = new Set(["Unknown", "Stopped", "StartPending", "StopPending", "Running", "ContinuePending", "PausePending", "Paused"]);
const startTypes = new Set(["Unknown", "Boot", "System", "Automatic", "Manual", "Disabled", "AutomaticDelayed"]);

export function validateProcessResult(cabinetId, data) {
  if (!data || !validGuid(data.cabinetId) || data.cabinetId.toLowerCase() !== cabinetId ||
      !validGuid(data.actionId) || !states.has(data.state) || !time(data.requestedAtUtc) ||
      (data.completedAtUtc !== null && data.completedAtUtc !== undefined && !time(data.completedAtUtc)) ||
      typeof data.truncated !== "boolean" || !Array.isArray(data.processes) || data.processes.length > 200)
    throw Error("Invalid process observation");
  if ((data.state === "pending" || data.state === "failed") && data.processes.length)
    throw Error("Unverified process observation");
  const seen = new Set();
  for (const row of data.processes) {
    if (!row || Object.keys(row).some(key => !allowed.has(key)) ||
        !text(row.name) || /[\\/]/.test(row.name) || !Number.isSafeInteger(row.pid) || row.pid < 0 ||
        !number(row.cpuPercent, 100) || !count(row.workingSetBytes, Number.MAX_SAFE_INTEGER) ||
        !count(row.threadCount, 1000000) || !count(row.handleCount, 10000000) || seen.has(row.pid))
      throw Error("Invalid process observation");
    seen.add(row.pid);
  }
}

function servicesFromCabinet(cabinetId, data) {
  if (!data?.cabinet || !validGuid(data.cabinet.id) || data.cabinet.id.toLowerCase() !== cabinetId ||
      !data.site || !validGuid(data.cabinet.siteId) || data.site.id.toLowerCase() !== data.cabinet.siteId.toLowerCase())
    throw Error("Invalid cabinet identity");
  const inventory = data.currentInventory;
  if (inventory === null || inventory === undefined) return { description: "No service inventory has been retained for this cabinet.", rows: [] };
  if (!time(inventory.firstObservedUtc) || !time(inventory.lastObservedUtc) ||
      Date.parse(inventory.lastObservedUtc) < Date.parse(inventory.firstObservedUtc)) throw Error("Invalid inventory times");
  if (inventory.services === null || inventory.services === undefined)
    return { description: `Service inventory unavailable. Version first observed ${html(inventory.firstObservedUtc)}; last confirmed ${html(inventory.lastObservedUtc)}.`, rows: [] };
  if (!Array.isArray(inventory.services)) throw Error("Invalid service inventory");
  const rows = inventory.services.slice(0, 500).map(service => {
    if (!service || !text(service.name) || (service.displayName != null && !text(service.displayName, 512)) ||
        !serviceStates.has(service.state) || !startTypes.has(service.startType)) throw Error("Invalid service inventory");
    return `<li><strong>${html(service.displayName ?? service.name)}</strong> (${html(service.name)}): ${html(service.state)}; start type ${html(service.startType)}.</li>`;
  });
  return { description: `Retained service inventory, first observed ${html(inventory.firstObservedUtc)}; last confirmed ${html(inventory.lastObservedUtc)}. State and PID may be from the first stored observation, not current. ${inventory.services.length > 500 ? "Only the first 500 services are shown; inventory truncated." : ""}`, rows };
}

export function renderProcessDiagnostics(cabinetId, process, cabinet) {
  const services = servicesFromCabinet(cabinetId, cabinet);
  if (process !== null) validateProcessResult(cabinetId, process);
  const base = `/cabinet/${cabinetId}/processes`;
  const title = process === null ? "No saved process observation for this cabinet." :
    `Saved action ${html(process.actionId)}. Requested ${html(process.requestedAtUtc)}; Agent-reported completion ${html(process.completedAtUtc ?? "Unknown")}. Outcome: ${html(process.state)}.`;
  const rows = process?.processes.map(row => `<li><strong>${html(row.name)}</strong> · PID ${row.pid}; CPU ${html(row.cpuPercent ?? "Unknown")}; working set ${html(row.workingSetBytes ?? "Unknown")} bytes; threads ${html(row.threadCount ?? "Unknown")}; handles ${html(row.handleCount ?? "Unknown")}.</li>`).join("") ?? "";
  const message = process === null ? "No saved process observation. Service inventory can still be inspected." :
    process.state === "pending" || process.state === "failed" ? `Process observation ${html(process.state)}; no verified rows available.` :
    `${process.processes.length} saved process rows. ${process.truncated ? "Result truncated; additional processes are not shown." : "This is not a live process sample."}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Process and service observations | Mashura Support</title><link rel="stylesheet" href="/styles.css"></head><body><main class="fleet-page"><p class="tag">LOCAL DEVELOPMENT BUILD · NO MFA</p><a href="/cabinet/${cabinetId}">Back to cabinet</a><h1>Process and service observations</h1><p>Cabinet ${cabinetId}. Historical observations only; these do not establish crash-time process state.</p><h2>Processes</h2><p>${title}</p><p role="status">${message}</p>${process ? `<a href="${base}/${process.actionId}">Pin this saved process result</a>` : ""}${rows ? `<ul class="fleet-list">${rows}</ul>` : "<p>No collected process rows available.</p>"}<h2>Services</h2><p>${services.description}</p>${services.rows.length ? `<ul class="fleet-list">${services.rows.join("")}</ul>` : "<p>No retained service rows available.</p>"}<p>Service PID is deliberately not shown: unchanged inventory may retain an older PID. No process or service control is available here.</p></main></body></html>`;
}
