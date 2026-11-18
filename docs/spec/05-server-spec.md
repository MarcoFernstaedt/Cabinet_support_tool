# Server Specification

## Runtime

- Node.js 22 LTS, TypeScript in strict mode, Fastify
- Two separate listeners, either in one service or as two services sharing the same data store
- Console API listener: HTTPS behind a reverse proxy, cookie sessions, reachable only from Mashura's internal network or VPN
- Agent API listener: its own port and hostname, the only part of the platform reachable from the internet, with mutual TLS terminated by Node itself so the client certificate is verified directly, never passed along in a header
- **The parts run together or apart** (F21.R3, decision-log D60): `SERVER_ROLES` names what a process runs, as a comma-separated list of `agent` (the agent API), `console` (the console API) and `jobs` (the background jobs). It defaults to all three, so a single process behaves as before. The cabinets' ingest can run in its own process, on its own port and host, from the same build as the console. Either can be stopped, restarted or scaled while the other keeps serving. The processes share nothing in memory: commands, results and alerts travel through the database and its notifications table, and every job takes its lease first. An unknown or empty role stops the server at start. So does `console` named without the console's settings. With `AGENT_API_WORKERS` above 1, only a process with the `agent` role forks workers, and they serve agents only. A primary left with no part of its own (`agent` alone, several workers) opens no database connection: it only starts the workers and replaces any that stop.
- **One writer per background job across server instances** (F21.R1, decision-log D49). Inside one host the primary process runs the background jobs and the workers serve agents. With more than one instance (two hosts), each job runs only while that instance holds the job's lease in `job_leases`: the minute loop (`jobs.minute`, 150 s), the replacement re-apply (`jobs.reapply`, 45 s), resuming fleet jobs at start (`jobs.resume-fleet-jobs`), the daily chain check and retention (`jobs.daily`), the hourly notification prune (`jobs.hourly`), the operations checks (`jobs.ops-checks`), the error trends (`jobs.error-trends`) and the demo simulator (`jobs.demo`). A lease outlasts its job's interval, so the holder keeps it from run to run; another instance takes it over only once the holder has stopped renewing and the lease has run out. Taking and renewing is one statement, so two instances asking at once cannot both get it, and a lease that cannot be read counts as not held: the job is skipped, never run twice.
- **Fleet job lifetime ownership.** Every route-started or resumed fleet job acquires its own `fleet.job.<job ID>` lease (30 s), with a fresh owner token per attempt. Each runner statement or transaction renews an unexpired lease under a row lock held until commit; an expired or replaced owner cannot continue verification writes, issuance or completion. Recovery takes the ten-minute startup lease once, then looks for unfinished jobs every 10 s for as long as the process runs, so a job started after boot is found too: jobs still reading `running`, and cancelled jobs whose `finished_at` is null. A runner that ends on a failed statement leaves its progress in the database and the next scan resumes the job, following up targets in `issued` and in `succeeded` alike, so a restart between a command succeeding and its verification does not strand it. Cancellation is consulted only once a job has no outstanding work left: its outstanding commands are followed up, and then it ends without issuing anything new.

## Console API areas

- Auth: login, logout, current user, authenticator-app enrollment, step-up verification
- Fleet: list clients, sites in a client, cabinets in a site, cabinet detail, search by client, site or cabinet name
- Operations: issue a command to a cabinet, get a command's status and result
- Alerts: list with filters, claim, resolve, the unrecognized-error list, and the offline filter with its drill-down counts
- Issues: issue types, symptom rules, rule proposals, approvals, previews and history
- Software library: list, upload, approve, retire packages
- Live updates: one Server-Sent Events stream per signed-in user for new major alerts, claims and command results
- Admin: users, clients and sites, pending queue, cabinet role changes, settings, fleet safety controls, security alerts, audit log, online users, upgrade rollouts

## Issuing a command

1. Validate the request body against the operation schema.
2. Check the user's role allows the operation.
3. For write operations, check the fleet write pause and the user's write limit, then consume the one-time step-up token for this exact action.
4. For package.install, check the package is approved and not retired, and put its ID and hash into the command.
5. Write the command record and the audit entry together.
6. Hand the command to the waiting long poll for that cabinet, if one is open.
7. When the result arrives, store it, write the audit entry and push it to the user's live stream.
8. A command that can no longer run is marked expired by the minute job: one still queued past its expiry, one handed to a poll that never confirmed it whose expiry has passed, and one delivered with no result after 35 minutes. Each expiry writes an audit entry (`command.expire`, actor `system`, with why: `never_delivered`, `unconfirmed` or `unanswered`) in the same transaction as the change. The long poll never hands over a command past its expiry; it does not mark it expired itself, so until the next minute job such a command still reads as queued or delivered. A result that arrives after expiry is kept.

