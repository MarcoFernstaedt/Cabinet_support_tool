// Runs one SQL statement as the database owner and prints the first column of every row, one per line (CI checks and fixtures).
// Reads DATABASE_OWNER_URL. The statement comes from the command line, never from untrusted input.
import { createRequire } from "node:module";

const mssql = createRequire(new URL("../server/package.json", import.meta.url))("mssql");
const statement = process.argv[2];
const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!statement || !ownerUrl) throw new Error("Usage: DATABASE_OWNER_URL=… node sql-query.mjs \"<statement>\"");
const url = new URL(ownerUrl);
const pool = await new mssql.ConnectionPool({
  server: decodeURIComponent(url.hostname), port: Number(url.port || 1433), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  database: decodeURIComponent(url.pathname.slice(1)) || "master",
  options: { encrypt: url.searchParams.get("encrypt") !== "false", trustServerCertificate: url.searchParams.get("trustServerCertificate") === "true" },
}).connect();
try {
  const result = await pool.request().query(statement);
  for (const row of result.recordset ?? []) console.log(String(Object.values(row)[0] ?? ""));
} finally { await pool.close(); }
