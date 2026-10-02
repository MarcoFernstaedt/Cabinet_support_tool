const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const validGuid = value => typeof value === "string" && guid.test(value);

function validPage(data, page) {
  return data && Array.isArray(data.items) && data.items.length <= 20 && Number.isSafeInteger(data.totalCount) && data.totalCount >= 0 &&
    data.page === page && data.pageSize === 20 && typeof data.hasMore === "boolean" &&
    data.hasMore === (page * 20 < data.totalCount) && data.items.length <= Math.max(0, data.totalCount - (page - 1) * 20) &&
    (!data.hasMore || data.items.length === 20);
}

export function renderSiteIncidents(siteId, queue, summary, page) {
  if (!validGuid(siteId) || !validPage(queue, page)) throw Error("Invalid incident page");
  if (summary && (summary.siteId !== siteId || ![summary.open, summary.acknowledged, summary.resolved].every(n => Number.isSafeInteger(n) && n >= 0) || summary.total !== summary.open + summary.acknowledged + summary.resolved || !Number.isFinite(Date.parse(summary.asOfUtc)))) summary = null;
  const counts = summary ? `${summary.open} open, ${summary.acknowledged} acknowledged, ${summary.resolved} resolved (${summary.total} retained). Server query: ${escapeHtml(summary.asOfUtc)}.` : "Counts unavailable. The incident page remains available; refresh to retry.";
  const rows = queue.items.map(row => {
    if (!validGuid(row.id) || !validGuid(row.sourceCabinetId) || !validGuid(row.targetCabinetId) || row.siteId !== siteId || !["Open", "Acknowledged", "Resolved"].includes(row.status)) throw Error("Invalid incident identity");
    const evidence = row.incidentEvidence;
    let evidenceText = "Accepted interval evidence unavailable. Counts and measurement times unknown.";
    if (evidence) {
      if (evidence.id !== row.evidenceId || evidence.sourceCabinetId !== row.sourceCabinetId || evidence.targetCabinetId !== row.targetCabinetId || ![evidence.successCount, evidence.failureCount, evidence.errorCount].every(n => Number.isSafeInteger(n) && n >= 0)) throw Error("Invalid incident evidence");
      evidenceText = `Historical interval ${escapeHtml(evidence.firstObservedUtc)} to ${escapeHtml(evidence.lastObservedUtc)}: ${evidence.successCount} replies, ${evidence.failureCount} nonreplies, ${evidence.errorCount} probe errors.`;
    }
    return `<li><article class="incident-card"><h2>${escapeHtml(row.sourceName)} · ${escapeHtml(row.status)}</h2><p>Source <a href="/cabinet/${row.sourceCabinetId}">${row.sourceCabinetId}</a> to target <a href="/cabinet/${row.targetCabinetId}">${row.targetCabinetId}</a></p><p>Evidence received: ${escapeHtml(row.receivedUtc ?? "Unknown")}. ${evidenceText}</p><p>ICMP nonreply does not prove firewall causation. Operator resolution is not measured recovery.</p></article></li>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Site incidents | Mashura Support</title><link rel="stylesheet" href="/styles.css"></head><body><main class="fleet-page"><p class="tag">LOCAL DEVELOPMENT BUILD · NO MFA</p><a href="/fleet">Cabinet finder</a><h1>Site incident annotations</h1><p>Source site: ${siteId}. Historical retained workflow, not live connectivity health.</p><p role="status">${counts}</p><p>${queue.totalCount} queue incidents. Page ${page}. Resolved rows excluded from this page, included in workload counts.</p>${rows ? `<ul class="fleet-list">${rows}</ul>` : "<p>No unresolved incidents on this page.</p>"}<nav aria-label="Incident pages">${page > 1 ? `<a href="/site/${siteId}/incidents?page=${page - 1}">Previous page</a>` : ""}${queue.hasMore ? `<a href="/site/${siteId}/incidents?page=${page + 1}">Next page</a>` : ""}</nav></main></body></html>`;
}

export function renderCabinet(data, requestedId) {
  const row = data?.cabinet, site = data?.site;
  if (!row || !site || !validGuid(requestedId) || row.id.toLowerCase() !== requestedId.toLowerCase() || !validGuid(row.siteId) || site.id !== row.siteId) throw Error("Invalid cabinet identity");
  const label = escapeHtml(row.friendlyName || row.hostname);
  const sync = site.syncCabinetId ? `${escapeHtml(site.syncCabinetHostname ?? "Unknown name")} (${escapeHtml(site.syncCabinetId)})` : "No designated sync cabinet";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cabinet detail | Mashura Support</title><link rel="stylesheet" href="/styles.css"></head><body><main class="fleet-page"><p class="tag">LOCAL DEVELOPMENT BUILD · NO MFA</p><a href="/fleet">Back to cabinet finder</a><h1>${label}</h1><p>Historical observations. Current cabinet condition is unverified.</p><dl class="cabinet-facts"><div><dt>Cabinet ID</dt><dd>${escapeHtml(row.id)}</dd></div><div><dt>Client / site</dt><dd>${escapeHtml(row.clientName)} / ${escapeHtml(row.siteName)} (${escapeHtml(row.siteId)})</dd></div><div><dt>Role</dt><dd>${escapeHtml(row.role ?? "Unknown")}</dd></div><div><dt>Enrollment</dt><dd>${row.isActive ? "Active" : "Inactive"}</dd></div><div><dt>Last check-in</dt><dd>${escapeHtml(row.lastCheckInUtc ?? "Unknown")}</dd></div><div><dt>Reported health</dt><dd>${escapeHtml(row.health ?? "Unknown")}</dd></div><div><dt>Site sync cabinet</dt><dd>${sync}</dd></div></dl><a href="/site/${row.siteId}/incidents">Site incidents</a> · <a href="/cabinet/${row.id}/events">Collected Event Viewer result</a> · <a href="/cabinet/${row.id}/crashes">Crash investigation</a> · <a href="/cabinet/${row.id}/processes">Process and service observations</a></main></body></html>`;
}

export function renderFleet(data, { search, page }) {
  if (!validPage(data, page)) throw Error("Invalid fleet response");
  const rows = data.items.map(row => {
    if (!guid.test(row.id) || !guid.test(row.siteId)) throw Error("Invalid cabinet identity");
    const label = escapeHtml(row.friendlyName || row.hostname);
    const position = `${escapeHtml(row.clientName)} / ${escapeHtml(row.siteName)}`;
    return `<li><a href="/cabinet/${row.id}"><strong>${label}</strong><span>${position}</span><span>${escapeHtml(row.health ?? "Unknown")} · Last check-in: ${escapeHtml(row.lastCheckInUtc ?? "Unknown")}</span></a></li>`;
  }).join("");
  const query = number => `/fleet?${new URLSearchParams({ search, page: String(number) })}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cabinet finder | Mashura Support</title><link rel="stylesheet" href="/styles.css"></head><body><main class="fleet-page"><p class="tag">LOCAL DEVELOPMENT BUILD · NO MFA</p><h1>Cabinet finder</h1><p>Historical check-in information, not live cabinet status. The configured loopback upstream must contain disposable synthetic data.</p><a href="/">Event preview</a><form method="get" action="/fleet"><label for="fleet-search">Search cabinets</label><input id="fleet-search" name="search" maxlength="80" value="${escapeHtml(search)}"><button>Search</button></form><p role="status">${data.totalCount} matching cabinets. Page ${page}.</p>${rows ? `<ul class="fleet-list">${rows}</ul>` : "<p>No cabinets match this search.</p>"}<nav aria-label="Cabinet pages">${page > 1 ? `<a href="${escapeHtml(query(page - 1))}">Previous page</a>` : ""}${data.hasMore ? `<a href="${escapeHtml(query(page + 1))}">Next page</a>` : ""}</nav></main></body></html>`;
}

export async function readBoundedJson(response, limit = 131072) {
  if (!response.ok || response.status !== 200 || !response.body) throw Error("Upstream unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error("Upstream response too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