## Enrollment and certificates

- Validate and consume the bootstrap token (a site installer's token counts one use per request, up to its limit), store the request and fingerprints, place it in the pending queue. A request from a site installer lists its intended client, site and role, which the approval form starts from and the approval is held to.
- **Batch approval** (F6.R2, decision-log D36): `POST /api/admin/enrollments/approve-batch` approves up to 50 pending cabinets at one client and site with one role and one baseline decision (`inherited`, or `attach`, which attaches with the first cabinet approved and the rest inherit it), confirmed with one code bound to the whole body (`enrollment.approve_batch`). Each cabinet is approved on its own, with its own audit entry, so one refusal (another site's installer, a taken name) leaves the others approved and itself pending; the answer says what became of each, and the batch is audited once with the counts. A request listed twice, or two cabinets with one name, refuse the whole batch before anything runs. A capture is one site draft from one cabinet's report, so it stays a single approval.
- On admin approval with step-up, the admin assigns the client, site, cabinet name and role. The server then has the CSR signed by the issuing key in the KMS and returns the certificate on the agent's next enrollment poll.
- On rejection, the request is closed and the token stays consumed.
- **Fleet install script** (decision-log D57): `POST /api/admin/installer` with `format: "fleet-script"` and a `site` returns `Install-CabinetAgent-Fleet.ps1` instead of the launcher. A fleet script without a site is refused (`site_required`). `GET /api/install/package?architecture=windows-x64|windows-x86`, with no session, serves that architecture's package to `Authorization: Bearer <site installer token>` while the token can still enroll a cabinet. Otherwise it returns 401 (`install_token_refused`), or 404 for an architecture the server does not have. The query is validated against `install-package-query`, which admits only the architecture.
- Every agent connection is checked against the cabinet record: unknown or revoked certificate serials are refused.

## Sync cabinets and satellites

- **A site may have several sync cabinets.** Each sync cabinet holds the address its satellites reach (`cabinets.sync_address`); each satellite names the sync cabinet it reaches (`cabinets.sync_cabinet_id`). The ports stay per site: the site's own, else the client's, else the fleet default.
- **A satellite's link counts only while it points at an active sync cabinet at the same site.** Otherwise the satellite's enrollment is incomplete: the console marks it, and its sync tests and diagnosis have no target. Removing, demoting or moving a cabinet therefore never leaves a satellite aimed at the wrong place.
- **Approval.**
  - A satellite may name its sync cabinet; the server checks it is an active sync cabinet at the same site (`invalid_sync_cabinet` otherwise).
  - Left out: at a site with one sync cabinet the satellite is linked to it; at a site with none it is approved as incomplete; at a site with several the approval is refused (`choose_sync_cabinet`).
  - Only a satellite names one (`sync_not_allowed` for a sync or standalone cabinet).
  - Everything happens in the approving transaction: a refused or failed approval leaves no cabinet and no link.
- **Linking without asking.** When a site has exactly one active sync cabinet (one is approved, removed, or a role changes), every active satellite there without a live link is linked to it, and each link is audited as the system's.
- **The address.** Taken from the sync cabinet's own reported network settings (config snapshots and `network.config` results): the single private IPv4 address on its connected adapters, written exactly as a dotted quad. It is followed when it changes. A report with none, or several, keeps the last address. An Admin may set the address with an authenticator code (`cabinet.sync_address`); a report never replaces it, and clearing it goes back to the reported address. Every change is audited: the system's for a report, the Admin's for a setting.
- **Assigning.** An Admin assigns a satellite to a sync cabinet at its own site, or unassigns it, with an authenticator code (`cabinet.sync_cabinet`).
- **Role changes.** A cabinet that stops being a satellite drops its link; one that stops being a sync cabinet drops its address. A cabinet that becomes a sync cabinet starts from the address it last reported.

## Fingerprint scanner per client

- **A client either uses a fingerprint scanner or does not** (`clients.fingerprint_scanner`). Existing clients start on; a new client chooses with the approval that creates it. An approval for an existing client may not carry the choice (`scanner_for_existing_client`): its setting is changed on the client's page.
- **Switching it on** (Admin, authenticator code bound to the exact choice) takes the scanner's Windows service as an approved-list entry (key name and exact program path) and, optionally, the client's scanner hardware IDs. In one transaction:
  - the service joins the client's approved list. With signing on it is a change waiting for the Admin's offline signature, and the list in force is untouched until then. The change starts from the client's pending change, else its own list, else the fleet's, because a client list replaces the fleet's whole. A list in force that already approves the service is left alone;
  - the service joins the client's watched services (at most 16);
  - the broker keeps the service running only once the signed list approves it, so watching starts with the signature.
- **Switching it off:** the client's cabinets get no scanner IDs; an agent from 0.3.1 is told not to look for a scanner (`heartbeat-response scanner.watch: false`, sent only to agents that know the field); scanner events from an older agent are stored and open no alert; open scanner alerts are resolved, each audited; the cabinet diagnosis does not read the scanner and reports it as not used; the scanner's service comes off the client's watched list. The approved list is left alone: removing an entry needs the same signature as adding one, and an approved service that nobody watches does nothing by itself.
- **The client's page** shows whether the scanner is used, its service, and where that service stands: approved and watched, waiting for the signature, or not on the approved list.

## Site policies

The owner's decision (09-open-decisions.md "Site policies at first approval"): the firewall policy and the time zone are inherited fleet → client → site; the network standard stays per site.

- **Firewall policy** (`sites.firewall_policy`, migration 0014): the site's own, else the client's, else the fleet default (all off unless an Admin changes it). The drift alert, the one-click and bulk apply, the fleet operation and the network diagnosis all read the one that applies. A site's own is set or removed by an Admin with an authenticator code bound to the exact policy (`PUT /api/sites/:id/firewall-policy`, step-up action `site.firewall_policy`); its cabinets are compared again at once.
- **Time zone** (`clients.time_zone`, and the fleet default in the settings row `time.zone`): the site's own, else the client's, else the fleet's; with none, no zone is checked. The wrong-zone alert, the cabinet's time facts, the fleet operation that sets zones and the cabinet diagnosis all use one SQL expression for it (`SITE_ZONE_SQL` in time.ts). A client's default is set by Tier 2 and up, like a site's (`PUT /api/clients/:id/time-zone`); the fleet default by an Admin (`PUT /api/settings/time-zone`). Every change is audited and re-checks the cabinets it reaches.
- **At a site's first approval** the approval may carry `sitePolicies` (firewall policy and time zone). The console pre-fills them from what the site would inherit (`GET /api/admin/enrollments/:id/site-policies`); keeping the inherited value sends null, so the site goes on following its client and the fleet; only a value the approver sets becomes the site's own. Each is written and audited as its own change in the approval's transaction. An approval for an existing site may not carry them (`site_policies_for_existing_site`): its policies are changed on its page.
- **The network standard** is set on the site page, from what its cabinets report ("Standards for <site>"), once they have reported their network; a pending cabinet has reported none.
- **Where a cabinet's settings come from** (F6.R5, decision-log D38). Every setting with a parent scope is resolved when it is read, so a cabinet approved after its site, client or the fleet has a setting follows it at once; approval copies nothing onto a new cabinet (a replacement keeps the old cabinet's own settings, below). `GET /api/cabinets/:id/setting-origins` (Tier 1 and up) answers, for each such setting in a fixed order (firewall policy, network baseline, time zone, sync ports, scanner use, scanner IDs, watched services, approved programs, file-facts paths, USB watch, configuration baseline), the level that applies (`source`: cabinet, site, client, model, role, fleet, or `default`, `automatic`, `none`), every level that sets it in the order it is resolved (`setAt`), the levels whose stored value was refused when read (`rejected`; such a level allows nothing rather than passing to the level above), and for a list how many entries apply. It uses the resolver each setting is enforced with. The cabinet's Standards tab shows it: a line per setting with the level it comes from, and in its window the other levels that set it and any refused one. A test fails when a column is added to clients or sites that this read does not cover.

## Replacing a cabinet

The owner's decision (09-open-decisions.md "Replacing a cabinet"): when a cabinet's drive fails, the agent is installed again on the new drive and enrolls as a new request. Its approval may say which cabinet it replaces (`replacesCabinetId`, migration 0015 `cabinets.replaces_cabinet_id`).

- **What may be replaced:** an active cabinet at the approval's site with the same role. Otherwise the approval is refused before anything is written: `not_replaceable` (not active: removed, pending, or replaced already), `replacement_elsewhere` (another site), `replacement_role_differs`. The old cabinet is read under lock, so two approvals cannot both replace it; a cabinet is replaced at most once.
- **The new cabinet takes its place**, in the approval's transaction:
  - a satellite keeps the sync cabinet the old one reached, unless the approval names another; a sync cabinet takes the old one's satellites and, when an Admin had set it, its address (a reported address is not copied: the new cabinet reports its own);
  - the old cabinet's own settings are copied: scanner hardware IDs, watched services, file-facts paths, the in-office flag, its approved-programs list (with signing on, a change waiting for the Admin's signature, like any other), its USB watch policy and its approved cabinet baseline (as a new approved version whose origin names the one copied). Settings it inherited from its site, client or fleet are not copied: the new cabinet inherits them the same way;
  - when the new cabinet takes the old one's name, the old record is renamed "<name> (replaced YYYY-MM-DD)".
