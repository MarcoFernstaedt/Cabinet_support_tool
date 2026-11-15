import type { ServicesListOutput } from "@mashura/cabinet-contracts/types";

type Service = ServicesListOutput["services"][number];
export type ServiceOrder = { kind: "unknown"; reason: string } | { kind: "cycle"; names: string[] } | { kind: "checked"; stages: string[][] };

/** Dependency precedence only: independent services have no enforced relative order. Never infer it from current state. */
export function serviceOrder(services: readonly Service[]): ServiceOrder {
  const byName = new Map<string, Service>();
  const unknown = (reason: string): ServiceOrder => ({ kind: "unknown", reason });
  for (const service of services) {
    const key = service.name.toLowerCase();
    if (byName.has(key)) return unknown(`Duplicate service name: ${service.name}.`);
    byName.set(key, service);
  }
  if (services.length === 0) return unknown("No services were reported.");
  for (const service of services) {
    for (const list of [service.dependencies, service.dependentServices]) {
      if (!Array.isArray(list)) return unknown(`Dependency information is unavailable for ${service.name}.`);
      for (const name of list) {
        if (typeof name !== "string" || !name.length) return unknown(`Invalid dependency information for ${service.name}.`);
        if (name.startsWith("+")) return unknown(`Load-order group ${name} is not resolved by this reading.`);
        if (!byName.has(name.toLowerCase())) return unknown(`Dependency ${name} is not in this reading.`);
      }
    }
  }
  // Detect cycles before checking the reverse read, so a cycle is always named as such.
  const visiting = new Set<string>(), done = new Set<string>(), path: string[] = [];
  const stages = new Map<string, number>();
  function visit(key: string): string[] | null {
    if (visiting.has(key)) return [...path.slice(path.indexOf(key)), key].map(k => byName.get(k)!.name);
    if (done.has(key)) return null;
    visiting.add(key); path.push(key);
    let stage = 0;
    for (const dependency of byName.get(key)!.dependencies!) {
      const next = dependency.toLowerCase();
      const cycle = visit(next);
      if (cycle) return cycle;
      stage = Math.max(stage, stages.get(next)! + 1);
    }
    path.pop(); visiting.delete(key); done.add(key); stages.set(key, stage);
    return null;
  }
  for (const key of byName.keys()) {
    const cycle = visit(key);
    if (cycle) return { kind: "cycle", names: cycle };
  }
  for (const service of services) {
    for (const name of service.dependencies!) {
      if (!byName.get(name.toLowerCase())!.dependentServices!.some(n => n.toLowerCase() === service.name.toLowerCase()))
        return unknown(`The forward and reverse dependency readings disagree for ${service.name}.`);
    }
    for (const name of service.dependentServices!) {
      if (!byName.get(name.toLowerCase())!.dependencies!.some(n => n.toLowerCase() === service.name.toLowerCase()))
        return unknown(`The forward and reverse dependency readings disagree for ${service.name}.`);
    }
  }
  const groups: string[][] = [];
  for (const [key, stage] of stages) (groups[stage] ??= []).push(byName.get(key)!.name);
  for (const group of groups) group.sort((a, b) => a.localeCompare(b));
  return { kind: "checked", stages: groups };
}
