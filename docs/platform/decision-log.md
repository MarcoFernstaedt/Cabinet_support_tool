# Decision log

Every choice made while building, with why, what else was considered, what it costs, and how it was proven. Kept for the
end-of-project review, where each one is gone over again. Newest first. Figures say whether they were **measured** (with
where) or **worked out** from limits in the code; nothing here is an estimate presented as a measurement.

---

## D51. The trends say where they were cut (2026-11-08)

**What the code did** (F17, "keep the limit on screen"): the trends answer was cut silently:
- 100 issue types and 200 errors in `errorTrends`;
- the 40,000 busiest error groups a day in `computeTrendDay`.

A cut list read as the whole, so an error ranked 201st or dropped on a flood day was invisible without a sign that anything was missing.

**The decision** (mine, within the brief):
- **The answer carries its limits.** For each list, how many are shown and how many matched, and the days at the per-day group limit.
- **The page says so.** The Error trends view shows a note only when something was cut, with the way to narrow it: a client or a mark.
- **The limits stay.** They keep one answer and one night bounded; what changes is that they are never silent.

**Cost.** One grouped count over `error_daily` for the 30-day window, beside the reads the answer already makes.

**How it was proven.** `server/test/trend-limits.test.ts`:
- 205 different errors give 200 listed and `{ shown: 200, matched: 205, limit: 200 }`, with no day at the group limit.
- A day with 40,000 groups is named in `daysAtGroupLimit`.

The red check: with "matched" reported as the rows shown, the first test fails.

---

## D49. One writer per background job across instances: a lease per job (2026-11-08)

**What the code did** (F21.R1): `server/src/main.ts` runs every background job in the primary process (node:cluster workers serve
agents only), so one host never runs a job twice. Nothing stopped two instances on two hosts from both running every job: two offline
checks, two retention runs, two demo simulators answering the same commands, two resumes of the same fleet job.

**The decision** (mine, within the brief's "single-writer under a named lock or a job row"): a job row, not a held lock.
- **A lease per job.** `job_leases` (migration 0030) holds one row per job name with its holder and when the lease runs out. An instance
  runs the job only while it holds the lease and renews it every run. Each lease outlasts its interval, so the holder keeps it.
- **Takeover only after a lapse.** Another instance takes a lease only once the holder has stopped renewing and the lease has run out:
  after a crash or a shutdown, at most one lease length later.
- **One statement, two cannot win.** Taking and renewing is one `MERGE … WITH (HOLDLOCK)`, so two instances asking at the same moment
  cannot both get it.
- **A failed read is "not held".** The job is skipped that time, never run by two.
- **Why not `sp_getapplock` held for the job.** A session-owned lock needs one connection kept for the whole job, and a long job (retention,
  the chain check) would pin it. A transaction-owned lock would put the job inside one transaction. A lease row needs neither, and survives
  a dead holder by running out.
- **Covered:** the minute loop, the replacement re-apply, resuming fleet jobs at start, the daily chain check and retention, the hourly
  prune, the operations checks, the error trends and the demo simulator.
- **Not covered:** per-poll and per-request work (agents, console), which is not a background job. A fleet job's own batches already run
  under row locks once started.

**Cost.** One indexed statement per job run: about one a minute, plus one a second while demo mode is on.

**How it was proven.** `server/test/job-lease.test.ts`, on a real SQL Server:
- 25 rounds of two instances asking for one lease at the same moment: exactly one wins each time.
- The holder renews, and the other is refused while the lease runs. Once it has run out the other takes it over, and the first is then
  refused.
- A job run by two instances' loops for 10 rounds runs 10 times, always by the same instance. When that one stops it moves to the other.
- A lease that cannot be read runs nothing.

The red check: with `takeLease` granting every request, tests 1 to 3 fail. `maintenance.test.ts` and `demo.test.ts` still pass with
the guards in place.

---

## D48. Firmware that differs from its model's expectation is a named, minor alert (2026-11-08)

**What the code did** (F19.R7): the agent already reads the BIOS version and date into the `hardware` item of the `system` category,
and baselines can already be approved for a model and expect any field of any item. So a model baseline expecting `biosVersion` already
made a cabinet on other firmware drift. But drift only feeds health (and only a required item degrades it), and nothing raised an alert.
Old or silently changed firmware stayed a line in a drift list, and the brief asks for "detect, alert, hand to a human".

**The decision** (mine, within the brief):
- **Raised from the drift.** When a cabinet's drift includes the hardware item's `biosVersion` or `biosDate`, one minor alert opens:
  issue type `firmware_drift`, migration 0029. It reads "BIOS 1.12.0, expected 1.18.0; BIOS date …", and the title follows the latest
  drift.
- **Closed automatically.** When the drift clears, the alert closes through `closeAutomatically`, audited by `firmware-drift`.
- **Minor, not major.** Firmware that differs is a risk to look at, not a failure. A required item in the baseline still degrades health
  for whoever wants that.
- **Equality, not "at least".** A newer, unplanned firmware is drift too: the brief names "silently changed" beside "old", and the fix for
  an approved newer firmware is to approve it in the baseline.
- **Never flashed.** The platform never updates firmware. A vendor's signed driver package installs like any other package.

**How it was proven.** `server/test/firmware-drift.test.ts`, through the real baseline approval, ingest and drift:
- A cabinet of the model on older firmware opens one minor alert naming both values. Reporting the expected firmware closes it, audited
  by `firmware-drift`.
- A cabinet that matched and then reported a newer, unplanned firmware opens it. A cabinet of a model with no baseline opens nothing.
- The title shows "unknown" for a missing value.

`baselines.test.ts` and `audit-sweep.test.ts` still pass.

The red check: without the firmware check in the drift evaluation, tests 1 and 2 fail.

---

## D47. A close found by the cabinet's reading names the fix it verifies, with before and after (2026-11-08)

**What the code did** (F18.R1): an alert whose condition the cabinet's own reading shows gone was already closed by the platform, and the
close was audited (F4). The time zone, clock, firewall policy, service watch and network baseline checks all work this way. The
platform writes that fix those issues already return their before and after (`time.setZone`, `firewall.applyPolicy`, `service.control`,
`network.setDns`, and so on). But nothing joined the two: the audit said "closed automatically", never "closed because the zone change
person X made at 10:02 took, from Pacific to Eastern".

**The decision** (mine, within the brief):
- **Joined in the one closing path.** `closeAutomatically`, which every automatic close goes through, looks up the fix for each closed
  alert: the newest successful platform write of an operation that fixes that issue type, on that cabinet, since the alert opened.
- **What the audit records.** The entry's `verifiedFix` carries the command, operation, who, when, and before and after from the write's
  own result. `time.sync` gives the last successful syncs and `network.renewLease` the address before and after; a test reads every
  fixing operation's output schema, so one that reports no such pair cannot be added to the list.
- **No credit without a fix.** `verifiedFix` is null when nothing the platform did since the alert opened explains the close, so a
  cabinet that put itself right is never shown as fixed by someone.
- **Why since the alert opened.** A write from before the alert did not fix it; crediting it would be wrong.
- **Bounded.** At most 100 closes in one call look the fix up (one indexed read each). A fleet-wide sweep that closes more audits the
  rest without it.

**How it was proven.** `server/test/verified-fix.test.ts`, through the real time check:
- A cabinet in the wrong zone opens the alert. A `time.setZone` the platform ran, then the cabinet's next reading showing the site's
  zone, closes it. The audit names `time.setZone`, the person, and Pacific → Eastern.
- A cabinet that put itself right is closed with `verifiedFix: null`. A write from an hour before the alert opened is not credited.

`audit-sweep.test.ts` still passes.

The red check: with the lookup removed, the first test fails. The review of #201 found that `network.renewLease` reports
`addressBefore`/`addressAfter`, which the first version did not read; the third test now covers every fixing operation's output schema,
and it fails with that pair taken out.

---

## D46. A fleet job's cabinet that never took the command is "offline", not "failed" (2026-11-08)

**What the code did** (F18.R2): `fleet-jobs.ts` recorded each cabinet's final state as skipped, failed, verified, not verified or
cancelled. A cabinet out of contact for the whole job, whose command expired without being delivered, was "failed" with "did not answer
before the command expired". A cabinet that took the command and then went quiet read the same. The brief asks for per-cabinet final
states that are not uniform, offline among them. These two need different next steps:
- **Offline:** nothing was tried on it. Bring it back and run the job again for it.
- **Took the command and went quiet:** the change may have been made. Check it.

**The decision** (mine, within the brief):
- **A new final state, `offline`** (migration 0028 widens the state check). It is used when the command expired without ever being
  delivered.
- **Still `failed`** when the command was delivered and expired unanswered, with the detail "took the command but did not answer; check
  whether the change was made".
- **Counted as a problem.** The list of jobs counts offline with failed and not verified. The sync-cabinets-last rule already treats
  anything but verified or skipped as doubt, so an offline satellite still holds its sync cabinet back.
- **Shown.** The console shows "Offline: not reached".

**How it was proven.** `server/test/fleet-jobs.test.ts`:
- The existing partial-failure test now expects the never-delivered cabinet to be offline. The other cabinet is verified, the counts
  are one offline and one verified, and the list of jobs counts one problem.
- A new test: a cabinet whose command was delivered and then expired is failed, with "took the command but did not answer".

The red check: without the offline branch, the partial-failure test fails.

---

## D45. "Nothing to compare" always says why (2026-11-08)

**What the code did** (F8.R5): with no healthy mark, `/compare-healthy` returned an empty answer, and both tabs said "This cabinet has not
been seen healthy" for every cause. That one sentence covered six different situations, each with a different next step:
- not judged yet;
- no configuration reported;
- no approved baseline;
- judged and never healthy;
- healthy once with no mark kept;
- a mark whose configuration is gone.

The last one was shown as a list of "unavailable" categories under a heading that implied there was a comparison.

**The decision** (mine, within the brief): one reader, `nothingToCompare`, in `since-healthy.ts`.
- **No mark:** the reason is the health evaluation's own (F8.R1), else `no_mark`.
- **A mark kept but every one of its categories unavailable:** `versions_pruned`.
- **Something to compare:** null.

Both routes return it, and both tabs show one sentence per reason, saying what would change it. The wording is defined once, in
`ConfigParts.tsx`.

**How it was proven.** `server/test/nothing-to-compare.test.ts`, through both routes, which must agree:
- A new cabinet is `not_evaluated`. After the real evaluation of a cabinet that reported nothing, it is `no_configuration`. With
  configuration and no baseline, the real evaluation gives `no_baseline`. A judged, never-healthy cabinet is `never_healthy`. A cabinet
  healthy once with no mark is `no_mark`.
- A mark pointing at a version no longer kept is `versions_pruned`. A mark of what is in force now is comparable, so null.

The red check: with the reader always returning null, both tests fail.

---

## D44. "What changed since it was healthy" is one route, ranked by closeness to the problem (2026-11-08)

**What the code did** (F8.R4): the answer was spread over four routes and two tabs.
- `/drift` gave the drift from the baseline.
- `/config-changes` and `/config-history` gave the changes, newest first, marking those within an hour before the problem.
- `/compare-healthy` gave the comparison with the mark.
- `changesSinceHealthy` on the health view was only a count.

Nothing put the changes in the order a technician needs: the ones nearest the moment the cabinet stopped being healthy.

**The decision** (mine, within the brief):
- **One route.** `GET /api/cabinets/:id/since-healthy` returns the health, the drift, the comparison with the mark (F8.R3's lists
  included) and the configuration changes since the mark, in one read.
- **Ranked by closeness to the problem.** The order is by absolute distance in minutes from when the problem was first observed
  (`cabinet_health.degraded_since`). At an equal distance, the change before comes ahead of the one after, because a cause comes before
  its effect. While the cabinet is healthy there is no problem to measure from, so the order is newest first. Each change carries its
  signed distance.
- **Closeness, never cause.** The page says this order is about time only, as the history already does.
- **Bounded.** At most 200 changes, read from the 400 newest since the mark.
- **No route removed.** `/compare-healthy` stays for the Compare tab and anything else that reads it.

**How it was proven.** `server/test/since-healthy.test.ts`, through the real ingest and the real route:
- A degraded cabinet with changes 20 minutes before, 5 before and 5 after the problem: the answer ranks them 5 before, 5 after, 20
  before. It carries the health, the problem time, empty drift (no baseline), the comparison with all three, and where the changes start.
- A healthy cabinet lists its changes newest first with no distance. An unknown cabinet gets 404; no session gets 401.
- `rankChanges` on its own: distance first, before ahead of after on a tie, newest first without a problem.

The red check: with the order changed to newest first, tests 1 and 3 fail.

---

## D43. A service set to restart the computer is a named, minor alert (2026-11-08)

**What the code did** (F14.R3): `services.list` has always returned each service's recovery actions (`ServiceRecovery` in the agent's
contracts). The Services tab showed only the first one, as muted text ("On failure: restart"). A "reboot" in the second or later
actions was never shown at all, and nothing raised an alert. A service that keeps failing with such a setting restarts the cabinet over and
over, and each restart then looks like a crash.