- **The old cabinet is retired, its history kept:** status removed, its certificates revoked (its agent is cut off at once), its open alerts resolved as "Replaced by <name>.", each audited. Its page stays reachable and links to the new cabinet; the new cabinet's page links back. Audit: `cabinet.replace` on the new cabinet (what was moved and copied) and `cabinet.revoke` on the old one.
- **Re-applying on the machine** (migration 0016, `replacement-reapply.ts`). The approval queues it; it starts once the new cabinet has reported (it says whether it is read-only), checked every 15 seconds, and carries on after a server restart. The server reads the new cabinet's network, then plans, in this order:
  - **firewall**: the policy that applies to the new cabinet (`firewall.applyPolicy`);
  - **time zone**: the zone that applies to its site, else the zone the old cabinet reported (`time.setZone`);
  - **drawer**: the standard drawer address, 172.20.1.0/32, when the old cabinet had a drawer (any 172.20.1.x address), on the new cabinet's drawer adapter: the one wired adapter already on 172.20.1.x, else the one on an unidentified network (`network.setIp`, no gateway);
  - **DNS**, then **address**: only when the old cabinet had them fixed, the same servers, and the same address, prefix and gateway, on the new cabinet's one connected adapter with a gateway (`network.setDns`, `network.setIp`). The address goes last: it is the change most likely to cut the cabinet off, and the agent's safety net undoes it then.
  A step already in place, or one the server cannot place safely (no single adapter to aim at, nothing reported), is skipped with the reason; nothing is guessed. Every value is checked against the operation's schema before it is sent.
