# What it costs to run

Estimates for 8,000 to 10,000 cabinets, October 2026. Prices are typical list prices for a small cloud VPS and change; check them before buying. The measurements are in [performance.md](performance.md).

## What drives the cost

| Cost driver | Measured or decided | Effect |
|---|---|---|
| Server and database | One machine runs the application (two worker processes) and SQL Server Express. At 10,000 cabinets the application used about 3 GB and SQL Server about 1.7 GB | 4 vCPU, 8 GB memory, 80 GB disk |
| Database licence | SQL Server **Express** (free), 10 GB limit; the first year at 10,000 cabinets is about 9.2 GB with 90-day events | No licence cost. At about 70% (8 months) plan the move below |
| Bandwidth | About 3 MB a cabinet a day in total (1.6 MB up, 1.5 MB down), measured | 10,000 cabinets: about 30 GB a day, about 1 TB a month. Most VPS plans include this |
| Alerts and email | No email or outbound notifications are sent | None |
| Storage for backups | Express writes uncompressed SQL backups; gpg may compress during encryption, but the resulting size must be measured | Budget for 14 retained full backups plus an off-host copy |
| Agent signing | A code-signing certificate is needed for production agents | The one fixed yearly cost outside hosting |
| People | Support staff use the console; there are no per-user fees | None |

## Monthly estimate

| Size | Machine | Typical price | Backups and monitoring | Total |
|---|---|---|---|---|
| Up to 1,000 cabinets | 2 vCPU, 4 GB | about $12 to $25 | about $3 | about $15 to $30 |
| 8,000 cabinets | 4 vCPU, 8 GB | about $25 to $60 | about $5 | about $30 to $65 |
| 10,000 cabinets | 4 vCPU, 8 GB (dedicated cores preferred) | about $40 to $80 | about $5 | about $45 to $85 |

Add the code-signing certificate (commonly $100 to $400 a year) and a domain (about $15 a year).

## Where the money goes if it grows

1. **The 10 GB database limit (about month 8 to 12 at 10,000 cabinets).** Choose one, cheapest first: keep command answers 30 days instead of 90 (saves 1.4 GB); clear event detail after 14 days instead of 30 (saves 0.5 GB); move to SQL Server Standard (a licence cost, no size limit). The first two are settings and cost nothing.
2. **Beyond about 10,000 cabinets** the application, not the database, runs out first. Add worker processes on a second machine before buying a larger one.
3. **Keep the machine dedicated to this platform**; a shared machine was the cause of the slow tails in the load test.

## Why it stays cheap

- Cabinets hold one long poll each and send a heartbeat every 5 minutes; the server sets the pace and slows it under load, so a small machine carries the fleet.
- Only what troubleshooting needs is stored: counts of events kept 90 days with their detail cleared after 30, command answers, a short load history, and drive history for failure prediction. Free text is not collected, and nothing is read from the cabinet application's database or the Windows Security log.
- Nothing is sent out: no email, SMS or third-party monitoring. The platform's own health page and alerts are read in the console.
