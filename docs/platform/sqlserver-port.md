# Microsoft SQL Server: how the platform talks to its database

The platform database is **Microsoft SQL Server 2022** (decision of the owner, October 2026; it replaces the PostgreSQL the first milestones used).
Nothing had been deployed on PostgreSQL, so `server/migrations/0001_baseline.sql` is one consolidated T-SQL schema, not a translation of the 25 old migrations.

## The data layer (`server/src/db/db.ts`)

- `createPool(url)` returns a `Pool`. The URL is `sqlserver://user:password@host:1433/database?encrypt=true&trustServerCertificate=false`.
- `pool.query(sql, params)` and `tx.query(sql, params)` take `$1`, `$2` placeholders (turned into `@p1`, `@p2`) and return `{ rows, rowCount }`.
- `transaction(pool, async tx => …)` runs one transaction. A deadlock victim is run again (up to 3 times), so the function must change nothing outside the database.
- `lock(tx, name)` serializes a section by name until the transaction ends (it replaces PostgreSQL advisory locks).
- `notify(tx, channel, payload)` writes a row to the `notifications` table; triggers do the same for new commands, command results and alert changes. Server processes poll the table (`src/db/notifications.ts`).
- `isUniqueViolation(e)`, `isConstraintViolation(e)`, `isDeadlock(e)` replace PostgreSQL error codes.
- `audit(tx, entry)` calls the `audit_append` procedure. The application's role cannot write the audit tables itself.

What the layer does for the rest of the code, so the rest need not think about it:

- JavaScript values become fixed SQL types: strings `nvarchar`, integers `int` or `bigint`, numbers with a fraction `float`, booleans `bit`, `Date` `datetime2(3)`, `Buffer` `varbinary`, objects and arrays JSON text.
- GUIDs come back in lower case. Columns listed in `src/db/json-columns.ts` come back parsed (objects and arrays; `value` any JSON).
- `bigint` columns come back as strings (as before); `int` as numbers.

## Schema conventions

| PostgreSQL | SQL Server |
|---|---|
| `uuid` | `uniqueidentifier` (`DEFAULT NEWID()`) |
| `text` | `nvarchar(n)`; indexed or constrained columns are bounded (at most 450), others `nvarchar(max)` |
| `timestamptz` | `datetime2(3)`, always UTC (`SYSUTCDATETIME()`); the audit time is `datetime2(6)` |
| `boolean` | `bit` |
| `jsonb` | `nvarchar(max)` with `CHECK (ISJSON(col) = 1)` |
| `text[]`, `integer[]`, `uuid[]` | JSON array in `nvarchar(max)` |
| `bytea` | `varbinary(n)` |
| `bigserial` | `bigint IDENTITY` |
| partial index `WHERE …` | filtered index (no `OR`, no computed columns in the filter) |
| regular expression `CHECK` | `LIKE` pattern with a binary collation |

Reserved words used as column names must be bracketed in queries: `[key]` (issue_types, settings), and when in doubt `[at]`, `[match]`, `[before]`, `[after]`, `[value]`, `[user]`.

The database must use a case-insensitive collation (the SQL Server default `SQL_Latin1_General_CP1_CI_AS` is fine). Row versioning (`READ_COMMITTED_SNAPSHOT`) is switched on by the migrator so readers never block writers.

## Rewrite cookbook (PostgreSQL → T-SQL)

| PostgreSQL | T-SQL |
|---|---|
| `now()` | `SYSUTCDATETIME()` |
| `now() - interval '10 minutes'` | `DATEADD(minute, -10, SYSUTCDATETIME())`; with a parameter `DATEADD(second, -$1, SYSUTCDATETIME())` |
| `extract(epoch from (a - b))` | `DATEDIFF_BIG(millisecond, b, a) / 1000.0` |
| `LIMIT n` / `OFFSET m` | `TOP (n)`; or `ORDER BY … OFFSET m ROWS FETCH NEXT n ROWS ONLY` |
| `INSERT … RETURNING x` | `INSERT … OUTPUT inserted.x …` |
| a statement with `OUTPUT` on `commands`, `alerts` (they have triggers) | `DECLARE @o TABLE (…); … OUTPUT inserted.x INTO @o …; SELECT x FROM @o;` |
| `ON CONFLICT (k) DO UPDATE` | `MERGE t WITH (HOLDLOCK) USING (SELECT …) s ON … WHEN MATCHED THEN UPDATE … WHEN NOT MATCHED THEN INSERT …;` (the semicolon is required) |
| `ON CONFLICT DO NOTHING` | `IF NOT EXISTS (…) INSERT …`, or insert and catch `isUniqueViolation` |
| `x = ANY($1)` with an array | `x IN (SELECT value FROM OPENJSON($1))` (for GUID columns `SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1)`) |
| `col->>'a'` / `col->'a'` | `JSON_VALUE(col, '$.a')` / `JSON_QUERY(col, '$.a')` |
| `jsonb_array_elements(col)` | `CROSS APPLY OPENJSON(col)` |
| `jsonb_build_object(…)` / `jsonb_agg(…)` | `JSON_OBJECT(…)` / `(SELECT … FOR JSON PATH)` |
| `col @> '{…}'` | `JSON_VALUE` comparisons on the keys that matter |
| `x::text`, `x::int`, `x::uuid` | `CAST(x AS nvarchar(…))`, `CAST(x AS int)`, `CAST(x AS uniqueidentifier)` |
| `count(*) FILTER (WHERE c)` | `SUM(CASE WHEN c THEN 1 ELSE 0 END)` |
| `DISTINCT ON (k) …` | `ROW_NUMBER() OVER (PARTITION BY k ORDER BY …) = 1`, or `CROSS APPLY (SELECT TOP 1 …)` |
| `ILIKE` | `LIKE` (the collation is case-insensitive); escape `[`, `%`, `_` in the search text |
| `a \|\| b` | `CONCAT(a, b)` |
| `length(x)`, `position(…)` | `LEN(x)`, `CHARINDEX(…)` |
| `string_agg(x, ',')` | `STRING_AGG(x, ',')` |
| `FOR UPDATE [SKIP LOCKED]` | `FROM t WITH (UPDLOCK, ROWLOCK [, READPAST])` |
| `pg_advisory_xact_lock(hashtext(k))` | `lock(tx, k)` |
| `pg_notify` / `LISTEN` | `notify(tx, channel, payload)` / the notification poller |
| `WHERE flag` / `NOT flag` | `WHERE flag = 1` / `flag = 0`; a boolean in the select list needs `CASE WHEN … THEN 1 ELSE 0 END` |
| `ORDER BY x DESC NULLS LAST` | `ORDER BY CASE WHEN x IS NULL THEN 1 ELSE 0 END, x DESC` (SQL Server sorts NULL first ascending) |
| `generate_series` | a numbers CTE, or compute in TypeScript |

Rules that stay: every query is parameterized (never build SQL from input; table and column names that vary come from a fixed list in code), the application's role has only the rights in the baseline migration, and the audit log is written only through `audit_append`.

## What is different on purpose

- The audit chain hashes UTF-16 text because SQL Server's `HASHBYTES` does (verification in `verifyAuditChain` matches).
- SQL Server has no `TRUNCATE` trigger. The audit table's owner could truncate it; the application's role cannot (it has no `ALTER`), and the hash chain would show the loss.
- The semantic version check on `agent_releases.version` is a looser `LIKE` pattern; the contract schema is the strict check and runs before anything reaches the database.
