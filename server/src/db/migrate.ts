// Versioned migrations from server/migrations, applied in order, each in its own
// transaction. A migration that was already applied may never change: its
// checksum is recorded and checked on every run.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");

export interface Migration { version: string; checksum: string; sql: string; }

export function readMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir).filter(f => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort().map(file => {
    const sql = readFileSync(join(dir, file), "utf8");
    return { version: file.slice(0, -4), checksum: createHash("sha256").update(sql).digest("hex"), sql };
  });
}

export async function migrate(client: pg.Client, migrations = readMigrations()): Promise<string[]> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  await client.query("SELECT pg_advisory_lock(727274)"); // one migrator at a time
  try {
    const applied = new Map((await client.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations")).rows.map(r => [r.version, r.checksum]));
    for (const [version] of applied)
      if (!migrations.some(m => m.version === version)) throw new Error(`Migration ${version} was applied but its file is missing.`);
    const ran: string[] = [];
    for (const m of migrations) {
      const recorded = applied.get(m.version);
      if (recorded !== undefined) {
        if (recorded !== m.checksum) throw new Error(`Migration ${m.version} was changed after it was applied. Add a new migration instead.`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [m.version, m.checksum]);
        await client.query("COMMIT");
        ran.push(m.version);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)");
  }
}