**The decision** (mine, within the brief's "visible and alertable"):
- **Raised from the reading.** When a `services.list` result is stored, a "reboot" in any of the three actions opens one alert per
  cabinet: issue type `service_reboot_recovery` (migration 0027), **minor**, titled with the services, up to five and then how many more.
  The check runs in the same transaction as the stored result.
- **Minor, not major.** It is a setting that makes a failure worse, not a failure. Major alerts make the cabinet unhealthy; this should
  not.
- **The title follows the reading.** The alert fold keeps an open alert's first title, and this one lists names, so the service updates it.
- **Closed when it is gone.** The next reading with none closes the alert automatically, through `closeAutomatically`, audited as
  `alert.resolve` by `service-recovery` (F4).
- **Visible.** The Services tab shows a warning badge, "Restarts the computer if it fails", for any of the three actions.

**What it does not do yet.** The reading is on demand (the Services tab, a diagnosis). Making recovery actions part of the stored services
configuration, so a change to them is drift and is seen without anyone looking, needs the agent's config builder (F14.R1, with the
dependencies), and the agent cannot be built here.

**How it was proven.** `server/test/service-reboot-recovery.test.ts`, through issue, take and store of a real `services.list` command:
- A restart of the service itself opens nothing.
- Two services with a reboot in any position open one minor alert of the new type naming both. The same setting seen again updates that
  alert and its title.
- A reading with none closes it, audited by `service-recovery` with `automatic: true`.
- The title stops at five names.

`audit-sweep.test.ts` still passes, so the close goes through the audited path.

The red check: with the hook removed from `storeResult`, the first test fails.

---

## D42. "Changed since healthy" also lists what changed and came back (2026-11-08)

**What the code did** (F8.R3): `compareWithHealthy` in `cabinet-health.ts` skips a category whose version now equals the mark's, and
diffs the rest item by item. Both snapshots are compared item by item already. What the comparison could not see is anything that
changed and changed back: an item set A → B → A, or a whole category that returned to the marked version. It reads as "nothing differs"
though the change records hold the changes, and a change that came and went can be the very thing that made the cabinet unhealthy at the
time.

**The decision** (mine, within the brief):
- **Read both sources.** Keep the end-state comparison as it is, and also read the change records since the mark. Every item they name
  that is not in the end-state list is returned as `changedAndBack`, with the number of changes and when last.
