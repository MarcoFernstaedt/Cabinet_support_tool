// The batch approval panel's sentence for a cabinet the server did not approve (F6.R2, review of #188).
import test from "node:test";
import assert from "node:assert/strict";
import { refusalText } from "../src/lib/error-explanations.ts";
import { explainFailure, formatExplanation } from "../src/lib/error-explanations.ts";

test("a refusal's own reason is shown; without one, the code's explanation, never a server log message", () => {
  assert.equal(refusalText({ error: "not_this_site", reason: "This cabinet was installed with another site's installer." }), "This cabinet was installed with another site's installer.");
  const taken = refusalText({ error: "name_taken" });
  assert.equal(taken, formatExplanation(explainFailure({ code: "name_taken", message: "" })));
  assert.match(taken, /Name already in use/);
  for (const code of ["not_pending", "demo_client", "name_taken"])
    assert.notEqual(explainFailure({ code, message: "" }).title, explainFailure({ code: "some_future_code", message: "" }).title, `${code} has its own entry`);
});
