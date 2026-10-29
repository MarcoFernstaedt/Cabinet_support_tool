// The capability registry (docs/platform/diagnostic-engine-execution.md, "The foundation in detail", items 3 and 5): the schema refuses a
// malformed or hostile registry, and the server refuses an entry that claims what its module cannot do (above all a repair it cannot
// verify), a reference that resolves to nothing, a dependency cycle, a module at another version, and a module nobody registered.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractError } from "../src/contracts.js";
import type { DiagnosticModule } from "../src/diagnose/module.js";
import { cabinetModules } from "../src/diagnose/cabinet-findings.js";
import { dependencyCycle, loadRegistry, parseRegistry, RegistryError, registryIssues, type Capability, type CapabilityRegistry } from "../src/diagnose/registry.js";

const examples = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "contracts", "examples", "diagnostics");
const load = (dir: string, kind: string, name: string) => JSON.parse(readFileSync(join(examples, dir, kind, name), "utf8")) as unknown;
const scanner = () => load("module", "valid", "scanner-offline.json") as DiagnosticModule;
const modules = (...ms: DiagnosticModule[]) => new Map(ms.map(m => [m.id, m]));
const base = () => load("registry", "valid", "chain.json") as CapabilityRegistry;

function refusal(change: (r: CapabilityRegistry) => void, ms = modules(scanner())): string[] {
  const r = base();
  change(r);
  return registryIssues(r, ms).map(i => `${i.path}: ${i.reason}`);
}

test("the committed registry is valid with the modules the server has (the cabinet checks)", () => {
  const r = loadRegistry(new Map(cabinetModules().map(m => [m.id, m])));
  assert.deepEqual(r.capabilities.filter(c => c.status === "built").map(c => c.id).sort(), cabinetModules().map(m => m.id).sort());
  assert.ok(r.capabilities.some(c => c.id === "sql-connectivity-ladder" && c.status === "planned"), "the plan's first new module is named");
  // Leaving a module out of the registry is refused.
  assert.throws(() => loadRegistry(new Map([...cabinetModules().map(m => [m.id, m] as const), ["extra-module", { ...cabinetModules()[0]!, id: "extra-module" }]])), RegistryError);
});

test("every valid example is accepted and every hostile one is refused by the schema", () => {
  assert.doesNotThrow(() => parseRegistry(base(), modules(scanner())));
  assert.doesNotThrow(() => parseRegistry(load("registry", "valid", "empty.json"), new Map()));
  const files = readdirSync(join(examples, "registry", "invalid"));
  assert.ok(files.length >= 14);
  for (const f of files) assert.throws(() => parseRegistry(load("registry", "invalid", f), modules(scanner())), ContractError, f);
});

test("a repair is claimed only when every repair is verified by a read", () => {
  const noReadBack = scanner();
  noReadBack.remediation[0]!.verification = { kind: "none", reason: "Nothing shows it worked" };
  assert.deepEqual(refusal(() => {}, modules(noReadBack)), ["/capabilities/0/provides: verify needs every repair the module offers to be verified by a read"]);
  assert.deepEqual(refusal(r => { r.capabilities[0]!.provides = ["diagnose", "repair"]; }), ["/capabilities/0/provides: a repair is claimed only with verify"]);
  // The same module, honestly registered as diagnose-only, is accepted.
  assert.deepEqual(refusal(r => { r.capabilities[0]!.provides = ["detect", "diagnose"]; }, modules(noReadBack)), []);
  const diagnoseOnly = scanner();
  diagnoseOnly.remediation = [];
  assert.deepEqual(refusal(() => {}, modules(diagnoseOnly)), ["/capabilities/0/provides: repair needs the module to offer a repair",
    "/capabilities/0/provides: verify needs every repair the module offers to be verified by a read"]);
});

