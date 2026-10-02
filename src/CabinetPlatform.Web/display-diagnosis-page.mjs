import { validGuid } from "./read-only-pages.mjs";

const time = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)$/.test(value) && Number.isFinite(Date.parse(value));
const fields = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const statuses = new Set(["Unavailable", "InteractiveSessionInaccessible", "NotCollected"]);
const states = new Set(["pending", "failed", "complete"]);

export function renderDisplayDiagnosis(cabinetId, result) {
  if (result !== null && (!fields(result, ["cabinetId", "actionId", "state", "requestedAtUtc", "completedAtUtc", "display"]) ||
      !validGuid(result.cabinetId) || result.cabinetId.toLowerCase() !== cabinetId || !validGuid(result.actionId) ||
      !states.has(result.state) || !time(result.requestedAtUtc) ||
      (result.completedAtUtc != null && !time(result.completedAtUtc)) ||
      (result.state !== "complete" && result.display != null) ||
      (result.state === "complete" && result.display == null))) throw Error("Invalid saved display result");
  const observation = result?.display;
  let rows = [];
  if (observation != null) {
    if (!fields(observation, ["observedAtUtc", "modeStatus", "modes", "modesTruncated", "scalingStatus", "scalingPercent", "magnifierStatus", "appZoomStatus"]) ||
        !time(observation.observedAtUtc) || !["Observed", "Unavailable", "Denied"].includes(observation.modeStatus) ||
        !Array.isArray(observation.modes) || observation.modes.length > 8 || typeof observation.modesTruncated !== "boolean" ||
        !statuses.has(observation.scalingStatus) || observation.scalingPercent != null ||
        !statuses.has(observation.magnifierStatus) || !statuses.has(observation.appZoomStatus) ||
        (observation.modeStatus === "Observed") !== (observation.modes.length > 0) ||
        (observation.modeStatus !== "Observed" && observation.modesTruncated)) throw Error("Invalid display evidence");
    const seen = new Set();
    rows = observation.modes.map(mode => {
      if (!fields(mode, ["displayIndex", "widthPixels", "heightPixels", "refreshHz"]) ||
          !Number.isSafeInteger(mode.displayIndex) || mode.displayIndex < 0 || mode.displayIndex >= 8 || seen.has(mode.displayIndex) ||
          !Number.isSafeInteger(mode.widthPixels) || mode.widthPixels < 1 || mode.widthPixels > 32768 ||
          !Number.isSafeInteger(mode.heightPixels) || mode.heightPixels < 1 || mode.heightPixels > 32768 ||
          (mode.refreshHz != null && (!Number.isSafeInteger(mode.refreshHz) || mode.refreshHz < 1 || mode.refreshHz > 1000)))
        throw Error("Invalid display mode");
      seen.add(mode.displayIndex);
      return `<li>Service-visible display ${mode.displayIndex + 1}: ${mode.widthPixels} × ${mode.heightPixels} pixels${mode.refreshHz == null ? "; refresh unknown" : ` at ${mode.refreshHz} Hz`}.</li>`;
    });
  }
  const state = result === null ? "No saved display observation for this cabinet." :
    `Saved action ${result.actionId}. Requested ${result.requestedAtUtc}; Agent-reported completion ${result.completedAtUtc ?? "Unknown"}. Outcome: ${result.state}.`;
  const details = observation == null ? `<p role="status">${result ? `Display observation ${result.state}; no verified mode rows available.` : "No saved display observation. No mode or session facts available."}</p>` :
    `<p>Agent observation ${observation.observedAtUtc}. OS mode read: ${observation.modeStatus}. These are modes visible to the service, not proof of the interactive user's effective resolution.</p>${rows.length ? `<ul>${rows.join("")}</ul>` : "<p>No verified OS mode available.</p>"}${observation.modesTruncated ? "<p>More displays were reported; only the first eight are shown.</p>" : ""}<dl><div><dt>Scaling</dt><dd>${observation.scalingStatus === "InteractiveSessionInaccessible" ? "Interactive session inaccessible" : observation.scalingStatus}; no reliable user scaling measurement.</dd></div><div><dt>Magnifier</dt><dd>${observation.magnifierStatus === "InteractiveSessionInaccessible" ? "Interactive session inaccessible" : observation.magnifierStatus}; state unknown.</dd></div><div><dt>App zoom</dt><dd>${observation.appZoomStatus}; application-specific zoom not measured.</dd></div></dl>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Display diagnosis | Mashura Support</title><link rel="stylesheet" href="/styles.css"></head><body><main class="fleet-page"><p class="tag">LOCAL DEVELOPMENT BUILD · NO MFA</p><a href="/cabinet/${cabinetId}">Back to cabinet</a><h1>Display observations</h1><p>Cabinet ${cabinetId}. Saved read-only evidence, not live interactive-session state. No display correction or remote access here.</p><p>${state}</p>${result ? `<a href="/cabinet/${cabinetId}/display/${result.actionId}">Pin this saved display result</a>` : ""}${details}</main></body></html>`;
}
