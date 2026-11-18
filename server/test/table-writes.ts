// Which source file writes which table (F21.R2, decision-log D56): a static read of server/src for the statements that change a table
// (INSERT INTO, UPDATE, DELETE, MERGE), against the tables the migrations create. An UPDATE or DELETE through an alias
// ("UPDATE p SET … FROM fleet_patterns p", "DELETE d FROM cabinet_drift d") is followed to its table. A write whose table is built at run
// time is found too (runtimeTableWrites), so it cannot pass unseen: the file must declare the tables it can write. A test helper only:
// nothing at run time depends on it, and it reads text, it never runs any of it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The rest of the statement that starts at `from`: up to the semicolon that ends it, or the end of the string literal that holds it (a
 * backtick or a double quote), each counted only outside parentheses, quoted SQL strings and comments. An UPDATE or DELETE through an
 * alias names its table after FROM, which can sit well past the verb: the reader used to look only 600 characters on, and the fold in
 * alerts.ts (writeAlerts) has its FROM at 610, so that write was not read at all (review of #313). Capped at 20,000 characters.
 */
export function statementRest(text: string, from: number): string {
  const end = Math.min(text.length, from + 20_000);
  let depth = 0;
  for (let i = from; i < end; i++) {
    const skip = opaqueEnd(text, i);
    if (skip === null) return text.slice(from, end);
    if (skip > i) { i = skip - 1; continue; }
    const ch = text[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "`" || ch === "\"" || (ch === ";" && depth <= 0)) return text.slice(from, i);
  }
  return text.slice(from, end);
}

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
        const after = statementRest(text, m.index! + m[0].length);
        const via = new RegExp(`\\b(?:FROM|JOIN)\\s+\\[?([a-z_][a-z0-9_]*)\\]?(?:\\s+AS)?\\s+${name}\\b`, "i").exec(after);
        if (via) add(via[1]!.toLowerCase(), file);
      }
    }
  }
  return out;
}

/** One file's writes of one table, as the column-ownership rule reads them (decision-log D118). */
export interface WriteShape {
  /** The columns each plain `UPDATE <table> SET …` sets, lower case, one list per statement. */
  updates: string[][];
  /** Every other write of the table: INSERT, DELETE, MERGE, or an UPDATE whose SET the reader cannot split (through an alias too). */
  other: number;
}

/**
 * The columns a SET clause assigns, or null when it cannot be read: everything after SET up to WHERE, OUTPUT or FROM, or the end of the
 * statement's text, split at the commas outside parentheses; each part must start with a column name and `=`.
 */
export function setColumns(clause: string): string[] | null {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < clause.length; i++) {
    const skip = opaqueEnd(clause, i);
    if (skip === null) return null;
    if (skip > i) { i = skip - 1; continue; }
    const ch = clause[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { parts.push(clause.slice(start, i)); start = i + 1; }
  }
  parts.push(clause.slice(start));
  const columns: string[] = [];
  for (const raw of parts) {
    // A part may start with a comment that explains it (alerts.ts writes one before `severity = …`): skip the comments and the
    // whitespace before the column (review of #313).
    let at = 0;
    for (;;) {
      while (at < raw.length && /\s/.test(raw[at]!)) at++;
      const end = opaqueEnd(raw, at);
      if (end === null) return null;
      if (end === at || raw[at] === "'") break;
      at = end;
    }
    const part = raw.slice(at);
    // A column may carry the statement's alias (`k.sync_cabinet_id = …`).
    const m = /^\s*(?:[a-z_][a-z0-9_]*\.)?\[?([a-z_][a-z0-9_]*)\]?\s*=/i.exec(part);
    if (!m) return null;
    columns.push(m[1]!.toLowerCase());
  }
  return columns.length > 0 ? columns : null;
}

/**
 * The text of a SET clause: from just after SET up to the WHERE, OUTPUT or FROM that ends it, or the end of the statement's text (a
 * semicolon, double quote or backtick), each counted only outside parentheses, quoted strings and comments, so a subquery's own FROM or
 * WHERE, or the word "from" in a string or a comment, does not end the clause early and hide the assignments after it (review of #313).
 * Null when the statement's text ends while a parenthesis, a string or a comment is still open: the reader cannot tell where the clause
 * stops, so the write is not read as a column update.
 */
/**
 * Where a piece of SQL the reader must not look inside ends, when one starts at `i`: a quoted string ('…', with '' for a quote inside it),
 * a line comment (-- to the end of the line) or a block comment. `i` itself when none starts there; null when the text ends inside one
 * (review of #313: a word or a comma inside them is not the statement's own).
 */
