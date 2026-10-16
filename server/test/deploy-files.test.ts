// The deployed image must carry everything the demo's simulated cabinets answer from, or every simulated write fails with
// "no answer for this operation" on a real installation while all tests (which run from the repository) pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { examplesAvailable } from "../src/demo/outputs.js";

const root = join(import.meta.dirname, "..", "..", "..");

test("the image copies the contract examples the demo needs", () => {
  assert.match(readFileSync(join(root, "deploy", "Dockerfile"), "utf8"), /^COPY contracts\/examples /m);
  assert.match(readFileSync(join(root, "deploy", "Dockerfile.dockerignore"), "utf8"), /^!contracts\/examples\/\*\*$/m);
});

test("the examples are found where the server looks", () => assert.equal(examplesAvailable(), true));
