// What the affected cabinets of a fleet incident are (decision-log D157), as the Incidents page, its case notes and a fleet pattern's
// report put it: only the values that stand out, one line each, and nothing broken by a damaged or older answer.
import test from "node:test";
import assert from "node:assert/strict";
import { attributeLine, standingAttributes, type SharedAttribute } from "../src/lib/crash-incident.ts";

const bios: SharedAttribute = { attribute: "biosVersion", name: "BIOS version", value: "1.4.2", affected: 4, affectedShare: 100, unaffected: 1, unaffectedShare: 16.7, standsOut: true };
const model: SharedAttribute = { attribute: "model", name: "Model", value: "Dell Inc. OptiPlex 7090", affected: 2, affectedShare: 50, unaffected: 3, unaffectedShare: 50, standsOut: false };

test("only the values that stand out are listed, in the server's order", () => {
  assert.deepEqual(standingAttributes([model, bios]), [bios]);
  assert.deepEqual(standingAttributes([]), []);
});

test("an older server without the field, or a damaged list, lists nothing and never throws", () => {
  for (const bad of [undefined, null, "BIOS", 42, {}] as unknown[]) assert.deepEqual(standingAttributes(bad as never), [], String(bad));
  assert.deepEqual(standingAttributes([null, { standsOut: true }, { ...bios, standsOut: "yes" }, { ...bios, value: 7 }] as never), []);
});

test("the case-notes line says what it is and on how many cabinets of each side", () => {
  assert.equal(attributeLine(bios, 4, 6), "BIOS version 1.4.2: 4 of 4 affected (100%) vs 1 of 6 unaffected (16.7%)");
  assert.equal(attributeLine({ ...bios, affected: Number.NaN, unaffectedShare: -3 }, 4, Number.POSITIVE_INFINITY),
    "BIOS version 1.4.2: 0 of 4 affected (100%) vs 1 of 0 unaffected (0%)", "a damaged count reads as 0, never NaN or Infinity");
});
