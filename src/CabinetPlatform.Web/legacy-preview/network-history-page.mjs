import { validGuid } from "./read-only-pages.mjs";

const html = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const time = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)$/.test(value) && Number.isFinite(Date.parse(value));
// Compare all seven .NET fractional digits, not JavaScript's millisecond precision.
const preciseUtc = value => {
  const match = /^(.*?)(?:\.(\d{1,7}))?(?:Z|\+00:00)$/.exec(value);
  return `${match[1]}.${(match[2] ?? "").padEnd(7, "0")}`;
};
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 10000;
const cursor = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,2048}$/.test(value);

export function renderNetworkHistory(sourceId, requestedTarget, data, requestedBounds = {}) {
  if (!data || !validGuid(data.sourceCabinetId) || data.sourceCabinetId.toLowerCase() !== sourceId ||
      (data.targetCabinetId != null && !validGuid(data.targetCabinetId)) ||
      (data.targetCabinetId?.toLowerCase() ?? null) !== (requestedTarget ?? null) ||
      ![data.asOfUtc, data.fromUtc, data.toUtc].every(time) || preciseUtc(data.fromUtc) >= preciseUtc(data.toUtc) ||
      (requestedBounds.from && preciseUtc(requestedBounds.from) !== preciseUtc(data.fromUtc)) ||
      (requestedBounds.to && preciseUtc(requestedBounds.to) !== preciseUtc(data.toUtc)) ||
      !Array.isArray(data.items) || data.items.length > 20 ||
      (data.nextCursor != null && (!cursor(data.nextCursor) || data.items.length === 0)))
    throw Error("Invalid network history");
  const seen = new Set();
  let previous = null;
  const rows = data.items.map(row => {
    if (!row || !validGuid(row.id) || !validGuid(row.sourceCabinetId) || row.sourceCabinetId.toLowerCase() !== sourceId ||
        !validGuid(row.targetCabinetId) || (requestedTarget && row.targetCabinetId.toLowerCase() !== requestedTarget) ||
        !validGuid(row.configurationId) || ![row.firstObservedUtc, row.lastObservedUtc, row.receivedUtc].every(time) ||
        preciseUtc(row.firstObservedUtc) > preciseUtc(row.lastObservedUtc) ||
        (row.evidenceUnavailable === true ? ![row.successCount, row.failureCount, row.errorCount].every(value => value == null) :
          ![row.successCount, row.failureCount, row.errorCount].every(count)) ||
        (row.evidenceUnavailable != null && typeof row.evidenceUnavailable !== "boolean") ||
        (row.evidenceUnavailable === true && (row.lastSuccessUtc != null || row.lastFailureUtc != null)) ||
        ![row.lastSuccessUtc, row.lastFailureUtc].every(value => value == null || time(value)) ||
        seen.has(row.id.toLowerCase())) throw Error("Invalid network evidence");
    const sortTime = preciseUtc(row.lastObservedUtc), sortId = row.id.toLowerCase();
    if (previous && (sortTime > previous.time || (sortTime === previous.time && sortId >= previous.id))) throw Error("Invalid history order");
    previous = { time: sortTime, id: sortId };
    seen.add(sortId);
    if (row.evidenceUnavailable === true)
      return `<li><article class="incident-card"><h3>Target <a href="/cabinet/${row.targetCabinetId}">${row.targetCabinetId}</a></h3><p>Accepted interval ${row.id}; observed ${html(row.firstObservedUtc)} to ${html(row.lastObservedUtc)}; received ${html(row.receivedUtc)}. Retained measurement details unavailable or inconsistent. Counts and outcome unknown; this is not a clean interval.</p></article></li>`;
    const gap = row.errorCount > 0 ? "Local probe errors mean coverage unknown for those samples." : "A retained interval does not prove continuous coverage; gaps or buffer loss may be unknown.";
    const reply = row.successCount ? `Reply confirmed at the reported observation time ${html(row.lastSuccessUtc ?? "Unknown")}; exact restoration onset is not established.` : "No reply recorded in this retained interval; that alone does not prove a remote outage.";
    return `<li><article class="incident-card"><h3>Target <a href="/cabinet/${row.targetCabinetId}">${row.targetCabinetId}</a></h3><p>Configuration ${row.configurationId}. Observed ${html(row.firstObservedUtc)} to ${html(row.lastObservedUtc)}; server received ${html(row.receivedUtc)}. ${row.successCount} replies, ${row.failureCount} nonreplies, ${row.errorCount} local probe errors.</p><p>${reply} ${gap} Nonreply is not proof of firewall causation or application sync failure.</p></article></li>`;
  });
  const query = new URLSearchParams({ ...(requestedTarget ? { target: requestedTarget } : {}), from: data.fromUtc, to: data.toUtc, ...(data.nextCursor ? { cursor: data.nextCursor } : {}) });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Network history | Mashura Support</title><link rel="stylesheet" href="/styles.css"></head><body><main class="fleet-page"><p class="tag">LOCAL DEVELOPMENT BUILD · NO MFA</p><a href="/cabinet/${sourceId}">Back to cabinet</a><h1>Retained network history</h1><p>Source ${sourceId}${requestedTarget ? ` to target ${requestedTarget}` : ", all accepted targets"}. From ${html(data.fromUtc)} to ${html(data.toUtc)}. Server query ${html(data.asOfUtc)}. Observations use Agent clocks; receipt can be delayed. Retention, clock drift, buffering and replay mean this traversal is not a complete uptime or outage history.</p>${rows.length ? `<ul class="fleet-list">${rows.join("")}</ul>` : "<p>No retained intervals match this window. Absence is not a clean bill of health.</p>"}${data.nextCursor ? `<nav aria-label="Network history pages"><a href="/cabinet/${sourceId}/network-history?${html(query.toString())}">Older retained intervals</a></nav>` : "<p>No additional retained rows in this query. Recovery is not established from displayed evidence alone.</p>"}</main></body></html>`;
}