- **No guessing for categories that cannot be compared.** A category whose old version is gone is still reported as unavailable, and its
  in-between changes are not called "back as they were".
- **Say when the list may be short.** `interimComplete` is false when the mark is older than change records are kept (the events
  retention), because older changes have been pruned.
- **On screen.** The Baseline tab's "Since last healthy" shows the list under its own heading, 50 at most with a pointer to the History
  view.

**Cost.** One grouped read of `config_changes` for one cabinet since one time (indexed by cabinet), capped at 500 rows. No new storage.

**How it was proven.** `server/test/changed-and-back.test.ts`, through the real ingest and the real route:
- A service disabled and then restored after the mark: no end-state difference, and listed once with 2 changes and the time of the last.
- Two services changed; one stayed changed and one came back: each is in its own list.
- A mark older than the 90-day default keeps says the list may be incomplete; a cabinet with no mark returns empty lists.

The red check: with the list emptied, tests 1 and 2 fail.

---

## D41. Last known healthy is the health evaluation's, everywhere (2026-11-08)

**What the code did** (F8.R1): two values had the same name.
- **The cabinet's page** (`fleet.ts:179-181`): before the oldest open alert began; with none open, now when online, else the last
  heartbeat.
- **The configuration health and its comparison** (`cabinet_health.last_healthy_at`): the last time the evaluation judged the cabinet
  healthy against its baseline.

So a cabinet with an open minor alert could read "3 hours ago" on its page and "healthy" on its health tab. A cabinet with no baseline
read "now" on its page though nothing had judged it.

**The decision** (mine; the brief asks for one definition and leaves which to me): the health evaluation's.
- It is the one "changed since healthy" compares against. A page that says "healthy 3 hours ago" while the comparison starts from a mark
  of yesterday sends a technician to the wrong window.
- It is judged against something: the approved baseline, required items, major alerts and contact.
- The page's old value counted any open alert, minor ones too, and called "online" healthy. Neither is a judgement.
- **With no time,** the page says why rather than guessing: not judged yet, no configuration reported, no approved baseline, or never seen
  healthy. That is part of F8.R5's honest empty state, here for the page.

`lastKnownHealthy()` in `cabinet-health.ts` is the one reader. The cabinet detail route returns it as `lastHealthy`, and `lastHealthyAt`
stays as its time, though nothing in the tree reads it now: the cabinet summary reads `lastHealthy`. The cabinet timeline already used `cabinet_health.last_healthy_at`.

**Cost.** One indexed read by primary key in place of the alerts aggregate the page ran before.

**How it was proven.** `server/test/last-known-healthy.test.ts`, through the cabinet and condition routes:
- Judged healthy with an open minor alert: "now" on both.
- Degraded since being healthy 5 hours ago, though online and clear: the same 5 hours on both.
- Offline for 2 hours, last healthy a day ago: a day ago, not the last heartbeat.
- With no time: not evaluated, no configuration (the real evaluation of a silent cabinet), no baseline, never healthy.

The test in `scale.test.ts` that pinned the old value ("now when online and clear, the start of the oldest open alert otherwise") is
replaced by this one, since that is the behavior F8.R1 removes.

The red check: with the page's old computation restored, both tests fail.

---

## D40. The healthy mark in use is never pruned: kept by the prune, held by the database (2026-11-08)

**What the code did** (F8.R2): `keepMark` in `server/src/services/cabinet-health.ts` prunes marks after adding one (30 days, always the
newest 10, a cap of 60). The mark `cabinet_health.last_mark_id` points at was the one just added, the newest, so it could not be pruned
in practice. But nothing stated that, nothing tested it, and nothing stopped another path (a retention job, a manual delete) from
deleting it. The brief's "a mark can be pruned while it is referenced" was a risk without a guard, not something seen happening.

**The decision** (mine, within the brief): both of the guards the brief allows.
- **The prune skips the mark in use**, whatever its age or rank, in the same statement.
- **A foreign key** from `cabinet_health.last_mark_id` to `healthy_marks.id` (migration 0026) makes the database refuse any other
  deletion of it, and any reference to a mark that does not exist. A reference already pointing at nothing is cleared first; none is
  expected. Removing a cabinet still removes both, through the existing cascades.

The config versions a mark points at were already kept (`config-ingest.ts`, any version a healthy mark points at), so a kept mark can
always be compared.

**How it was proven.** `server/test/health-mark-reference.test.ts`:
- 70 marks older than 30 days, with the cabinet pointing at the third: the prune keeps the newest 10 and that one, and removes the other
  59. With 65 recent marks and the cabinet pointing at the oldest, the cap keeps 60 plus that one.
- The database refuses to delete the mark in use and to point at a mark that does not exist; another mark deletes normally; removing the
  cabinet removes its marks and its health row.

The red checks: without the prune's exclusion, the first test fails (the database refuses the delete); without the foreign key, the second
fails.

---

## D39. Bulk import: clients and sites from a pasted list; cabinets by enrolling (2026-11-08)

**The decision** (F6.R4; mine, within the brief, as the owner asked me to take the recommended choice and record why):
- **What is imported.** Clients and sites: one line per site, naming its client. A preview says, line by line, what would be created and
  what exists already, and saves nothing. The import takes one authenticator code bound to exactly those rows.
- **What exists is used.** A client or site already there is matched the way the database's unique indexes match names (capitals do
  not make a new one) and left as it is. The same list can be imported again after new lines are added; a list with nothing new is
  refused, so a repeat does not look like work done. The same site listed twice is a mistake in the list and is refused.
- **All or nothing.** One transaction: the code, every new client and site with the same audit entry it has when created on its own
  (marked `via: import`), and one `fleet.import` entry. A list that half imports is harder to reason about than one that did not import.
- **Cabinets are not imported.** A cabinet exists once it enrols with its own key and an Admin approves it. Importing cabinet records
  would create cabinets with no identity, and importing installer tokens would be a second way to hand out enrolment secrets. A site
  installer for up to 100 cabinets (D35) and batch approval (D36) already make many cabinets one action.

**Why a pasted list and not a file upload.** The platform has no general file transfer by rule, and a list of names is text. A
spreadsheet's copy pastes as tab-separated lines, which the console reads as well as commas. The console only shapes the text into rows;
the server checks every name against the contract (no control characters, no markup, no leading or trailing spaces, 1 to 128
characters) and decides what exists.

**Limit.** 200 rows per import, so one transaction stays short (worked out: at most 400 inserts and their audit rows).

**How it was proven.** `server/test/fleet-import.test.ts`:
- A preview of four rows against one existing client and site reports one new client (named twice with different capitals) and three
  new sites, and saves nothing. The import creates exactly those, with their audit entries. The same list again is refused with
  `nothing_to_import`; extended by one line, only that line is created.
- Refused, creating nothing: Tier 2, no code, a code confirmed for one row used for two, a site listed twice, a list naming a demo
  client, and eight hostile bodies (empty, a missing site, a padded name, markup, an extra field, a control character, 129 characters,
  201 rows).
- With the database refusing the second site (a trigger the test adds), neither the client nor the first site nor their audit entries are
  kept.
`console/test/import-rows.test.ts` covers reading the list (commas, tabs, quotes, a heading, bad lines named by number), and
`server/test/console-fleet-import-e2e.test.ts` previews and imports a list in a real browser.

The red checks: without the transaction around the inserts, the third test fails; without the existing-name lookup, the first fails.

---

## D38. Where a cabinet's settings come from: read, never copied (2026-11-08)

