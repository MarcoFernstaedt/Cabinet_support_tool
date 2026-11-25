// Diagnostic modules (docs/spec/18-built-designs.md §2, item 1). A module is data: what it applies
// to, the catalog reads it uses, its ordered checks, the causes it can name, and the catalog writes that may repair them with how each is
// verified. The schema (contracts/schemas/diagnostics/module.schema.json) checks the shape; this checks what a schema cannot: that every
// operation is in the catalog and of the right kind, that each read's parameters pass that operation's own schema, that every reference
// inside the module resolves, and that every rule step names a rule the server has. A module that fails any of these is refused whole.
// Pure: no database, no network, no regular expressions. Problems name a place and a reason, never the submitted value.
import { catalog, diagnosticFiles, isOperationName, operations, type DiagnosticModule } from "../contracts.js";

export type { DiagnosticModule };

export interface ModuleIssue {
  /** Where in the module, as a JSON pointer. */
  path: string;
  reason: string;
}

export class ModuleError extends Error {
  readonly issues: readonly ModuleIssue[];
  constructor(issues: readonly ModuleIssue[]) {
    super("The diagnostic module was refused");
    this.name = "ModuleError";
    this.issues = issues;
  }
}

/** The problems with an already schema-valid module beyond its shape; empty when there are none. `rules` is every rule name the server has. */
export function moduleIssues(m: DiagnosticModule, rules: ReadonlySet<string>): ModuleIssue[] {
  const issues: ModuleIssue[] = [];
  const add = (path: string, reason: string) => { if (issues.length < 50) issues.push({ path, reason }); };
  // `field` is the property that must be unique, so the refusal points at the place the author wrote.
  const unique = (ids: string[], path: string, field = "id") => {
    const seen = new Set<string>();
    ids.forEach((id, i) => { if (seen.has(id)) add(`${path}/${i}/${field}`, `duplicate ${field}`); seen.add(id); });
    return seen;
  };

  const reads = unique(m.signals.reads.map(r => r.id), "/signals/reads");
  m.signals.reads.forEach((r, i) => {
    const entry = isOperationName(r.operation) ? catalog.get(r.operation) : undefined;
    if (!entry) return add(`/signals/reads/${i}/operation`, "not in the operation catalog");
    if (entry.kind !== "read") return add(`/signals/reads/${i}/operation`, "a signal must be a read operation");
    if (!operations[r.operation].params.is(r.params)) add(`/signals/reads/${i}/params`, "does not match the operation's parameters");
  });
  unique((m.signals.thresholds ?? []).map(t => t.name), "/signals/thresholds", "name");

  unique(m.procedure.map(p => p.id), "/procedure");
  m.procedure.forEach((p, i) => {
    if (p.kind === "read" && p.read !== undefined && !reads.has(p.read)) add(`/procedure/${i}/read`, "names no declared read");
    if (p.kind === "rule" && p.rule !== undefined && !rules.has(p.rule)) add(`/procedure/${i}/rule`, "names no rule the server has");
  });
  if (!m.procedure.some(p => p.kind === "read")) add("/procedure", "no step reads anything");

  m.evidence.keep.forEach((id, i) => { if (!reads.has(id)) add(`/evidence/keep/${i}`, "names no declared read"); });

  const hypotheses = unique(m.hypotheses.map(h => h.id), "/hypotheses");
  const keys = new Set<string>();
  m.hypotheses.forEach((h, i) => { if (keys.has(h.findingKey)) add(`/hypotheses/${i}/findingKey`, "duplicate finding key"); keys.add(h.findingKey); });

  unique(m.remediation.map(r => r.id), "/remediation");
  m.remediation.forEach((r, i) => {
    const entry = isOperationName(r.operation) ? catalog.get(r.operation) : undefined;
    if (!entry) add(`/remediation/${i}/operation`, "not in the operation catalog");
    else if (entry.kind !== "write") add(`/remediation/${i}/operation`, "a repair must be a write operation");
    r.forHypotheses.forEach((h, j) => { if (!hypotheses.has(h)) add(`/remediation/${i}/forHypotheses/${j}`, "names no hypothesis"); });
    const v = r.verification;
    if (v.kind !== "none" && v.read !== undefined && !reads.has(v.read)) add(`/remediation/${i}/verification/read`, "names no declared read");
  });

  const builds = m.applicability.windowsBuilds;
  if (builds?.min !== undefined && builds.max !== undefined && builds.min > builds.max) add("/applicability/windowsBuilds", "min is above max");
  return issues;
}

/** A module from untrusted data: the schema first, then moduleIssues. Throws ContractError or ModuleError; returns it typed. */
export function parseModule(data: unknown, rules: ReadonlySet<string>): DiagnosticModule {
  const m = diagnosticFiles.module.parse(data);
  const issues = moduleIssues(m, rules);
  if (issues.length) throw new ModuleError(issues);
  return m;
}
