# Decision log

Every choice made while building, with why, what else was considered, what it costs, and how it was proven. Kept for the
end-of-project review, where each one is gone over again. Newest first. Figures say whether they were **measured** (with
where) or **worked out** from limits in the code; nothing here is an estimate presented as a measurement.

---

## D21. Crash incidents: an alert opens one, repeats count on the alert, all resolved closes it (2026-11-04)

**Owner's decision.** Asked what opens and closes a crash incident (engine part 5b): a blue-screen or reboot-loop alert opens one
incident per cabinet, later crash alerts join it, and it closes when all its crash alerts are resolved. In the owner's words, a site
must not "show 20 alerts if the same kind": the same alert is shown **once with the number of times it occurs**, and incidents have
to be built for that.

**What is built.**
- **Module `crash-incidents` v1** (`contracts/diagnostics/modules/crash-incidents.json`, registered as built, phase 2). Its rule
  `crash.incident` (`planCrashIncident`, `server/src/services/crash-incidents.ts`) decides from the cabinet's crash alerts: open,
  add the alerts not yet linked, close when none is unresolved, or nothing.
- **Repeats never multiply.** Alerts already fold every repeat of one kind into one alert with a count (`occurrences`). The incident
  links each alert once, with one evidence step when it joins; a repeat adds no step and no row. Fifteen blue screens are one alert
  counted 15 times on one incident.
