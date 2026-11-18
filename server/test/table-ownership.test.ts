// Module boundaries, enforced (F21.R2, decision-log D56): every table has one owning module, written down in src/db/table-owners.ts with
// today's other writers listed as debt. This test reads the source and fails on a write nobody listed, on a listed write that is gone
// (the debt was paid; the list shrinks with it), and on a table with no owner. A setting column may be owned by its feature module instead
// (D118): a file whose every write of a table is a plain UPDATE of columns it owns there is not debt. No database is needed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCEPTED_WRITERS, RUNTIME_TABLE_WRITES, TABLE_OWNERS } from "../src/db/table-owners.js";
import { migrationColumns, migrationTables, runtimeTableWrites, setClause, setColumns, tableWriteShapes, tableWriters } from "./table-writes.js";

// dist/test/ -> server/
const server = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tables = migrationTables(join(server, "migrations"));
const literal = tableWriters(join(server, "src"), tables);
const runtime = runtimeTableWrites(join(server, "src"));
const shapes = tableWriteShapes(join(server, "src"), tables);
const columnsOf = migrationColumns(join(server, "migrations"));
/**
 * Whether a file writes a table only as the owner of the columns it sets (D118): every write it makes of the table is a plain UPDATE
 * (no INSERT, DELETE, MERGE, unreadable SET or run-time table name), and every column each one sets is declared as that file's.
 */
const coveredByColumns = (table: string, file: string): boolean => {
  const columns = TABLE_OWNERS[table]?.columns ?? {};
  const w = shapes.get(table)?.get(file);
  if (!w || w.other > 0 || w.updates.length === 0 || (RUNTIME_TABLE_WRITES[file] ?? []).includes(table)) return false;
  return w.updates.every(u => u.every(c => columns[c] === file));
};
/** Every write: the ones the reader sees by name, and the ones a file declares for its run-time table names. */
const writers = new Map([...literal].map(([t, f]) => [t, new Set(f)]));
for (const [file, list] of Object.entries(RUNTIME_TABLE_WRITES))
  for (const t of list) (writers.get(t) ?? writers.set(t, new Set()).get(t)!).add(file);

test("every table the migrations create names its owning module", () => {
  const missing = [...tables].filter(t => !TABLE_OWNERS[t]).sort();
  assert.deepEqual(missing, [], `name an owner in src/db/table-owners.ts for: ${missing.join(", ")}`);
  const gone = Object.keys(TABLE_OWNERS).filter(t => !tables.has(t)).sort();
  assert.deepEqual(gone, [], `no migration creates: ${gone.join(", ")}`);
});

test("a write whose table is built at run time is declared, with the tables it can write, and a declaration nothing needs comes off", () => {
  const undeclared = [...runtime.keys()].filter(f => !RUNTIME_TABLE_WRITES[f]).sort();
  assert.deepEqual(undeclared, [], `these files write a table named at run time; declare its tables in RUNTIME_TABLE_WRITES: ${undeclared.join(", ")}`);
  const stale = Object.keys(RUNTIME_TABLE_WRITES).filter(f => !runtime.has(f)).sort();
  assert.deepEqual(stale, [], `no run-time table write is left in: ${stale.join(", ")}`);
  for (const [file, list] of Object.entries(RUNTIME_TABLE_WRITES)) for (const t of list) assert.ok(tables.has(t), `${file} declares ${t}, which no migration creates`);
});

test("no file writes a table it does not own unless the debt list names it", () => {
  const unlisted: string[] = [];
  for (const [table, files] of writers) {
    const o = TABLE_OWNERS[table]!;
    for (const f of files) if (f !== o.owner && !o.also.includes(f) && !(o.accepted ?? []).includes(f) && !coveredByColumns(table, f)) unlisted.push(`${f} writes ${table} (owned by ${o.owner})`);
  }
  assert.deepEqual(unlisted.sort(), [], "a new write across a module boundary: go through the owning module, or list it as debt with a reason in D56");
});

