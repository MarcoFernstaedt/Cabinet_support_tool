// Prepares the SQL Server database for the platform (docs/platform/sqlserver-port.md). Run by the one-shot `migrate` service, as the
// database owner (sa), in two steps around the migrations:
//   node database-setup.mjs create   creates the database (case-insensitive collation, row versioning is switched on by the migrator)
//   node database-setup.mjs login    creates or updates cabinet_app_login, a member of cabinet_app and nothing else
// Idempotent: running either again changes nothing, except that `login` resets the password to APP_DB_PASSWORD.
//
// Reads DATABASE_OWNER_URL (sqlserver://sa:…@mssql:1433/cabinet) and, for `login`, APP_DB_PASSWORD. Never prints a password.
import { createRequire } from "node:module";

// The server package sits next to this folder, in the image (/opt/cabinet) and in a checkout.
const mssql = createRequire(new URL("../server/package.json", import.meta.url))("mssql");

const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) throw new Error("DATABASE_OWNER_URL must be set.");
const step = process.argv[2];
if (step !== "create" && step !== "login") throw new Error("Usage: database-setup.mjs create|login");

const url = new URL(ownerUrl);
const database = decodeURIComponent(url.pathname.slice(1));
if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(database)) throw new Error("The database name must be letters, digits and underscores.");
const LOGIN = "cabinet_app_login";

const connect = async (name) => new mssql.ConnectionPool({
  server: decodeURIComponent(url.hostname), port: Number(url.port || 1433), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: name,
  options: { encrypt: url.searchParams.get("encrypt") !== "false", trustServerCertificate: url.searchParams.get("trustServerCertificate") === "true" },
}).connect();

if (step === "create") {
  const pool = await connect("master");
  try {
    await pool.request().input("name", mssql.NVarChar(128), database)
      .query(`IF DB_ID(@name) IS NULL BEGIN DECLARE @sql nvarchar(400) = N'CREATE DATABASE ' + QUOTENAME(@name) + N' COLLATE Latin1_General_100_CI_AS_SC'; EXEC (@sql); END`);
    // SIMPLE recovery: the log is reused after each checkpoint instead of growing until a log backup that Express cannot schedule.
    // Recovery point is the nightly full backup (deploy/backup.sh). The log starts at 1 GB and grows in 256 MB steps.
    await pool.request().input("name", mssql.NVarChar(128), database).query(`
      DECLARE @sql nvarchar(800) = N'ALTER DATABASE ' + QUOTENAME(@name) + N' SET RECOVERY SIMPLE; ALTER DATABASE ' + QUOTENAME(@name) + N' SET PAGE_VERIFY CHECKSUM;';
      EXEC (@sql);
      DECLARE @log sysname = (SELECT name FROM sys.master_files WHERE database_id = DB_ID(@name) AND type = 1);
      IF (SELECT size FROM sys.master_files WHERE database_id = DB_ID(@name) AND type = 1) < 131072
      BEGIN SET @sql = N'ALTER DATABASE ' + QUOTENAME(@name) + N' MODIFY FILE (NAME = ' + QUOTENAME(@log) + N', SIZE = 1024MB, FILEGROWTH = 256MB)'; EXEC (@sql); END`);
    console.log(`Database ${database} is ready.`);
  } finally { await pool.close(); }
} else {
  const password = process.env.APP_DB_PASSWORD;
  // The password goes into DATABASE_URL and into DDL (which takes no parameters), so it is limited to letters and digits.
  if (!password || !/^[A-Za-z0-9]{24,128}$/.test(password)) throw new Error("APP_DB_PASSWORD must be 24 to 128 letters and digits.");
  const master = await connect("master");
  let existed;
  try {
    existed = (await master.request().query(`SELECT 1 AS x FROM sys.server_principals WHERE name = '${LOGIN}'`)).recordset.length === 1;
    await master.request().query(`${existed ? "ALTER" : "CREATE"} LOGIN ${LOGIN} ${existed ? "WITH PASSWORD" : "WITH PASSWORD"} = N'${password}'${existed ? "" : ", CHECK_POLICY = ON, DEFAULT_DATABASE = [" + database + "]"}`);
  } finally { await master.close(); }
  const db = await connect(database);
  try {
    await db.request().query(`IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = '${LOGIN}') CREATE USER ${LOGIN} FOR LOGIN ${LOGIN}`);
    await db.request().query(`IF IS_ROLEMEMBER('cabinet_app', '${LOGIN}') = 0 ALTER ROLE cabinet_app ADD MEMBER ${LOGIN}`);
  } finally { await db.close(); }
  console.log(`${LOGIN} ${existed ? "updated" : "created"}; member of cabinet_app.`);
}