- **Issued in the approving Admin's name**, one step at a time: each is answered, then verified from what the cabinet reports or reads back, before the next. The Admin's code at approval is the confirmation (`viaReplacement` in the audit entry, which names the replaced cabinet); the steps count once against the Admin's hourly limit, and every pause, the read-only flag and the Admin's own status still apply. A step that fails stops the steps after it. Nothing is sent to a read-only cabinet, or in the name of an Admin who can no longer make changes. Audit: `replacement.reapply.plan` (the steps and why any were skipped), a `command.write` per step, `replacement.reapply.finish`. The new cabinet's page shows each step, the value sent and its result.

## Issue types and symptom rules

This is how errors become meaningful alerts, and how the team teaches the system new symptoms of known problems.

- Issue type: a named problem with a severity of major or minor and a short description. Starting set: Fingerprint scanner problem, Drive failing, Driver failure, Network connectivity, Unexpected firewall change, Windows update failure, Agent problem. Admins can add more.
- Symptom rule: links a pattern of events to one issue type. It matches on structured fields only: log, source, event ID and level, plus optionally a device hardware ID and a plain phrase that must appear in the message. No regular expressions are allowed, so a badly written rule cannot freeze the server.
- Built-in rules: the agent's fingerprint scanner events map to Fingerprint scanner problem, SMART warnings to Drive failing, and unexplained firewall changes to Unexpected firewall change.
- Unrecognized errors: an event that matches no rule is stored as a minor unrecognized alert, listed on its cabinet and in a fleet-wide Unrecognized list.

