// Which source file writes which table (F21.R2, decision-log D56): a static read of server/src for the statements that change a table
// (INSERT INTO, UPDATE, DELETE, MERGE), against the tables the migrations create. An UPDATE or DELETE through an alias
// ("UPDATE p SET … FROM fleet_patterns p", "DELETE d FROM cabinet_drift d") is followed to its table. A test helper only: nothing at run
// time depends on it, and it reads text, it never runs any of it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** The tables the migrations create. */
export function migrationTables(migrationsDir: string): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(migrationsDir).filter(n => n.endsWith(".sql")))
    for (const m of readFileSync(join(migrationsDir, f), "utf8").matchAll(/CREATE TABLE \[?([a-z_0-9]+)\]?/gi)) out.add(m[1]!.toLowerCase());
  return out;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []; });
}

/** Table -> the files under `srcDir` (relative, forward slashes) whose statements write it. */
export function tableWriters(srcDir: string, tables: ReadonlySet<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (t: string, f: string) => { if (tables.has(t)) (out.get(t) ?? out.set(t, new Set()).get(t)!).add(f); };
  for (const p of files(srcDir)) {
    const file = relative(srcDir, p).split("\\").join("/");
    const text = readFileSync(p, "utf8");
    for (const m of text.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|DELETE|MERGE(?:\s+INTO)?)\s+\[?([a-z_][a-z0-9_]*)\]?/gi)) {
      const verb = m[1]!.toUpperCase(), name = m[2]!.toLowerCase();
      if (tables.has(name)) { add(name, file); continue; }
      // Through an alias: the alias's table is named after FROM (or JOIN) in the same statement, within a short reach.
      if (verb === "UPDATE" || verb === "DELETE") {
        const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 600);
        const via = new RegExp(`\\b(?:FROM|JOIN)\\s+\\[?([a-z_][a-z0-9_]*)\\]?(?:\\s+AS)?\\s+${name}\\b`, "i").exec(after);
        if (via) add(via[1]!.toLowerCase(), file);
      }
    }
  }
  return out;
}
