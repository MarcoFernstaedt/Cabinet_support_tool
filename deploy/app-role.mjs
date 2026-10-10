// Creates (or updates) the application's least-privilege database login: cabinet_app_login, a member of cabinet_app
// and nothing else (server/README.md "Run it locally"). Run by the one-shot `migrate` service, after the migrations,
// as the database owner. Idempotent: running it again only resets the password to APP_DB_PASSWORD.
//
// Reads DATABASE_OWNER_URL and APP_DB_PASSWORD from the environment. Never prints the password.
import { createRequire } from "node:module";

const pg = createRequire("/opt/cabinet/server/package.json")("pg");

const ownerUrl = process.env.DATABASE_OWNER_URL;
const password = process.env.APP_DB_PASSWORD;
if (!ownerUrl) throw new Error("DATABASE_OWNER_URL must be set.");
// The password goes into DATABASE_URL, so it is limited to characters that need no URL escaping.
if (!password || !/^[A-Za-z0-9]{24,128}$/.test(password)) throw new Error("APP_DB_PASSWORD must be 24 to 128 letters and digits.");

const ROLE = "cabinet_app_login";
const client = new pg.Client({ connectionString: ownerUrl });
await client.connect();
try {
  const exists = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE])).rowCount === 1;
  // DDL takes no bind parameters, so the server quotes the password itself (format %L), never string concatenation here.
  const verb = exists ? "ALTER" : "CREATE";
  const statement = (await client.query(
    `SELECT format('${verb} ROLE ${ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text) AS sql`,
    [password])).rows[0].sql;
  await client.query(statement);
  await client.query(`GRANT cabinet_app TO ${ROLE}`);
  console.log(`${ROLE} ${exists ? "updated" : "created"}; member of cabinet_app.`);
} finally {
  await client.end();
}