test("detect needs events; a built entry needs its module at the registered version", () => {
  const quiet = scanner();
  delete quiet.signals.events;
  assert.deepEqual(refusal(() => {}, modules(quiet)), ["/capabilities/0/provides: detect needs the module to listen for events"]);
  assert.deepEqual(refusal(r => { r.capabilities[0]!.moduleVersion = 2; }), ["/capabilities/0/moduleVersion: is not the module's version"]);
  assert.deepEqual(refusal(() => {}, new Map()), ["/capabilities/0/id: no module has this id"]);
});

test("every module the server has is registered as built", () => {
  const other = { ...scanner(), id: "time-drift" };
  assert.deepEqual(refusal(() => {}, modules(scanner(), other)), ["/capabilities: module time-drift is not registered as built"]);
  assert.deepEqual(refusal(r => { r.capabilities[0]!.status = "planned"; delete r.capabilities[0]!.moduleVersion; }), ["/capabilities: module scanner-offline is not registered as built"]);
});

test("references resolve, never to the entry itself, and a built entry never depends on a planned one", () => {
  assert.deepEqual(refusal(r => { r.capabilities[0]!.next = ["nowhere"]; }), ["/capabilities/0/next/0: names no entry"]);
  assert.deepEqual(refusal(r => { r.capabilities[1]!.dependsOn = ["usb-power"]; }), ["/capabilities/1/dependsOn/0: names itself"]);
  assert.deepEqual(refusal(r => { r.capabilities[0]!.dependsOn = ["usb-power"]; }),
    ["/capabilities/0/dependsOn/0: a built entry cannot depend on a planned one", "/capabilities: dependencies go round in a circle: scanner-offline > usb-power > scanner-offline"]);
  assert.deepEqual(refusal(r => { r.capabilities.push({ ...r.capabilities[1]! }); }), ["/capabilities/2/id: duplicate id"]);
});

test("a dependency cycle of any length is found, and a chain without one is not", () => {
  const entry = (id: string, dependsOn: string[]): Capability => ({ id, status: "planned", phase: 2, title: id, provides: ["diagnose"], dependsOn });
  assert.equal(dependencyCycle([entry("aaa", ["bbb"]), entry("bbb", ["ccc"]), entry("ccc", [])]), null);
  assert.deepEqual(dependencyCycle([entry("aaa", ["bbb"]), entry("bbb", ["ccc"]), entry("ccc", ["aaa"])]), ["aaa", "bbb", "ccc", "aaa"]);
  assert.equal(dependencyCycle([entry("aaa", []), entry("bbb", ["bbb"])]), null, "naming itself is reported once, as such, not again as a cycle");
  // A long chain does not overflow the stack and is not a cycle.
  const long = Array.from({ length: 200 }, (_, i) => entry(`m${i}`, i + 1 < 200 ? [`m${i + 1}`] : []));
  assert.equal(dependencyCycle(long), null);
});

test("a refusal names places and reasons, never a submitted value, and hostile shapes are refused", () => {
  const hostile = "<script>alert(1)</script>";
  try { parseRegistry({ ...base(), capabilities: [{ ...base().capabilities[0]!, title: hostile, command: "powershell" }] }, modules(scanner())); assert.fail("accepted"); } catch (e) {
    assert.ok(e instanceof ContractError);
    assert.ok(!JSON.stringify(e.issues).includes("script>") && !JSON.stringify(e.issues).includes("powershell"));
  }
  try { parseRegistry({ ...base(), capabilities: [{ ...base().capabilities[0]!, next: ["nowhere-at-all"] }, base().capabilities[1]!] }, modules(scanner())); assert.fail("accepted"); } catch (e) {
    assert.ok(e instanceof RegistryError);
    assert.ok(!JSON.stringify(e.issues).includes("nowhere-at-all"));
  }
  for (const text of ["null", "[]", '"registry"', '{"__proto__": {"polluted": true}}', '{"version": 1, "capabilities": {}}'])
    assert.throws(() => parseRegistry(JSON.parse(text), new Map()), ContractError, text);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const many = { version: 1, capabilities: Array.from({ length: 201 }, (_, i) => ({ id: `m${i}x`, status: "planned", phase: 2, title: "x", provides: ["diagnose"] })) };
  assert.throws(() => parseRegistry(many, new Map()), ContractError);
});
