// Which source file writes which table (F21.R2, decision-log D56): a static read of server/src for the statements that change a table
// (INSERT INTO, UPDATE, DELETE, MERGE), against the tables the migrations create. An UPDATE or DELETE through an alias
// ("UPDATE p SET … FROM fleet_patterns p", "DELETE d FROM cabinet_drift d") is followed to its table. A write whose table is built at run
// time is found too (runtimeTableWrites), so it cannot pass unseen: the file must declare the tables it can write. A test helper only:
// nothing at run time depends on it, and it reads text, it never runs any of it.
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

/**
 * The start of a write, up to where its table is named: the verb, then a row limit if it has one (`UPDATE TOP ($1)`,
 * `DELETE TOP (500) FROM`), then INTO or FROM if written. The retention sweeps limit each batch with TOP, and a reader that took the
 * table to follow the verb directly did not see them (review of #224).
 */
const WRITE = /\b(INSERT|UPDATE|DELETE|MERGE)(?:\s+TOP\s*\(\s*[^()]*\))?(?:\s+(?:INTO|FROM))?\s+/;

/**
 * The files under `srcDir` with a write whose table is not named in the text but built at run time (an UPDATE whose table is an
 * interpolated variable), with how many such statements each has. The reader cannot see which table those write, so each file has to
 * declare them (table-owners.ts). SQL keywords are matched in upper case only, as this codebase writes them, so prose that starts with
 * "Update" is not taken for a statement.
 */
export function runtimeTableWrites(srcDir: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of files(srcDir)) {
    const file = relative(srcDir, p).split("\\").join("/");
    const n = [...readFileSync(p, "utf8").matchAll(new RegExp(`${WRITE.source}\\[?\\$\\{`, "g"))].length;
    if (n > 0) out.set(file, n);
  }
  return out;
}

/** Table -> the files under `srcDir` (relative, forward slashes) whose statements write it. */
export function tableWriters(srcDir: string, tables: ReadonlySet<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (t: string, f: string) => { if (tables.has(t)) (out.get(t) ?? out.set(t, new Set()).get(t)!).add(f); };
  for (const p of files(srcDir)) {
    const file = relative(srcDir, p).split("\\").join("/");
    const text = readFileSync(p, "utf8");
    for (const m of text.matchAll(new RegExp(`${WRITE.source}\\[?([a-z_][a-z0-9_]*)\\]?`, "gi"))) {
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
