import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ServicesListOutput } from "@mashura/cabinet-contracts/types";
import { serviceOrder } from "../src/lib/service-order.ts";
type Service = ServicesListOutput["services"][number];
const svc = (name: string, dependencies: string[] | null = [], dependentServices: string[] | null = []): Service => ({
  name, displayName: name, state: "running", startType: "automatic", account: null, processId: null, executablePath: null, description: null, recovery: null,
  dependencies, dependentServices,
});
describe("Windows service dependency precedence", () => {
  it("shows a chain with independent services sharing a stage", () => {
    assert.deepEqual(serviceOrder([svc("C", ["B"]), svc("A", [], ["B"]), svc("B", ["a"], ["C"]), svc("Independent")]), { kind: "checked", stages: [["A", "Independent"], ["B"], ["C"]] });
  });
  it("distinguishes absent from a checked empty dependency list", () => {
    const old = svc("A"); delete old.dependencies;
    assert.equal(serviceOrder([old]).kind, "unknown");
    assert.deepEqual(serviceOrder([svc("A")]), { kind: "checked", stages: [["A"]] });
  });
  it("reports failed forward and reverse reads as unknown", () => {
    assert.deepEqual(serviceOrder([svc("A", null)]).kind, "unknown");
    assert.equal(serviceOrder([svc("A", [], null)]).kind, "unknown");
  });
  it("does not guess when a dependency is missing or is a group", () => {
    assert.equal(serviceOrder([svc("A", ["Missing"])]).kind, "unknown");
    assert.equal(serviceOrder([svc("A", ["+Group"])]).kind, "unknown");
  });
  it("reports self-reference as a cycle without an order", () => {
    assert.deepEqual(serviceOrder([svc("A", ["a"])]), { kind: "cycle", names: ["A", "A"] });
  });
  it("reports cycles without ordering even unrelated services", () => {
    assert.deepEqual(serviceOrder([svc("A", ["B"]), svc("B", ["C"]), svc("C", ["A"]), svc("D")]), { kind: "cycle", names: ["A", "B", "C", "A"] });
  });
  it("rejects inconsistent reverse reads and duplicate names", () => {
    assert.deepEqual(serviceOrder([svc("A", ["B"]), svc("B")]).kind, "unknown");
    assert.equal(serviceOrder([svc("A", [], ["B"]), svc("B")]).kind, "unknown");
    assert.equal(serviceOrder([svc("A"), svc("a")]).kind, "unknown");
  });
  it("does not infer an order from delayed, manual, disabled or running state", () => {
    const services = [svc("A"), svc("B"), svc("C")];
    services[0]!.startType = "automatic_delayed"; services[1]!.startType = "manual"; services[2]!.startType = "disabled";
    assert.deepEqual(serviceOrder(services), { kind: "checked", stages: [["A", "B", "C"]] });
  });
  it("does not treat an empty reading as checked", () => assert.equal(serviceOrder([]).kind, "unknown"));
});
