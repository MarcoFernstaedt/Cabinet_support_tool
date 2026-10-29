// Diagnostic modules (docs/platform/diagnostic-engine-execution.md, "The foundation in detail", items 1 and 5): the schema refuses a
// malformed or hostile module, and the server refuses what a schema cannot see: an operation of the wrong kind, a read whose parameters
// its operation refuses, a reference that resolves to nothing, a rule the server does not have. Pure: no database.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractError } from "../src/contracts.js";
import { ModuleError, moduleIssues, parseModule, type DiagnosticModule } from "../src/diagnose/module.js";

const examples = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "contracts", "examples", "diagnostics", "module");
const load = (kind: string, name: string) => JSON.parse(readFileSync(join(examples, kind, name), "utf8")) as unknown;
const RULES = new Set(["scanner.present", "scanner.serviceRunning", "time.drift"]);
const base = () => load("valid", "scanner-offline.json") as DiagnosticModule;

/** The single issue a changed module raises, as "path: reason". */
function refusal(change: (m: DiagnosticModule) => void, rules: ReadonlySet<string> = RULES): string[] {
  const m = base();
  change(m);
  try { parseModule(m, rules); } catch (e) {
    if (e instanceof ModuleError) return e.issues.map(i => `${i.path}: ${i.reason}`);
    throw e;
  }
  return [];
}

test("every valid example is accepted whole", () => {
  for (const f of readdirSync(join(examples, "valid"))) assert.doesNotThrow(() => parseModule(load("valid", f), RULES), f);
  assert.deepEqual(moduleIssues(base(), RULES), []);
});

test("every hostile or malformed example is refused by the schema before anything reads it", () => {
  const files = readdirSync(join(examples, "invalid"));
  assert.ok(files.length >= 20);
  for (const f of files) assert.throws(() => parseModule(load("invalid", f), RULES), ContractError, f);
});

test("a signal must be a catalog read, with parameters its operation accepts", () => {
  assert.deepEqual(refusal(m => { m.signals.reads[0]!.operation = "service.control"; }), ["/signals/reads/0/operation: a signal must be a read operation"]);
  assert.deepEqual(refusal(m => { m.signals.reads[0]!.params = { hardwareIds: ["not a hardware id; del *"] }; }), ["/signals/reads/0/params: does not match the operation's parameters"]);
  assert.deepEqual(refusal(m => { m.signals.reads[0]!.params = { command: "cmd.exe" }; }), ["/signals/reads/0/params: does not match the operation's parameters"]);
});

test("a repair must be a catalog write: a read cannot be offered as a fix", () => {
  assert.deepEqual(refusal(m => { m.remediation[0]!.operation = "services.list"; }), ["/remediation/0/operation: a repair must be a write operation"]);
});

test("every reference inside a module resolves: reads, rules, evidence, causes and verification", () => {
  assert.deepEqual(refusal(m => { m.procedure[0]!.read = "nowhere"; }), ["/procedure/0/read: names no declared read"]);
  assert.deepEqual(refusal(m => { m.procedure[3]!.rule = "scanner.unknownRule"; }), ["/procedure/3/rule: names no rule the server has"]);
  assert.deepEqual(refusal(m => { m.evidence.keep = ["peripheral", "files"]; }), ["/evidence/keep/1: names no declared read"]);
  assert.deepEqual(refusal(m => { m.remediation[0]!.forHypotheses = ["service_stopped", "made_up"]; }), ["/remediation/0/forHypotheses/1: names no hypothesis"]);
  assert.deepEqual(refusal(m => { m.remediation[0]!.verification = { kind: "functional", read: "nowhere" }; }), ["/remediation/0/verification/read: names no declared read"]);
  // A module that claims a repair verified by a read it never declared is the case the plan names: it cannot verify, so it is refused.
  assert.deepEqual(refusal(m => { m.remediation[0]!.verification = { kind: "read_back", read: "time" }; }), ["/remediation/0/verification/read: names no declared read"]);
});