**The decision** (F6.R5; mine, within the brief's requirement):
- **Inherit by reading.** A new cabinet inherits every setting with a parent scope because every such setting is resolved when it is read,
  cabinet → site → client (→ role or model where the setting has one) → fleet. Approval writes nothing of them onto the cabinet. This was
  already how each setting worked; R5 proves it for all of them at once and shows it.
- **One read, the enforcing resolvers.** `GET /api/cabinets/:id/setting-origins` lists, for each such setting, the level that applies,
  every level that sets it, and any level whose stored value was refused. It calls the resolver each setting is enforced with
  (`sitePolicy`, `siteTimeZone`, `syncPortsForSite`, `scannerLevels`, `watchLevels`, `appLevels`, `allowlistLevels`, `usbPolicyLevels`,
  `approvedFor`), so the console cannot name one origin while the cabinet follows another.
- **Shown where the settings are.** The Standards tab gains approved programs, file-facts paths and USB watch lines, the sync line says
  where its ports come from, and each line's window names the other levels that set it and any refused one.

**Why read and not copy.** A copy taken at approval goes stale the first time the site or client changes, and then the cabinet silently
differs from its siblings. Reading keeps one value per level and makes a change at the site reach every cabinet there.

**Why a refused level is shown.** A level whose stored list fails its own hash denies everything; it does not fall through to the level
above. Showing it as "not set" would hide why a cabinet may do nothing.

**Alternative.** Each tab reading its own setting's levels, as before. Rejected for the three settings with no line on the Standards tab,
and because a new setting would have nowhere it must be added; the schema test below now makes that a failing test.

**How it was proven.** `server/test/setting-origins.test.ts`:
- With settings at the fleet, client and site, a cabinet approved through the real route follows each from the right level, and its own
  columns stay empty.
- A cabinet's own scanner IDs win; an empty site port list still overrides the fleet's; a damaged site approved-programs list and a damaged
  client USB policy are reported as rejected.
- The read needs a session and a live cabinet: no session 401, a bad or unknown id 404, a removed cabinet 404.
- Every column on `clients` and `sites` is either a setting the read covers or on a short list of things that are not settings, so a new
  column fails the test until it is added.
`server/test/console-setting-origins-e2e.test.ts` opens the Standards tab in a real browser and checks the new lines and the refused note.

The red checks: without the route, every test in the first file fails; with a setting left out of the read, the order check fails.

---

## D37. Applying a site's standards: from its own cabinets, or copied from another site (2026-11-08)

**The decision** (F6.R3; mine, within the brief): a site's standards are applied in one action, from one of two sources.
- **"Suggested":** what the site's own cabinets report, as `siteStandards` already worked out.
- **Another site's own settings:** a site set up the way this one should be.

Each chosen part goes through the writer it has when set on its own (`writeNetworkBaseline`, `writeSiteTimeZone`, `writeSitePolicy`),
with that part's audit entry, all in one transaction. A part with nothing to apply is skipped with the reason, and nothing at all to apply
is refused. It is an Admin action with a code bound to the request, because it can set the firewall policy, which is Admin only on its
own; an Admin who does not want the firewall leaves it out of the parts.

**Why "another site" is the saved template.** The brief asks for a captured template applied rather than retyped. A site that is set up is
that template, kept current by the people who run it: there is nothing to keep in step and no second store of the same settings. A named
template detached from any site would need its own lifecycle and approval, and nothing in the brief needs that yet.

**Why one transaction.** A site half set up (its time zone but not its firewall) is worse than one not set up: it looks done. Either the
parts that can be applied are, or nothing is.

**How it was proven.** `server/test/site-standards-apply.test.ts`:
- A copy sets all three, each with its own audit entry and the summary.
- Applying the suggestions sets the time zone and firewall and skips the network, with why. Nothing to apply is refused and writes nothing.
- These are refused and write nothing: Tier 2, a code confirmed for fewer parts, a copy onto itself, an unknown site, and five hostile
  bodies.
- A copy skips what the other site does not set itself.

The red checks: with the firewall part never written, the first two tests fail; without the refusal when nothing applies, the second fails.

---

## D36. Approving a batch: one code, each cabinet on its own (2026-11-08)

**The decision** (F6.R2; mine, within the brief's requirement and D35):
- **One action.** An Admin approves up to 50 pending cabinets at one client and site, with one role and one baseline decision, confirmed
  with one authenticator code bound to the whole body: every cabinet's request id and name, the place, the role and the decision.
- **Each cabinet on its own.** Each one goes through the same `approveEnrollment` as a single approval, in its own transaction and with its
  own audit entry. One refused (another site's installer, a taken name) does not undo or stop the others; it stays pending and the answer
  gives its reason. The batch is audited once more, with what was approved and what was refused.
- **Attach once.** An `attach` decision attaches the version with the first cabinet approved, and the rest use it as the baseline in force.
- **No capture.** A capture turns one cabinet's first report into the site's draft, so it is chosen one cabinet at a time.

**Why each cabinet on its own, and not all or nothing.** A batch is for a site's worth of cabinets arriving together. One with a problem
(installed with another site's installer, a name already taken) should not hold back the rest, and should not be approved by default
either. Running each through the single approval keeps one code path for every rule a cabinet is approved under: site and role held to the
installer, the baseline check, a satellite's sync cabinet, the audit entry.

**Why one code is enough.** The code is bound to the exact list. It cannot approve a cabinet left off it, or one under another name, and a
code confirmed for one cabinet does not approve two.

**How it was proven.** `server/test/batch-approval.test.ts`:
- Three cabinets from one site installer and one from another site's are approved together: the three are issued under their chosen
  names, and the fourth is refused with `not_this_site` and stays pending. Each approval has its own audit entry, and the batch entry
  records 3 approved and the one refused.
- An attach is made once for two cabinets.
- These approve nothing: a request listed twice, two names alike, a code confirmed for one cabinet, Tier 2, a capture, an empty list, a
  bad id and a `<script>` name.

The red checks: with a refusal stopping the batch, the first test fails; without the switch from attach to inherited after the first
cabinet, the second fails.

---

## D35. One installer per site: bounded by count and days, held to its site at approval (2026-11-07)

**Owner's decision.** Asked how a site installer (one token several cabinets of one site can use) should be bounded, the owner chose the
recommendation, "Admin sets count".

**The decision.**
- **Limits.** The Admin chooses the site, optionally a role, how many cabinets (1 to 100, default 10) and how many days (1 to 30, default 7).
  The authenticator code confirms exactly those. The token stops at either limit, and `token.revoke` stops it early.
- **Counting.** Each use is counted under the token row's lock, so two cabinets at once count as two. Each is audited with the token's id
  and site.
- **Approval.** A request made with it arrives with its client, site and role filled in. It is approved only at that site, and with that
  role when one was named.
- **What stays the same.** A token with no site is still for one cabinet, once. The agent and the installer script are unchanged: the token
  they carry looks the same.

**Why this, and not the alternatives.**
- **Every cabinet still needs an approval**, so the token alone enrolls nothing. Its risk is a leaked file filling the pending queue with
  requests. The count bounds that, and a per-site count keeps each installer to the site it was made for.
- **A fixed small batch** would need several installers for a large site. **Unlimited until revoked** would let one leaked file make
  any number of requests.
- **Holding the approval to the installer's site** makes "scoped to a site" mean something: the person who made the installer confirmed
  that site with a code, and a cabinet that turns up claiming it can only be placed there or rejected.

**How it was proven.** `server/test/site-installer.test.ts`, through the real console routes and enrollment path:
- A 2-cabinet token takes two and refuses the third, and is used up at its last. Its creation and both uses are audited.
- The pending list carries the intended client, site and role.
- Approval at another site, or with another role, is refused and changes nothing. The right one passes. Without a role the approver chooses.
- A revoked, or expired, token enrolls nothing. Revoking is Admin only and happens once. A one-cabinet token is still used once.
- A code confirmed for 2 cabinets does not make one for 50. Seven hostile bodies are refused, and so are a missing site and Tier 2. The
  database refuses 500 uses, and refuses more than one use without a site.

The red checks: with the site check taken out of the approval, the second test fails; with tokens single-use again, the first fails.

---

## D34. A role baseline's required services are that role's watched services (2026-11-07)

**Owner's decision.** Asked whether a role baseline's required services should also be watched (restarted when they stop), or stay
separate from the watch list, the owner chose the recommendation: "Required = watched".

**The decision.** When a role baseline is approved, its required running services become the watch list of that role, the widest level,
below the fleet's. They are stored as `services.watched.role.<role>` in the approval's transaction and audited as `services.watched.role`.
"Required running services" means required `services` items that are present, or matched without asking for them to be stopped or
disabled. Only names the contract accepts count, at most 16. The heartbeat reads the role's list in the statement it already runs (one
more keyed `settings` lookup), and the existing rule applies: the most specific level with a list wins, and only approved services are sent.

**Where this differs from the option as worded.** The option said the watch-list setting "stays for additions and for turning one off at a
site or cabinet". Both work, but through the levels' existing rule rather than as a union: a site's own list replaces the role's. A site adds
a service with a list that includes the role's and the extra one (the console starts the list from the one it replaces), and turns one off
with a list that leaves it out. The client and site editors show each role list their cabinets fall back to, and a new list starts from them (added in review of #185: without it, a site watched only by its role read "no services are watched", and a list saved there to add one service dropped the rest). A union would have needed a way to subtract, and per cabinet a resolved baseline on every heartbeat. The rule
"the most specific level wins, null inherits, [] watches nothing" is unchanged, and the hot path keeps one statement.

**How it was proven.** `server/test/baselines.test.ts`:
- Which items count: required present or matched-running services count. Optional, stopped, disabled and absent ones do not, nor drivers,
  names the contract refuses (a semicolon, a leading space, 81 characters), or a repeat. The list is sorted and capped at 16.
- Through the real routes: approving a standalone role baseline stores `["Spooler"]` and audits it with the version. A standalone cabinet's
  watch source is the role and a satellite's is not. A site's empty list replaces it.
- The heartbeat sends nothing until the service is approved, then `["Spooler"]`. This check caught a column left out of the heartbeat's
  outer select while it was being written.

With the store step taken out of the approval, the second test fails.

---

## D33. A cabinet's role carries its expected set, as a baseline level (2026-11-07)

**Owner's decision.** Asked whether F7's role template is keyed by the three roles a cabinet already has (sync, satellite, standalone) or
is a named template an Admin creates and assigns, the owner chose the recommendation, "The three roles".

**The decision.** A baseline can apply to a `role`. Its id is the role, and nothing but the three roles is accepted (contract, and the
`baselines_role_check` constraint in migration 0024). It sits between the fleet's baseline and a model's. Admins make it, as for the fleet's
and a model's. It applies to every active cabinet of that role, and is counted when a cabinet is approved with "use the baseline in force".

**Why this, and not the alternatives.**
- **No new step at setup.** Every cabinet has a role from the moment it is approved, so its expectations follow without an assignment. A
  named template would be one more choice per cabinet or site, against F6's aim of fewer fields per cabinet.
- **Everything baselines already do comes with it:** capture from a working cabinet, two-person approval, item-by-item inheritance, drift,
  "degraded" with the item named, the fleet view and the timeline. A separate template system would have duplicated all of it.
- **Between fleet and model**, because a role says what a cabinet does and a model says what hardware it is: a model baseline (a driver
  version for that hardware) narrows a role's expectation, and a client, site or cabinet narrows both.
- **What it does not cover:** cabinets of one role that run different workloads. If that appears, a narrower client or site baseline says
  so; named templates remain the way to go further, and would need their own decision.

**How it was proven.** `server/test/baselines.test.ts`:
- Tier 2 is refused, and so are hostile role ids (an unknown role, the wrong case, empty, null, an injection string, a trailing space, 65
  characters). The database refuses an unknown role written directly.
- A role baseline applies to its role and not another; it sits after the fleet's and before a model's; a model's item replaces the
  role's.
- A cabinet missing the service its role requires is degraded, with the service named; once it runs it, the reason goes.

With the role left out of a cabinet's scopes, the second test fails. `server/test/enrollment-baseline.test.ts`: a sync role baseline is
"in force" for a sync approval (preview and approval) and refused as such for a standalone one.
## D32. What F4's audit sweep counts as a transition (2026-11-07)

**The decision.** `server/test/audit-sweep.test.ts` reads the server's source. Every statement that changes a row's `state` or `status`,
and every `DELETE`, must sit in a function that writes an audit row, or close alerts through `closeAutomatically`. Otherwise it must be
listed in the test with its reason. Four kinds are listed and not audited row by row:
- **A delivery lease** (a command's `delivered`, renewed on each re-offer). The command's issue, result and expiry are audited.
- **One step's progress inside a run** (a fleet job's target, a re-apply step, a rollout offer, a diagnosis's own state). The run's start
  and end, and every command it issues, are audited.
- **Derived or cached rows** recomputed from others (drift, daily error counts, healthy marks and configuration versions past their cap).
- **Telemetry retention** (notifications, raw samples folded into hourly rows, operations counters). The nightly run is audited as
  `retention.run` with each count, and batch retention as `retention.batch`.

**Why.** F4 asks for every automatic and destructive transition. Read literally ("every row change"), it would put one audit row on
every poll and every heartbeat. The chain is serialized through one head row (`audit_append` takes `UPDLOCK, HOLDLOCK` on it), so that
would make the audit log the platform's bottleneck. The four kinds above either are not decisions, or are already covered by an audited
row that says what happened. Everything a person relies on as an outcome is audited: an alert closed, a command expired, a job ended.

**The cost moved off the poll.** The long poll used to mark expired commands itself, with two bare `UPDATE`s. Auditing them there would
need a table variable on every poll, which the poll's own comment rules out (tempdb queued at 10,000 cabinets). The minute job now
expires all three cases (`expireCommands`) and audits each with why. The poll still never hands over an expired command, so the only
visible change is that one can read as queued or delivered for up to a minute. The poll runs two fewer statements when it has work.

**How it was proven.** The sweep test passes, and with one converted close put back to a bare `UPDATE` (`crashes.ts`) it fails, naming
that line. `closeAutomatically` is tested to write one row per alert closed, none when nothing closed, to roll back with its caller, and
to refuse to run without its `OUTPUT` clause.

---

## D31. The operator command line acts only on the named person's authenticator code (2026-11-07)

**Owner's decision.** Asked how the command line should prove who is acting (finding F3), the owner chose the recommendation, "Their
authenticator code".

**The decision.** Every `platform-admin` command that changes something needs `--as <username> --code <6 digits>`, and the code is checked
as the console checks a step-up (02-security-model.md "Control 8"): one use per 30-second step, claimed in the same `totp_last_step` the
console uses; a locked account refused; a wrong code counted toward the same lock (`recordAuthFailure`, now in
`server/src/services/auth-failures.ts`, shared by both doors). Every attempt that reaches the code check is audited as `cli.authenticate`, `via: "cli"`,
`proof: "authenticator"`; a refusal before it (no `--as`, a missing or malformed code, an unknown name, a lower role, no authenticator, a locked
account) leaves no audit row. Read-only commands are unchanged. `user add` runs without `--as` only while there is no active Admin.

**Why this, and not the alternatives.**
- **Before, a name was the whole proof.** `--as` only looked the name up (`server/src/cli.ts`, the old `userId`), so anyone with a shell on
  the server could act as any Admin, and the audit log named that Admin. The code makes the audit row true.
- **A password** would be typed into a shell history or a process list. A code is useless a step later.
- **Signed requests or a separate CLI key** would be a second credential to issue, store and revoke, for a tool used rarely.
- **Leaving it to the shell's own access control** is what F3 found wanting: the platform's accounts, roles and lock would not apply.

**What it costs.** Each change from a script needs a fresh code, so one account can make about two changes a minute (the current step and
the next). The Windows CI job has its own test accounts' authenticators (`.github/ci/ci-authenticator.mjs`, never shipped), which wait for
the next step when needed. If every Admin loses their authenticator there is no command line way back; this is open in
09-open-decisions.md, with the recommendation to keep two Admins.

**How it was proven.** `server/test/cli-authority.test.ts` runs the real command line against a test database: a right code acts and is
audited; a missing, malformed, wrong, out-of-window, reused or someone else's code acts on nothing; five wrong codes lock the account,
raise one security alert, and a right code is then refused; the first Admin needs no `--as`, the second does. With the code check taken
out, three of its six tests fail. The CI helper was run here against a test database: enroll, then two changes and a user creation in a
row, all accepted.

---

## D30. The agent will send an application crash's faulting module and exception code (2026-11-07)

**Owner's decision.** Asked whether the agent should send these for Application Error 1000 (the open question D29 left), the owner chose
the recommendation: "go with your recommended decision, and ensure that you document the reason for that choice."

**The decision.** For Application Error 1000 only, the agent sends the faulting module and the exception code as event fields, the way it
already sends Kernel-Power 41's fields (D19). Each value is bounded and checked against the event schema before it leaves the cabinet. The
server adds them to the crash's signature and title. Application Hang 1002 stays program-only, because its message holds no module or code.

**Why this, and not the alternatives.**
- **The detail decides the fix.** Today two crashes of one program share one alert whatever the cause. A crash in `ucrtbase.dll` with
  0xc0000409 (the program corrupted its own memory) and a crash in a driver's DLL with 0xc0000005 (often the driver) need different people.
  Grouping them hides the second behind the first.
- **It reuses a path that already exists and is checked.** Kernel-Power 41's fields already go through `EventDetail.Fields`, the contract
  and the server's validation. No new kind of data leaves the cabinet: the module name and the code are already in the event Windows
  wrote, only on a later line than the agent sends today.
- **It is a read, not a write.** It changes what the agent reports, not what it does to the cabinet. It is still an agent release, so it
  waits for the signed release channel (F1) like every other agent change.
- **Rejected: send the whole message.** It is unbounded text, it would grow every event row for every source, and the capacity budget
  counts event rows. Two named, bounded fields cost almost nothing.
- **Rejected: leave it program-only.** That is honest but leaves the hidden-cause case above unsolved, which is the reason the owner asked
  for crashes to be raised in the first place.

**Order.** The server side, which reads the fields when present and keeps the program-only signature when absent, can land first. The agent
side ships with the first signed release after F1. Until then nothing changes on a cabinet.

---

## D29. Application crashes and hangs are known by their program, so different programs never fold together (2026-11-04)

**Spec.** Roadmap Phase 3 lists "application-crash correlation (Application Error and hang events are not mapped)". This follows the
owner's 4 November request that problems from the event logs across the fleet be raised as things that deserve attention (D25).

**What was wrong.** An unrecognized error was known only by its log, source and event ID. So every Application Error 1000, whatever
program crashed, was one alert per cabinet. Across the fleet it was one pattern: CabinetUI.exe crashing at 5 sites and a reader tool
crashing at 5 others read as "Application Error 1000 at 10 sites".

**What is built.**
- **What the signature carries.** For an Application Error 1000 or an Application Hang 1002, the signature also holds the program.
  - It is read from the first line of the message by its label ("Faulting application name:", or "The program … version"), in any
    letter case, without regular expressions.
  - It is appended after a `~`, with `|` and `~` removed and the name cut at 80 characters.
- **How it shows.** The alert title names the program: "CabinetUI.exe crashed" or "CabinetUI.exe stopped responding".
- **Folding.** Repeats of the same program fold into one alert with its count. A different program is its own alert, and so its own fleet
  pattern (D22), with its own alarm level (D25).
- **Still unrecognized.** The alert can still be mapped to an issue type, which then takes over as before.
- **Triage** reads the signature by splitting on `|` and dropping the `~` tail after the last `|`, so its counts and samples are unchanged.

**Why the program only.** The agent puts only the first line of a message into an event (`EventLogWatch.ToEvent`, `Message =
e.FirstLine`; D19 says the same). For an Application Error 1000, that line names the program. The faulting module and exception code are
on later lines, so a cabinet never sends them. The review of #164 checked this against the live database on 7 November 2026: no
Application Error or Application Hang event from a real cabinet carried the faulting module or the exception code.

An earlier version of this PR also read the module and code. It worked only on the demo's one-line messages and its own test fixture, so
it was removed.

**Open.** Sending the module and code would mean the agent sends them as fields for these two events, as it already does for Kernel-Power
41 (D19). That changes what the agent sends and needs an agent release. It is recorded in 09-open-decisions for the owner to decide.

**Limits.**
- Alerts opened before this change keep their old signature and resolve as usual.
- A first line without the label (Windows in another language, say) falls back to the plain signature: one alert per source, as before,
  never a wrong program.

**Proof.** `app-crash-signatures.test.ts`, on exactly the first line a cabinet sends:
- the parsing, including letter case;
- hostile input: separators and a 10,000-character name, other logs and IDs, a hang with no version, empty values;
- one cabinet: the same program twice is one alert with 2 occurrences, and another program is its own alert;
- across the fleet: two programs at five sites each are two fleet patterns.

All four fail with the parsing switched off, and all pass with it on.

---

## D28. Anyone may restart a cabinet; shutdown stays Admin; the authenticator code stays (2026-11-04)

**Owner's decision.** Asked about the device-restart operation approved on 25 October, the owner answered about restarting the
machine: "as for devices I'm assuming you mean like restarting the windows machine, that can be everyone can restart since it's a
common fix". Also: "We should be able to restart services". Service restart already exists (`service.control`, Tier 2, one click, approved
services only) and is unchanged.

**What changed.**
- `system.restart` is now open to every role, Tier 1 included, in the operations catalog (`minimumRole: tier1`) and in the agent's copy
  of it. That covers restart now or after a delay, and cancelling a waiting restart.
- The server's separate rule keeps shutdown for Admins only, because a shut-down cabinet stays off until someone switches it on.
- The console shows the restart panel to everyone, and the shutdown choice only to Admins, both from the same catalog.

**What did not change, and why.**
- **The authenticator code stays.** A restart interrupts whoever is at the cabinet. The code ties the confirmation to that exact restart
  and delay, so a stray click or a reused confirmation cannot restart a cabinet. The 10 October answer was "all tiers, one click".
  Dropping the code to a click is a one-line catalog change if the owner wants it.
- **No bulk restarts** (29 October) still holds: one cabinet at a time, from its own page.
- **Device-level restart** (restarting one hardware device, such as the scanner) is not built. The owner's answer was about the machine,
  so that operation waits until it is asked for again.

**Proof.** `support-actions.test.ts`:
- Tier 1 restarts with a code and is refused without one;
- Tier 1 may cancel a waiting restart, and is refused a shutdown (403);
- Tier 2 and Admin behave as before.

With the catalog back at Tier 2 the test fails, and at Tier 1 it passes. The contract test's list of Tier 1 writes now includes
`system.restart`.

---

## D27. Every test that turns the demo on waits the same 90 s; the seed stays one cabinet at a time (2026-11-04)

**The failure.** A review run of #161 (on a machine where another job held both cores, load 9 to 11) had three browser tests time out:
`console-actions-e2e`, `console-crawl-e2e` and `console-readings-e2e`. Each waited 60 s in the shared `startDemo` for the demo tour's "Site
overview". The same timeout is in the reviewer's logs from 23 and 27 October, and the three passed alone on a quiet machine.

**Cause.** Turning demo mode on is slow, and the shared helper gave it less time than D17 had settled on.
- **Measured** (`enableDemo` alone on a fresh test database, this container, two runs): 18.5 and 16.6 s in all.
- By phase (first run):

  | Phase | Time |
  |---|---|
  | Each cabinet's heartbeat, drift and time checks and events, one cabinet at a time | 9.0 s |
  | History | 4.5 s (inserts 1.5 s, drive refresh 1.2 s, stored readings 1.4 s) |
  | Configuration snapshots | 4.1 s |
  | Fleet checks | 0.4 s |
- D17 gave the setup test 90 s for this step, but the shared helper used by every other browser test still waited 60 s.

**Decision.** One limit, `DEMO_ON_LIMIT_MS` (90 s) in `test/browser-console.ts`, used wherever a browser test waits for demo mode to turn on:
- `startDemo`, the shared helper;
- the setup test ("Turn demo mode on");
- the guided demo test, both for its first tour step and for the wait after it resets the demo. Its other tour steps keep 60 s, since they
  do not wait on the seed.

(`console-demo-e2e` turns the demo on through the server before the browser opens, so it has no such wait.) Every one of these tests allows
300 s or more overall, so the longer wait fits.

**Tried and rejected: seeding sites side by side.** Running four sites at once, with each site's cabinets still one at a time, made
things worse when measured:
- the per-cabinet phase went from 9.0 s to 13.2 s;
- the second run hung for over nine minutes and was stopped.

The cabinets wait on each other across sites too, on the alert and fleet-pattern writes, not only within a site as D17 found. Making that
safe means reworking the locking on those paths, which a demo seed does not justify.

**Still open.** Writing the history and snapshots in fewer statements would save a few seconds. It stays listed under the open fixes.

---

## D26. Crash signatures: the stop code, and the exception or subtype that names the failure; the faulting driver waits on a sample dump (2026-11-04)

**Spec.** Roadmap Phase 2: "A crash signature (stop code plus faulting module) groups crashes across the fleet."

**Owner's decision.** The faulting module needs the driver list inside a small dump. Microsoft does not publish its layout, and there is no
real dump here to check a reading against. Asked how to proceed, the owner chose to supply one or two real small dumps. Until then, crash
signatures group by stop code and parameters. This is recorded in 09-open-decisions.

**What is built.**
- **The signature.** The stop code, plus the first parameter where Microsoft's bug-check reference documents it as the kind of failure:
  - the exception code for 0x1E, 0x3B, 0x7E and 0x8E, and the two the reference documents with a 0x1000 prefix (0x1000007E, 0x1000008E);
  - the subtype for 0x1A, 0x9F, 0xC2, 0x124, 0x133 and 0x139.

  Common exception codes and a few subtypes are named in plain words (0xC0000005 is an access violation, for example). For every other
  stop code the parameters are addresses or counts that differ from crash to crash, so they are left out: they would split one failure into
  many.
- **Parsing.** Read from the BugCheck 1001 message without regular expressions, for 64-bit and 32-bit formats. A sign-extended
  exception code (0xffffffffc0000005) is the same signature as the plain one. Anything malformed gives no signature or no parameters,
  never a wrong one.
- **One crash, counted once.** Windows logs a crash under both BugCheck and WER-SystemErrorReporting. The second entry is taken as the
  other half only when it comes from the other source, within 10 minutes, for the same cabinet and signature. Two real crashes minutes
  apart, as in a reboot loop, stay two.
- **Across the fleet** (Incidents page, "Kinds of blue screen"):
  - each kind with its cabinets, sites, clients and crashes, first and last seen, and its trend (the last 24 hours against the 24 before);
  - per kind, who has it and what they had in common before their first crash of that kind, using the same comparison as the fleet
    incident;
  - demo cabinets are their own rows, never mixed with real ones.
- **Limits on the query.** Tier 1, read only. It covers up to 14 days, one query per person at a time, under the 15-second limit
  fleet-wide queries already use. Its query is checked against `crash-signature-query.schema.json`, and the key is re-checked against
  exactly the form the list gives.

**Alternatives.**
- Stop code only. Rejected: 0x7E alone mixes access violations with other exceptions that have different causes.
- All four parameters. Rejected: addresses make every crash unique.
- Reading the driver list now, from what is known of its layout. Rejected by the owner's answer: untested, it risks naming the wrong
  driver.

**Proof.**
- `crash-signatures.test.ts`:
  - parsing, including 32-bit, sign-extended and hostile input (three or five parameters, 17-digit numbers, a megabyte of text, 100,000
    stray brackets);
  - keys accepted back only in the exact form;
  - across the fleet, 8 cabinets with 10 crashes (8 logged twice, plus a reboot loop's 2 more) and the driver they all installed standing
    out.
- `crashes.test.ts`: the demo's overnight incident is one 0xD1 signature through the console API, real and demo kept apart, and
  hostile queries refused.
- Console: the trend text.

---

## D25. Fleet alarm level: major problems ring at once, minor ones only when they spread; each report says what to do (2026-11-04)

**Owner's request and decision.** "Any event log, system log and other such things happening across the fleet should be raised: not small
issues but issues that deserve attention, along with the tools for the job. The goal is a fleet management tool that can help diagnose
and resolve issues." Asked which fleet problems should ring the alarm (banner, sound, desktop notification): **major ones at once; a
minor one only once it has spread**, to 20 sites by default (the recommendation).

**What was already there.** The agent sends every Critical and Error entry from the System and Application logs (warnings too from the
hardware and WHEA logs). An entry no rule knows becomes an "unrecognized" alert of its own, and any alert seen at 5 or more sites within
24 hours becomes a fleet pattern (D22). What was missing was the line between noise and attention: every fleet pattern rang the alarm,
including a minor warning.

**What is built.**
- **Alarm level.** A fleet pattern rings when it is major (blue screens, reboot loops, disk, power and hardware errors, or anything a rule
  marks major) as soon as it opens. A minor one is listed on the Incidents page as "Open, listed" and rings only once it reaches the
  Admin's number of sites (Settings, Alerts: "A minor one rings the alarm at", 2 to 1000, default 20). When it starts to ring, every console
  hears it within seconds, as for a new one.
- **Once rung, it stays rung.** The time it first rang is kept (`alarmed_at`, migration 0023, audited as `fleet_pattern.alarm`). Raising the
  number afterwards does not silence a problem that people were already told about. Patterns that opened before this change rang under
  D23, so they keep their alarm.
- **What to do, in the report.**
  - For a known issue, the report has its runbook, with every check and one-click fix run on a still-affected cabinet you choose. The
    roles, confirmations and limits are the same as anywhere else.
  - Once a fix works on one cabinet, "Recovery, site by site" (D24) stages it for the rest.
  - For an error no rule knows yet, the report says how to name it for the whole fleet ("Map to issue" on an affected cabinet's alert, Tier
    2), after which a runbook can be written for it.

**Why stored rather than worked out on each read.** The alarm must reach consoles at the moment a minor pattern crosses the line, which
needs the sweep to notice the crossing. Keeping the time also shows afterwards when people were told.

**Limits.**
- What counts as major comes from the rules and issue types. An error no rule knows is minor until someone maps it, and so it rings only
  once it is widespread. Mapping it to a major issue type makes the next one ring at once.
- Nothing is sent outside the platform (D23).

**Proof.** `fleet-patterns.test.ts`:
- a major pattern at 5 sites rings at once;
- a minor one at 5 and then 7 sites stays listed, and rings at 8 (the test's setting), once across repeated sweeps;
- raising the number afterwards keeps it rung;
- 60 sites in reboot loops ring, while a minor clock problem at 3 sites does not.

The minor-pattern test fails when every pattern rings, as before this change. Console: a pattern never rung does not sound the alarm,
however wide.

---

## D24. Incident response mode: recovered and still-affected counts, an hourly timeline, and recovery staged site by site (2026-11-04)

**Spec.** Roadmap module 42: "Incident page: affected and recovered counts, groupings, comparisons, staged recovery." Groupings (by
client, site and agent version) and comparisons (what affected cabinets have in common against the rest) came with fleet patterns (D22).
This adds the rest to the fleet alert's report. No owner question was needed: each choice below follows from the spec or an earlier
decision.

**What is built.**
- **Recovered and still affected.** A cabinet has recovered when every one of its alerts in the pattern is resolved. One resolved alert
  beside an open one does not count, because the problem is still showing there. It recovered when the last of those alerts was resolved.
- **How it went.** A table by hour of how many cabinets began to show the problem and how many recovered, so the people handling it can
  see whether it is still spreading and whether fixes are working.
- **Staged recovery, site by site.** The report lists the sites with cabinets still affected, those with the most first. "Stage" opens
  Fleet operations on that site with exactly its still-affected cabinets chosen. From there the fix runs the way every bulk change does:
  pick the operation, preview it, confirm with the password, and it runs in the batches you set, with each cabinet's result recorded and
  verified.

**Why one site at a time.** A fleet operation covers the cabinets of one site, and the server refuses anything wider (`one_site_only`).
That rule is there so a mistake can only reach one place. Staging the whole fleet in one go would have meant loosening it during an
incident, the moment a wrong choice costs most. Site by site keeps the rule, and is also what "staged" asks for: fix one site, watch it
recover in the report, then do the next.

**Alternatives.**
- One button for every still-affected cabinet. Built first, then dropped: the server refused it at preview, because it spans sites.
- A new multi-site recovery job. Rejected for the same reason: it would be a second way to bypass the one-site rule.

**Limits.**
- The hand-off travels through the browser tab's own storage, the same way Fleet operations keeps its selection. If storage is blocked,
  Fleet operations opens with no site chosen.
- Fleet operations runs its own fixed operations (time zone, clock sync, firewall policy). A recovery needing another kind of fix (a driver
  roll-back, say) still goes through that fix's own page.
- The report lists up to 500 sites, as it did before.

**Proof.**
- `fleet-patterns.test.ts` checks:
  - the counts (12 affected; after 5 recover, 5 and 7);
  - that a cabinet with one resolved and one open alert is not recovered;
  - that the hourly totals match the counts;
  - that each site lists exactly its still-affected cabinets.
- `console-incident-response-e2e.test.ts` drives a real browser through it. The report shows 6 still affected and 2 recovered, and lists 5
  sites (not the one that recovered). Staging the three-cabinet site opens Fleet operations with "2 of 3 selected", the two still affected.

---

## D23. Fleet alarm: in every open console within seconds; nothing sent outside (2026-11-04)

**Owner's request and decision.** "We need to know as soon as possible when something like the reboot loops happen, or other things
affecting fleet error logs." Asked how to reach people: **console only**, keeping the October decision that the platform sends nothing
outside (no email, SMS, chat or webhooks).

**What is built.**
- **Detection within seconds.** An event batch that raises a new alert asks for a fleet check, which runs about 2 seconds later instead
  of at the next one-minute sweep; a burst of batches shares one check (`checkFleetSoon`). The one-minute sweep stays as the safety net
  (and catches reboot loops and outages, which are raised outside event batches).
- **Everyone signed in hears it.** Opening or resolving a fleet pattern is announced on the live stream to every signed-in console,
  whatever the role (`event: fleet`). The console shows a **red banner on every page** naming the problem and its reach (sites,
  cabinets, clients) with a link to the report, plays a short sound, and shows a **desktop notification** where the browser allows it
  (a button asks for that permission). A console opened later shows the open patterns at once; the tab title counts them.
- **Acknowledge** hides the banner in that browser only; the pattern stays open until no cabinet has the problem.

**Limits.** Nobody hears about it until a console is open: that is what console only means. Browsers can hold the sound until the page
has been used once, and a desktop notification needs the browser's permission; the banner shows either way.

**Proof.** `alerts.test.ts`: a tier1 console's stream hears a fleet pattern open within 15 seconds when the same error arrives from 5
sites through ingest alone, with no sweep run by hand; red with the ingest check removed. Console: the alarm's choice of what to show
(open and unacknowledged, widest first), its text, and acknowledgements read safely from browser storage.

---

## D22. Fleet patterns: the same problem at 5 sites within 24 hours is one fleet alert, with a report (2026-11-04)

**Owner's request and decision.** "100 sites get a new installed driver, 50 get the same error message: that should be detected as a
common thing the cabinets have; and if, say, 60 sites have an outage, a blue screen or something else, it should raise that as an alert
and report what is happening, which clients, sites and cabinets are affected, and any common factors." Asked when: the same problem at
**5 or more sites within 24 hours** (the recommendation), and it must also cover the case a few weeks ago of **60 sites in reboot loops**.
Both numbers are Admin settings (Settings, Alerts: "Fleet alert at N sites within H hours").

**What is built.**
- **A problem is the alerts' own grouping:** one issue type (blue screen, reboot loop, offline, a mapped error...) or, for an error no
  rule recognizes, one alert signature (the same log, source and event ID). Repeats on a cabinet already fold into one alert; two cabinets
  at one site count as one site.
- **The one-minute sweep** (`sweepFleetPatterns`, `server/src/services/fleet-patterns.ts`) counts the sites per problem among alerts
  seen within the window. At the threshold it opens **one fleet pattern** (migration 0022, one open per problem by a unique index),
  audited; later sweeps count it up (sites, cabinets, clients, occurrences only grow while it is open); it resolves itself once no
  cabinet has the problem unresolved, audited. A new one opens only while at least one of its alerts is unresolved: the resolved alerts
  of a pattern that just closed are still inside the window, and until 7 November 2026 they opened it again on the next sweep (a new
  alarm and notification every minute after the fleet recovered; found from a test that failed under load in review of #181). Demo
  cabinets are counted apart from real ones.
- **The report** (`GET /api/fleet-patterns/:id`, Tier 1 and up, read only): clients, sites and cabinets affected with their counts and
  first and latest times, agent versions, and **what they have in common**: the changes (drivers, updates, software) each affected
  cabinet recorded in the 72 hours before its problem began, compared with the rest of the fleet; a change at least half of them had,
  and 40 points more than the others, stands out. This is the comparison the crash incident view already used (`compareChanges`, now
  shared).
- **Console:** the Incidents page lists fleet patterns (open first, widest first) with the report beside each.

**Considered.** A share of the fleet (10% of sites): scales, but a small fleet trips on very few sites and a large one waits long. A
fixed number caught early, adjustable, was chosen. One fleet alert per issue per client: a bad driver crosses clients, and that is the
signal.

**Limits.** "The same error message" is the same log, source and event ID; two different messages under one event ID group together.
Outages are counted through the offline and site-outage alerts that already exist. The sweep reads alerts seen in the window only.

**Proof.** `fleet-patterns.test.ts`: 50 of 100 sites with one error after the same driver install give one pattern (50 sites, 51
occurrences), counted up to 55, and the driver stands out in the report; 60 sites in reboot loops (two cabinets each) give one pattern of
60 sites and 120 cabinets, major; four sites do not, until an Admin lowers the threshold to three; resolving every loop alert resolves
the pattern, with open and resolve audited; alerts outside the window and a mix of 3 real and 3 demo sites make none. Red with the demo
split removed, with the self-resolve removed, and with the window removed. `crashes.test.ts`: the routes (Tier 1, 401, 404).

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