export function opaqueEnd(text: string, i: number): number | null {
  if (text[i] === "'") {
    for (let j = i + 1; j < text.length; j++) if (text[j] === "'") { if (text[j + 1] === "'") j++; else return j + 1; }
    return null;
  }
  if (text.startsWith("--", i)) { const nl = text.indexOf("\n", i); return nl === -1 ? null : nl + 1; }
  if (text.startsWith("/*", i)) { const end = text.indexOf("*/", i + 2); return end === -1 ? null : end + 2; }
  return i;
}

export function setClause(text: string): string | null {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const skip = opaqueEnd(text, i);
    if (skip === null) return null;
    if (skip > i) { i = skip - 1; continue; }
    const ch = text[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ";" || ch === "`" || ch === "\"") return depth === 0 ? text.slice(0, i) : null;
    else if (depth === 0 && /^(?:WHERE|OUTPUT|FROM)\b/i.test(text.slice(i)) && (i === 0 || /\W/.test(text[i - 1]!))) return text.slice(0, i);
  }
  return depth === 0 ? text : null;
}

/** Table -> file -> the shape of that file's writes of it (D118). Only tables in `tables` are reported. */
export function tableWriteShapes(srcDir: string, tables: ReadonlySet<string>): Map<string, Map<string, WriteShape>> {
  const out = new Map<string, Map<string, WriteShape>>();
  const shape = (t: string, f: string): WriteShape => {
    const byFile = out.get(t) ?? out.set(t, new Map()).get(t)!;
    return byFile.get(f) ?? byFile.set(f, { updates: [], other: 0 }).get(f)!;
  };
  for (const p of files(srcDir)) {
    const file = relative(srcDir, p).split("\\").join("/");
    const text = readFileSync(p, "utf8");
    for (const m of text.matchAll(new RegExp(`${WRITE.source}\\[?([a-z_][a-z0-9_]*)\\]?`, "gi"))) {
      const verb = m[1]!.toUpperCase(), name = m[2]!.toLowerCase();
      const after = statementRest(text, m.index! + m[0].length);
      if (!tables.has(name)) {
        // Through an alias: an UPDATE's columns are read as for the table itself; a DELETE is another kind of write.
        if (verb === "UPDATE" || verb === "DELETE") {
          const via = new RegExp(`\\b(?:FROM|JOIN)\\s+\\[?([a-z_][a-z0-9_]*)\\]?(?:\\s+AS)?\\s+${name}\\b`, "i").exec(after);
          if (via && tables.has(via[1]!.toLowerCase())) {
            const table = via[1]!.toLowerCase();
            const set = verb === "UPDATE" ? /^\s*SET\b/i.exec(after) : null;
            const clause = set ? setClause(after.slice(set[0].length)) : null;
            const columns = clause === null ? null : setColumns(clause);
            if (columns) shape(table, file).updates.push(columns); else shape(table, file).other++;
          }
        }
        continue;
      }
      if (verb !== "UPDATE") { shape(name, file).other++; continue; }
      const set = /^\s*(?:WITH\s*\([^)]*\)\s*)?SET\b/i.exec(after);
      const clause = set ? setClause(after.slice(set[0].length)) : null;
      const columns = clause === null ? null : setColumns(clause);
      if (columns) shape(name, file).updates.push(columns); else shape(name, file).other++;
    }
  }
  return out;
}

/** Table -> the columns the migrations give it: those in its CREATE TABLE, and those added later with ALTER TABLE … ADD. */
export function migrationColumns(migrationsDir: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (t: string, c: string) => (out.get(t) ?? out.set(t, new Set()).get(t)!).add(c.toLowerCase());
  for (const f of readdirSync(migrationsDir).filter(n => n.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    for (const m of sql.matchAll(/CREATE TABLE \[?([a-z_0-9]+)\]? \(([\s\S]*?)\n\);/gi))
      for (const c of m[2]!.matchAll(/^\s*\[([a-z_0-9]+)\]\s/gim)) add(m[1]!.toLowerCase(), c[1]!);
    for (const m of sql.matchAll(/ALTER TABLE \[?([a-z_0-9]+)\]? ADD\s([\s\S]*?)(?:;|\nGO\b)/gi))
      for (const c of m[2]!.matchAll(/(?:^|,)\s*\[([a-z_0-9]+)\]\s/gim)) add(m[1]!.toLowerCase(), c[1]!);
  }
  return out;
}
