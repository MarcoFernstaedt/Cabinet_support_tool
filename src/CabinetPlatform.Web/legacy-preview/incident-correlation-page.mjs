import { validGuid } from "./read-only-pages.mjs";

const html = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const timeOrNull = value => value == null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
const count = value => Number.isSafeInteger(value) && value >= 0;
const firewallStates = new Set(["Unknown", "Read", "Partial", "AccessDenied", "Unavailable", "Unsupported"]);

export function renderIncidentCorrelation(alertId, data) {
  if (!validGuid(alertId) || !data || !validGuid(data.alertId) || data.alertId.toLowerCase() !== alertId ||
      ![data.siteId, data.sourceCabinetId, data.targetCabinetId, data.evidenceId].every(validGuid) ||
      data.sourceCabinetId.toLowerCase() === data.targetCabinetId.toLowerCase() ||
      !["Open", "Acknowledged", "Resolved"].includes(data.status) ||
      (data.currentSyncCabinetId != null && !validGuid(data.currentSyncCabinetId)) ||
      typeof data.targetIsCurrentSync !== "boolean" ||
      data.targetIsCurrentSync !== (data.currentSyncCabinetId?.toLowerCase() === data.targetCabinetId.toLowerCase()))
    throw Error("Invalid incident identity");
  const observation = item => {
    if (item == null) return null;
    if (!validGuid(item.cabinetId) || ![item.lastCheckInUtc, item.latestHeartbeatCollectedAtUtc, item.latestHeartbeatReceivedAtUtc].every(timeOrNull) ||
        ((item.latestHeartbeatCollectedAtUtc ?? null) === null) !== ((item.latestHeartbeatReceivedAtUtc ?? null) === null))
      throw Error("Invalid cabinet observation");
    return item;
  };
  const source = observation(data.source), target = observation(data.target);
  if ((source && source.cabinetId.toLowerCase() !== data.sourceCabinetId.toLowerCase()) ||
      (target && target.cabinetId.toLowerCase() !== data.targetCabinetId.toLowerCase())) throw Error("Mismatched cabinet evidence");
  const interval = data.interval;
  if (interval != null && (!timeOrNull(interval.firstObservedUtc) || !timeOrNull(interval.lastObservedUtc) ||
      interval.firstObservedUtc == null || interval.lastObservedUtc == null ||
      Date.parse(interval.firstObservedUtc) > Date.parse(interval.lastObservedUtc) || !timeOrNull(interval.receivedUtc) ||
      ![interval.successCount, interval.failureCount, interval.errorCount].every(count) ||
      interval.successCount + interval.failureCount + interval.errorCount > 10000)) throw Error("Invalid interval evidence");
  const firewall = interval?.sourceFirewallCheck;
  if (firewall != null && (!timeOrNull(firewall.observedUtc) || firewall.observedUtc == null ||
      !firewallStates.has(firewall.status) || ![true, false, null, undefined].includes(firewall.hasOutboundProfileBlockClue)))
    throw Error("Invalid firewall clue");
  const firewallLabel = firewall == null ? "Source outbound firewall profile clue not collected." :
    firewall.hasOutboundProfileBlockClue === true ? "Possible source outbound profile block, not a confirmed cause." :
    firewall.hasOutboundProfileBlockClue === false ? "No coarse source outbound block observed; explicit rules and destination firewall remain unknown." :
    `Source firewall profile read ${html(firewall.status)} and inconclusive. No cause established.`;
  const intervalLabel = interval == null ? "Retained interval unavailable. Do not substitute a newer probe for this incident." :
    `Accepted source-to-target ICMP interval ${html(interval.firstObservedUtc)} to ${html(interval.lastObservedUtc)}; server received ${html(interval.receivedUtc ?? "Unknown")}. ${interval.successCount} replies, ${interval.failureCount} nonreplies, ${interval.errorCount} local probe errors. ${firewallLabel}${firewall ? ` Firewall observation ${html(firewall.observedUtc)}.` : ""}`;
  const contact = (label, id, item) => `<section class="incident-card"><h2>${label}</h2><a href="/cabinet/${id}">Cabinet ${id}</a><p>Last server contact ${html(item?.lastCheckInUtc ?? "Unknown")}; latest heartbeat collected ${html(item?.latestHeartbeatCollectedAtUtc ?? "Unknown")}; heartbeat received ${html(item?.latestHeartbeatReceivedAtUtc ?? "Unknown")}. These timestamps are independent of the incident interval and do not establish reachability between cabinets.</p></section>`;
  const topology = data.currentSyncCabinetId == null ? "No current sync cabinet designated for the source site. Incident-time topology unknown." :
    data.targetIsCurrentSync ? "Target is the current designated sync cabinet. Incident-time topology is not established." :
      `Target is not the current designated sync cabinet ${html(data.currentSyncCabinetId)}. The target's incident-time role is unknown.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Incident evidence | Mashura Support</title><link rel="stylesheet" href="/styles.css"></head><body><main class="fleet-page"><p class="tag">LOCAL DEVELOPMENT BUILD · NO MFA</p><a href="/site/${data.siteId}/incidents">Back to site incidents</a><h1>Connectivity incident evidence</h1><p>Alert ${alertId}. Accepted evidence ${data.evidenceId}. Source ${data.sourceCabinetId} to target ${data.targetCabinetId}.</p><p>Operator status: ${html(data.status)}. Resolved is not measured recovery. ICMP nonreply is not proof of firewall causation or application sync failure.</p><section class="incident-card"><h2>Accepted interval</h2><p>${intervalLabel}</p></section><section class="incident-card"><h2>Current topology</h2><p>${topology}</p></section>${contact("Source contact and measurement", data.sourceCabinetId, source)}${contact("Target contact and measurement", data.targetCabinetId, target)}<section class="incident-card"><h2>Application transport</h2><p>Application-port evidence not collected. Target-to-server contact and ICMP do not prove the cabinet application or database sync path works.</p></section></main></body></html>`;
}
