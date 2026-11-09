// The line along which a client's data would move to a database of its own (F21.R5, decision-log D62), held against the foreign keys the
// migrations actually create: every table is placed; the platform and the directory never depend on a client table; every client table
// leads back to its client; and each foreign key that would cross from a client database to the platform's is listed.
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_KEY_COLUMNS, CROSS_REFERENCES, TABLE_PLACEMENT } from "../src/db/client-data.js";
import { createPool, type Pool } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { migrationTables } from "./table-writes.js";

const server = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
let db: TestDatabase;
let owner: Pool;
let fks: { from: string; to: string }[];
let columns: Map<string, Set<string>>;

test.before(async () => {
  db = await createTestDatabase();
  // As the owner: the application's login cannot see every table (the audit chain's head is the procedures' alone).
  owner = await createPool(db.ownerUrl, { max: 1 });
  fks = (await owner.query<{ from: string; to: string }>(
    "SELECT DISTINCT OBJECT_NAME(parent_object_id) AS [from], OBJECT_NAME(referenced_object_id) AS [to] FROM sys.foreign_keys")).rows;
  columns = new Map();
  for (const r of (await owner.query<{ t: string; c: string }>("SELECT t.name AS t, c.name AS c FROM sys.tables t JOIN sys.columns c ON c.object_id = t.object_id")).rows)
    (columns.get(r.t) ?? columns.set(r.t, new Set()).get(r.t)!).add(r.c);
});
test.after(async () => { await owner?.end(); await db?.drop(); });

/** Which rules a placement map and its cross references break, given the schema's foreign keys and columns. */
function placementProblems(placement: Readonly<Record<string, string>>, crossRefs: readonly string[], fk: readonly { from: string; to: string }[], cols: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const out: string[] = [];
  const at = (t: string) => placement[t];
  const crossing = new Set<string>();
  for (const { from, to } of fk) {
    if (from === to) continue;
    if (at(from) !== "client" && at(to) === "client") out.push(`${from} (${at(from)}) has a foreign key to the client table ${to}`);
    if (at(from) === "client" && at(to) === "platform") crossing.add(`${from} -> ${to}`);
  }
  for (const c of [...crossing].filter(c => !crossRefs.includes(c)).sort()) out.push(`unlisted cross reference: ${c}`);
  for (const c of crossRefs.filter(c => !crossing.has(c))) out.push(`listed cross reference that no foreign key makes: ${c}`);
  // A client table leads back to its client: through foreign keys to the directory (or to another client table that does), or by a
  // column that names the cabinet, site or client.
  const leads = new Map<string, boolean>();
  const back = (t: string, seen: Set<string>): boolean => {
    if (at(t) === "directory") return true;
    if (at(t) !== "client" || seen.has(t)) return false;
    if (leads.has(t)) return leads.get(t)!;
    seen.add(t);
    const ok = CLIENT_KEY_COLUMNS.some(c => cols.get(t)?.has(c)) || fk.some(f => f.from === t && f.to !== t && back(f.to, seen));
    leads.set(t, ok);
    return ok;
  };
  for (const [t, p] of Object.entries(placement)) if (p === "client" && !back(t, new Set())) out.push(`${t} is placed with a client but nothing in it leads to one`);
  return out;
}

test("every table the migrations create is placed: platform, directory or client", () => {
  const tables = migrationTables(join(server, "migrations"));
  const missing = [...tables].filter(t => !TABLE_PLACEMENT[t]).sort();
  assert.deepEqual(missing, [], `place these in src/db/client-data.ts: ${missing.join(", ")}`);
  assert.deepEqual(Object.keys(TABLE_PLACEMENT).filter(t => !tables.has(t)).sort(), [], "no migration creates these");
  // The migration runner's own record (migrate.ts) is in every database, each with its own; it is nobody's data.
  for (const t of columns.keys()) if (t !== "schema_migrations") assert.ok(TABLE_PLACEMENT[t], `${t} is in the database but not placed`);
});

test("the platform and the directory depend on no client table, every client table leads to its client, and every crossing is listed", () => {
  assert.deepEqual(placementProblems(TABLE_PLACEMENT, CROSS_REFERENCES, fks, columns), []);
});

test("the rules catch a wrong placement, an unlisted crossing, a stale listing and a client table that leads nowhere", () => {
  // events placed with the platform: its foreign keys to alerts (a client table) would make the platform depend on a client.
  assert.ok(placementProblems({ ...TABLE_PLACEMENT, events: "platform" }, CROSS_REFERENCES, fks, columns).some(p => p.startsWith("events (platform) has a foreign key")));
  // users placed with a client: every crossing to it changes, and users leads to no client.
  const users = placementProblems({ ...TABLE_PLACEMENT, users: "client" }, CROSS_REFERENCES, fks, columns);
  assert.ok(users.some(p => p.includes("users is placed with a client but nothing in it leads to one")), users.join("\n"));
  assert.ok(users.some(p => p.startsWith("listed cross reference that no foreign key makes: alerts -> users")));
  // A new foreign key from a client table to the platform, not listed.
  assert.deepEqual(placementProblems(TABLE_PLACEMENT, CROSS_REFERENCES, [...fks, { from: "events", to: "issue_types" }], columns), ["unlisted cross reference: events -> issue_types"]);
  // A table named in the placement that has no key column and no foreign key.
  assert.deepEqual(placementProblems({ ...TABLE_PLACEMENT, orphan_rows: "client" }, CROSS_REFERENCES, fks, columns), ["orphan_rows is placed with a client but nothing in it leads to one"]);
});