Mapping an error to an existing issue:

1. From any event or unrecognized alert, a Tier 2 or Admin user chooses Map to issue and picks an issue type.
2. The server pre-fills a rule from that event: log, source, event ID, and the device hardware ID if there is one. The user can narrow or widen it.
3. Before saving, the server shows how many events across the fleet in the last 30 days the rule would have matched, and on how many cabinets.
4. The user chooses whether matching open alerts should be regrouped under the issue now.
5. A Tier 2 user's rule is saved as a proposal and goes live once an Admin approves it. An Admin's rule goes live directly. Both require step-up.
6. Once live, every new matching event raises that issue, so the next time the error appears the team is told it is, for example, a fingerprint scanner problem.

Protecting the rules:

- Rules decide what people get alerted about, so a careless or malicious rule could hide a real problem.
- Every rule keeps its full version history, with who proposed, approved, changed or disabled it, and can be rolled back.
- Suppression rules, which mark a known harmless event as ignore, are Admin only, require a written reason, and expire after 90 days unless renewed. All active suppressions are listed on one admin screen.
- Every rule change is in the audit log.

## Alerts engine

- Each incoming event is checked against the live symptom rules. A match raises or updates an alert for that issue type with the issue's severity.
- Correlation: repeats of the same issue on the same cabinet fold into one open alert with an occurrence count and first-seen and last-seen times. The same issue on several cabinets at one site within an hour is flagged as a site-wide pattern.
- Major alerts go out on every support and admin live stream immediately.
- Claiming is atomic: the first claim wins, and later claims get told who owns it. Claim and resolve are both audited.
- An alert the platform closes by itself is audited too: `alert.resolve` with actor `system` (naming the check that closed it) and `automatic: true`, in the same transaction as the closure (finding F4). Every automatic close goes through `closeAutomatically` (`server/src/services/automatic-close.ts`) or audits on its own (the site outage, a security alert clearing itself). The disk-filling forecast closes through `closeSignatureAlert` in `alerts.ts` (decision-log D98).
- **A close that verifies a fix names it** (F18.R1, decision-log D47). When a cabinet's own reading closes an alert whose issue a platform write fixes (time zone: `time.setZone`; clock: `time.sync`; firewall policy: `firewall.applyPolicy`, `firewall.setProfile`; service failing or watch: `service.control`, `service.setStartType`; network baseline: `network.setIp`, `network.setDns`, `network.renewLease`), the audit entry carries `verifiedFix`: the newest such write that succeeded on that cabinet since the alert opened, with its command, who issued it, when, and the before and after the cabinet reported in its result (`before`/`after`; for `time.sync` the last successful syncs, for `network.renewLease` the address). `verifiedFix` is null when nothing the platform did since the alert opened explains the close (the cabinet put itself right, or someone changed it on the cabinet). At most 100 closes in one call look the fix up.
- **Every state change and every delete is audited (F4).** A statement that changes a row's state or status, or deletes rows, writes an audit row in the same transaction, or is a named exception that is not a transition of its own: a delivery lease, one step's progress inside a run whose start and end are audited, derived or cached rows recomputed from others, and telemetry retention whose nightly run is audited with its counts. `server/test/audit-sweep.test.ts` reads the server's source and fails on any new statement that is neither audited nor on that list with its reason. A fleet job's automatic end is audited as `fleet.job.finish`.
- Alert states: open, claimed, resolved.
- **Fleet patterns** (decision-log D22, D23, D25): the same problem at the threshold number of sites within the look-back window is one fleet pattern. It opens only while at least one of its alerts is still unresolved, counts up while open, and resolves itself once none is; the resolved alerts of a closed pattern never open it again.
- **Kinds of blue screen** (decision-log D26, D61): the console's list groups the blue screens in the window by crash signature, each crash logged under both sources counted once, on active cabinets of the scope; demo cabinets' kinds are their own rows. It reads only the BugCheck 1001 entries the blue-screen alerts hold (from BugCheck and WER), so a blue screen that an approved rule hides, or files under another issue, is not on it. A kind's report compares its cabinets with the other active cabinets of the same kind, real or demo.
- **New kinds of blue screen** (F17, decision-log D52): every blue screen on a cabinet is one alert whatever its kind, so the blue-screen pattern above holds every kind at once. Once an hour, the crashes the platform alerted on in the last 90 days, from BugCheck and WER as on the kinds list, are grouped by crash signature (D26), each crash logged under both sources counted once. A kind whose first crash in the fleet is at most 7 days old and that has reached 2 or more active, non-demo cabinets opens one major fleet pattern, keyed `crash:<signature>` and titled "New kind of blue screen: <signature title>", while at least one of those cabinets has a blue-screen alert open. The same pass counts it up and resolves it once none of them has; the minute sweep leaves these keys alone, since no alert carries a kind. Its report lists the cabinets that had that kind. At most 20 open in one pass. Opening and resolving are audited (`fleet_pattern.open` with the signature and its first crash).

