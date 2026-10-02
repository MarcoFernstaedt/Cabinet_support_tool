import { validateEventResult } from "./event-result-page.mjs";
import { renderWerMetadata } from "./wer-metadata-page.mjs";

const html = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

export function renderCrashInvestigation(cabinetId, data, wer = { state: "missing" }) {
  if (data === null) return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Crash evidence | Mashura Support</title><link rel="stylesheet" href="/styles.css"></head><body><main class="fleet-page"><p class="tag">LOCAL DEVELOPMENT BUILD · NO MFA</p><a href="/cabinet/${cabinetId}">Back to cabinet</a><h1>Application crash investigation</h1><p role="status">Event Viewer result not collected for this cabinet. Event coverage unknown.</p><section class="incident-card"><h2>Independent Windows Error Reporting metadata</h2>${renderWerMetadata(cabinetId, wer)}</section><p>Historical process evidence unavailable. <strong>Cause unknown.</strong> WER report creation time does not establish crash time or link to an event.</p></main></body></html>`;
  validateEventResult(cabinetId, data);
  const ready = data.state === "complete" || data.state === "partial";
  const application = data.channelReads.find(row => row.channelName.toLowerCase() === "application");
  const available = ready && application?.outcome === "readable";
  const clues = available ? data.entries.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
    entry.channel.toLowerCase() === "application" &&
    ((entry.provider === "Application Error" && entry.eventId === 1000) ||
     (entry.provider === "Windows Error Reporting" && entry.eventId === 1001))) : [];
  const rows = clues.map(({ entry, index }) => `<li class="incident-card"><strong>${entry.provider === "Windows Error Reporting" ? "Windows Error Reporting event" : "Application Error event"} ${entry.eventId}</strong><p>Recorded ${html(entry.occurredAt)} · ${html(entry.level)} · Application channel.</p><a href="/cabinet/${cabinetId}/events/${data.actionId}?entry=${index}">Inspect exact collected event</a></li>`).join("");
  const coverage = data.state === "pending" ? "The latest event request is pending. Application event coverage unavailable." :
    data.state === "failed" ? "The latest event request failed. Application event coverage unavailable." :
    !data.requestedChannels.some(name => name.toLowerCase() === "application") ? "Application channel was not requested. Crash event coverage unavailable." :
    !application ? "Application channel read outcome missing. Crash event coverage unavailable." :
    application.outcome !== "readable" ? `Application channel ${html(application.outcome)}. Crash event coverage unavailable.` :
    "Application channel was read in this saved result. Other event sources and time windows may be missing.";
  const limits = `${data.truncated || application?.truncated ? "The saved result was truncated. " : ""}${data.requestedProviders.length ? "The saved view restricted providers, so other crash events may be absent. " : ""}Events can be missing outside the saved view's time, level and record limits.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Crash evidence | Mashura Support</title><link rel="stylesheet" href="/styles.css"></head><body><main class="fleet-page"><p class="tag">LOCAL DEVELOPMENT BUILD · NO MFA</p><a href="/cabinet/${cabinetId}">Back to cabinet</a><h1>Application crash investigation</h1><p>Cabinet ${cabinetId}. Latest saved Event Viewer action ${html(data.actionId)}. Requested ${html(data.requestedAtUtc)}; Agent-reported completion ${html(data.completedAtUtc ?? "Unknown")}. Outcome: ${html(data.state)}.</p><p role="status">${coverage}</p><p>${limits}</p><h2>Collected Application event clues</h2>${rows ? `<ul class="fleet-list">${rows}</ul>` : "<p>No matching event clues in this bounded result. This does not establish that no application crashed.</p>"}<section class="incident-card"><h2>Independent Windows Error Reporting metadata</h2>${renderWerMetadata(cabinetId, wer)}<p>A Windows Error Reporting event is not a WER report and is not automatically the same incident as an Application Error event.</p><p>Historical process evidence unavailable. A later process list cannot establish what was running when an earlier event occurred.</p><p><strong>Cause unknown.</strong> Time proximity and provider names alone do not identify the failing process or its cause.</p></section><p>Only event metadata is shown here. Event messages may contain sensitive content; inspect an exact event only in the separate saved-result view on disposable test data.</p></main></body></html>`;
}
