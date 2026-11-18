# Operations: what the platform records about itself

The platform counts its own health so the host admin can see trouble coming, with no outside service and no notifications. **No email, webhook or other message is ever sent.** The alerts show in the console; an external uptime monitor can poll the `/health` address.

## What is collected, and where

| What | Where | How |
|---|---|---|
| Requests answered, requests turned away (503 and 429), other server errors (5xx) by route pattern and status, the class of unexpected errors (type name and SQL Server or driver code), agent certificate refusals by reason, retention run results | table `ops_counters` (hour, kind, code, count) | counted in memory by each server process, written in one batched statement a minute |
| Database connection wait (95th percentile of a second-by-second sample, highest of the hour), event-loop delay (95th percentile, highest of the hour) | `ops_counters`, kinds starting `g_` | same |
| Database size against the edition limit, log size, free disk on the volumes holding the database, age of the last full or differential backup, certificate authority expiry, next cabinet certificate to expire, when the audit chain was last verified, when retention last ran, online and offline cabinets | read live from SQL Server's catalog views, `msdb.dbo.backupset` and the platform tables when the page is opened or a check runs | nothing is stored |
| Open operations alerts | `security_alerts` (kinds `ops_database`, `ops_disk`, `ops_backup`, `ops_errors`, `ops_shed`, `ops_migration`, `ops_ca`) | one open alert per kind |
| Agent faults | `agent_status` events from the cabinet's agent: `check` and `code` fields only (`loop_restart` with the loop name and exception type, `renewal_failed` with `http_<status>` or `unreachable`, plus the existing event-queue losses and upgrade status) | at most once an hour per code; shown on the cabinet page with the other agent status events |

Counter rows carry no message text, no identifier (no cabinet, user, address or URL: routes are patterns such as `/agent/v1/events`) and no payload. A code is cut to 80 characters of letters, digits and `_ . : / -`; the meter refuses kinds it does not know and holds at most 300 different codes between writes.

## What is NOT collected

No file contents, screenshots or keystrokes; nothing from the cabinet application's database (the platform never connects to it); never the Windows Security log; no exception messages (only the exception's type name and a code); no request or response bodies; no names, addresses or identifiers in counters.

## Retention

`ops_counters` rows are kept 90 days and pruned by the nightly retention job. Operations alerts follow the security alert retention (they are kept until resolved, then with the other resolved alerts). Agent status events follow the event retention (90 days).

## Who can see it

Admins only: the **System health** page (Admin -> System health, `GET /api/admin/system-health`, no parameters, never cached, no secrets) and the open alerts on the Security alerts page. The host admin also has the command `platform-admin status`, which prints the same summary on the server.

## The alerts

| Alert | Raised when | Clears |
|---|---|---|
| `ops_database` | database data files reach 70% (and then 85%) of the edition limit (SQL Server Express: 10 GB; no alert on editions without a limit). One alert; its title shows the level. | on its own, under 70% |
| `ops_disk` | free space on a volume holding the database is under 10% or 5 GB | on its own |
| `ops_backup` | the last full or differential backup is older than 36 hours, or none is recorded | on its own |
| `ops_ca` | the certificate authority expires within 60 days | on its own |
| `ops_errors` | 20 or more server errors and at least 2% of requests over 5 minutes | an Admin closes it |
| `ops_shed` | more than 5% of requests turned away in each of 10 minutes (each minute with at least 20 requests) | an Admin closes it |
| `ops_migration` | a database migration failed (raised by `platform-admin migrate` through `security.ts`, audited like the others; D110) | an Admin closes it |
| `audit_chain`, `certificate` | already existed: a broken audit chain; a cabinet certificate about to expire | as before |

The checks run every 10 minutes (and 30 seconds after start-up). Rates are judged per server process.

## Permissions the database account needs

The size guard works with the application's normal account (`sys.database_files`). Free disk and backup age need more, and show "unknown" without raising anything until the host admin grants them:

```sql
GRANT VIEW SERVER PERFORMANCE STATE TO [cabinet_app_login];   -- SQL Server 2022: sys.dm_os_volume_stats
USE msdb; CREATE USER [cabinet_app_login] FOR LOGIN [cabinet_app_login]; GRANT SELECT ON dbo.backupset TO [cabinet_app_login];
```

## Sizes

See "Database size" and "Events: 90 days within 10 GB" in [performance](performance.md). `ops_counters` is small: about 100 codes x 24 hours x 90 days, well under 20 MB.
