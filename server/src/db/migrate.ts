// Versioned migrations from server/migrations, applied in order, each in its own
// transaction. A migration that was already applied may never change: its
// checksum is recorded and checked on every run. A file is split into batches
// at lines that read GO (CREATE PROCEDURE and friends must start a batch).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { parseDatabaseUrl } from "./db.js";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");

export interface Migration { version: string; checksum: string; sql: string; }

export function readMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir).filter(f => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort().map(file => {
    const text = readFileSync(join(dir, file), "utf8");
    return { version: file.slice(0, -4), checksum: createHash("sha256").update(text).digest("hex"), sql: text };
  });
}

export function batches(text: string): string[] {
  return text.split(/^\s*GO\s*$/gim).map(b => b.trim()).filter(b => b.length > 0);
}

/** The owner's connection (it may create tables and roles). */
export async function connectOwner(url: string): Promise<sql.ConnectionPool> {
  return new sql.ConnectionPool({ ...parseDatabaseUrl(url), pool: { max: 1, min: 1 }, requestTimeout: 120_000 }).connect();
}

/**
 * A failed migration leaves an operations alert for the Admins (best effort: it needs the security alerts table and the widened kind rule,
 * so it cannot be raised when the failing migration is one of the first). The alert names the migration, never the error text.
 */
export async function alertMigrationFailed(pool: sql.ConnectionPool, version: string): Promise<boolean> {
  const title = `Database migration ${version} failed; the database stays at the previous version`;
  try {
    const r = await pool.request().input("t", sql.NVarChar(256), title).input("d", sql.VarChar(sql.MAX), JSON.stringify({ version })).query(
      `UPDATE security_alerts SET occurrences = occurrences + 1, last_seen = SYSUTCDATETIME(), title = @t, detail = @d WHERE signature = 'ops:migration' AND state = 'open';
       IF @@ROWCOUNT = 0 INSERT INTO security_alerts (kind, signature, title, detail) VALUES ('ops_migration', 'ops:migration', @t, @d);`);
    return r.rowsAffected.length > 0;
  } catch { return false; }
}

export async function migrate(pool: sql.ConnectionPool, migrations = readMigrations()): Promise<string[]> {
  // Readers must not block writers: row versioning gives each statement a consistent snapshot, as PostgreSQL does.
  await pool.request().query("IF (SELECT is_read_committed_snapshot_on FROM sys.databases WHERE name = DB_NAME()) = 0 ALTER DATABASE CURRENT SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE");
  await pool.request().query(`IF OBJECT_ID('schema_migrations') IS NULL CREATE TABLE schema_migrations (version nvarchar(100) PRIMARY KEY, checksum char(64) NOT NULL, applied_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME())`);
  await pool.request().query("DECLARE @r int; EXEC @r = sp_getapplock @Resource = 'cabinet-migrations', @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 60000; IF @r < 0 THROW 50001, 'another migration is running', 1;");
  try {
    const applied = new Map((await pool.request().query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations")).recordset.map(r => [r.version, r.checksum]));
    for (const [version] of applied)
      if (!migrations.some(m => m.version === version)) throw new Error(`Migration ${version} was applied but its file is missing.`);
    const ran: string[] = [];
    for (const m of migrations) {
      const recorded = applied.get(m.version);
      if (recorded !== undefined) {
        if (recorded !== m.checksum) throw new Error(`Migration ${m.version} was changed after it was applied. Add a new migration instead.`);
        continue;
      }
      const t = new sql.Transaction(pool);
      await t.begin();
      try {
        for (const batch of batches(m.sql)) await new sql.Request(t).query(batch);
        await new sql.Request(t).input("v", sql.NVarChar(100), m.version).input("c", sql.Char(64), m.checksum).query("INSERT INTO schema_migrations (version, checksum) VALUES (@v, @c)");
        await t.commit();
        ran.push(m.version);
      } catch (e) {
        await t.rollback().catch(() => undefined);
        await alertMigrationFailed(pool, m.version);
        throw new Error(`Migration ${m.version} failed: ${(e as Error).message}`);
      }
    }
    return ran;
  } finally {
    await pool.request().query("EXEC sp_releaseapplock @Resource = 'cabinet-migrations', @LockOwner = 'Session'").catch(() => undefined);
  }
}
