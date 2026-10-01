import { validGuid } from "./read-only-pages.mjs";

const html = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const time = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const short = (value, max = 256) => typeof value === "string" && value.length <= max;
const states = new Set(["pending", "failed", "complete", "partial"]);

export function renderEventResult(cabinetId, data, query) {
  if (!validGuid(cabinetId) || !data || !validGuid(data.cabinetId) || data.cabinetId.toLowerCase() !== cabinetId.toLowerCase() ||
      !validGuid(data.actionId) || !states.has(data.state) || !time(data.requestedAtUtc) ||
      (data.completedAtUtc != null && !time(data.completedAtUtc)) ||
      !Array.isArray(data.entries) || data.entries.length > 100 || !Array.isArray(data.channelReads) || data.channelReads.length > 20 ||
      !Array.isArray(data.requestedChannels) || data.requestedChannels.length > 20 || !data.requestedChannels.every(v => short(v, 512)) ||
      !Array.isArray(data.requestedProviders) || data.requestedProviders.length > 50 || !data.requestedProviders.every(v => short(v, 255)) ||
      typeof data.truncated !== "boolean") throw Error("Invalid saved event result");
  const ready = data.state === "complete" || data.state === "partial";
  if (ready && (!validGuid(data.viewId) || !short(data.viewDisplayName) || !data.completedAtUtc)) throw Error("Invalid saved event result");
  if (!ready && (data.entries.length || data.channelReads.length)) throw Error("Unverified saved event result");
  const channels = new Set(data.requestedChannels.map(v => v.toLowerCase()));
  for (const row of data.channelReads) {
    if (!row || !short(row.channelName, 512) || !channels.has(row.channelName.toLowerCase()) || !short(row.outcome, 64) ||
        !Number.isSafeInteger(row.recordsRead) || row.recordsRead < 0 || typeof row.truncated !== "boolean") throw Error("Invalid channel evidence");
  }
  for (const row of data.entries) {
    if (!row || !short(row.channel, 512) || !channels.has(row.channel.toLowerCase()) ||
        !(row.provider === null || short(row.provider, 255)) ||
        !short(row.level, 64) || !Number.isSafeInteger(row.eventId) || !time(row.occurredAt) ||
        !(row.message === null || short(row.message, 8192))) throw Error("Invalid event evidence");
  }
  if (data.entries.length && data.channelReads.length && data.entries.some(row => !data.channelReads.some(read => read.channelName.toLowerCase() === row.channel.toLowerCase()))) throw Error("Missing channel outcome");
  const rawChannel = query.get("channel"), rawProvider = query.get("provider"), rawEntry = query.get("entry");
  if ((rawChannel && !channels.has(rawChannel.toLowerCase())) || (rawProvider && !short(rawProvider, 255)) ||
      (rawEntry !== null && !/^(0|[1-9][0-9]{0,2})$/.test(rawEntry))) throw Error("Invalid event filter");
  const base = `/cabinet/${cabinetId}/events`;
  const link = (values = {}) => `${base}${Object.keys(values).length ? `?${new URLSearchParams(values)}` : ""}`;
  const filtered = data.entries.map((row, i) => ({ row, i })).filter(({ row }) =>
    (!rawChannel || row.channel.toLowerCase() === rawChannel.toLowerCase()) && (!rawProvider || row.provider === rawProvider));
  const selected = rawEntry === null ? null : filtered.find(({ i }) => i === Number(rawEntry));
  if (rawEntry !== null && !selected) throw Error("Invalid event selection");
  const outcomes = data.channelReads.map(row => `<li><strong>${html(row.channelName)}</strong>: ${html(row.outcome)}; ${row.recordsRead} collected${row.truncated ? "; truncated" : ""}</li>`).join("");
  const tabs = data.requestedChannels.map(channel => `<a href="${html(link({ channel }))}"${rawChannel === channel ? ' aria-current="page"' : ""}>${html(channel)}</a>`).join("");
  const rows = filtered.map(({ row, i }) => `<li><a href="${html(link({ ...(rawChannel ? { channel: rawChannel } : {}), ...(rawProvider ? { provider: rawProvider } : {}), entry: String(i) }))}"><strong>${html(row.provider ?? "Unknown provider")} · ${row.eventId}</strong><span>${html(row.channel)} · ${html(row.level)} · ${html(row.occurredAt)}</span></a></li>`).join("");
  const detail = selected ? `<section class="incident-card" aria-label="Selected event"><h2>${html(selected.row.provider ?? "Unknown provider")} · ${selected.row.eventId}</h2><dl class="cabinet-facts"><div><dt>Channel</dt><dd>${html(selected.row.channel)}</dd></div><div><dt>Provider</dt><dd>${html(selected.row.provider ?? "Unknown provider")}</dd></div><div><dt>Level</dt><dd>${html(selected.row.level)}</dd></div><div><dt>Recorded</dt><dd>${html(selected.row.occurredAt)}</dd></div></dl>${selected.row.provider ? `<a href="${html(link({ provider: selected.row.provider }))}">Show this provider’s collected events</a>` : "<p>Provider unknown; provider filtering unavailable.</p>"}<h3>Collected message</h3><pre>${html(selected.row.message ?? "No message was collected.")}</pre></section>` : "<p>Select a collected event to inspect its details.</p>";
  const message = data.state === "pending" ? "A saved event request is pending; no collected result is available." : data.state === "failed" ? "The latest saved event request failed; no collected result is available." : `${filtered.length} of ${data.entries.length} collected records shown. ${data.truncated ? "Result was truncated; this is not the complete event log." : "Historical collection, not live cabinet state."}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Collected events | Mashura Support</title><link rel="stylesheet" href="/styles.css"></head><body><main class="fleet-page"><p class="tag">LOCAL DEVELOPMENT BUILD · NO MFA</p><a href="/cabinet/${cabinetId}">Back to cabinet</a><h1>Collected Event Viewer result</h1><p>Cabinet ${cabinetId}. View: ${html(data.viewDisplayName ?? "Unknown")}. Saved action ${html(data.actionId)}.</p><p>Requested ${html(data.requestedAtUtc)}; Agent-reported completion ${html(data.completedAtUtc ?? "Unknown")}. Outcome: <strong>${html(data.state)}</strong>.</p><p>Requested channels: ${html(data.requestedChannels.join(", ") || "Unknown")}. Provider scope: ${html(data.requestedProviders.join(", ") || "All requested channels")}.</p><p role="status">${html(message)}</p>${outcomes ? `<h2>Channel outcomes</h2><ul>${outcomes}</ul>` : "<p>Channel outcomes unavailable.</p>"}<nav class="event-filters" aria-label="Collected event channels"><a href="${base}">All channels</a>${tabs}${rawProvider ? `<a href="${base}">Clear provider filter</a>` : ""}</nav>${rows ? `<ul class="fleet-list">${rows}</ul>` : "<p>No records in this saved result match the filter.</p>"}${detail}<p>Only this bounded saved result is shown. Event messages can be incomplete or sensitive; no live process or cause is inferred.</p></main></body></html>`;
}
