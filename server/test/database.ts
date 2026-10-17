// A fresh database per test file on a real SQL Server, migrated by the owner account (sa in tests), used through
// a login that has only the cabinet_app role (as in production).
import { randomBytes } from "node:crypto";
import sql from "mssql";
import { migrate, connectOwner } from "../src/db/migrate.js";
import { createPool, Pool } from "../src/db/db.js";

export const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "sqlserver://sa:Dev-Only-Pass-1%21@localhost:1433/master?trustServerCertificate=true";
const APP_USER = "cabinet_app_test";
const APP_PASSWORD = "test-only-not-a-secret";

export interface TestDatabase { name: string; ownerUrl: string; appUrl: string; app: Pool; drop(): Promise<void>; }

function urlFor(base: string, database: string, user?: string, password?: string): string {
  const u = new URL(base);
  u.pathname = "/" + database;
  if (user) { u.username = user; u.password = encodeURIComponent(password ?? ""); }
  return u.toString();
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = "cabinet_test_" + randomBytes(6).toString("hex");
  const admin = await connectOwner(ADMIN_URL);
  await admin.request().query(`CREATE DATABASE ${name}`);
  await admin.request().query(`IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = '${APP_USER}') CREATE LOGIN ${APP_USER} WITH PASSWORD = '${APP_PASSWORD}', CHECK_POLICY = OFF`);
  await admin.close();
  const ownerUrl = urlFor(ADMIN_URL, name);
  const owner = await connectOwner(ownerUrl);
  await migrate(owner);
  await owner.request().query(`CREATE USER ${APP_USER} FOR LOGIN ${APP_USER}; ALTER ROLE cabinet_app ADD MEMBER ${APP_USER}`);
  await owner.close();
  const appUrl = urlFor(ADMIN_URL, name, APP_USER, APP_PASSWORD);
  const app = await createPool(appUrl);
  return {
    name, ownerUrl, appUrl, app,
    async drop() {
      await app.end();
      const c = await connectOwner(ADMIN_URL);
      await c.request().query(`IF DB_ID('${name}') IS NOT NULL BEGIN ALTER DATABASE ${name} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${name}; END`);
      await c.close();
    },
  };
}

/** Runs fn with a connection as the database owner (for backdating rows and tampering that the application's account cannot do). */
export async function asOwner<T>(db: TestDatabase, fn: (c: Pool) => Promise<T>): Promise<T> {
  const pool = await createPool(db.ownerUrl, 2);
  try { return await fn(pool); } finally { await pool.end(); }
}

export type { sql };
