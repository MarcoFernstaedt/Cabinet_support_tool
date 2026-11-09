// Module boundaries, enforced (F21.R2, decision-log D56): every table has one owning module, written down in src/db/table-owners.ts with
// today's other writers listed as debt. This test reads the source and fails on a write nobody listed, on a listed write that is gone
// (the debt was paid; the list shrinks with it), and on a table with no owner. No database is needed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_TABLE_WRITES, TABLE_OWNERS } from "../src/db/table-owners.js";
import { migrationTables, runtimeTableWrites, tableWriters } from "./table-writes.js";

// dist/test/ -> server/
const server = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tables = migrationTables(join(server, "migrations"));
const literal = tableWriters(join(server, "src"), tables);
const runtime = runtimeTableWrites(join(server, "src"));
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
    for (const f of files) if (f !== o.owner && !o.also.includes(f)) unlisted.push(`${f} writes ${table} (owned by ${o.owner})`);
  }
  assert.deepEqual(unlisted.sort(), [], "a new write across a module boundary: go through the owning module, or list it as debt with a reason in D56");
});

test("the debt list shrinks: a listed writer that no longer writes the table must come off it, and every owner writes its table", () => {
  const stale: string[] = [];
  for (const [table, o] of Object.entries(TABLE_OWNERS)) {
    const files = writers.get(table) ?? new Set<string>();
    for (const f of o.also) if (!files.has(f)) stale.push(`${f} no longer writes ${table}`);
    if (files.size > 0 && !files.has(o.owner)) stale.push(`${o.owner} owns ${table} but does not write it`);
  }
  assert.deepEqual(stale.sort(), []);
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
  ].join("\n"));
  const found = tableWriters(join(root, "src"), new Set(["alerts", "fleet_patterns", "cabinet_drift", "job_leases", "users", "sessions"]));
  assert.deepEqual([...found.keys()].sort(), ["alerts", "cabinet_drift", "fleet_patterns", "job_leases"]);
  assert.deepEqual([...found.get("alerts")!], ["services/a.ts"]);
  assert.deepEqual([...runtimeTableWrites(join(root, "src"))], [["services/a.ts", 2]], "the two writes through a table named at run time are seen");
});
