# Decision log

Every choice made while building, with why, what else was considered, what it costs, and how it was proven. Kept for the
end-of-project review, where each one is gone over again. Newest first. Figures say whether they were **measured** (with
where) or **worked out** from limits in the code; nothing here is an estimate presented as a measurement.

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
