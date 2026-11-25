// Every migration file is immutable once it can have been applied. migrate.ts records each file's
// sha256 in schema_migrations and refuses to start when a recorded version's file changed or went
// missing ("Migration 0010_missing_objects was changed after it was applied. Add a new migration
// instead."). That refusal only fires on a database that already applied the file, so a fresh test
// database and CI both pass — the deployment is where it bites. D151: this test holds the same
// hashes, so an edit to an applied migration fails review instead of a cabinet's server.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_DIR, readMigrations } from "../src/db/migrate.js";

const MANIFEST = join(MIGRATIONS_DIR, "checksums.json");

test("no migration file changed, vanished or arrived unrecorded", () => {
  const recorded: Record<string, string> = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const files = readMigrations();
  const changed = files.filter(m => recorded[m.version] !== undefined && recorded[m.version] !== m.checksum).map(m => m.version);
  const added = files.filter(m => recorded[m.version] === undefined).map(m => m.version);
  const gone = Object.keys(recorded).filter(v => !files.some(m => m.version === v));
  assert.deepEqual(changed, [], "an applied migration may not change — add a new migration instead");
  assert.deepEqual(added, [], "a new migration needs its hash recorded: node scripts/write-migration-checksums.mjs");
  assert.deepEqual(gone, [], "a migration file was deleted — migrate.ts refuses to start on any database that applied it");
});