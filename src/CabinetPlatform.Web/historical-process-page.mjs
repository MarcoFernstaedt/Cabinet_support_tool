import { validGuid } from "./read-only-pages.mjs";

const fields = (value, names) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const utc = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?(?:Z|\+00:00)$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const html = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const positive = value => Number.isSafeInteger(value) && value > 0;
const ticks = value => BigInt(Date.parse(value)) * 10000n + BigInt(((value.match(/\.(\d{1,7})/)?.[1] ?? "").padEnd(7, "0").slice(3) || "0"));

export function validateHistoricalProcess(cabinetId, data, actionId = null) {
  if (!fields(data, ["cabinetId", "actionId", "state", "requestedAtUtc", "completedAtUtc", "evidence"]) ||
      !validGuid(data.cabinetId) || data.cabinetId.toLowerCase() !== cabinetId ||
      !validGuid(data.actionId) || (actionId && data.actionId.toLowerCase() !== actionId) ||
      !["complete", "pending", "failed"].includes(data.state) || !utc(data.requestedAtUtc) ||
      !(data.completedAtUtc === null || utc(data.completedAtUtc)) ||
      (data.completedAtUtc !== null && ticks(data.completedAtUtc) < ticks(data.requestedAtUtc))) throw Error("Invalid historical process result");
  if (data.state !== "complete") {
    if (data.evidence !== null || (data.state === "pending" && data.completedAtUtc !== null)) throw Error("Invalid process state");
    return data;
  }
  const e = data.evidence;
  if (!utc(data.completedAtUtc) || !fields(e, ["version", "observedUtc", "windowStartUtc", "status", "auditCoverageVerified", "truncated", "events"]) ||
      e.version !== 1 || !utc(e.observedUtc) || !utc(e.windowStartUtc) ||
      ticks(e.observedUtc) - ticks(e.windowStartUtc) !== 864000000000n ||
      ticks(e.observedUtc) > ticks(data.completedAtUtc) + 3000000000n ||
      ticks(e.observedUtc) < ticks(data.completedAtUtc) - 7n * 864000000000n ||
      !["Read", "Partial", "Denied", "Unavailable"].includes(e.status) ||
      e.auditCoverageVerified !== false || typeof e.truncated !== "boolean" ||
      !Array.isArray(e.events) || e.events.length > 64 ||
      (e.truncated && e.status !== "Partial") ||
      (["Denied", "Unavailable"].includes(e.status) && (e.events.length !== 0 || e.truncated))) throw Error("Invalid process evidence");
  const ids = new Set();
  for (const row of e.events) {
    if (!fields(row, ["occurredUtc", "kind", "processId", "recordId"]) || !utc(row.occurredUtc) ||
        ticks(row.occurredUtc) < ticks(e.windowStartUtc) || ticks(row.occurredUtc) > ticks(e.observedUtc) ||
        !["Start", "Exit"].includes(row.kind) || !Number.isInteger(row.processId) || row.processId < 1 || row.processId > 4294967295 ||
        !(row.recordId === null || positive(row.recordId)) || (row.recordId !== null && ids.has(row.recordId))) throw Error("Invalid process event");
    if (row.recordId !== null) ids.add(row.recordId);
  }
  return data;
}

export function renderHistoricalProcess(cabinetId, source) {
  const section = body => `<section class="incident-card"><h2>Historical process lifecycle (independent)</h2>${body}</section>`;
  if (source.state === "missing") return section("<p>Historical process evidence unavailable: not collected. Audit continuity UNKNOWN.</p>");
  if (source.state === "denied") return section("<p>Historical process evidence access denied. Audit continuity UNKNOWN.</p>");
  if (source.state === "unsafe") return section("<p>Historical process evidence unsafe or invalid; no rows shown. Audit continuity UNKNOWN.</p>");
  if (source.state === "unavailable") return section("<p>Historical process evidence unavailable from the support server. Audit continuity UNKNOWN.</p>");
  const d = source.data;
  const intro = `<p>Separate process action: <a href="/cabinet/${cabinetId}/crashes/process/${d.actionId.toLowerCase()}">Open exact saved process observation</a>. Requested ${html(d.requestedAtUtc)}; Agent-reported completion ${html(d.completedAtUtc ?? "Unknown")}. Outcome: ${d.state}.</p>`;
  if (d.state !== "complete") return section(`${intro}<p>Process request ${d.state}. Audit continuity UNKNOWN; no historical rows available.</p>`);
  const e = d.evidence;
  const rows = e.events.map(row => `<li>${row.kind} · PID ${row.processId} · Recorded ${html(row.occurredUtc)}.</li>`).join("");
  return section(`${intro}<p>Observed ${html(e.observedUtc)}; window begins ${html(e.windowStartUtc)}. Source status: ${e.status.toLowerCase()}${e.truncated ? "; truncated, partial coverage" : ""}. Audit continuity UNKNOWN even for a Read with zero rows.</p>${rows ? `<ul>${rows}</ul>` : "<p>No recorded starts or exits in this bounded result; this does not establish no processes ran.</p>"}<p>Each row is an independent recorded start or exit, not a reconstructed lifetime. PID may be reused. Presence at crash time UNKNOWN; no event, WER report or process row establishes cause.</p>`);
}
