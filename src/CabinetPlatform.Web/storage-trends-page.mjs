import { validGuid } from "./read-only-pages.mjs";
import { opaqueStorageToken, preciseStorageUtc, validStorageUtc, validStorageWindow, validateSmart } from "./storage-investigation-page.mjs";

const escape = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const display = value => value == null ? "Unknown" : escape(value);
const exact = (a, b) => preciseStorageUtc(a) === preciseStorageUtc(b);

export function renderStorageTrends(cabinetId, selector, requested, data) {
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).some(key => !["cabinetId", "fromUtc", "toUtc", "asOfUtc", "items", "nextCursor"].includes(key)) ||
      !validGuid(data.cabinetId) || data.cabinetId.toLowerCase() !== cabinetId ||
      !validStorageWindow(data.fromUtc, data.toUtc) || !exact(data.fromUtc, requested.from) || !exact(data.toUtc, requested.to) ||
      !validStorageUtc(data.asOfUtc) || !Array.isArray(data.items) || data.items.length > 20 ||
      (data.nextCursor != null && (!opaqueStorageToken(data.nextCursor) || data.items.length === 0)))
    throw Error("Invalid SMART history");
  let previous = null;
  const rows = data.items.map((row, index) => {
    if (!validateSmart(row) ||
        (row.receivedUtc != null && !validStorageUtc(row.receivedUtc)) ||
        preciseStorageUtc(row.observedUtc) < preciseStorageUtc(data.fromUtc) || preciseStorageUtc(row.observedUtc) >= preciseStorageUtc(data.toUtc) ||
        (previous !== null && preciseStorageUtc(row.observedUtc) > previous)) throw Error("Invalid SMART trend point");
    previous = preciseStorageUtc(row.observedUtc);
    return `<li><article class="incident-card"><h2>Observation ${index + 1}</h2><p>Agent observed ${escape(row.observedUtc)}; server receipt ${display(row.receivedUtc)}. Reported health ${escape(row.health)}; dominant source ${escape(row.source)}, not per-counter provenance. ${row.aggregated ? "Daily worst-value aggregate, not an individual measurement at midnight." : "Individual retained observation."}</p><p>Temperature ${display(row.temperatureCelsius)} °C; power-on hours ${display(row.powerOnHours)}; rated endurance consumed ${row.wearPercent == null ? "Unknown" : `${row.wearPercent}%`}; reallocated sectors ${display(row.reallocatedSectors)}; pending sectors ${display(row.pendingSectors)}. Missing counters are unknown, not zero.</p></article></li>`;
  });
  const query = new URLSearchParams({ driveSelector: selector, from: requested.from, to: requested.to, ...(data.nextCursor ? { cursor: data.nextCursor } : {}) });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SMART trend | Mashura Support</title><link rel="stylesheet" href="/styles.css"></head><body><main class="fleet-page"><p class="tag">LOCAL DEVELOPMENT BUILD · NO MFA</p><a href="/cabinet/${cabinetId}/storage">Back to storage snapshot</a><h1>Retained SMART trend</h1><p>Cabinet ${cabinetId}; observation window [${escape(data.fromUtc)}, ${escape(data.toUtc)}). Server query ${escape(data.asOfUtc)}. Historical reports do not establish current drive condition, physical continuity, or complete coverage. Retention, delayed delivery and clock drift can change later pages.</p>${rows.length ? `<ul class="fleet-list">${rows.join("")}</ul>` : "<p>No retained observations in this window. Drive condition is unknown.</p>"}${data.nextCursor ? `<nav aria-label="SMART trend pages"><a href="/cabinet/${cabinetId}/storage/trends?${escape(query.toString())}">Older retained observations</a></nav>` : "<p>No additional retained observations in this query.</p>"}</main></body></html>`;
}
