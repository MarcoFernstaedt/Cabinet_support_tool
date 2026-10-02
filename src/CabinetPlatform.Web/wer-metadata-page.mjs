import { validGuid } from "./read-only-pages.mjs";

const fields = (value, names) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const utc = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?(?:Z|\+00:00)$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10);
const stores = ["MachineQueue", "MachineArchive"];
const statuses = ["Read", "Partial", "Denied", "Unavailable"];
const eventTypes = ["APPCRASH", "BEX", "BEX64", "CLR20r3", "MoAppCrash", "AppHangB1"];
const reportGuid = value => typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value) &&
  value.toLowerCase() !== "00000000-0000-0000-0000-000000000000";
const html = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

export function validateWerMetadata(cabinetId, data, actionId = null) {
  if (!fields(data, ["cabinetId", "actionId", "state", "requestedAtUtc", "completedAtUtc", "metadata"]) ||
      !validGuid(data.cabinetId) || data.cabinetId.toLowerCase() !== cabinetId ||
      !validGuid(data.actionId) || (actionId && data.actionId.toLowerCase() !== actionId) ||
      !["complete", "failed", "pending"].includes(data.state) || !utc(data.requestedAtUtc) ||
      !(data.completedAtUtc === null || utc(data.completedAtUtc))) throw Error("Invalid WER result");
  if (data.state !== "complete") {
    if (data.metadata !== null || (data.state === "pending" && data.completedAtUtc !== null)) throw Error("Invalid WER state");
    return data;
  }
  const metadata = data.metadata;
  if (!utc(data.completedAtUtc) || !fields(metadata, ["version", "observedUtc", "stores", "reports"]) ||
      metadata.version !== 1 || !utc(metadata.observedUtc) ||
      Date.parse(metadata.observedUtc) > Date.parse(data.completedAtUtc) + 5 * 60000 ||
      Date.parse(metadata.observedUtc) < Date.parse(data.completedAtUtc) - 7 * 86400000 ||
      !Array.isArray(metadata.stores) || metadata.stores.length !== 2 ||
      !Array.isArray(metadata.reports) || metadata.reports.length > 40) throw Error("Invalid WER metadata");
  const outcomes = new Map();
  for (const row of metadata.stores) {
    if (!fields(row, ["store", "status", "truncated"]) || !stores.includes(row.store) || outcomes.has(row.store) ||
        !statuses.includes(row.status) || typeof row.truncated !== "boolean" || (row.truncated && row.status !== "Partial")) throw Error("Invalid WER store");
    outcomes.set(row.store, row.status);
  }
  const ids = new Set();
  for (const row of metadata.reports) {
    if (!fields(row, ["reportId", "createdUtc", "eventType", "store"]) || !reportGuid(row.reportId) ||
        ids.has(row.reportId.toLowerCase()) ||
        !utc(row.createdUtc) || !eventTypes.includes(row.eventType) ||
        !["Read", "Partial"].includes(outcomes.get(row.store)) || Date.parse(row.createdUtc) > Date.parse(metadata.observedUtc) ||
        Date.parse(row.createdUtc) < Date.parse(metadata.observedUtc) - 7 * 86400000) throw Error("Invalid WER report");
    ids.add(row.reportId.toLowerCase());
  }
  return data;
}

export function renderWerMetadata(cabinetId, evidence) {
  const { state, data } = evidence;
  if (state === "missing") return "<p>WER metadata not collected for this cabinet. Coverage unknown.</p>";
  if (state === "denied") return "<p>WER metadata access denied. Coverage unknown.</p>";
  if (state === "unsafe") return "<p>WER metadata unsafe or invalid; no report details shown. Coverage unknown.</p>";
  if (state === "unavailable") return "<p>WER metadata unavailable from the support server. Coverage unknown.</p>";
  const link = `/cabinet/${cabinetId}/crashes/${data.actionId.toLowerCase()}`;
  const intro = `<p>Separate WER action: <a href="${link}">Open exact saved WER observation</a>. Requested ${html(data.requestedAtUtc)}; Agent-reported completion ${html(data.completedAtUtc ?? "Unknown")}. Outcome: ${data.state}.</p>`;
  if (data.state !== "complete") return `${intro}<p>WER ${data.state}; machine-store coverage unknown. No report metadata available.</p>`;
  const metadata = data.metadata;
  const outcome = metadata.stores.map(row => `<li>Machine ${row.store === "MachineQueue" ? "queue" : "archive"}: ${row.status.toLowerCase()}${row.truncated ? "; truncated" : ""}.</li>`).join("");
  const reports = metadata.reports.map(row => `<li>${html(row.eventType)} · Report created ${html(row.createdUtc)} · Machine ${row.store === "MachineQueue" ? "queue" : "archive"}. This is report creation time, not the crash time.</li>`).join("");
  return `${intro}<p>Agent-observed ${html(metadata.observedUtc)}. Machine queue holds unsent reports; machine archive holds sent reports. These are independent of collected Event Viewer clues.</p><ul>${outcome}</ul>${reports ? `<h3>Collected WER report metadata</h3><ul>${reports}</ul>` : "<p>No reports in this bounded observation; this does not establish no crash.</p>"}<p>Only recent allowlisted report types are shown. Denied, unavailable, partial or truncated stores and collection bounds leave gaps; no event-to-report match or cause is inferred.</p>`;
}
