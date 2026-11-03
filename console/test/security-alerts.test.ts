import test from "node:test";
import assert from "node:assert/strict";
import { closedByText } from "../src/lib/security-alerts.ts";

test("an alert a person closed names them", () => {
  assert.match(closedByText("Dana Reyes"), /Dana Reyes/);
});

test("an alert the platform closed itself never reads as closed by nobody", () => {
  for (const none of [null, undefined, "", "   "]) {
    const text = closedByText(none);
    assert.doesNotMatch(text, /^Closed by\s*$/, JSON.stringify(none));
    assert.match(text, /platform/i, JSON.stringify(none));
  }
});
