import test from "node:test";
import assert from "node:assert/strict";
import { computeDrift } from "../src/services/baseline-drift.js";
import { judge } from "../src/services/cabinet-health.js";
import { DEFAULT_HEALTH, type ResolvedItem } from "../src/services/baselines.js";
import type { Item } from "../src/services/config-canonical.js";

const expectation: ResolvedItem = {
  category: "services", key: "service:App", mode: "match", expect: { dependencies: ["rpcss"] }, required: true, severity: "minor", note: null,
  origin: { kind: "global", id: null, name: "Fleet", baselineId: "baseline", versionId: "version", version: 1 },
};
const drift = (dependencies: string[] | undefined) => computeDrift([expectation], new Map([["services", [{ key: "service:App", values: dependencies === undefined ? {} : { dependencies } } satisfies Item]]]));

test("service dependency gains and losses ride the existing field drift path", () => {
  assert.deepEqual(drift(["rpcss"]), []);
  for (const dependencies of [["rpcss", "other"], [], ["missing"], ["app"]]) {
    const rows = drift(dependencies);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.field, "dependencies");
    assert.deepEqual(rows[0]!.expected, ["rpcss"]);
    assert.deepEqual(rows[0]!.actual, dependencies);
    assert.equal(rows[0]!.required, true);
  }
});
test("absent dependency telemetry is never equal to a checked empty list", () => {
  assert.equal(drift(undefined)[0]!.actual, null);
  const empty = { ...expectation, expect: { dependencies: [] } };
  assert.equal(computeDrift([empty], new Map([["services", [{ key: "service:App", values: {} }]]])).length, 1);
  assert.deepEqual(computeDrift([empty], new Map([["services", [{ key: "service:App", values: { dependencies: [] } }]]])), []);
});

test("required dependency drift degrades health through the existing judgement", () => {
  const facts = { lastContactAt: new Date(), now: new Date(), hasConfig: true, hasBaseline: true, criticalAlerts: [], requiredDrift: drift([]) };
  assert.equal(judge(facts, DEFAULT_HEALTH).state, "degraded");
  assert.equal(judge({ ...facts, requiredDrift: drift(["rpcss"]) }, DEFAULT_HEALTH).state, "healthy");
  assert.equal(judge(facts, { ...DEFAULT_HEALTH, requireRequiredItems: false }).state, "healthy");
});
