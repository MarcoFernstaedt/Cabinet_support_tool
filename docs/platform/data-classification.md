# Data classification and retention

What the platform holds, how sensitive it is, where it lives, and how long it is kept. Retention periods marked "setting" are changed by an Admin in Admin → Settings → Keep data for; the daily job removes what is past them and records each run in the audit log.

The platform never reads the cabinet application's database or the Windows Security log, and holds no patient data. Case notes copied out of the console are written to contain none.

## Classes

| Class | What it is | Sensitivity | Where | Kept |
|---|---|---|---|---|
| **Secrets** | Password hashes (Argon2), authenticator secrets (sealed with the server's key), session and step-up token hashes, the platform CA key | Restricted | Database (sealed or hashed); keys in the server's environment, never in the repository or logs | Sessions: until they expire, then 1 day. Step-up tokens: 2 minutes, then 1 day. Passwords and authenticator secrets: while the account exists |
| **Audit log** | Every sign-in, change, refusal, confirmation and export, in a hash chain | Restricted | Database; the app cannot delete or change rows | Forever (never pruned) |
| **Accounts** | Names, user names, roles, limits | Internal | Database | While the account exists |
| **Fleet records** | Clients, sites, cabinets, roles, settings, policies | Internal | Database | While they exist; removed clients and sites keep their history |
| **Configuration snapshots and baselines** | What a cabinet reports about its configuration (adapter and service settings, installed drivers, updates and programs, firewall rules, hosts entries, task and startup program names, hardware model and identity) and the baselines approved for it. Never passwords, keys, file contents or startup arguments | Confidential, per client | Agent queue (30 entries, 4 MB), then database (compressed) | Newest 20 versions per category; change rows follow the events setting; baselines and their versions are kept (an Admin's written reason is part of the record) |
| **Cabinet events (evidence)** | What cabinets reported: Windows event log entries (log, source, event ID, record ID, first line), monitor events, changes | Confidential, per client | Agent queue, then database | Setting: events, 7 to 3650 days (default 90) |
| **Command results** | What a diagnostic or change returned | Confidential, per client | Database | Setting: command results, 7 to 3650 days (default 90). The command itself, who sent it and when, stays |
| **Alerts** | Problems found and how they were resolved | Internal | Database | Setting: resolved alerts, 30 to 3650 days (default 365). Open alerts stay |
| **Firewall history** | Profile and rule changes with before and after | Confidential | Database | Setting: firewall history, 30 to 3650 days (default 365) |
| **Diagnoses** | Network diagnosis runs and findings | Internal | Database | Setting: network diagnoses, 7 to 365 days (default 30) |
| **Boot records** | When each cabinet started (reboot-loop detection, crash timelines) | Internal | Database | Setting: boot records, 30 to 3650 days (default 365) |
| **Incidents** | One problem on one cabinet followed from symptom to outcome: the steps (symptom, evidence, likely cause, proposed repair, approval, what ran, verification, notes, close), who took each, and links to the alerts, diagnoses, commands, case notes and fleet jobs involved. Steps and links cannot be changed by the application | Internal | Database; every step also in the audit log | Closed incidents follow the resolved alerts setting (default 365 days); open ones are never removed; removed with their cabinet |
| **Fleet operation jobs** | Each job and every cabinet's result | Internal | Database | Setting: fleet operation jobs, 30 to 3650 days (default 365); running jobs are never removed. The commands and audit entries stay |
| **Security alerts** | Suspicious activity raised to Admins | Restricted | Database; the app cannot delete them | Forever |
| **Software library and releases** | Approved packages and agent releases | Internal | Server file store, read-only | Until retired by an Admin |
| **Evidence packages** | A download of what the platform holds about one cabinet for a period | Confidential, per client | Built on demand; not stored by the platform | The download is recorded in the audit log with its hash |
| **Simulated (demo) data** | The demo fleet and everything it produced | Public (fictitious) | Database, marked demo | Deleted when demo mode is turned off |

## On the cabinet

- **Event queue.** At most 5,000 events wait to be sent, in a file only the agent can write. When it is full, the oldest are dropped and counted, and the count is reported.
- **Flood limit.** At most 20 entries with the same source and event ID are sent from one look at a log; the rest are counted in a summary event.
- **First look.** When the agent is installed, it reads the last 24 hours of errors and warnings, the last 14 days of changes (updates, drivers, software), and the last 30 days of crash, storage and hardware evidence (blue screens, unexpected restarts, disk, file system, controller and WHEA errors), so problems from before the install are seen.
- **State files** are capped at 1 MB each.

## On the server

- **Ingest quota.** Each cabinet may send 3,000 events an hour. Over that, the batch is refused with "slow down" and the agent keeps it in its queue and tries again later.
- **Request limits.** Agent requests are at most 1 MB; console requests at most 256 KB. Packages have their own size limit.
- **Query limits.** The fleet crash incident covers at most 14 days, one query per person at a time, with a 15-second database limit; a cabinet's timeline shows its newest 2,000 events.

## Evidence integrity

An evidence package (a cabinet's Crashes and restarts → Download evidence package) contains the cabinet's events, boots, alerts, the commands sent to it and their results, the timeline and the crash analysis for the chosen period.

- **Provenance.** Each section says where its data came from: the agent (with the original Windows log, source, event ID and record ID), the server's alerts engine, or the server's own analysis. The analysis is labelled as correlation, not proof.
- **Hashes.** Each section carries the SHA-256 of its canonical JSON (keys sorted, no spaces), and the package carries a SHA-256 of the whole. Changing any value changes the hash; `verifyEvidence` in `server/src/services/evidence.ts` checks a package.
- **Audit.** Every export is recorded with who exported it, the cabinet, the period and the package hash, so a package handed on later can be matched to its export.