test("the debt list shrinks: a listed writer that no longer writes the table must come off it, and every owner writes its table", () => {
  const stale: string[] = [];
  for (const [table, o] of Object.entries(TABLE_OWNERS)) {
    const files = writers.get(table) ?? new Set<string>();
    for (const f of [...o.also, ...(o.accepted ?? [])]) if (!files.has(f)) stale.push(`${f} no longer writes ${table}`);
    // A debt entry the file's own columns now cover was paid: it comes off (D118).
    for (const f of o.also) if (coveredByColumns(table, f)) stale.push(`${f} writes ${table} only through the columns it owns; take it off the debt list`);
    if (files.size > 0 && !files.has(o.owner)) stale.push(`${o.owner} owns ${table} but does not write it`);
  }
  assert.deepEqual(stale.sort(), []);
});

test("a column owner owns a column the table has, writes it, and is not the table's owner or an accepted writer (D118)", () => {
  const problems: string[] = [];
  for (const [table, o] of Object.entries(TABLE_OWNERS)) for (const [column, file] of Object.entries(o.columns ?? {})) {
    if (!columnsOf.get(table)?.has(column)) problems.push(`${table}.${column} is not a column the migrations create`);
    if (file === o.owner) problems.push(`${file} owns ${table}; it needs no column of it declared`);
    if ((o.accepted ?? []).includes(file)) problems.push(`${file} is accepted for ${table}; an accepted writer owns no column`);
    if (!(shapes.get(table)?.get(file)?.updates ?? []).some(u => u.includes(column))) problems.push(`${file} owns ${table}.${column} but never sets it`);
  }
  assert.deepEqual(problems.sort(), []);
});

test("a column owner that sets another feature's column, or writes its table any other way, is not covered by its columns (D118)", () => {
  // Every covered file sets only its own columns and writes the table no other way; a file that does more is debt or unlisted.
  const covered: string[] = [];
  for (const [table, o] of Object.entries(TABLE_OWNERS)) for (const file of new Set(Object.values(o.columns ?? {}))) if (coveredByColumns(table, file)) covered.push(`${table} ${file}`);
  assert.deepEqual(covered.sort(), [
    "cabinets services/rollouts.ts", "cabinets services/settings.ts", "cabinets services/sync-cabinets.ts",
    "clients services/firewall-policy.ts", "clients services/time.ts", "clients services/writes.ts",
    "sites services/firewall-policy.ts", "sites services/network-baseline.ts", "sites services/settings.ts", "sites services/time.ts",
  ], "the files each table's columns cover; a change here is a change to what counts as debt");
});

test("an accepted writer has its reason, a reason no table uses comes off, and no file is both debt and accepted (D108)", () => {
  const used = new Set<string>();
  const problems: string[] = [];
  for (const [table, o] of Object.entries(TABLE_OWNERS)) for (const f of o.accepted ?? []) {
    used.add(f);
    if (!ACCEPTED_WRITERS[f]?.trim()) problems.push(`${f} is accepted for ${table} without a reason in ACCEPTED_WRITERS`);
    if (o.also.includes(f)) problems.push(`${f} is both debt and accepted for ${table}`);
    if (f === o.owner) problems.push(`${f} owns ${table}; an owner is not accepted, it owns`);
  }
  for (const f of Object.keys(ACCEPTED_WRITERS)) if (!used.has(f)) problems.push(`${f} has a reason in ACCEPTED_WRITERS but no table accepts it`);
  assert.deepEqual(problems.sort(), []);
});

