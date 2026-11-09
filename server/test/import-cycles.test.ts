// The retention run imports every owner's prune; an owner that imports maintenance.ts back puts both in an import cycle, and which
// module then runs before its constants exist depends on the order modules happen to load. That happened once: with fleet-jobs.ts
// importing maintenance.ts, six test files failed to load ("Cannot access 'LIVE_LINK' before initialization", decision-log D73). The
// owners take their batching helpers from db/batches.ts instead; this holds maintenance.ts out of every cycle, from the source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []; });
}

/** Module -> the modules it imports at run time (relative imports; `import type` is erased and does not count). */
export function importGraph(sources: ReadonlyMap<string, string>): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const [file, text] of sources) {
    const deps: string[] = [];
    for (const m of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+"(\.{1,2}\/[^"]+)\.js";/gm))
      deps.push(join(dirname(file), m[1]!) + ".ts");
    graph.set(file, deps.filter(d => sources.has(d)));
  }
  return graph;
}

/** The modules from which `start` is reached again: empty when it is in no cycle. */
export function cycleThrough(graph: ReadonlyMap<string, readonly string[]>, start: string): string[] {
  const reaches = (from: string, seen = new Set<string>()): boolean => {
    if (from === start) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (graph.get(from) ?? []).some(d => reaches(d, seen));
  };
  return (graph.get(start) ?? []).filter(d => reaches(d));
}

test("maintenance.ts is in no import cycle: no module it imports imports it back", () => {
  const sources = new Map(files(SRC).map(p => [relative(SRC, p).split("\\").join("/"), readFileSync(p, "utf8")]));
  const back = cycleThrough(importGraph(sources), "services/maintenance.ts");
  assert.deepEqual(back, [], `these imports lead back to services/maintenance.ts; take the helper from db/batches.ts instead: ${back.join(", ")}`);
});

test("the reader finds a cycle through an import, ignores type-only imports, and finds none in a chain", () => {
  const src = (pairs: Record<string, string>) => new Map(Object.entries(pairs));
  const cyc = importGraph(src({ "services/maintenance.ts": `import { pruneX } from "./owner.js";`, "services/owner.ts": `import { inBatches } from "./maintenance.js";` }));
  assert.deepEqual(cycleThrough(cyc, "services/maintenance.ts"), ["services/owner.ts"]);
  const typeOnly = importGraph(src({ "services/maintenance.ts": `import { pruneX } from "./owner.js";`, "services/owner.ts": `import type { BatchOptions } from "./maintenance.js";` }));
  assert.deepEqual(cycleThrough(typeOnly, "services/maintenance.ts"), []);
  const chain = importGraph(src({ "services/maintenance.ts": `import { pruneX } from "./owner.js";`, "services/owner.ts": `import { inBatches } from "../db/batches.js";`, "db/batches.ts": `import { audit } from "./db.js";` }));
  assert.deepEqual(cycleThrough(chain, "services/maintenance.ts"), []);
  const viaReExport = importGraph(src({ "services/maintenance.ts": `export { a } from "./owner.js";`, "services/owner.ts": `export { b } from "./maintenance.js";` }));
  assert.deepEqual(cycleThrough(viaReExport, "services/maintenance.ts"), ["services/owner.ts"]);
});