test("ids and finding keys are unique, builds are in order, and something is read", () => {
  // The duplicate is named; the read it replaced then resolves to nothing, and that is said too.
  assert.deepEqual(refusal(m => { m.signals.reads[1]!.id = "peripheral"; }), ["/signals/reads/1/id: duplicate id", "/procedure/1/read: names no declared read", "/evidence/keep/1: names no declared read"]);
  assert.deepEqual(refusal(m => { m.procedure[1]!.id = "read_scanner"; }), ["/procedure/1/id: duplicate id"]);
  // A threshold is named by `name`, not `id`: the refusal points at the property the author wrote.
  assert.deepEqual(refusal(m => { m.signals.thresholds = [{ name: "disconnects_per_day", value: 3, unit: "count" }, { name: "disconnects_per_day", value: 5, unit: "count" }]; }),
    ["/signals/thresholds/1/name: duplicate name"]);
  assert.deepEqual(refusal(m => { m.hypotheses[1]!.id = "unplugged"; }), ["/hypotheses/1/id: duplicate id", "/remediation/0/forHypotheses/0: names no hypothesis"]);
  assert.deepEqual(refusal(m => { m.hypotheses[1]!.findingKey = "scanner.not_present"; }), ["/hypotheses/1/findingKey: duplicate finding key"]);
  assert.deepEqual(refusal(m => { m.applicability.windowsBuilds = { min: 22000, max: 19045 }; }), ["/applicability/windowsBuilds: min is above max"]);
  assert.deepEqual(refusal(m => { m.procedure = m.procedure.filter(p => p.kind === "rule") as DiagnosticModule["procedure"]; }), ["/procedure: no step reads anything"]);
});

test("with no rules known, every rule step is refused rather than trusted", () => {
  assert.deepEqual(refusal(() => {}, new Set()), ["/procedure/3/rule: names no rule the server has", "/procedure/4/rule: names no rule the server has"]);
});

test("a refusal names places and reasons, never the submitted value", () => {
  const hostile = "<script>alert(1)</script>";
  const m = base() as unknown as Record<string, unknown>;
  m.title = hostile;
  m.command = "powershell -enc AAAA";
  try { parseModule(m, RULES); assert.fail("accepted"); } catch (e) {
    assert.ok(e instanceof ContractError);
    const text = JSON.stringify(e.issues) + e.message;
    assert.ok(!text.includes("script>") && !text.includes("powershell"), text);
  }
  const value = "not a hardware id; del *";
  try { parseModule({ ...base(), signals: { ...base().signals, reads: [{ id: "peripheral", operation: "peripheral.status", params: { hardwareIds: [value] } }, ...base().signals.reads.slice(1)] } }, RULES); assert.fail("accepted"); } catch (e) {
    assert.ok(e instanceof ModuleError);
    assert.ok(!JSON.stringify(e.issues).includes(value));
  }
});

test("prototype keys, wrong types and oversized input are refused, not merged", () => {
  for (const text of ['{"__proto__": {"polluted": true}}', "null", "[]", '"scanner-offline"', "42"])
    assert.throws(() => parseModule(JSON.parse(text), RULES), ContractError, text);
  const proto = JSON.parse(JSON.stringify(base()).replace('"version":1', '"version":1,"__proto__":{"polluted":true}')) as unknown;
  assert.throws(() => parseModule(proto, RULES), ContractError);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const big = base();
  big.procedure = Array.from({ length: 5_000 }, (_, i) => ({ id: `s${i}`, kind: "read" as const, read: "peripheral" })) as DiagnosticModule["procedure"];
  assert.throws(() => parseModule(big, RULES), ContractError);
  assert.throws(() => parseModule({ ...base(), version: 1.5 }, RULES), ContractError);
  assert.throws(() => parseModule({ ...base(), id: "Scanner-Offline" }, RULES), ContractError);
});

test("the issue list is capped, so a module built to produce thousands of problems cannot flood a log", () => {
  const m = base();
  m.evidence.keep = Array.from({ length: 16 }, (_, i) => `missing_${i}`);
  m.procedure = [...m.procedure.slice(0, 1), ...Array.from({ length: 31 }, (_, i) => ({ id: `r${i}`, kind: "read" as const, read: `nowhere_${i}` }))] as DiagnosticModule["procedure"];
  m.remediation = Array.from({ length: 8 }, (_, i) => ({ id: `fix${i}`, operation: "services.list" as const, forHypotheses: Array.from({ length: 16 }, (_, j) => `h${i}_${j}`), preconditions: [],
    verification: { kind: "read_back" as const, read: "nowhere" } })) as unknown as DiagnosticModule["remediation"];
  const issues = moduleIssues(m, RULES);
  assert.equal(issues.length, 50);
});