test("the reader finds writes however they are spelled, through an alias too, and nothing that only reads", () => {
  const root = mkdtempSync(join(tmpdir(), "owners-"));
  mkdirSync(join(root, "src", "services"), { recursive: true });
  writeFileSync(join(root, "src", "services", "a.ts"), [
    "db.query(`INSERT INTO alerts (id) VALUES ($1)`);",
    "db.query(`UPDATE p SET resolved_at = SYSUTCDATETIME() FROM fleet_patterns p WHERE p.id = $1`);",
    "db.query(`DELETE d FROM cabinet_drift d WHERE d.cabinet_id = $1`);",
    "db.query(`MERGE [job_leases] WITH (HOLDLOCK) AS t USING (SELECT 1 AS x) s ON 1 = 0 WHEN NOT MATCHED THEN INSERT (name) VALUES ('x');`);",
    "db.query(`SELECT * FROM users u JOIN sessions s ON s.user_id = u.id`);",
    "db.query(`UPDATE ${TABLE[level]} SET name = $2 WHERE id = $1`);",
    "db.query(`DELETE FROM ${table} WHERE cabinet_id = $1`);",
    // A row limit between the verb and the table, as the retention sweeps write (review of #224).
    "db.query(\"DELETE TOP ($1) FROM cabinets WHERE id IS NOT NULL\");",
    "db.query(`UPDATE TOP (500) incidents SET state = 'closed' WHERE id = $1`);",
    "db.query(`UPDATE TOP ($1) e SET alert_id = NULL FROM events e JOIN alerts a ON a.id = e.alert_id`);",
    "db.query(`DELETE TOP ( 100 ) ${TABLE[level]} WHERE id = $1`);",
  ].join("\n"));
  const found = tableWriters(join(root, "src"), new Set(["alerts", "fleet_patterns", "cabinet_drift", "job_leases", "users", "sessions", "cabinets", "incidents", "events"]));
  assert.deepEqual([...found.keys()].sort(), ["alerts", "cabinet_drift", "cabinets", "events", "fleet_patterns", "incidents", "job_leases"]);
  assert.deepEqual([...found.get("alerts")!], ["services/a.ts"]);
  assert.deepEqual([...runtimeTableWrites(join(root, "src"))], [["services/a.ts", 3]], "the three writes through a table named at run time are seen, one with a row limit");
  // The columns an UPDATE sets, as the column rule reads them (D118).
  writeFileSync(join(root, "src", "services", "b.ts"), [
    "db.query(\"UPDATE sites SET time_zone = $2 OUTPUT deleted.time_zone AS old WHERE id = $1\");",
    "db.query(`UPDATE cabinets WITH (ROWLOCK) SET [model] = COALESCE($3, model), manufacturer = COALESCE($2, manufacturer) WHERE id = $1`);",
    "db.query(`UPDATE k SET k.sync_cabinet_id = $2 FROM cabinets k WHERE k.id = $1`);",
    "db.query(`INSERT INTO sites (id, name) VALUES ($1, $2)`);",
    "db.query(`DELETE d FROM cabinets d WHERE d.id = $1`);",
    "db.query(`UPDATE sites SET ${column} = $2 WHERE id = $1`);",
    // A subquery in the SET: its own FROM and WHERE do not end the clause, so the assignment after it is still read (review of #313).
    "db.query(`UPDATE clients SET time_zone = (SELECT TOP 1 tz FROM sites WHERE id = $1), manufacturer = $2 WHERE id = $3`);",
  ].join("\n"));
  const shaped = tableWriteShapes(join(root, "src"), new Set(["sites", "cabinets", "clients"]));
  assert.deepEqual(shaped.get("sites")!.get("services/b.ts"), { updates: [["time_zone"]], other: 2 }, "an INSERT and a SET built at run time are other writes");
  assert.deepEqual(shaped.get("clients")!.get("services/b.ts"), { updates: [["time_zone", "manufacturer"]], other: 0 }, "a subquery's FROM and WHERE do not hide the assignment after it");
  for (const [text, clause] of [[" a = 1 WHERE id = $1", " a = 1 "], [" a = (SELECT x FROM t WHERE y = 1), b = 2 WHERE id = $1", " a = (SELECT x FROM t WHERE y = 1), b = 2 "],
    [" a = 1 OUTPUT inserted.a", " a = 1 "], [" a = (SELECT x FROM t", null], [" a = (1", null], [" fromage = 1 WHERE id = $1", " fromage = 1 "]] as const)
    assert.deepEqual(setClause(text), clause, text);
  assert.deepEqual(shaped.get("cabinets")!.get("services/b.ts"), { updates: [["model", "manufacturer"], ["sync_cabinet_id"]], other: 1 }, "a comma inside a call does not split; an alias's columns are read; a DELETE is another write");
  for (const [clause, columns] of [[" a = 1, [b] = COALESCE(x, y) ", ["a", "b"]], [" k.a = 1 ", ["a"]], [" a = 1, b ", null], ["", null], [" = 1 ", null]] as const)
    assert.deepEqual(setColumns(clause), columns, clause);
});
