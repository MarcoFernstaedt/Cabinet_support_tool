// The capability registry (contracts/diagnostics/
// registry.json). One entry per module, built or planned: what it can do, which version is registered, what it depends on, what is offered
// after it, and its engine phase. The schema checks the shape; this checks what a schema cannot: that a built entry has its module at that
// version, that it claims only what the module can do, that every reference resolves, that dependencies have no cycle, and that every
// module the server has is registered. A repair is claimed only with "verify", and "verify" only when every repair the module offers is
// verified by a read: a module that would claim a repair it cannot verify is refused. Pure: no database, no network, no regular expressions.
import { readRegistry } from "@mashura/cabinet-contracts/load";
import { diagnosticFiles, type CapabilityRegistry, type DiagnosticModule } from "../contracts.js";

export type { CapabilityRegistry };
export type Capability = CapabilityRegistry["capabilities"][number];

export interface RegistryIssue { path: string; reason: string }

export class RegistryError extends Error {
  readonly issues: readonly RegistryIssue[];
  constructor(issues: readonly RegistryIssue[]) {
    super("The capability registry was refused");
    this.name = "RegistryError";
    this.issues = issues;
  }
}

/** The problems with a schema-valid registry, given every module the server has (by id); empty when there are none. */
export function registryIssues(r: CapabilityRegistry, modules: ReadonlyMap<string, DiagnosticModule>): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const add = (path: string, reason: string) => { if (issues.length < 50) issues.push({ path, reason }); };
  const byId = new Map<string, Capability>();
  r.capabilities.forEach((c, i) => { if (byId.has(c.id)) add(`/capabilities/${i}/id`, "duplicate id"); else byId.set(c.id, c); });

  r.capabilities.forEach((c, i) => {
    const at = `/capabilities/${i}`;
    for (const [field, ids] of [["dependsOn", c.dependsOn ?? []], ["next", c.next ?? []]] as const)
      ids.forEach((id, j) => {
        const target = byId.get(id);
        if (id === c.id) add(`${at}/${field}/${j}`, "names itself");
        else if (!target) add(`${at}/${field}/${j}`, "names no entry");
        else if (field === "dependsOn" && c.status === "built" && target.status === "planned") add(`${at}/${field}/${j}`, "a built entry cannot depend on a planned one");
      });
    if (c.status !== "built") return;
    const m = modules.get(c.id);
    if (!m) return add(`${at}/id`, "no module has this id");
    if (m.version !== c.moduleVersion) add(`${at}/moduleVersion`, "is not the module's version");
    const provides = new Set(c.provides);
    if (provides.has("detect") && !(m.signals.events?.length)) add(`${at}/provides`, "detect needs the module to listen for events");
    if (provides.has("repair") && m.remediation.length === 0) add(`${at}/provides`, "repair needs the module to offer a repair");
    if (provides.has("repair") && !provides.has("verify")) add(`${at}/provides`, "a repair is claimed only with verify");
    if (provides.has("verify") && (m.remediation.length === 0 || m.remediation.some(x => x.verification.kind === "none")))
      add(`${at}/provides`, "verify needs every repair the module offers to be verified by a read");
  });

  for (const id of modules.keys()) if (byId.get(id)?.status !== "built") add("/capabilities", `module ${id} is not registered as built`);
  const cycle = dependencyCycle(r.capabilities);
  if (cycle) add("/capabilities", `dependencies go round in a circle: ${cycle.join(" > ")}`);
  return issues;
}

/** The first cycle in dependsOn, as the ids along it with the first repeated at the end, or null. An entry naming itself is not counted
 *  here: registryIssues already says "names itself" for it. */
export function dependencyCycle(capabilities: readonly Capability[]): string[] | null {
  const deps = new Map(capabilities.map(c => [c.id, c.dependsOn ?? []]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "visiting") return [...path.slice(path.indexOf(id)), id];
    state.set(id, "visiting");
    path.push(id);
    for (const d of deps.get(id) ?? []) if (d !== id && deps.has(d)) { const found = visit(d); if (found) return found; }
    path.pop();
    state.set(id, "done");
    return null;
  };
  for (const id of deps.keys()) { const found = visit(id); if (found) return found; }
  return null;
}

/** A registry from untrusted data: the schema first, then registryIssues. Throws ContractError or RegistryError. */
export function parseRegistry(data: unknown, modules: ReadonlyMap<string, DiagnosticModule>): CapabilityRegistry {
  const r = diagnosticFiles.registry.parse(data);
  const issues = registryIssues(r, modules);
  if (issues.length) throw new RegistryError(issues);
  return r;
}

/** The committed registry (contracts/diagnostics/registry.json), checked against the modules the server has. */
export function loadRegistry(modules: ReadonlyMap<string, DiagnosticModule>): CapabilityRegistry {
  return parseRegistry(readRegistry(), modules);
}
