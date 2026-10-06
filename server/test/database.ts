// A fresh database per test file, migrated by the owner account, used through
// a login account that has only the cabinet_app role (as in production).
import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/db.js";

export const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://platform_owner:dev-only-local@localhost:5432/postgres";
const APP_USER = "cabinet_app_test";
const APP_PASSWORD = "test-only-not-a-secret";

export interface TestDatabase { name: string; ownerUrl: string; appUrl: string; app: pg.Pool; drop(): Promise<void>; }

function urlFor(base: string, database: string, user?: string, password?: string): string {
  const u = new URL(base);
  u.pathname = "/" + database;
  if (user) { u.username = user; u.password = password ?? ""; }
  return u.toString();
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = "cabinet_test_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const ownerUrl = urlFor(ADMIN_URL, name);
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  await migrate(owner);
  await owner.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_USER}') THEN CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASSWORD}'; END IF;
    END $$`);
  await owner.query(`GRANT cabinet_app TO ${APP_USER}`);
  await owner.query(`GRANT CONNECT ON DATABASE ${name} TO ${APP_USER}`);
  await owner.end();
  const appUrl = urlFor(ADMIN_URL, name, APP_USER, APP_PASSWORD);
  const app = createPool(appUrl);
  return {
    name, ownerUrl, appUrl, app,
    async drop() {
      await app.end();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export async function asOwner<T>(db: TestDatabase, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: db.ownerUrl });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