## Firewall change attribution

- A firewall_changed event carrying the ID of a platform command is recorded as an approved change on that cabinet's firewall history.
- Any other firewall change raises Unexpected firewall change.

## Approved software library

The approved delivery path for released platform operations. The [dev-only SSH transport](02-security-model.md#development-ssh-transport) follows the cabinet’s SSH policy.

- An Admin uploads a driver package (a zip containing the INF, its signed catalog and its binaries) or an MSI installer, with its name, version, vendor and the hardware it is for, such as the fingerprint scanner's hardware IDs.
- On upload, the server computes the SHA-256 hash and checks the signature itself: the catalog signature for drivers, the Authenticode signature for MSI files, and that the signer is on the trusted publisher list. Anything unsigned, tampered with, or from an unlisted signer is refused.
- A second Admin must approve the package before it can be used. The uploader cannot approve their own package.
- Approved packages are stored read-only. Changing a package means uploading a new version, which needs its own approval. Retiring a package blocks any further installs.
- The agent repeats every check itself before installing, so the server's checks are a first gate, not the only one.
- Size limit per package: 500 MB by default.

## Fleet safety controls

- Write pause: an Admin can pause all write operations fleet-wide, or for one client, at once. Reads keep working. Meant for incidents or anything that looks wrong.
- Per-user write limit: by default at most 20 writes per hour per user. A fleet job or bulk change counts as one. Going over, on any write path, pauses that user's writes and raises a security alert to Admins. An Admin's resume restarts the count.
- One cabinet per write command, always. There is no way to send a change to many cabinets at once, except signed agent upgrades through staged rollout.

## Security alerts

Raised to Admins as major alerts:

- Unusual write volume from one user
- Repeated failed logins or step-ups on one account
- Sign-in from a network location the account has not used before
- An audit chain break
- An agent reporting a failed self-check, a refused package, or a signature failure
- A cabinet connecting with a revoked or unknown certificate

Repeats of one alert fold into one open alert with a count. An Admin resolves an alert with a note. Alerts raised by one event at a time
(write volume, failed sign-ins or step-ups, a new location or device, a failed self-check, a refused package, a signature failure, a
revoked or unknown certificate) also close on their own after 14 days with no recurrence, with an audit entry, so the list stays current
(owner's decision 2026-11-02). A recurrence after that opens a new alert. An audit chain break never closes on its own; the platform's
operations alerts close when their condition clears.

## Offline handling

- A cabinet with no heartbeat for 5 minutes is offline. This is a status, not an alert.
- The offline filter returns counts by client, then by site, then the cabinets themselves.
- An admin setting, default 5 days, turns a cabinet offline longer than the threshold into a real alert in the Alerts tab. The alert resolves itself when the cabinet returns.

## Audit log

- Written in the same transaction as the action it records.
- Each entry: sequence number, UTC timestamp, user, action, target cabinet or user, outcome, request details with secrets removed, previous entry hash, own hash.
- Cabinet views are logged when a cabinet view opens, so admins can see who looked at what and when. Opening an event log entry is logged too.
- Daily chain verification. A break raises a security alert.

## Presence

Online users are those with an active session and activity in the last 5 minutes. Admins see each user's name, role, last activity time and current cabinet if any.

## Accounts

- Two-factor authentication is a per-account setting. When it is on, login requires the password and then the authenticator code.
- Tier 2 and Admin accounts cannot be used until two-factor is set up, and a user cannot be promoted to Tier 2 or Admin without it.
- Tier 1 accounts may turn two-factor on for themselves. An admin setting, off by default, requires it for every account.
- Only an Admin can reset or remove a user's authenticator.
- Resetting a password, resetting an authenticator or disabling an account ends all of that user's sessions at once.
- The last remaining Admin account cannot be deleted or demoted.

## Platform database

The server has its own database. It stores the support team and admin accounts, the fleet's client, site and cabinet records, alerts, and the log of everything each support member did on each cabinet: which cabinets they opened, which operations they ran, the results, and when. It has no connection to the cabinet application's database on each cabinet, which stays out of scope.

Records it holds:

- User: ID, name, username, role, password hash, two-factor on or off, authenticator secret encrypted, status, write limit, created and last login times
- Session: ID, user, created, last activity, expiry, address
- Client: ID, name, write pause flag
- Site: ID, client, name
- Cabinet: ID, site, name, role, status of pending, active or removed, hostname, serial number, read-only mode, certificate serial and expiry, agent version, last heartbeat time
- Enrollment request: ID, fingerprints, token used, status, decided by, decided at
- Command: ID, cabinet, operation, parameters, issued by, issued at, expires at, status, result
- Event: ID, cabinet, kind, source, detail, occurred at, received at, matched rule
- Issue type: ID, name, severity, description, created by
- Symptom rule: ID, issue type, match fields, kind of map or suppress, state of proposed, live, disabled or expired, version, proposed by, approved by, reason, expires at
- Alert: ID, cabinet, issue type, severity, signature, state, occurrence count, first seen, last seen, claimed by, resolved by
- Package: ID, name, version, vendor, type of driver or MSI, target hardware IDs, SHA-256 hash, signer, size, state of uploaded, approved or retired, uploaded by, approved by
- Firewall change: ID, cabinet, command ID if any, before, after, occurred at
- Setting: key, value, changed by, changed at
- Audit entry: as above
- Rollout: ID, version, batches, state, started by

Database engine: Microsoft SQL Server 2022 (decided by the owner in October 2026; the first milestones used PostgreSQL, see docs/platform/sqlserver-port.md). The application's database role has no right to write the audit tables: entries are appended only through a stored procedure that chains their hashes, and an `INSTEAD OF` trigger refuses to change or delete an entry even for the owner. Schema changes go through versioned migration files checked into the repository, never manual edits.

## Retention

Events and command results kept 90 days by default (the bulky detail of events without an alert is cleared after 30 days; see docs/platform/performance.md), alerts and firewall history 1 year, the audit log indefinitely. Values are settings.

## Operations

- Health endpoint for monitoring
- Structured JSON logs without secrets
- Configuration from environment variables and a secret store
- Dependencies pinned, audited on every build
- Daily encrypted database backups, with restores tested before the client beta

## Development SSH transport

The [security model](02-security-model.md#development-ssh-transport) defines the development
build and configuration gates. A cabinet-scoped operator obtains step-up for action
`ssh.transport` and the cabinet ID, then sends `{ "stepUpToken": "…" }` to
`POST /api/cabinets/:id/ssh-transport` with the usual console session and origin headers. The
response includes `transportId` and `endpoint` with the assigned loopback host and port. Run
`ssh -p <assigned-port> <cabinet-user>@127.0.0.1` on the platform host, verifying the cabinet’s
host key. The endpoint accepts one client. The operator can close it with
`DELETE /api/cabinets/:id/ssh-transport/:transportId`. Disconnect, lease expiry, the 30-minute
session limit, and graceful server shutdown also close the transport.

The off-network acceptance extends `scripts/acceptance/session-shell-cabinet.mjs`. Use its
existing off-network enrollment setup with `SHELL_OFF_NETWORK=1`, `SHELL_PLATFORM_HOST`,
`SHELL_PLATFORM_PORT=8443`, and the test SQL database. Set `SHELL_SSH_USER` to the same cabinet
account used by `SHELL_CABINET_SSH` and `SHELL_SSH_IDENTITY` to a usable key authorized for that
account. The Linux acceptance container uses host networking so the host’s SSH client can dial
the platform’s assigned loopback port. The harness reads the cabinet’s ED25519 host key before
Tailscale goes down, waits for a fresh authenticated public connection using the existing
enrollment checks, then runs one command through SSH. After recovery it copies the evidence file
via the original cabinet connection and verifies the authenticated account, the stopped tailnet,
the agent’s two outbound destinations, and the absence of an agent listener. The database keeps
the audit evidence. The harness also checks that the local endpoint refuses new connections after
closure.
