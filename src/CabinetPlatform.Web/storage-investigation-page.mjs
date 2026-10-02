import { validGuid } from "./read-only-pages.mjs";

const escape = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const utc = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)$/.test(value) && Number.isFinite(Date.parse(value));
const number = (value, max) => value == null || (Number.isFinite(value) && value >= 0 && value <= max);
const integer = value => value == null || (Number.isSafeInteger(value) && value >= 0 && value <= 2147483647);
const fields = (value, permitted) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => permitted.includes(key));
const unknown = value => value == null ? "Unknown" : escape(value);

export function renderStorageInvestigation(cabinetId, data) {
  if (!data || !validGuid(data.cabinetId) || data.cabinetId.toLowerCase() !== cabinetId || !utc(data.asOfUtc) ||
      !Array.isArray(data.volumes) || data.volumes.length > 32 || !Array.isArray(data.smart) || data.smart.length > 32)
    throw Error("Invalid storage identity or bounds");
  const heartbeat = data.heartbeat;
  if (heartbeat != null && (!fields(heartbeat, ["collectedAtUtc", "receivedUtc", "diskFreePercent", "worstDiskHealth"]) ||
      !utc(heartbeat.collectedAtUtc) || !utc(heartbeat.receivedUtc) || !number(heartbeat.diskFreePercent, 100) ||
      (heartbeat.worstDiskHealth != null && !["Unknown", "Healthy", "Watch", "Failing"].includes(heartbeat.worstDiskHealth))))
    throw Error("Invalid storage heartbeat");
  const volumes = data.volumes.map((volume, index) => {
    if (!fields(volume, ["freePercent", "observationFirstUtc", "observationLastUtc", "embeddedValuesMeasuredAtUtc"]) ||
        !utc(volume.observationFirstUtc) || !utc(volume.observationLastUtc) ||
        !utc(volume.embeddedValuesMeasuredAtUtc) || !number(volume.freePercent, 100))
      throw Error("Invalid volume evidence");
    return `<li><strong>Volume observation ${index + 1}</strong>. Free space ${volume.freePercent == null ? "Unknown" : `${volume.freePercent}%`}. Embedded values measured at ${escape(volume.embeddedValuesMeasuredAtUtc)}; version observed ${escape(volume.observationFirstUtc)} to ${escape(volume.observationLastUtc)}. A later inventory observation does not remeasure these values. Volume identity is withheld.</li>`;
  });
  const smart = data.smart.map((drive, index) => {
    if (!fields(drive, ["observedUtc", "health", "source", "temperatureCelsius", "powerOnHours", "wearPercent", "reallocatedSectors", "pendingSectors", "aggregated"]) ||
        !utc(drive.observedUtc) ||
        !["Unknown", "Healthy", "Watch", "Failing"].includes(drive.health) ||
        !["Unavailable", "StorageReliabilityCounter", "FailurePredictStatus", "FailurePredictData"].includes(drive.source) ||
        (drive.temperatureCelsius != null && (!Number.isSafeInteger(drive.temperatureCelsius) || drive.temperatureCelsius < -2147483648 || drive.temperatureCelsius > 2147483647)) ||
        !integer(drive.powerOnHours) || !integer(drive.wearPercent) ||
        !integer(drive.reallocatedSectors) || !integer(drive.pendingSectors) ||
        (drive.aggregated != null && typeof drive.aggregated !== "boolean")) throw Error("Invalid SMART evidence");
    return `<li>Drive observation ${index + 1}. Measured ${escape(drive.observedUtc)}; server receipt time not retained. Reported health ${escape(drive.health)}; dominant source ${escape(drive.source)} (not field-by-field provenance)${drive.aggregated ? "; daily worst-value aggregate, not a measurement at midnight" : ""}. Temperature ${unknown(drive.temperatureCelsius)} °C; power-on hours ${unknown(drive.powerOnHours)}; rated endurance consumed ${drive.wearPercent == null ? "Unknown" : `${drive.wearPercent}%`}; reallocated sectors ${unknown(drive.reallocatedSectors)}; pending sectors ${unknown(drive.pendingSectors)}. Missing counters are unknown, not zero. A later drive replacement is not ruled out; drive identity is withheld.</li>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Storage observations | Mashura Support</title><link rel="stylesheet" href="/styles.css"></head><body><main class="fleet-page"><p class="tag">LOCAL DEVELOPMENT BUILD · NO MFA</p><a href="/cabinet/${cabinetId}">Back to cabinet</a><h1>Storage and SMART observations</h1><p>Source cabinet ${cabinetId}; server query ${escape(data.asOfUtc)}. These are historical reports, not verified current drive condition. A retained SMART flag is not a prediction from this page. Missing evidence is unknown.</p>${heartbeat ? `<section><h2>Heartbeat storage summary</h2><p>Collected ${escape(heartbeat.collectedAtUtc)}; server received ${escape(heartbeat.receivedUtc)}. Reported free space ${heartbeat.diskFreePercent == null ? "Unknown" : `${heartbeat.diskFreePercent}%`}; reported worst disk health ${unknown(heartbeat.worstDiskHealth)}. This verdict may be carried from an earlier full collection.</p></section>` : "<p>No heartbeat storage summary available.</p>"}<section><h2>Volume observations</h2>${volumes.length ? `<ul>${volumes.join("")}</ul>` : "<p>No volume observations available. Free space is unknown.</p>"}</section><section><h2>SMART observations</h2>${smart.length ? `<ul>${smart.join("")}</ul>` : "<p>No SMART observations available. Drive condition is unknown.</p>"}</section></main></body></html>`;
}