- **Kept in line from the alerts**, not followed through the ~20 places an alert can be raised or resolved: after every event batch
  that raised a crash alert or reported a start, after a person resolves a crash alert, and in the one-minute sweep (which also
  catches the reboot loop's own 2-hour recovery). A failure there never fails the event batch.
- **One open crash incident per cabinet**, enforced by a unique filtered index (migration 0021). Two runs at once: the second open
  fails and adds to the first one's incident instead.
- **The crash page** shows the incident with each of its alerts once: how often, first and latest, open or resolved
  (`GET /api/cabinets/:id/crash-incident`, Tier 1 and up, read only).

**Considered.** Closing after quiet days (the owner chose the alerts' own resolution). Opening only on repeated crashes (a single blue
screen matters to a cabinet that runs a pharmacy). Following every resolve path directly: about twenty places, each a chance to miss
one; reconciling from the alerts cannot drift.

**Costs.** One extra query per event batch that touches crashes or starts; the sweep reads only cabinets with an unresolved crash
alert or an open crash incident, at most 500 a minute.

**Proof.** `crashes.test.ts`: the rule on its own (opening, a blue screen naming the incident before a loop, joining, a repeat adding
nothing, one open alert keeping it open, closing); fifteen BugCheck events through the real ingest give one incident, one alert with
15 occurrences, two steps; a reboot loop joins it; resolving one keeps it open, resolving both closes it on the sweep; the next blue
screen opens a new incident; three runs at once open one incident with one link and one evidence step; the route's 404s and 401.
Red: without the unique index (two incidents), without the ingest hook (no incident until the sweep), and without the close rule.

---

## D20. New crash dumps and short uptimes raise agent events; a short run is under 20 minutes (2026-11-04)

**What the spec asks.** "New dumps, short uptimes and repeated boots raise events" (13-roadmap.md, phase 2, agent monitors). It does
not say how short a short uptime is.

**Decision.**
- **New dumps.** Every 5 minutes (first look a minute after start) the agent runs `crash.list` in the broker. A small dump whose name
  was not there last time is sent once as a `crash_dump` event (major) with its name, time, size, and the stop code and parameters its
  header gave, or why the header could not be read. The first look after install sends only dumps written in the last day, so an old
  Minidump folder is not a flood and a crash just before the agent started is not lost. At most 10 per look, oldest first: a name
  counts as seen only once it was sent (or the first look left it out), so the rest go on the next looks and none is lost.
- **Short uptimes.** Every 5 minutes the agent runs `boot.history` for 2 days. Each start newer than the last one looked at, whose run
  before it lasted under **20 minutes**, is sent once as a `short_uptime` event (minor) with both starts, how long the run lasted, and
  how it ended (and why, D19). A run's length is the uptime Windows logged at a clean or requested shutdown, else the time between its
  start and the next. Starts dated more than 5 minutes ahead of the cabinet's clock are ignored. At most 10 per look, oldest first; when more
  are waiting, the bookmark stops at the last one sent.
- **On the server.** A `crash_dump` raises the blue-screen issue on the same alert signature as the BugCheck 1001 event, so a dump and
  its event are one alert (two occurrences), and a dump whose event was lost still raises it. A `short_uptime` raises nothing itself:
  both its starts are recorded as boots (once each, inside the same-boot window), so the reboot-loop rule (3 starts within 60 minutes)
  sees loops even when no heartbeat or start record arrived. Times that do not parse, more than 5 minutes ahead or older than 3 days
  record nothing.

**Why 20 minutes.** It is worked out from the server's existing reboot-loop rule, not measured: three starts in 60 minutes means runs
of 20 minutes or less on average, so a run under 20 minutes is one step of what the platform already calls a loop. It is a constant
(`UptimeWatch.ShortRunSeconds`); the spec does not set it, so it is noted in 09-open-decisions.md for the owner to change.

**Considered.** Sending every start and letting the server judge: the server already gets starts from heartbeats and Kernel-General 12;
what it misses is a cabinet that crashes before it reaches the server, which is exactly what the agent's own record covers. Raising a
minor alert per short run: one bad restart would page people; the loop alert is the signal that matters.

**Costs.** One `crash.list` and one `boot.history` read in the broker every 5 minutes (a directory listing with 4 KB per dump, and a
filtered System-log query). An agent on this version needs a server that knows the two event kinds: deploy the server first.

**Proof.** `CrashWatchTests` (15, after review): first look bounded to a day, each dump once, survives an agent restart, header problems reported,
at most 10, a future-dated dump; short runs once each, Windows' logged uptime before the gap, the limit's edge, the first look's day,
a loop oldest first, a future start ignored. 30 dumps and 15 short runs are all sent across looks, none lost (red
  with the first version, which marked every name seen and moved the bookmark to the newest start; found in review). Red with each guard removed (1, 3, 1 and 1 failures). `crashes.test.ts`: a dump alone
raises the blue screen; with its BugCheck event it is one alert with 2 occurrences; three short runs make 4 boots and a reboot-loop
alert and no other alert; hostile times record no boot. Red with the dump handling removed, and with the time bounds removed.

---

## D19. Unexpected restarts are classified: blue screen, power button, or power lost / frozen (2026-11-03)

**What the spec asks.** Phase 2 "power-loss classification": tell a bug check from a power loss from a forced power-off
(13-roadmap.md). Before this, every Kernel-Power 41 and EventLog 6008 was one "restarted without shutting down cleanly".

**Decision.** Each unexpected restart on a cabinet's crash view gets one cause (`classifyShutdowns`, `server/src/services/crashes.ts`):
1. **Its own fields first.** Kernel-Power 41 carries `BugcheckCode` (non-zero after a blue screen) and `PowerButtonTimestamp`
   (non-zero when the button was held). When the event arrives with them, they decide.
2. **Else a blue screen within 10 minutes**, either side: Windows logs the BugCheck 1001 when it starts again, usually a minute or two
   after its Kernel-Power 41. Bug check.
3. **Else power lost, or Windows froze and was reset.** The event cannot tell these two apart, so the platform does not claim either.

The crash view returns `shutdownCauses` (counts by cause) and each timeline entry says its cause; the console shows "Why they restarted".

**The agent's half.** The event watch sent only the first line of each event's message. Since the follow-up PR, `eventlog.query`
returns, for Kernel-Power 41 only, the event's `BugcheckCode`, `BugcheckParameter1`, `PowerButtonTimestamp` and `SleepInProgress`
(`KernelPowerFields`), and the watch puts them in the event's `detail.fields`. The contract allows only those four names and only plain
decimal or 0x-hex numbers, so this is not a way to send other event data. Field values that are not plain numbers never decide a
cause. The Windows read of the fields runs only on Windows. While GitHub Actions cannot run (account billing), it can only be proven on a
real cabinet; the picking and the event are tested on Linux. The agent's check on values is exactly the contract's pattern (a
lower-case 0x only), so it never sends a value its own outbound check would refuse. A cabinet on an older agent sends no fields and keeps the step 2 and 3 classification.

**Why 10 minutes.** Long enough for a slow start after a blue screen, short enough that an unrelated blue screen hours later does not
claim a power cut. Worked out, not measured on cabinets.

**Proof.** `crashes.test.ts`: the rules with hostile field values; the pairing window both inside and just outside; a cabinet with four
restarts (no fields, button held, blue screen paired, bug-check field) counted 2 / 1 / 1 through the API, red with the classification
removed; and the demo's blue-screen cabinet classified as a bug check.

---

## D18. Drive risk classes, with thresholds an Admin sets (2026-11-03)

**Owner's decision.** Asked what "configurable rules" means for the spec's five drive classes (13-roadmap.md, line 5): an Admin sets
the thresholds, and the defaults follow the metrics drive makers and field studies already use ("most are the same").

**What is built.**
- **The classes.** Healthy, Attention, High risk, Critical, and Unknown for a drive with no stored assessment. They are the existing
  levels under their spec names (ok, watch, act, urgent), so stored history and alerts carry on unchanged. The API gives `riskClass`
  beside `level`; the console shows the class, with the advice (plan a replacement; back up now) next to it on the Fleet page too.
- **The thresholds** are a new `drives` group in Admin > Settings, saved like every other platform setting: a code bound to the exact
  change, an audit entry with before and after, Admin only, every value range-checked by the contract and again by the server. The
  server also refuses a set whose steps do not rise (for example Attention at or above High risk) and saves nothing. A stored set that
  is out of range or does not rise is read as the defaults. Drives are judged again on their next report (about daily).
- **What an Admin can set, and the defaults** (today's values, so nothing changes until someone changes them):
  - rated life used (SSD wear, NVMe "percentage used"): Attention 80%, High risk 90%, Critical 95%;
  - projected days until 100% of rated life: High risk 180, Critical 60;
  - temperature: Attention 60 °C, High risk 70 °C; a rise of 10 °C over 30 days is Attention;
  - new reallocated sectors: High risk at 1 in 7 days, Critical at 8 in 30 days.
- **What stays fixed**, because every source agrees on it: the drive's own failure prediction and a "failing" health are Critical;
  pending or uncorrectable sectors are High risk and Critical when they grow; any reallocated sector is Attention.

**Where the defaults come from** (the common reference points, not measurements of this fleet):
- Field studies of large drive fleets (Backblaze's published SMART statistics; Google's 2007 "Failure Trends in a Large Disk Drive
  Population") found that drives with any reallocated, pending or uncorrectable sectors fail far more often than drives with none, and
  that growth in those counts is the stronger sign. Hence any reallocated sector is Attention and growth is High risk or Critical.
- The NVMe specification's "percentage used" reaches 100 at the end of the drive's rated endurance; makers warrant to that point,
  not past it. Hence the wear ladder ends at 95%, short of 100.
- Drive makers commonly rate operation up to about 70 °C (SSDs) or 60 °C (many hard drives). Hence Attention at 60 and High risk at 70.

**Alternatives.** Fixed thresholds (nothing to misconfigure, but a release for every change); per-client thresholds (more flexible,
more to manage). Both were offered; the owner chose Admin-set fleet-wide values with industry defaults.

**Proof.** `trends.test.ts`: the class names, Unknown for no level, thresholds moving the line both ways, and non-rising sets
refused. `admin.test.ts`: the defaults, a change with a code, a non-rising change refused with nothing saved, hostile values refused
by the contract, Tier 2 refused. `drives.test.ts`: a stored threshold changes the class of a real report (red with the thresholds not
passed in). `console-admin-e2e`: an Admin changes "Critical at" in Settings with a code and it is stored (red against the old page).
`console-readings-e2e`: the Fleet page and the drive history show Critical, High risk and Attention.

---

## D17. The setup test waits 90 s for "Turn demo mode on"; the seed stays one cabinet at a time (2026-11-03)

**The failure.** `console-setup-e2e` failed twice in full runs: "the confirmed request was still running after 30 s (the dialog says
Confirming…)". Both times it was the "Turn demo mode on" step; it passed alone each time.

**Measured** (`enableDemo` alone on a fresh test database, this container, three runs): 22.7, 25.1 and 23.3 s in all. By phase
(runs 2 and 3): inserting the fleet 0.4–0.6 s; each cabinet's heartbeat, drift and time checks and events, one at a time, 8.7–9.2 s;
the history 5.0–5.3 s; configuration snapshots and baseline alerts 4.9–5.1 s; the fleet checks 0.5 s. So the step uses most of a 30 s
wait on an idle machine, and the suite runs two files at once.

**Decision.** The test gives that one step 90 s (`DEMO_ON_LIMIT_MS`); every other confirmation keeps 30 s. Proof: with the limit set to
15 s the test fails alone ("still running after 15 s"); at 90 s it passes alone (47 s for the whole test).

**Tried and rejected: seeding six cabinets at once.** Running the per-cabinet step six at a time made one statement exceed the
driver's 10 s limit (`ETIMEOUT`) on the first run: the cabinets of one site wait on each other in the database. Making that safe means
reworking the locking on the heartbeat and alert paths, which is not worth it for a demo seed, so the change was reverted.

**Cost.** An Admin waits about 20–25 s behind "Confirming…" when turning demo mode on. Speeding the seed up (for example by writing
the history and snapshots in fewer statements) is listed under the open fixes in remaining-phases.md.

---

## D16. A diagnosis that finds a problem opens the incident (2026-11-03)

**Owner's decision.** Asked what should create an incident, the owner chose: a diagnosis that finds a problem (over "a person opens
it" and "both").

**What is built.** One open incident per cabinet and module (`server/src/services/diagnosis-incidents.ts`):
- **Network diagnosis:** module `network-diagnosis`, from its findings. A problem counts once, through the finding that explains it.
- **Cabinet diagnosis:** one incident per cabinet module (`cabinet-storage`, `cabinet-time` and so on), from each area's state. The
  network area is left out: the network diagnosis run alongside records its own.
- **A problem** opens the incident if none is open, with the first problem as its symptom. Every run adds an evidence step with what it
  found and is linked to the incident.
- **Warnings only** add evidence to an open incident, and open nothing.
- **A clean run** adds evidence and closes the incident as resolved, by the platform. If a repair was running it is recorded as a
  passed verification instead, which ends the same way.
- **A run that could not tell** (a cabinet area that was not read; the network settings could not be read and no problem was
  found) changes nothing, so a cabinet that is offline or half-read never closes an incident by saying nothing.
- Steps and the opening are by the system actor `diagnosis`, audited like every incident step. A failure to record never fails the
  diagnosis: it is logged and the diagnosis stays done.
- Finding titles come from cabinet data, so they are made one line and cut to the record's limits, never refused.

**Why.** Every incident then has evidence behind it, nobody has to remember to open one, and "fixed" is shown by a later run rather
than asserted, which is what the incident record was for (diagnostic-engine-audit.md, section 7).

**Costs and limits.**
- Two diagnoses of the same kind on one cabinet finishing at the same moment could open two incidents. Both diagnosis kinds already
  share a running run per cabinet, so this needs two runs started more than a run's length apart and finishing together; not guarded
  further.
- An incident awaiting approval or approved, with no repair run yet, is closed by a clean run: the problem went away by itself.
- Beyond a cabinet's History tab, Triage's **Open incidents** view lists every incident that is not closed (built 2026-11-03, PR #146, fleet-wide and per client); the crash incident page is the next part.

**Proof.** `server/test/diagnosis-incidents.test.ts`: the outcome rules, open, add, close, reopen as a new incident, modules kept
apart, the repair-then-verify path, and hostile titles. `demo.test.ts`: a real network diagnosis on a demo cabinet opens the incident,
and the clean run after the one-click fix closes the same one. `troubleshooting.test.ts`: a real cabinet diagnosis of a failing drive
opens the storage incident. Each goes red with its wiring removed.

---

## D15. The SQL connectivity ladder runs in the network diagnosis, on sync port 1433 (2026-11-03)

**Decision.** The ladder is its own diagnostic module, `sql-connectivity-ladder`, now registered as built. The network diagnosis runs it
after its own checks, and its findings sit in the sync layer. It checks:
- only the sync cabinet;
- only port 1433, SQL Server's default;
- only when the site's sync ports include 1433.

Its database check counts against the agent's 10 network tests a minute, so with four sync ports including 1433, two DNS servers are
tested instead of three.

**Findings.**
- **Something other than SQL Server answers on 1433:** a problem (`sql-not-sql`). The likely causes are another program on the port,
  or SQL Server listening elsewhere.
- **SQL Server answers:** ok, with its version and certificate, and a note that no sign-in was tried.
- **SQL Server requires encryption with a certificate a checking client would not trust:** info (`sql-cert`). It only matters if the
  sync software checks certificates.
- **The check did not come back:** "could not check" (`sql-nc`).
- **A closed or silent port:** nothing new; the existing port tests already report it, so nothing is said twice.

**Why 1433 only.** The sync ports are whatever the site lists; the others may not be SQL Server at all, and a pre-login to a different
service only proves it is not SQL Server. 1433 is where SQL Server answers by default.

**Alternatives.**
- **Every sync port.** Rejected: it doubles the network tests and checks services that are not databases.
- **A separate "database port" setting.** Rejected for now: one more setting, and nobody has needed a non-default port yet. It is the
  change to make if a site does.

**Cost.**
- A site whose SQL Server runs on another port gets no ladder check.
- The fourth (and now third) DNS server goes untested when 1433 is among four sync ports.

**Proof.**
- `sql-findings.test.ts` covers each answer, what is left to the port tests, a sync cabinet, a diagnosis made before the ladder
  existed, and that the module declares exactly the causes the rule can raise.
- `network-module.test.ts` covers that the plan runs the check exactly when 1433 is a tested sync port, within the 10-test limit, and
  that the module declares exactly that read.
- An empty rule fails five tests; dropping the check from the plan fails two.

---

## D14. One-off security alerts close themselves after 14 days with no recurrence (2026-11-02)

**Decision (owner's, from three options).** Open security alerts of the event-driven kinds close automatically when they have not recurred
for 14 days. The kinds are write volume, failed sign-ins, failed step-ups, new location, new device, agent self-check, refused package,
signature failure and certificate. Each closure:
- has the resolution "No recurrence in 14 days; closed automatically";
- has no person as the resolver;
- writes an audit entry.

The check runs with the daily jobs. Nothing is deleted, and a recurrence opens a fresh alert.

**Why.** Product test 2026-11-02, finding 3: these kinds are raised by one event and nothing clears them, so the list became a
permanent backlog (four rows idle for 11+ days whose causes were gone), and a new alert was harder to spot.

**Options not chosen.**
- **Keep manual resolution, sorting stale alerts last.** The backlog still grows.
- **Mark stale alerts and move them aside without resolving.** Still needs a person for every one.

**Not included.**
- An audit chain break: a person must look before it closes.
- The `ops_*` kinds: they already close when their condition clears.

**Cost.** An alert nobody looked at within 14 days closes anyway. It stays in the resolved list and the audit log, marked automatic.

**Proof.** `security-stale.test.ts` checks:
- old certificate and new-device alerts close, with an audit entry and no person as resolver;
- a 13-day-old alert, a broken chain and an ops alert stay open;
- a second run closes nothing more;
- a recurrence opens a new alert.

Making the close a no-op, or adding `audit_chain` to the closable kinds, fails the test.

---

## D13. The SQL connectivity check: how it is built (2026-11-02)

The engine plan already decided *that* this check exists and that a login-free TDS pre-login is allowed
(`diagnostic-engine-execution.md`, decision 7). These are the choices made while building it.

**1. It runs in the network service, not the broker.** The plan says "implemented in the agent's broker". CLAUDE.md says the
broker never opens a network connection, and that rule does not bend. The check needs no rights, so the unprivileged network
service answers it, beside `network.test`. **This differs from the plan, for that reason.**

**2. The target is the sync cabinet only, on an allowed port.** The plan says "a target an Admin configured". The sync cabinet's
address and its ports are already set by Admins (per cabinet, site, client or fleet), and the agent already enforces them for
TCP tests:
- the address must be private and on the cabinet's own network;
- the port must be in the local allowed list or the site's sync ports.

Reusing that adds no new setting and no new way to aim the agent. **Rejected:** a separate "database target" setting, which
would be one more thing to configure and a second path to the same server.

**3. The steps are TCP, pre-login, then TLS inside TDS.**
- The pre-login offers "encryption off", so the answer says whether the server *requires* encryption.
- When the server supports encryption, the TLS handshake runs inside TDS packets, as SQL Server expects, so the certificate it
  presents can be read.
- The certificate is judged by the system's own checks: a certificate the system trusts completes the handshake, and anything
  else stops it, after the certificate has been recorded. Nothing is ever sent over the session.
- **There is no DNS step.** The target is an IP address set in the console, so there is nothing to resolve.
- **Not covered:** TDS 8 "strict" servers, which expect TLS before the pre-login. They would read as "not SQL Server" until
  that case is added.

**4. It counts against the 10 network tests a minute** (`rateClass: network_test`). It is a network probe like the others,
so the agent's limit on probing a client's network covers it.

**5. A hostile server is expected.**
- Every TDS packet is capped at 4,096 bytes and every pre-login option's offset and length are checked against the packet.
  Anything malformed is "not SQL Server", never a guess.
- The TLS handshake stops after 64 KB.
- Each step has the 5 s limit of a network test.

**Cost.**
- It opens a connection to the sync cabinet's SQL Server, which logs a pre-login with no login after it. A server that alerts
  on that would see one per check.
- The certificate check uses no revocation lookup (the cabinets' network has no route to revocation servers).

**Proof (Linux container).**
- `SqlConnectivityTests` (20 tests), against servers made in the test:
  - a SQL-like server with real TLS inside TDS;
  - one with no encryption support;
  - a closed port;
  - an HTTP server;
  - a silent listener, given up on at 5 s;
  - wrong packet types;
  - a junk handshake;
  - the size cap;
  - 8 malformed pre-login answers;
  - a cabinet with no sync cabinet.
- Every output was checked against the contract.
- Removing the size cap fails a test; removing the pre-login bounds check fails three.
- **Against the real SQL Server 2022 (16.0.4305) in Docker:** answered as SQL Server, encryption "off", and its self-signed
  certificate read, with "does not name this address" and "not trusted".
- The validator refuses a port that is not allowed and every hostile parameter tried (a host name, a user and password, a
  database name, a query). The server replaces any address or ports the browser sends; with that removed, its test fails.
- Agent Core: 819 of 819. Full server suite: 849 of 849, 1,257 s at `--test-concurrency=2`.
- **Demo and console.**
  - The demo's sync cabinets answer as a default SQL Server install, through the same result path as a real agent. That
    path rejects any output that does not match the contract.
  - `demo.test.ts` checks that the database check agrees with the TCP test of the same port.
  - `console-actions-e2e` clicks "Check the sync database" on a healthy satellite and reads the version and certificate, and
    on a blocked one reads "No answer".
- **One difference.** On a *sync* cabinet the server fills in no address. A real agent then checks the sync address in its
  own configuration, or reports "no sync cabinet" when there is none. The demo checks the sync cabinet's own address, as its
  TCP test already does.
- **Not run:** on Windows, and against a real sync server on a real cabinet network.

---

## D12. Console e2e tests launch the browser first, through one helper with a 30-second limit (2026-11-02)

**Decision.** All 25 console e2e test files start Chromium through `server/test/browser-launch.ts`, as the first thing in
the test, before they start a database, a server or the demo simulator. The helper:
- gives the launch 30 seconds (Playwright's default is three minutes);
- fails with a message that names which browser it tried (the `PLAYWRIGHT_CHROMIUM` path, or Playwright's own) and why.

**Why.** Every file launched the browser after starting its servers and simulator, and outside the `try` that stops them. When
the browser could not start, the test failed, but the servers kept the process alive. **Measured** here with a browser path
that does not exist: on `main`, `console-actions-e2e` was still running after 150 s and was killed; with this change it fails
in 2 s, exits, and the error names the missing path.

**Alternatives.**
- **Move each launch inside its file's `try`.** Rejected: the cleanup in each file is different, and a launch failure would
  still have started everything first.
- **A global hook that kills leftover browsers.** Rejected: it hides the cause instead of reporting it.

**Cost.** If a test's own setup fails after the browser started, the browser is not closed by that test. That is the same
kind of leak as before, now for the browser instead of the servers. A setup failure is rare, and the runner's per-test limit
still ends it.

**Proof.**
- `browser-launch.test.ts`: a missing browser is refused at once, naming the path; a browser that starts but never answers
  is given up on at the limit (a script that only sleeps, 3 s limit).
- All 25 e2e files with the real browser: 28 of 28 passed, 660 s.

---

## D11. A diagnosis waits up to two minutes and never plans more than ten network tests (2026-11-02)

**Decision.**
- The time a network or cabinet diagnosis waits for its reads goes from 60 s to 120 s (`RUN_LIMIT_MS`,
  `server/src/diagnose/network.ts`). Reads still unanswered at the limit are reported as "no answer within 2 minutes".
- The planned network tests never exceed the agent's limit of 10 a minute. When a cabinet has four DNS servers and four
  sync ports (11 tests), the fourth DNS server is the one left out.
- The console waits up to two minutes for an earlier check to finish, and the cabinet page says the diagnosis "usually takes
  under a minute, and up to two when something does not answer".

**Why the longer limit.**
- The wait already ends as soon as every read has answered (`waitFor`), so a healthy cabinet takes exactly as long as before.
  The limit only decides how much of a slow case is kept.
- The slow case is the one the diagnosis exists for: a sync cabinet that answers nothing. Worked out from the agent's limits
  (not measured), that costs:
  - about 21 s for the 10-request ping series;
  - 41 s for the four port series, each stopping after two silent tries (D1);
  - about 12 s for the trace towards it (four silent hops, three 1 s probes each);
  - plus the other reads.

  That is past one minute, so the port tests and the trace, the evidence that says where the path breaks, came back as "no
  answer within a minute". Two minutes covers it.
- Possibly related: the `troubleshooting.test.ts` failure at `e429b81` ran 62 s and lacked a finding. Not shown to be this.

**Why the cap on network tests.** The agent spec allows 10 network tests a minute and the agent refuses the 11th
(`RateLimiter.cs`). The plan could reach 11, so on such a cabinet one test was always refused. The spec sets the limit, so the
server stays inside it rather than the agent raising it. DNS servers are dropped first: Windows asks them in order, so a
fourth is asked only after three have failed, while each sync port is a service the sync application needs.

**Alternatives.**
- **Fewer tries once the sync ping gets no reply.** Rejected: all reads are issued together, so the server would have to wait
  for the ping first, which adds time in every case. ICMP silence also does not mean the ports are closed
  (`pathhealth-correlation.ts`), so the ports still need testing.
- **A limit worked out per plan.** Rejected: a fixed limit is easier to reason about and to show to people, and the early end
  already makes the normal case fast.
- **Raising the agent's limit.** Rejected: it is set by the spec and protects cabinets from being flooded.

**Cost.**
- In the slow case the person waits up to a minute longer, and sees every reading instead of "no answer".
- A cabinet with four DNS servers and four sync ports does not have its fourth DNS server tested.
- Two diagnoses on one cabinet within a minute still meet the agent's limit. The second's tests are refused, and the
  findings say so. Not changed here.

**Proof.**
- `network-module.test.ts`: every combination of 1 to 4 DNS servers and 0 to 5 ports stays within 10 tests, keeps every
  port up to four, and keeps the first DNS servers. With the cap removed, that test fails.
- The two-minute limit itself is not exercised by a test: that would need an agent that answers slowly for over a minute.

---

## D10. Audit appends run in their own transaction (2026-11-02)

**Decision.** Migration `0019_audit_append_atomic.sql` changes `audit_append` and `audit_append_many` so each runs in its own
transaction with `XACT_ABORT ON`. The bodies are otherwise unchanged. In `audit_append_many` the transaction opens after the
input checks, so refused input opens none.

**The bug it fixes.** This is a product bug, not only a test problem.
- When `audit()` is called outside a transaction (straight on the pool, as at least eight call sites do, for example
  `src/diagnose/cabinet.ts:70` when someone starts "Diagnose this cabinet"), each statement in the procedure commits on its
  own. The `UPDLOCK, HOLDLOCK` that is meant to serialize the chain then ends with the SELECT that takes it.
- Two calls can therefore read the same head and take the same sequence number. The duplicate-key error ends only that one
  statement, so the losing call still goes on to move the head.
- The head can then fall behind the log. From that point every append collides with an entry that is already there, and
  each audited action fails with a 500 until the head catches up.

**Evidence.**
- `troubleshooting.test.ts`, CI job 124775471652 at `b811d72`: "Diagnose this cabinet" got a 500, then every later sign-in
  in the file failed within one second. The app ran without a logger, so the error text was not recorded.
- Local reproduction with the test's fake clock 60 s behind the database's: the same burst (9 of 10 failed), **once**; two
  more runs with the same skew passed, so it is not a reliable reproduction. The `onError`
  hook added in #132 recorded `Violation of PRIMARY KEY constraint 'audit_log_pkey' ... duplicate key value is (27)` on
  POST /diagnose, then the same error on each sign-in. Why the clock skew made it appear in that file has **not been
  established**; the race does not need it.
- `test/audit-concurrency.test.ts` reproduces the race without any skew: rounds of 30 appends at once, single and batched,
  straight on the pool. **Measured** here (Linux host on 2 cores, `nproc` and the container's `cpu_count` agreeing;
  SQL Server 2022 CU27 in Docker): before the fix,
  231, 232 and 239 of 300 calls failed in three runs; after it, 3 of 3 runs passed with every append in place, sequence
  numbers 1 to N with no gaps, the head at the last entry, and the chain verifying.

**Alternatives.**
- **Wrap every caller in a transaction.** Rejected: there are 15 call sites that are, or may be, outside a transaction,
  and any future one would bring the bug back. Fixing it in the procedure covers every caller, present and future.
- **A SEQUENCE for the numbers.** Rejected: each entry's hash includes the previous entry's hash, so appends have to be
  serialized anyway. Unique numbers alone would still let two entries chain from the same predecessor.
- **Retry on a duplicate key in the app.** Rejected: by then the losing call has already moved the head, so a retry would
  not repair the chain.

**Cost.**
- An error inside an append now rolls back the caller's whole transaction (`XACT_ABORT`). Before, the error reached the
  app as an exception and the caller rolled back anyway, so behaviour only changes for a caller that caught and ignored an
  audit error. None does: the `catch` blocks near audit calls rethrow everything except their own refusals (checked with grep
  over `src/`).
- Appends made outside a transaction now hold the chain lock for the whole procedure instead of one statement. That
  serializes them, which is what the lock was always meant to do. The added wait has not been measured.

**Proof.**
- `audit-concurrency.test.ts`: two tests. The concurrency test above, and one that checks an append inside a caller's
  transaction still commits or rolls back with that transaction, and that refused input changes nothing.
- The existing database, audit and migration tests: 24 of 24 passed.
- Full server suite with the migration: 845 tests, 807 passed, 38 skipped, 0 failed, 604 s at `--test-concurrency=2`
  (**measured**, Linux host, 2 cores, 2026-11-02). The skips are unmet prerequisites, not failures: 23 need a built console,
  10 need `TEST_AGENT_DLL`, 5 need `pwsh`.
- `troubleshooting.test.ts` with the 60 s skew: 10 of 10 in two runs after the fix. That alone proves little, because the
  skew reproduced the burst only once in three runs before; the concurrency test is the proof.

**Relation to D3.** This race was found because the suite runs two files at a time. A serial run would have hidden it.

---

## D1. TCP test series: 5 seconds per connection, stop at a refusal or at two misses in a row (2026-11-01)

**Decision.** In a TCP series (`network.test` with `method: tcp` and `count` above 1, `NetworkTester.TcpSeriesAsync`):

- each connection gets 5 seconds, the same as the single TCP test (was 2 seconds);
- a refusal ends the series: the port is closed;
- two tries in a row with no answer (or unreachable) end the series;
- no try starts that could end past 80 seconds into the series;
- `statistics.sent` is the number of connections actually tried, not the number asked for.

**Why.** On the Windows CI runner a closed port was sometimes reported as "No answer ... within 2 seconds" instead of
"refused": the refusal came back inside 2 seconds on one run and not on another, on the same runner image (job 124714381133
failed, job 124722989775 passed). Why it was late, and how long Windows takes to report a refusal, have **not been
measured**. A fixed operating-system schedule would have been late on every run, not on one of two, so the cause is open.
A longer limit gives a late refusal more room to arrive; it is not a demonstrated bound (see Cost). A support person reading "no answer" looks for a firewall or a dead
link; "refused" means the sync application is not listening. Getting that word right is the point of the test.

Raising the limit alone would have made a port that never answers much slower, and the network diagnosis tests up to four
sync ports one after another inside a one-minute limit (`RUN_LIMIT_MS`, `server/src/diagnose/network.ts`). Reads still
running at the minute are reported as "no answer within a minute", so a slower series loses evidence in exactly the case it
is meant to explain (a firewalled sync cabinet). Stopping early keeps the series faster than before in both failure cases.

**Options compared** (a 5-try series, as the diagnosis asks for; times are **worked out** from the limits and the 300 ms gap
between tries, not measured):

| Option | Closed port | Port that never answers | Four silent ports | Room for a late refusal on Windows |
|---|---|---|---|---|
| Before: 2 s each, always 5 tries | up to 11.2 s | 11.2 s | 44.8 s | 2 s: sometimes not enough (one run of two) |
| 5 s each, always 5 tries | up to 26.2 s | 26.2 s | 104.8 s (past the 1-minute limit) | 5 s, not proven enough |
| 5 s each, stop at refusal only | one try (under 5 s) | 26.2 s | 104.8 s (past the 1-minute limit) | 5 s, not proven enough |
| **Chosen: 5 s each, stop at refusal or two misses in a row** | **one try (under 5 s)** | **10.3 s** | **41.2 s** | **5 s, not proven enough** |

Also considered and not taken:

- **A limit between 2 and 5 seconds (say 2.5).** How long Windows takes to report a refusal has not been measured, so any
  such number would be a guess.
- **A Windows socket option that stops the system resending the opening packet.** Not taken: it is Windows-only,
  cannot be tested here, and it changes what a try measures on a weak link (the resends are part of what a real connection
  from the sync application goes through). Whether it would affect late refusals at all is unknown, because their cause
  is unknown.
- **Stop at the first miss.** That is faster, but a weak link that loses one try would read as dead, and telling "dead"
  from "answers some of the time" is why the series exists.

**Why the 80-second budget.** The contract allows up to 20 tries. At 5 seconds a try, a weak link whose misses never come
two in a row could keep a 20-try series going for 105.7 s (worked out). That is past the agent's 90-second limit for the
whole operation (`OperationRunner.DefaultTimeout`), which would end it with no output at all. The budget stops the series
early and still returns the tries it made. Nothing in the product asks for more than 5 tries today (the diagnosis asks for
5, the watch link for 3), and 5 tries always fit inside it (26.2 s worst case).

**Cost.**

- **5 seconds is not a demonstrated bound.** The late refusal was intermittent, not a fixed delay, and its cause is not
  measured. If it can take longer than 5 seconds, a closed port on Windows can still read as "No answer", and the
  assertion that is now strict on every platform can fail on Windows again. Getting "refused" out of a closed port on
  Windows is the point of this change, so the next Windows runs are the evidence. What would measure it: time each
  refused connection on the Windows runner (a series against a closed loopback port, printing each try's duration and
  outcome) over many runs, and set the limit from that distribution.
- A weak link is reported as "not answering" when two tries in a row each fail within 5 seconds, even if a later try would
  have connected. Each try already includes the system's own resends of the opening packet, so this needs every packet of
  two tries to be lost.
- A link that dies part way through stops after two misses. The output still shows how many of the tries connected.
- A sync cabinet that is completely silent still takes the diagnosis past one minute: a 10-request ping series that gets no
  replies takes 20.9 s (worked out), and the four port series take 41.2 s, before the gateway and DNS tests. Before this
  change the same case took 20.9 + 44.8 s. Recorded as a follow-up; not fixed here.

**Contract.** `statistics` description in `network.test.schema.json` updated; the shape is unchanged (`sent` was already
1 to 20). The server already reads `sent` as "tries made" ("received of sent connected", `network-findings.ts`).

**Proof.**

- `HelperTests.A_tcp_series_counts_every_connection_and_tells_a_dead_port_from_a_weak_one` is strict again on every
  platform. It requires "refused" and one try for a closed port.
- `A_tcp_series_ends_at_a_refusal_or_at_two_misses_in_a_row_and_nowhere_else` checks the stop rule over six try
  sequences.
- Four mutants of the rule were each caught by a failing test: three misses instead of two, one miss, no stop at a
  refusal, and a count that does not reset.
- No test on Linux can fail for the 2 s to 5 s change itself: a refusal on loopback comes back at once, so the strict
  assertion passes with either limit there. That change is exercised only on Windows.
- `A_tcp_series_never_starts_a_try_that_could_end_past_its_budget_and_the_budget_ends_before_the_operation_limit` checks
  the budget's edge and that it stays under the operation limit; both budget mutants were caught. That the loop consults
  the budget is not covered by a test: it would need a real series of more than 80 seconds.
- Agent Core suite: 791 passed on Linux.
- **Not proven on Windows yet.** GitHub Actions is on hold; the next Windows run is the proof.

---

## D2. Check the SQL Server Express installer before running it on CI: yes, built when Actions resumes (2026-11-01)

**Decision.** Before the Windows CI job runs the SQL Server Express installer as administrator, check that it is the file
Microsoft published. Two checks:

- its Authenticode signature is valid and signed by Microsoft;
- its SHA-256 matches a value pinned in the repository.

**What it is for.** The installer arrives through a Chocolatey package (`deploy/ci/windows-sqlserver.ps1`) and runs with
administrator rights on the runner that builds and tests the agent. A swapped package or download would run there with full
control, and could change test results or what the job builds. The check stops a tampered installer before it runs. It is
the same rule the repository already follows for actions, images and packages: pinned, not trusted by name
([supply-chain.md](supply-chain.md)). It protects CI only; nothing on a cabinet or the server is affected.

**Why not now.**

- The pinned hash has to come from the real file. This container cannot reach download.microsoft.com or
  community.chocolatey.org, so I cannot fetch the file to hash it or read the package's own install script.
- Checking the file before it runs means downloading it in our script instead of letting Chocolatey do it. That changes
  how the install works, and only a CI run can prove the change. Actions is on hold.

Writing it now would put an unproven change into the one CI step that took the longest to get working.

**Alternatives.**

- **Signature check only.** It needs no stored hash, but any Microsoft-signed file would pass, including another version.
- **Hash only.** This breaks silently if Microsoft re-publishes the file.

Both together cover both cases.

**Status.** Decided, not built. Tracked as open in [09-open-decisions.md](../spec/09-open-decisions.md) until it is built and
proven on CI; first item when Actions resumes.

---

## D3. Server tests stay at `--test-concurrency=2` (2026-11-01)

**Decision.** Keep running the server suite two test files at a time (`server/package.json`).

**Why.**

- The production server handles many requests at once. Running two files together exposes the same kind of contention: two
  writers on one table, a connection pool running out, ordering assumptions. The open `troubleshooting.test.ts` burst
  (a 500 followed by sign-in failures within a second) was found this way. A serial run would hide it, not fix it.
- Time: the suite took 18.6 and 20.1 minutes at concurrency 2 on CI (**measured**, jobs 124747977897 and 124747966648). How
  much longer a serial run takes has **not been measured**; it is expected to be longer, because the files mostly wait on
  the database.

**Alternatives.**

- **Serial.** Rejected because it hides real contention bugs.
- **Higher concurrency.** Not tried. CI has one SQL Server, and more parallel files would mean more lock waits, so
  failures that come from the test setup, not from the product.

**Cost.** The two tests that are not yet root-caused (the troubleshooting burst and the console-setup confirm) can fail a
run until they are fixed. Both now report their cause when they fail ([remaining-phases.md](remaining-phases.md)).

---

## D4. Windows CI gets SQL Server from a pinned Chocolatey package (2026-11-01, PR #132)

**Decision.** When the runner has no `SQLEXPRESS` instance (windows-2025 images carry none), install
`sql-server-express` version `2022.16.0.1000` with Chocolatey. Then set mixed-mode sign-in, TCP 1433 and sa
(`deploy/ci/windows-sqlserver.ps1`).

**Why.** The platform's database is SQL Server, so the Windows end-to-end and upgrade steps need a real one on the runner.
Chocolatey is already on the runner image, and pinning the version makes every run install the same build.

**Alternatives.**

- **A SQL Server container.** Windows runners do not run the Linux SQL Server image.
- **Downloading from Microsoft directly.** That is the shape D2 will take, once it can be proven on CI.

**Proof.** Run 41281942671 at `b811d72` was green on both jobs (**measured**).

---

## D5. CI approvals pass `--baseline capture` (PR #132)

**Decision.** The CI enrollment steps approve their cabinet with `--baseline capture`.

**Why.** Since 8c-1 an approval must say what happens to the cabinet's configuration baseline. A fresh CI database has no
baseline to attach, so capturing one from the cabinet itself is the only choice that needs nothing prepared. It also
exercises the capture path on real Windows.

**Proof.** Green at `b811d72`.

---

## D6. Server test step limit: 40 minutes (PR #132)

**Decision.** `timeout-minutes: 40` on the server suite step. The step prints the failing tests at the end.

**Why.** The suite took 18.6 and 20.1 minutes (**measured**, see D3); two earlier runs were cancelled at the old 15-minute
limit. 40 minutes is about twice the slowest measured run. That leaves room for a slow runner while still stopping a hang
within the hour.

---

## D7. Windows upgrade step limit: 75 minutes (PR #132)

**Decision.** `timeout-minutes: 75` on the M7 upgrade step.

**Why.** Each rollout waits for the cabinet's next check-in (5 minutes). The step took 33 minutes without the
failed-upgrade case (**measured**, 2026-11-01). With all four cases it took 41 minutes at `b811d72` (**measured**, run
41281942671). 75 minutes is about 1.8 times the full measured run.

---

## D8. Database setup waits up to 300 seconds per statement (PR #132)

**Decision.** `requestTimeout: 300_000` in `deploy/database-setup.mjs`.

**Why.** Creating the database grows its log to 1 GB, and SQL Server writes out the whole file. On a slow or busy disk that
takes longer than the driver's default 15 seconds, and setup then failed half done. 300 seconds is a ceiling that still
stops a real hang; it is not a measured duration. This is one-off setup, so a long wait costs nothing in normal running.

---

## D9. Result outbox: each pending result gets a strictly later write time (PR #132)

**Decision.** `ResultOutbox.StampPending` sets each pending result file's write time to the clock's time, or to 1 ms after
the previous stamp when the clock has not moved on.

**Why.** After a restart the agent sends pending results in the order of their write times. Two results written within the
file system's time resolution, or under a frozen clock, could come back out of order. A result put back in the queue also
kept its old delivery time, which would have sent it first. A file system that refuses the change leaves the time it had:
the result is still sent, only perhaps out of order.

**Alternative.** A sequence number in the file name. Rejected because it changes the on-disk format, and pending files from
an older agent would need migrating.

**Proof.** Frozen-clock and re-queue tests in the agent Core suite.
