// Today's cabinet checks as diagnostic modules (docs/platform/diagnostic-engine-execution.md, "The foundation in detail", item 4). The
// diagnosis now runs each module's rule steps in order instead of calling the checks by hand; its behaviour is unchanged, which the
// existing cabinet-findings tests prove (they are not edited). These tests keep the modules honest against the code they describe: the
// same reads the diagnosis issues, every finding a check can produce declared as a cause of its module and nothing declared that it
// cannot produce, every repair offered by the code declared with its verification, and the run order matching the registry.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CABINET_RULES, cabinetModules } from "../src/diagnose/cabinet-findings.js";
import { bundleReads } from "../src/diagnose/cabinet.js";
import { loadRegistry } from "../src/diagnose/registry.js";
import { networkModule } from "../src/diagnose/network-module.js";
import { findingKey } from "../src/services/known-fixes.js";

const source = readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "src", "diagnose", "cabinet-findings.ts"), "utf8");
/** The text of one top-level function, from its declaration to the closing brace at the start of a line. */
function body(name: string): string {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
/** Every quoted string after `label: "` in the text. */
function quoted(text: string, label: string): string[] {
  const out: string[] = [];
  for (let i = text.indexOf(`${label}: "`); i >= 0; i = text.indexOf(`${label}: "`, i + 1)) {
    const from = i + label.length + 3;
    out.push(text.slice(from, text.indexOf("\"", from)));
  }
  return out;
}
const RULE_FUNCTION: Record<string, string> = { "cabinet.system": "system", "cabinet.storage": "storage", "cabinet.performance": "performance", "cabinet.scanner": "scanner",
  "cabinet.devices": "devices", "cabinet.usbPorts": "usbPorts", "cabinet.services": "services", "cabinet.updates": "updates", "cabinet.time": "time", "cabinet.logs": "logs" };
const KNOWN_EVENTS = source.slice(source.indexOf("const KNOWN_EVENTS"), source.indexOf("\n];", source.indexOf("const KNOWN_EVENTS")));
/** The finding keys the code behind a rule can produce: explicit keys, and plain ids (whose key is the id without an instance number). */
function keysOf(rule: string): Set<string> {
  const text = body(RULE_FUNCTION[rule]!) + (rule === "cabinet.logs" ? KNOWN_EVENTS : "");
  return new Set([...quoted(text, "key"), ...quoted(text, "id").map(findingKey)]);
}

test("every cabinet module is checked, runs in the registry's order, and every rule it names is a rule the server has", () => {
  const modules = cabinetModules();
  assert.equal(modules.length, 9);
  assert.deepEqual(new Set(modules.flatMap(m => m.procedure.filter(p => p.kind === "rule").map(p => p.rule))), new Set(Object.keys(CABINET_RULES)));
  const registry = loadRegistry(new Map([...modules, networkModule()].map(m => [m.id, m])));
  // A module runs after everything it depends on.
  const position = new Map(modules.map((m, i) => [m.id, i]));
  for (const c of registry.capabilities.filter(c => c.status === "built"))
    for (const d of c.dependsOn ?? []) assert.ok(position.get(d)! < position.get(c.id)!, `${c.id} runs after ${d}`);
});

test("each module declares exactly the reads the diagnosis issues for it", () => {
  const declared = cabinetModules().flatMap(m => m.signals.reads.map(r => ({ operation: r.operation, params: r.params })));
  const issued = bundleReads(Date.parse("2026-10-29T12:00:00Z"), true).map(r => {
    // The log reads' start time moves with every run, so the module leaves it out and the diagnosis adds it.
    const { from, ...rest } = r.params as Record<string, unknown>;
    if (r.operation === "eventlog.query") assert.equal(from, "2026-10-28T12:00:00.000Z");
    return { operation: r.operation, params: rest };
  });
  const key = (x: { operation: string; params: Record<string, unknown> }) => `${x.operation} ${JSON.stringify(x.params)}`;
  assert.deepEqual(declared.map(key).sort(), issued.map(key).sort());
});

test("every finding a check can produce is a cause its module declares, and every declared cause is one the check can produce", () => {
  for (const m of cabinetModules()) {
    const produced = new Set(m.procedure.filter(p => p.kind === "rule").flatMap(p => [...keysOf(p.rule!)]));
    const declared = new Set(m.hypotheses.map(h => h.findingKey));
    assert.deepEqual([...produced].sort(), [...declared].sort(), m.id);
  }
});

test("every repair the checks offer is declared, verified by a read, on the module whose check offers it", () => {
  for (const m of cabinetModules()) {
    const offered = new Set(m.procedure.filter(p => p.kind === "rule").flatMap(p => quoted(body(RULE_FUNCTION[p.rule!]!), "operation")));
    // time() builds its actions through a small helper: act("time.sync", …) and act("time.setZone", …).
    for (const p of m.procedure) if (p.rule === "cabinet.time") for (const op of ["time.sync", "time.setZone"]) if (body("time").includes(`act("${op}"`)) offered.add(op);
    assert.deepEqual([...offered].sort(), m.remediation.map(r => r.operation).sort(), m.id);
    for (const r of m.remediation) assert.notEqual(r.verification.kind, "none", `${m.id} ${r.id}`);
  }
});
