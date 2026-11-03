import test from "node:test";
import assert from "node:assert/strict";
import { incidentHref, moduleArea, runsText } from "../src/lib/incidents.ts";

test("the area comes from the module that opened the incident", () => {
  assert.equal(moduleArea({ id: "network-diagnosis" }), "Network");
  assert.equal(moduleArea({ id: "cabinet-storage" }), "Storage");
  assert.equal(moduleArea(null), "Opened by hand");
  assert.equal(moduleArea({ id: "a-module-from-later" }), "a-module-from-later", "unknown modules are shown, not hidden");
});

test("how often it was looked at reads as words, never a bare or broken number", () => {
  assert.equal(runsText(1), "Found by one diagnosis");
  assert.equal(runsText(4), "Seen in 4 diagnoses");
  for (const n of [0, -1, Number.NaN]) assert.equal(runsText(n), "Not looked at by a diagnosis", String(n));
});

test("the link opens the incident on its own cabinet's History tab, with ids encoded", () => {
  assert.equal(incidentHref({ id: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", cabinet: { id: "7c9e6679-7425-40de-944b-e07fc1f90ae7" } }),
    "/cabinets/7c9e6679-7425-40de-944b-e07fc1f90ae7/history?incident=1b4e28ba-2fa1-11d2-883f-0016d3cca427");
  assert.equal(incidentHref({ id: "a&b=c", cabinet: { id: "../x" } }), "/cabinets/..%2Fx/history?incident=a%26b%3Dc");
});
