import { validGuid, validPage } from "./read-only-pages.mjs";

const html = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const timeOrNull = value => value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
const integer = n => Number.isSafeInteger(n) && n >= 0;
const healthValues = new Set(["Unknown", "Healthy", "Warning", "Critical", "Offline"]);

export function renderFleetHealth(health, cabinets, sites, cabinetPage, sitePage) {
  if (!validPage(cabinets, cabinetPage) || !validPage(sites, sitePage) || !health ||
      ![health.totalCabinets, health.healthy, health.warning, health.critical, health.offline, health.unknown,
        health.noMeasurement, health.staleMeasurement, health.measurementStaleAfterHours, health.stale, health.staleAfterHours].every(integer) ||
      health.totalCabinets !== cabinets.totalCount ||
      health.healthy + health.warning + health.critical + health.offline + health.unknown !== health.totalCabinets ||
      health.noMeasurement > health.totalCabinets || health.staleMeasurement > health.totalCabinets ||
      !timeOrNull(health.generatedUtc) || health.generatedUtc === null)
    throw Error("Invalid fleet health summary");
  const cabinetRows = cabinets.items.map(row => {
    if (!validGuid(row.id) || !validGuid(row.siteId) || row.isActive !== true || !healthValues.has(row.health) ||
        !timeOrNull(row.lastCheckInUtc) || !timeOrNull(row.latestHeartbeatCollectedAtUtc) ||
        !timeOrNull(row.latestHeartbeatReceivedAtUtc) ||
        (row.latestHeartbeatCollectedAtUtc === null) !== (row.latestHeartbeatReceivedAtUtc === null))
      throw Error("Invalid cabinet health");
    return `<li><a href="/cabinet/${row.id}"><strong>${html(row.friendlyName || row.hostname)}</strong></a> · ${html(row.clientName)} / ${html(row.siteName)} · ${html(row.role ?? "Unknown")}. Health classification: ${html(row.health)}. Contact ${html(row.lastCheckInUtc ?? "Never")}; latest heartbeat collected ${html(row.latestHeartbeatCollectedAtUtc ?? "Never")}; received ${html(row.latestHeartbeatReceivedAtUtc ?? "Never")}.</li>`;
  });
  const siteRows = sites.items.map(row => {
    if (!validGuid(row.id) || !integer(row.cabinetCount) || !integer(row.unhealthyCabinetCount) ||
        row.unhealthyCabinetCount > row.cabinetCount || !healthValues.has(row.worstHealth) ||
        (row.syncCabinetId !== null && !validGuid(row.syncCabinetId)) ||
        (row.syncCabinetHealth !== null && !healthValues.has(row.syncCabinetHealth))) throw Error("Invalid site health");
    const sync = row.syncCabinetId === null ? "Standalone site; no sync cabinet relationship." :
      `Sync cabinet <a href="/cabinet/${row.syncCabinetId}">${row.syncCabinetId}</a>; contact-based health ${html(row.syncCabinetHealth ?? "Unknown")}.`;
    let reachability = "No sync reachability evidence.";
    if (row.syncReachability !== null) {
      const r = row.syncReachability;
      if (row.syncCabinetId === null || ![r.reaching, r.notReaching, r.neverProbed].every(integer) ||
          !timeOrNull(r.mostRecentProbeUtc)) throw Error("Invalid sync reachability");
      reachability = `${r.reaching} last reached sync; ${r.notReaching} last did not reach; ${r.neverProbed} never probed. Most recent probe ${html(r.mostRecentProbeUtc ?? "Unknown")}. This is historical evidence, not current reachability or proof of a firewall cause.`;
    }
    return `<li><strong>${html(row.clientName)} / ${html(row.siteName)}</strong> (${row.id}). ${row.cabinetCount} cabinets, ${row.unhealthyCabinetCount} not classified Healthy, including Unknown. Worst classification ${html(row.worstHealth)}. ${sync} ${reachability}</li>`;
  });
  const link = (cabinetNumber, siteNumber) => `/fleet/health?${new URLSearchParams({ cabinetPage: String(cabinetNumber), sitePage: String(siteNumber) })}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fleet and site health | Mashura Support</title><link rel="stylesheet" href="/styles.css"></head><body><main class="fleet-page"><p class="tag">LOCAL DEVELOPMENT BUILD · NO MFA</p><a href="/fleet">Cabinet finder</a><h1>Fleet and site health</h1><p>Read-only classification snapshot at ${html(health.generatedUtc)}. Contact and measurements are separate; a recent contact can carry an old measurement. Health and sync probe history do not prove a current fault.</p><p role="status">${health.totalCabinets} active cabinets: ${health.healthy} Healthy, ${health.warning} Warning, ${health.critical} Critical, ${health.offline} Offline by contact threshold, ${health.unknown} Unknown. ${health.noMeasurement} with no measurement; ${health.staleMeasurement} stale measurement after ${health.measurementStaleAfterHours} hours. ${health.stale} stale contacts after ${health.staleAfterHours} hours.</p><section aria-label="Cabinets"><h2>Cabinets</h2><p>Page ${cabinetPage}. Missing timestamps mean no retained observation, not a healthy result.</p>${cabinetRows.length ? `<ul class="fleet-list">${cabinetRows.join("")}</ul>` : "<p>No cabinets on this page.</p>"}<nav aria-label="Cabinet health pages">${cabinetPage > 1 ? `<a href="${html(link(cabinetPage - 1, sitePage))}">Previous cabinets</a>` : ""}${cabinets.hasMore ? `<a href="${html(link(cabinetPage + 1, sitePage))}">Next cabinets</a>` : ""}</nav></section><section aria-label="Sites"><h2>Sites</h2><p>Page ${sitePage}. Stable client/site ordering, not a fleet-wide severity ranking. Unknown is counted among sites not classified Healthy.</p>${siteRows.length ? `<ul class="fleet-list">${siteRows.join("")}</ul>` : "<p>No sites on this page.</p>"}<nav aria-label="Site health pages">${sitePage > 1 ? `<a href="${html(link(cabinetPage, sitePage - 1))}">Previous sites</a>` : ""}${sites.hasMore ? `<a href="${html(link(cabinetPage, sitePage + 1))}">Next sites</a>` : ""}</nav></section></main></body></html>`;
}
