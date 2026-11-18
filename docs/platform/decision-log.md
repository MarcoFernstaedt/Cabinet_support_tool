# Decision log

Every choice made while building, with why, what else was considered, what it costs, and how it was proven. Kept for the
end-of-project review, where each one is gone over again. Newest first. Figures say whether they were **measured** (with
where) or **worked out** from limits in the code; nothing here is an estimate presented as a measurement.

---

## D123. A file-facts list is written with one fixed statement per level (2026-11-18)

**What the code did** (at `243d119`; three entries on the ownership debt list, F21.R2):
- **The statement.** `setAllowlist` in `server/src/services/filefacts-allowlist.ts:216` wrote a client's, site's or cabinet's own
  file-facts paths with one statement that built both its table and its column at run time:
  `UPDATE ${TABLE[level]} SET ${ALLOWLIST_COLUMN} …`.
- **The debt it caused.** The file was declared in `RUNTIME_TABLE_WRITES` and listed as debt on clients, sites and cabinets, though nothing
  else writes `filefacts_paths`. It was the same shape D122 removed from `approved-apps.ts`.

**The decision:**
- **Fixed statements.** `filefacts-allowlist.ts` owns `filefacts_paths` on clients, sites and cabinets. It writes the column through
  `writeAllowlistLevel(c, level, key, value)`, with one fixed statement per level, the same stored text, and the same live-row conditions.
- **Checks.** The level and the id are checked before the database is touched. The function answers whether a live client, site or
  cabinet took the list, and `setAllowlist` turns false into `not_found`, as before.
- **Why it is exported.** `setAllowlist` reads the level first (`readLevel` checks the id and refuses a removed scope), so these checks are
  the second line. The function is exported so the module's own test can hold them, as in D122.
- **Run-time writers left.** `filefacts-allowlist.ts` has none, so its `RUNTIME_TABLE_WRITES` entry comes off. Only the accepted demo
  simulator still writes through a table built at run time.
- **Debt count:** `filefacts-allowlist.ts` comes off all three tables, which leaves 8.

**Proof:**
- **`server/test/filefacts-write.test.ts`** (new, 2 tests, against the database):
  - **Writing.** Each level's list goes to that level only, and null clears it. A removed site or cabinet is not written and keeps what it
    had.
  - **Hostile input.** 6 bad levels and ids are refused, each with its own reason, on a connection that throws if used.
- **Red checks** (every file that imports `filefacts-allowlist.js`, with `table-ownership`, 54 tests). Each of these fails:

  | Edit | What fails |
  |---|---|
  | A run-time table name back | The run-time declaration test |
  | A site's list written to its client | The new writing test, `setting-origins` "a cabinet approved after its site…", and the column-owner and covered-set tests |
  | A removed cabinet still written | The new writing test |
  | The id check removed | The hostile-input test |

  Restored and `cmp` identical, 54 of 54 pass.

---

## D122. An approved-programs list is written with one fixed statement per level (2026-11-18)

**What the code did** (at `900a1b9`; three entries on the ownership debt list, F21.R2):
- **One run-time statement.** `writeLevel` in `server/src/services/approved-apps.ts:502` wrote a client's, site's or cabinet's list with a
  statement that built both its table and its column at run time: `UPDATE ${TABLE[level]} SET ${APPS_COLUMN} …`.
- **What that cost.** The reader can see neither, so the file was declared in `RUNTIME_TABLE_WRITES` and listed as debt on clients, sites
  and cabinets. Nothing else writes `approved_apps`.

**The decision:**
- **Fixed statements.** `approved-apps.ts` owns `approved_apps` on clients, sites and cabinets, and writes it with one fixed statement per
  level. The text it stores and the live-row conditions are as before.
- **Checks.** Before the database is touched, the function checks that the level is client, site or cabinet and that the id is a uuid.
- **Why export it.** Every caller in the module reads the level first (`readRaw`, which checks the id and refuses a removed scope), so these
  checks and the live-row condition are the second line. No public path can turn them red. The function is exported as
  `writeApprovedLevel` so the module's own test can hold them.
- **`approved-apps.ts` has no run-time table write left**, so its `RUNTIME_TABLE_WRITES` entry comes off.
- **Debt count:** `approved-apps.ts` comes off all three tables, which leaves 11.

**Proof:**
- **`server/test/approved-apps-write.test.ts`** (new, 2 tests, against the database):
  - **Writing.** Each level's list goes to that level only, and null clears it. A removed site or cabinet is not found and keeps what it
    had.
  - **Hostile input.** 6 bad levels and ids are refused, each with its own reason, on a connection that throws if used.
- **Red checks** (every file that imports `approved-apps.js`, with `table-ownership`, 113 tests). Each of these fails:

  | Edit | What fails |
  |---|---|
  | A run-time table name back | The run-time declaration test |
  | A site's list written to its client | The new writing test, `approved-list-signing-sql` "signing the approved list…", and the column-owner and covered-set tests |
  | A removed cabinet still written | The new writing test |
  | The id check removed | The hostile-input test |

  The last two failed no test before the new file: no public path reaches them.

  Restored and `cmp` identical, 113 of 113 pass.

---

## D121. A client's or site's scanner hardware IDs are written in one place, device-settings.ts (2026-11-18)

Numbered D121 as the next free number on the trunk. `feat/remote-access-tunnel` also carries a D120 and a D121, so it renumbers when it
lands (review of #315).

**What the code did** (at `66e66c4`; three entries on the ownership debt list, F21.R2):
- **`device-settings.ts`.** `setScanner` wrote a client's or site's scanner hardware IDs through a table name built at run time
  (`UPDATE ${TABLE[level]} SET scanner_hardware_ids …`). So the file was declared in `RUNTIME_TABLE_WRITES` and listed as debt on clients
  and sites.
- **`client-scanner.ts`.** Switching a client's fingerprint scanner on with IDs set `clients.scanner_hardware_ids` in its own statement,
  behind a condition built at run time. That made a second writer of the column, so `client-scanner.ts` stayed debt after D120.

**The decision:**
- **One owner for the column.** `device-settings.ts` owns `scanner_hardware_ids` on clients and sites, and exports
  `writeScannerIds(c, level, id, ids)`.
  - It has one fixed statement per level, and writes only a live client or site.
  - It stores the same JSON text as before.
  - Before the database is touched it checks the level, the id, and the list against the contract's rule: 1 to 16 distinct hardware IDs
    of `common.schema.json`'s pattern, or null.
- **The callers.** `setScanner` calls it. The scanner switch calls it when it is given IDs, and without them leaves the client's IDs as
  they were, as before. The switch's own statement is now fixed text that sets only `fingerprint_scanner` and `scanner_service`.
- **The column owners.**

  | Column | Owner |
  |---|---|
  | `scanner_hardware_ids` on clients and sites | `device-settings.ts` |
  | `sync_ports` on clients | `device-settings.ts` (nothing else writes it) |
  | `fingerprint_scanner` and `scanner_service` on clients | `client-scanner.ts` |

- **`device-settings.ts` has no run-time table write left**, so its `RUNTIME_TABLE_WRITES` entry comes off.
- **Debt count:** `device-settings.ts` comes off clients and sites, and `client-scanner.ts` off clients, which leaves 14.

**Proof:**
- **`server/test/scanner-ids-write.test.ts`** (new, 2 tests, against the database):
  - **Writing.** Each level's IDs go to that level only, can be cleared to inherit, and a removed site, or a client that does not exist,
    is not written.
  - **Hostile input.** 13 inputs are refused, each with its own reason, on a connection that throws if used.
- **Red checks** (the new file, `device-settings`, `client-scanner-sql` and `table-ownership`, 22 tests). Each of these fails:

  | Edit | What fails |
  |---|---|
  | A run-time table name back in `device-settings.ts` | The run-time declaration test |
  | A site's IDs written to its client | The new writing test, `device-settings.test.ts` "scanner IDs: the cabinet's own, else the site's…", and the column-owner and covered-set tests |
  | A removed site still written | The new writing test |
  | The list not checked | The hostile-input test |
  | Switching the scanner on and dropping its IDs | `client-scanner-sql` "switching on with signing…" |
  | `client-scanner.ts` writing the IDs itself again | The unlisted-write and covered-set tests |

  Restored and `cmp` identical, 22 of 22 pass.

---

## D120. A watched-services list is written in one place, watched-services.ts (2026-11-18)

**What the code did** (at `af88248`; three entries on the ownership debt list, F21.R2):
- **`watched-services.ts`.** `setWatched` wrote a client's, site's or cabinet's own list with one statement whose table it built at run
  time (`UPDATE ${table} SET watched_services …`). The reader cannot see a table built that way, so the file was declared in
  `RUNTIME_TABLE_WRITES` and listed as debt on all three tables.
- **`client-scanner.ts`.** Switching a client's fingerprint scanner on or off set `clients.watched_services` too, in the same statement as
  its own columns: the scanner's service is added to the list, or taken off it. So the column had two writers, and D118 could give it no
  owner.

**The decision:**
- **One owner for the column.** `watched-services.ts` owns `watched_services` on clients, sites and cabinets, and exports
  `writeWatchedServices(c, level, id, names)`.
  - It has one fixed statement per level, so the table each writes is in the text.
  - It writes only a live client, site or cabinet, and answers whether one took the list.
  - Before the database is touched it checks the level, the id, and every name against the watched-services contract's rule, at most 16.
  - It stores the same JSON text the data layer stored before.
- **The callers.** `setWatched` and the scanner switch both call it. The switch's own statement now sets only `fingerprint_scanner`,
  `scanner_service` and, when given, `scanner_hardware_ids`. Switching off still leaves the list alone unless the service was on it.
- **`watched-services.ts` has no run-time table write left**, so its `RUNTIME_TABLE_WRITES` entry comes off.
- **The column reader** now counts a `SET` with part of it built at run time (`${…}`) as unreadable, not read in part. The scanner
  switch's statement is that shape, with `scanner_hardware_ids` behind a condition. The reader had stopped at the quote inside the
  `${…}` and would have read the statement as setting only the first two columns.
- **What stays debt.** `client-scanner.ts` stays on the debt list for clients. `scanner_hardware_ids` is also written by
  `device-settings.ts` through a run-time table, which is its own change.
- **Debt count:** `watched-services.ts` comes off all three tables, which leaves 17.

**Proof:**
- **`server/test/watched-services-write.test.ts`** (new, 2 tests, against the database):
  - **Writing.** Each level's list goes to that level only, a list can be cleared to inherit, and a removed site or cabinet, or a client
    that does not exist, is not written.
  - **Hostile input.** 11 inputs are refused, each with its own reason, on a connection that throws if used.
- **The reader test** gains the scanner switch's statement, read as unreadable.
- **Red checks** (the new file, `client-scanner-sql`, `services`, `sqlserver-services` and `table-ownership`, 37 tests). Each of these
  fails:

  | Edit | What fails |
  |---|---|
  | A run-time table name back in `watched-services.ts` | The run-time declaration test |
  | A site's list written to its client | The new writing test, `services.test.ts` "watch lists: the most specific level wins…", and the column-owner and covered-set tests |
  | A removed cabinet still written | The new writing test |
  | The names not checked | The hostile-input test |
  | Switching the scanner on without watching its service | `client-scanner-sql` "switching on with signing…" |
  | Switching it off and keeping its service watched | `client-scanner-sql` "switching off: … the service off the watched list" |
  | A run-time `SET` read in part again | The reader test |

  Restored and `cmp` identical, 37 of 37 pass.

---

## D119. A cabinet's make and model are written in one place, config-ingest.ts (2026-11-18)

**What the code did** (at `68e1f67`; two entries on the ownership debt list, F21.R2):
- **Two writers of one pair of columns.** `cabinets.manufacturer` and `cabinets.model` were set by two files with the same statement, each
  trimming what the cabinet reported to 200 characters:
  - `config-ingest.ts:90`, from a configuration snapshot's hardware item;
  - `commands.ts:252`, from a `system.hardware` result.

  With two writers, D118 could give the columns no owner, so both files stayed on the debt list. `commands.ts` also sets `ipv4` and
  `ipv4_at` from a `network.config` result, and nothing else writes those.
- **What no test held.** A `system.hardware` result keeping the make and model. With that write taken out of `commands.ts`, every test
  still passed.

**The decision:**
- **One owner for the pair.** `config-ingest.ts` owns `manufacturer` and `model` and exports
  `rememberCabinetModel(c, cabinetId, { manufacturer, model })`, the statement both files ran. `commands.ts` calls it for a
  `system.hardware` result, in the same transaction as before.
- **What it does.** It checks the cabinet is a uuid before the database is touched, and trims each value to 200 characters. A value the
  cabinet did not give (missing, empty or not text) keeps the stored one, and with neither nothing is written.
  - The `commands.ts` path used `?.trim()` and would have thrown on a value that was not text. The output contract refuses one before it
    gets there, so nothing that works today changes.
- **`commands.ts` owns `ipv4` and `ipv4_at`.**
- **Debt count:** both files are now covered by their own columns, so both entries for `cabinets` come off, which leaves 20.

**Proof:**
- **`server/test/cabinet-model.test.ts`** (new, 3 tests, against the database):
  - **Keeping the values.** They are trimmed and kept. An empty make, or a value that is not text, keeps the stored one, and another cabinet
    is untouched.
  - **Nothing to keep, and hostile input.** Four empty reports write nothing on a connection that throws if used, and seven bad cabinet ids
    are refused there.
  - **The command path.** A real `system.hardware` result, the contract's `typical.json`, sent through `issueCommand` and `storeResult`,
    keeps the make and model it reports.
- **`table-ownership.test.ts`'s covered set** gains `commands.ts` and `config-ingest.ts` for `cabinets`.
- **Red checks** (`cabinet-model`, `baselines`, `readings` and `table-ownership`, 50 tests). Each of these fails:

  | Edit | What fails |
  |---|---|
  | `commands.ts` writing the columns itself again | The unlisted-write and covered-set tests |
  | A `system.hardware` result no longer kept | The command-path test (no test failed on this before it) |
  | An empty value overwriting the stored one | The first two new tests |
  | The cabinet check removed | The hostile-input test |

  Restored and `cmp` identical, 50 of 50 pass.

---

## D118. A setting column on a client, site or cabinet is owned by its feature module (2026-11-18)

**What the code did** (at `271121a`; the last 32 entries on the ownership debt list, F21.R2):
- **Owners of whole tables.** `clients` and `sites` are owned by `services/admin.ts`, and `cabinets` by `services/cabinets.ts`.
- **What the other writers do.** Most of the 32 entries are feature modules setting their own column on one of those rows:
  - `time.ts` sets `time_zone` and `clock_tolerance_seconds`;
  - `firewall-policy.ts` sets `firewall_policy`;
  - `network-baseline.ts` sets `network_baseline`;
  - `rollouts.ts` sets `in_office`;
  - `sync-cabinets.ts` sets the sync address and the sync cabinet.
- **What the rule assumed.** The ownership rule only knew tables, so every one of these counted as debt to move behind `admin.ts` or
  `cabinets.ts`.

**The decision** (the owner's, asked 2026-11-18; spec 09 "Who owns the setting columns of clients, sites and cabinets"):
- **Column owners.** A table's entry in `table-owners.ts` can name `columns`, mapping each column to the module that owns it.
- **What a column owner may write.** A file is not debt for a table when every write it makes of it is a plain `UPDATE` whose `SET` names
  only columns it owns there. An update through an alias counts, read through the alias.
- **What stays with the table's owner.** `INSERT`, `DELETE`, `MERGE`, a `SET` the reader cannot split into columns, and a table named at run
  time. So do creating, removing and renaming a row, and every column no feature owns.
- **Why not the alternatives.** Moving every write into `admin.ts` and `cabinets.ts` would make those two hold every feature's rules.
  Accepting the writers as exceptions would stop anything checking which module sets which column.
- **What is declared now.** Only columns that one file sets and that cover all of that file's writes of the table:

  | Table | Column | Owner |
  |---|---|---|
  | `clients` | `firewall_policy` | `firewall-policy.ts` |
  | `clients` | `time_zone`, `clock_tolerance_seconds` | `time.ts` |
  | `clients` | `write_paused`, `write_pause_reason` | `writes.ts` |
  | `sites` | `firewall_policy` | `firewall-policy.ts` |
  | `sites` | `time_zone`, `clock_tolerance_seconds` | `time.ts` |
  | `sites` | `sync_ports` | `settings.ts` |
  | `sites` | `network_baseline` | `network-baseline.ts` |
  | `cabinets` | `scanner_hardware_ids` | `settings.ts` |
  | `cabinets` | `in_office` | `rollouts.ts` |
  | `cabinets` | `sync_address`, `sync_address_source`, `sync_cabinet_id` | `sync-cabinets.ts` |

- **What stays debt, and why:**
  - shared columns: `manufacturer` and `model` (`commands.ts` and `config-ingest.ts`), and `watched_services` (`client-scanner.ts` and
    `watched-services.ts`);
  - writes through a table named at run time: `approved-apps.ts`, `device-settings.ts`, `filefacts-allowlist.ts`, `watched-services.ts`;
  - row creation: `enrollment.ts`, `fleet-import.ts`;
  - row removal and renaming: `replacement.ts`, `admin.ts` for `cabinets`;
  - `presence.ts`.

  Each needs its own change.
- **Debt count:** 10 entries come off, which leaves 22.

**Proof** (`server/test/table-ownership.test.ts`, 8 tests, 3 of them new; reader in `server/test/table-writes.ts`):
- **What the new tests check.**
  - Every declared column exists in the migrations.
  - Every column owner sets its column.
  - No column is declared for the table's owner or an accepted writer.
  - The set of files the columns cover is exactly the ten above. Changing it is changing what counts as debt.
  - A debt entry its own columns cover must come off.
- **The reader's self-test** gains column cases:
  - a comma inside `COALESCE(…)` does not split a `SET`;
  - an alias's columns are read;
  - an `INSERT`, a `DELETE` and a `SET` built at run time are other writes;
  - a clause it cannot split is unreadable;
  - a subquery's own `FROM` or `WHERE` does not end the `SET` clause early. The clause is cut only outside parentheses, and a statement
    that ends inside an open one is unreadable (`setClause`, added after review of #313). Before this, `SET a = (SELECT … FROM … WHERE
    …), b = …` was read as setting `a` alone, so a file setting a column it does not own could count as covered;
  - a quoted string (`'…'`, with `''` inside it) and a comment (`--` to the end of the line, `/* … */`) are just as opaque. A word in one
    no longer ends the clause, a comma in one no longer splits it, and text that ends inside one is unreadable (`opaqueEnd`, also after
    review of #313). Before this, `SET write_pause_reason = 'paused from the console', write_paused = 1` was read as setting the reason
    alone;
  - a part of a `SET` that starts with a comment is read past the comment to its column. `alerts.ts` writes one before `severity = …` in
    two of its three folds: the first one (`writeAlerts`, line 289) and `FOLD_EVENT` at 344. `FOLD_EVENT` read as another write until this
    change; `writeAlerts` was not read at all before the reach change below;
  - an `UPDATE` or `DELETE` through an alias is followed to its `FROM` anywhere in its own statement, up to the semicolon or the end of the
    string that holds it. The reader used to look only 600 characters past the verb. The first fold in `alerts.ts` (`writeAlerts`,
    line 289) has its `FROM alerts a` at 610, so that write was not read at all: not as a column update, and not as another write
    (review of #313). The table-writer scan the debt list is checked against had the same window and uses the same reach now. It finds no
    writer it did not find before, since no ownership test changed.
- **Red checks.** Each of these fails:

  | Edit | What fails |
  |---|---|
  | A covered column left undeclared (`clients.time_zone`) | The unlisted-write test and the covered-set test |
  | A covered file left on the debt list | The shrink test |
  | A column the table does not have | The column test |
  | A column owner that never sets its column | The column test |
  | A column owner that also inserts the table, or sets another feature's column (`time.ts` with an `INSERT INTO sites`, or setting `network_baseline`) | The unlisted-write test and the covered-set test |
  | The reader splitting at a comma inside a call | The reader test |
  | The reader not reading an alias's columns | The reader test, the unlisted-write test and the covered-set test |
  | The `SET` clause cut at any depth again | The reader test, on the subquery case |
  | Strings and comments read like the rest of the statement again | The reader test, on the string case |
  | A part's leading comment not skipped | The reader test, on the comment case and the `alerts.ts` folds |
  | The 600-character reach back | The reader test, on the three `alerts.ts` folds |

  Restored and `cmp` identical, 8 of 8 pass.

---

## D117. Settings rows are removed only by settings.ts, through removeSetting (2026-11-17)

**What the code did** (at `db9616f`; seven entries on the ownership debt list, F21.R2):
- **No way to remove a setting.** `services/settings.ts` owns the `settings` table and had `upsertSetting` to write a row, but nothing to
  remove one. Six modules each removed their own fleet-level row with their own `DELETE FROM settings`, to fall back to the default:

  | File | Line | Key |
  |---|---|---|
  | `approved-apps.ts` | 498 | `apps.approved` |
  | `device-settings.ts` | 114 | `sync.ports` |
  | `filefacts-allowlist.ts` | 213 | `filefacts.paths` |
  | `firewall-policy.ts` | 120 | `firewall.policy` |
  | `time.ts` | 69 | `time.zone` |
  | `time.ts` | 144 | `time.clockTolerance` |
  | `watched-services.ts` | 60 | `services.watched` |

  None of these took the per-key lock `upsertSetting` takes, and two (`time.ts`) built the statement text from the key.
- **A hand-written upsert.** `writes.ts:93` wrote the fleet write pause with its own `MERGE settings`.

**The decision:**
- **The counterpart of `upsertSetting`.** `settings.ts` exports `removeSetting(db, key)`. It checks the key before the database is touched:
  1 to 200 letters, digits, dots, colons, dashes or underscores, which is every key the platform uses. It takes the same per-key lock as
  `upsertSetting`, removes only that row, and answers whether there was one. It runs in the caller's transaction.
- **The six modules call it.** Each removal keeps its place, its transaction and its audit.
- **`writes.ts` calls `upsertSetting`.** It writes the same value, author and time, under the per-key lock.
- **The audit sweep's exception moves with the statement.** `audit-sweep.test.ts` excused `approved-apps.ts`'s `DELETE FROM settings`
  because the callers of `writeLevel` audit it. The other five removals passed because their own functions write an audit row. The one
  `DELETE` is now in `removeSetting`, which writes none, so the exception names `settings.ts` and every caller:
  - five audit in the function that calls it: `device-settings`, `filefacts-allowlist`, `firewall-policy`, `time` (twice) and
    `watched-services`;
  - `approved-apps` audits in the callers of `writeLevel`.

  Without the moved entry the sweep fails, naming `services/settings.ts:32`.
- **Debt count:** all seven entries for `settings` come off, which leaves 32. The `settings` table has no debt entry left. Only the
  accepted demo simulator and `usb-sql.ts` write it outside `settings.ts`.

**Proof:**
- **`server/test/settings-removal.test.ts`** (new, 3 tests, against the database):
  - **Removing.** A removal takes only the key it names and says whether it was there.
  - **Rollback.** A removal in a transaction that rolls back leaves the row, and a write after a removal in the same transaction adds it
    back.
  - **Hostile input.** 12 keys are refused on a connection that throws if used: an injection, spaces, a slash, a percent sign, a newline,
    a list and an object among them.
- **Red checks** (`settings-removal`, `table-ownership`, `site-policies`, `writes` and `clock-tolerance`, 30 tests). Each of these fails:

  | Edit | What fails |
  |---|---|
  | `time.ts` deleting from `settings` again | The ownership test |
  | A removal that removes nothing | Both removal tests and two `site-policies` tests that clear the fleet zone |
  | A removal that takes every key | The first removal test |
  | The key check disabled | The hostile-input test |
  | The fleet zone never cleared | The same two `site-policies` tests |
  | The fleet write pause not written | `writes.test.ts` "a fleet or client write pause stops writes but not reads" |

  Restored and `cmp` identical, 30 of 30 pass.
- **Neighbours.** The 28 files that import a changed module, with `table-ownership`, `import-cycles`, `module-load-order`, `audit-sweep`,
  `settings-removal`, `site-policies` and `writes`: 281 of 288 in the first run, with 5 skipped and 2 failures.
  - **`audit-sweep`:** fixed by moving the exception, as above.
  - **`demo.test.ts`** "every simulated cabinet reports its configuration…": it timed out waiting for drift to clear. It passed alone,
    19 of 19. It writes no setting, so the cause is not established.

---

## D116. The console sign-in's account writes go through users.ts, the users' owner (2026-11-17)

**What the code did** (at `b2fb6f0`; the last entry on the `users` table's debt list, F21.R2):
- **Nine writes.** `server/src/console-api/auth-routes.ts` wrote the `users` table with its own statements, none of which checked
  what it was given:

  | Line | Write |
  |---|---|
  | 101 | Clearing the failure count and lifting a lock (a sign-in that needs no code) |
  | 106 | Recording a finished sign-in |
  | 146 | Spending a sign-in code's step, and recording the sign-in when it completes |
  | 163 | Keeping the authenticator secret being set up |
  | 180 | Turning the authenticator on |
  | 206 | Setting a password the person chose |
  | 231 | Marking the tour done |
  | 250 | Spending a step-up code's step |
  | 278 | Clearing the failure count after a confirmed password |

- **Who owns that table.** `users` belongs to `services/users.ts`.

**The decision:**
- **Each statement moves into `users.ts`, unchanged.** The new functions are `clearAuthFailures` (with `unlock`), `recordSignedIn`,
  `spendSignInStep`, `pendingAuthenticatorSecret`, `enableAuthenticator`, `setOwnPassword` and `markTourCompleted`. The step-up claim was
  already the same statement as D115's `spendCodeStep`, which it now uses. The routes still decide every stage, audit it and manage
  sessions and devices.
- **What each checks** before the database is touched, with a plain error:
  - the account id is a uuid;
  - the step is a whole number, 0 or more;
  - the flags are booleans;
  - the sealed secret is 1 to 1024 bytes;
  - the password hash is 1 to 1024 characters with no spaces.

  Every value comes from the session, the database or the server's own hashing, so no sign-in that works today is refused.
- **Debt count:** the `console-api/auth-routes.ts` entry comes off, which leaves 39. The `users` table has no debt entry left; only the
  accepted demo simulator writes it outside `users.ts`.

**Proof:**
- **`server/test/sign-in-account-writes.test.ts`** (new, 5 tests, against the database). Each function writes only the account it names.
  - **Clearing the count.** It lifts the lock only when asked.
  - **Sign-in steps.** A step is spent once and only when newer, clears the count, and records the sign-in only when it completes.
  - **Authenticator setup.** It keeps the first pending secret and then turns the authenticator on; after that nothing is pending.
  - **Password and tour.** A chosen password no longer has to be changed.
  - **Hostile input.** 18 inputs are refused, each with its own reason, on a connection that throws if used.
- **`server/test/sign-in-route-writes.test.ts`** (new, 3 tests, through the real routes). The first red-check pass found that no test
  checked three of the routes' own writes, before this change or after it. The new tests check them:
  - a sign-in that needs no code clears the count and lifts a lock that has run out;
  - a sign-in finished with a code records it, and a correct password alone does not clear the count when a code follows;
  - a confirmed password clears the count.
- **Red checks** (the two new files, `console-api` and `table-ownership`). Each of these fails:

  | Edit | What fails |
  |---|---|
  | A `users` write back in the routes | The ownership test |
  | Clearing that always lifts the lock | The clearing test |
  | A code step that always records the sign-in | The step test |
  | A code step taken again | The step test |
  | The pending secret swapped | The setup test, and `console-api` "authenticator setup shows the same secret until it is confirmed" |
  | Enabling that forgets the step | The setup test |
  | A chosen password that must still be changed | The password test |
  | The login route not clearing the count | The first route test |
  | The confirm-password route not clearing the count | The third route test |
  | The code route never recording a finished sign-in | The second route test |
  | The account, step or secret check disabled | The hostile-input test |

  The three route edits failed no test until the route tests were added. Restored and `cmp` identical, all pass.

---

## D115. The command line's account writes go through users.ts, the users' owner (2026-11-17)

**What the code did** (at `c1a1c6d`; an entry on the ownership debt list, F21.R2):
- **Four writes.** `server/src/cli.ts` wrote the `users` table four times with its own statements:
  - spending an authenticator step for a command proved with `--code` (`cli.ts:115`);
  - `user resume-writes` (`cli.ts:296`);
  - `user add` (`cli.ts:312`);
  - `user reset-password` (`cli.ts:327`).
- **Who owns that table.** `users` belongs to `services/users.ts`.
- **No input check.** None of the four checked what it was given. A malformed username or name reached the table, whose check
  constraint refused it with a database error.

**The decision:**
- **Each statement moves into `users.ts`, unchanged.** The new functions are `spendCodeStep`, `resumeWritesByUsername`,
  `addUserFromCommandLine` and `setTemporaryPasswordByUsername`. The command line still authorizes each command, audits it and ends
  sessions as before.
- **What each checks** before the database is touched, with a plain error the command line prints (exit code 1):
  - the account id is a uuid;
  - the step is a whole number, 0 or more;
  - the username follows the table's rule;
  - the name is 1 to 128 characters with no control characters;
  - the role is tier1, tier2 or admin;
  - the password hash is 1 to 1024 characters with no spaces.
- **What changes for an operator.** `user add` with a username the table would refuse now gets the rule in words, not the constraint error.
  A name with a control character is refused now; that one the table accepted. A name made only of spaces is refused in words too, where
  the table refused it already with a constraint error, because its length check ignores trailing spaces and counts a name of spaces as none,
  and the command line refused an empty one before the table was reached.
- **Behaviour kept as it was.** The command line's `user resume-writes` still resumes whatever paused the person (unlike the console's,
  which refuses when they are not paused), and its `user add` still relies on the table's unique key for a username already used.
- **Debt count:** the `cli.ts` entry for `users` comes off, which leaves 40. The console sign-in routes (`auth-routes.ts`) are the last
  writer of `users` outside `users.ts`.

**Proof:**
- **`server/test/cli-account-writes.test.ts`** (new, 4 tests, against the database):
  - **Steps.** A step is spent once and only when newer, and clears the failure count. Another account is untouched, and an unknown
    account answers false.
  - **Resume.** Resuming by username clears the pause and its reason. An unknown username is not found, and a capitalised one is refused.
  - **Add and reset.** An added account must change its temporary password. A temporary password clears the lock and touches no other
    account.
  - **Hostile input.** 21 inputs are refused, each with its own reason, on a connection that throws if used.
- **Red checks** (`cli-account-writes`, `cli-authority` and `table-ownership`, 22 tests). Each of these fails:

  | Edit | What fails |
  |---|---|
  | A `users` write back in `cli.ts` | The ownership test |
  | A spent step taken again | The first new test |
  | Resuming that keeps the reason | The second new test |
  | A new account that need not change its password | The third new test |
  | A temporary password that keeps the lock | The third new test |
  | The username check skipped | The second and fourth new tests (TypeScript reported a type error but still built) |
  | The step check or the name check disabled | The hostile-input test |

  Restored and `cmp` identical, 22 of 22 pass.
- **One check that stays green.** The command line ignoring a step already spent fails no test.
  - `totp.verify` already refuses a step not newer than the last one spent, so a code used twice in a row is refused before the
    statement runs (`cli-authority` "a code is used once" holds either way).
  - The statement's own condition matters only for two uses of one code at once. The first new test holds that condition.

---

## D114. A person over their write limit is paused by users.ts, the users' owner (2026-11-17)

**What the code did** (at `7b97ddc`; an entry on the ownership debt list, F21.R2):
- **The write.** `recordLimitPause` in `server/src/services/writes.ts:75-86` paused a person's writes when a write went over their hourly
  limit, with its own `UPDATE users`:
  - it sets `writes_paused` and keeps a reason already given;
  - it runs only when the person was not paused already.

  Then it audited `writes.user_paused` and raised the `write_volume` security alert, with the person's username and limit.
- **Who owns that table.** `users` belongs to `services/users.ts`, which already holds the opposite write, `resumeUserWrites`.

**The decision:**
- **The pause moves; the audit and the alert stay.** `users.ts` exports `pauseUserWritesForLimit(c, id)` with the same statement, in the
  caller's transaction. It answers the username and limit when it paused the person, and null when they were paused already or there is no
  such account. `writes.ts` audits and raises the alert only on an answer, as before when exactly one row changed.
- **The account is checked** to be a uuid before the database is touched.
- **Debt count:** the `services/writes.ts` entry for `users` comes off, which leaves 41.

**Proof:**
- **`server/test/write-limit-pause.test.ts`** (new, 3 tests, against the database):
  - **Pausing.** A person is paused once, with the reason, and the answer gives their username and limit (id in upper case). A second
    pause answers null, another account is untouched, and an unknown account answers null.
  - **Reason and rollback.** A reason an Admin already gave is kept, and a pause in a transaction that rolls back leaves the account as
    it was.
  - **Hostile input.** Nine accounts that are not a uuid are refused on a connection that throws if used.
- **Red checks** (`write-limit-pause`, `writes`, `write-safety` and `table-ownership`, 24 tests). Each of these fails:

  | Edit | What fails |
  |---|---|
  | A `users` write back in `writes.ts` | The ownership test |
  | The pause not recorded | Four write-limit tests in `writes.test.ts` and `write-safety.test.ts` |
  | A pause that repeats | The first new test |
  | The reason overwritten | The second new test |
  | The account check removed | The hostile-input test |

  Restored and `cmp` identical, 24 of 24 pass.

---

## D113. A failed sign-in is counted against the account by users.ts, the users' owner (2026-11-17)

**What the code did** (at `d4ccf11`; an entry on the ownership debt list, F21.R2):
- **The write.** `recordAuthFailure` in `server/src/services/auth-failures.ts:10-16` counted a failed sign-in or step-up code against the
  account with its own `UPDATE users`. The statement:
  - starts the count again at 1 once an earlier lock has run out;
  - locks the account for 15 minutes at the fifth failure;
  - lifts a lock that has run out.

  At the fifth failure the function then raised a security alert.
- **Who owns that table.** `users` belongs to `services/users.ts`.
- **Who calls it.** The console's sign-in and step-up routes, the command line's sign-in, and its per-command code check.

**The decision:**
- **The statement moves; the policy stays.** `users.ts` exports `countAuthFailure(db, id, lockAt, lockMinutes)` with the same statement.
  It returns the count and the username after the change, or null when there is no such account. `auth-failures.ts` keeps the policy
  (five failures, 15 minutes), the alert and its title, and calls it.
- **What it checks** before the database is touched, each with its own message:
  - the account is a uuid;
  - the failures that lock are a whole number from 1 to 100;
  - the minutes locked are a whole number from 1 to 1440.

  Every caller passes an account id read from the database, so no sign-in that works today is refused.
- **Debt count:** the `services/auth-failures.ts` entry for `users` comes off, which leaves 42.

**Proof:**
- **`server/test/auth-failure-count.test.ts`** (new, 3 tests, against the database):
  - **Counting and locking.** Each failure counts one. The third of three locks the account for its 15 minutes, given the id in upper
    case. Another account is untouched, and an unknown account answers null.
  - **An expired lock.** A lock that has run out starts the count again at one and is lifted.
  - **Hostile input.** 11 inputs are refused, each with its own reason, on a connection that throws if used.
- **Red checks** (`auth-failure-count`, `console-api` and `table-ownership`, 27 tests). Each of these fails:

  | Edit | What fails |
  |---|---|
  | A `users` write back in `auth-failures.ts` | The ownership test |
  | A failure not counted | Three `console-api` sign-in tests (five failures lock; guessing codes locks; the count starts again after a lock) |
  | Reaching the limit not locking | The first new test and those three |
  | A lock that ran out not starting the count again | The second new test (no `console-api` test catches this alone) |
  | The account check or the number check disabled | The hostile-input test |

  Restored and `cmp` identical, 27 of 27 pass.

---

## D112. A batch's event links are written by events.ts, the events' owner (2026-11-17)

Numbered D112 because #271 takes D111 (D110 went to #306).

**What the code did** (at `e67dc55`; an entry on the ownership debt list, F21.R2):
- **The write.** `processBatch` in `server/src/services/alerts.ts:215-219` ended by recording, for every event of the batch that raised,
  joined or resolved an alert or matched a rule, that alert and rule, with its own `UPDATE events … FROM OPENJSON(…)`.
- **Who owns that table.** `events` belongs to `services/events.ts`. This was the last entry on its debt list.
- **Who calls it.** `processBatch` has one caller, `storeEvents` in `events.ts`, in the same transaction.

**The decision:**
- **`alerts.ts` decides, `events.ts` writes.** `processBatch` returns the links (`{ e, a, r }`, only those with an alert or a rule) with its
  outcomes. `storeEvents` passes them to a new `linkEventsToAlerts(c, cabinetId, links)` in the same transaction.
  - `alerts.ts` imports nothing new.
  - `events.ts` already imported `alerts.ts`, so no new import cycle.
- **What the function checks** before the database is touched, each with its own message:
  - the cabinet is a uuid;
  - the links are a list of at most 100, one per event in a batch (the event batch contract's `maxItems`);
  - each link's event is a uuid, and its alert and rule are each a uuid or null, never both null;
  - no event is linked twice.

  An empty list writes nothing.
- **One thing it adds.** The statement touches only the given cabinet's events. The old one matched on the event id alone. A batch's
  events are always its own cabinet's, so nothing that happens today changes.
- **Debt count:** the `services/alerts.ts` entry for `events` comes off, which leaves 43.

**Proof:**
- **`server/test/event-links.test.ts`** (new, 3 tests, against the database):
  - **Links.** An event raised, one suppressed and one resolved each get their alert and rule. An event not named is untouched, and
    another cabinet's event named under this cabinet is untouched.
  - **Rollback.** A link in a transaction that rolls back leaves the event as it was.
  - **Hostile input.** 17 inputs are refused, each with its own reason, on a connection that throws if used.
- **Red checks** (`event-links`, `alerts` and `table-ownership`, 31 tests). Each of these fails:

  | Edit | What fails |
  |---|---|
  | An `events` write back in `alerts.ts` | The ownership test |
  | `storeEvents` not recording the links | `alerts.test.ts` "an unrecognized error is mapped … and the next one raises the issue" |
  | The statement not limited to the cabinet | The links test |
  | The duplicate, size or empty-link check disabled | The hostile-input test |

  Restored and `cmp` identical, 31 of 31 pass.

---

## D110. A failed migration's alert is raised by security.ts, and the command line asks for it (2026-11-17)

**What the code did** (at `568a693`; an entry on the ownership debt list, F21.R2):
- **The write.** `alertMigrationFailed` in `server/src/db/migrate.ts:36-44` raised the "Database migration … failed" operations alert with
  its own `UPDATE security_alerts … IF @@ROWCOUNT = 0 INSERT …` on the owner's connection. `migrate()` called it when a migration failed
  (`migrate.ts:71`).
- **Who owns that table.** `security_alerts` belongs to `services/security.ts`.
- **Why it was left** (D88): moving the write into a service would make the database layer depend on that service.
- **What it skipped.** Every other security and operations alert goes through `raiseSecurityAlert`, which audits each raise
  (`security.alert`) and wakes the Admins' live streams. The migration alert did neither. A version name longer than the title column
  made it fail (it answered false), where `raiseSecurityAlert` cuts the title to fit.

**The decision:**
- **The alert moves to `security.ts`.** `alertMigrationFailed(owner, version)` raises it through `raiseSecurityAlert`, in its own
  transaction on the owner's connection. It is still best effort and still answers whether it was raised.
- **`migrate()` asks its caller instead.** It takes `onFailed(version)`, called after the failed migration's transaction has rolled back
  and before its error is thrown. A failing `onFailed` never hides that error.
- **The command line connects the two.** `platform-admin migrate` (`src/cli.ts`) passes `alertMigrationFailed`. The database layer imports
  no service, which answers D88's reason for leaving it.
- **What changes for an Admin:**
  - The alert is audited, like every other operations alert.
  - It appears on the live stream at once.
  - A long migration name is cut to fit instead of losing the alert.
- **Unchanged:** the kind, the signature (one open alert), the title and the detail.
- **Who calls `migrate()` without `onFailed`.** The test database setup and the migration tests. A failure there now raises no alert;
  none of them asserted one.
- **Debt count:** the `db/migrate.ts` entry for `security_alerts` comes off, which leaves 44.

**Proof** (`server/test/operations.test.ts`, two new tests, against the database):
- **The alert.** A hostile version name of 339 characters (an injection and padding) is raised: it folds into the one open migration
  alert, is stored as text cut to 256, is audited once as a repeat, and adds one notification.
- **The callback.** A broken migration added after the real ones:
  - fails with its own error;
  - tells the caller its version once;
  - leaves neither its half-built table nor a `schema_migrations` row.

  A caller whose alert throws still gets the migration's error. The command line's source passes `alertMigrationFailed`.
- **Red checks** (`operations` and `table-ownership`, 27 tests). Each of these fails:

  | Edit | What fails |
  |---|---|
  | A `security_alerts` write back in `migrate.ts` | The ownership test |
  | The command line passing no alert | The callback test |
  | `migrate()` never telling its caller | The callback test |
  | A failing alert allowed to replace the error | The callback test |
  | The alert's transaction not committed | The existing migration test, the new alert test, and the two system-health tests that count open alerts |

  Restored and `cmp` identical, 27 of 27 pass.

---

## D109. The clock tolerance is set site by site, from 10 to 120 seconds (2026-11-17)

**What the code did** (at `6aef428`):
- **One fleet-wide tolerance.** "Clock is off" opened when a cabinet's clock was more than `CLOCK_TOLERANCE_SECONDS` (120) from the
  server's (`server/src/services/cabinet-conditions.ts:15-21`).
- **Copied in five places.** The same 120 was written out again in the heartbeat's decision to check the time (`cabinets.ts:20`, its own
  copy "to avoid a circular import"), a fleet sync's verification (`fleet-jobs.ts:430`), the cabinet's time facts (`time.ts:98`) and the
  diagnosis (`cabinet-findings.ts:360`).

**The decision** (the owner's, spec 09 "Where the time zone, clock and firewall alerts live, and who adjusts them": what these alerts judge
must be adjustable site by site):
- **Three levels and a default, like the zone.** `sites.clock_tolerance_seconds` and `clients.clock_tolerance_seconds` (migration 0034)
  and the settings row `time.clockTolerance` give the site's own, else the client's, else the fleet's, else 120 seconds. All five users
  read one expression, `SITE_CLOCK_TOLERANCE_SQL`. `cabinet-conditions.ts` imports nothing, so `cabinets.ts` drops its copy.
- **10 to 120 seconds, taken as recommended** (the spec gives no range):
  - Not above 120, because the agent refuses a command issued more than two minutes ahead of its own clock (03-protocol.md). A looser
    tolerance would hide a clock that already breaks commands.
  - Not below 10, because the offset a heartbeat reports includes its own round trip.
- **Where the range is checked.** The contract (`clock-tolerance`), the service before it opens a transaction, and the column checks as
  the backstop. A fleet row outside the range, edited outside the platform, is ignored, so 120 applies.
- **Who sets each level.** Tier 2 and up for a site or a client, the same as the zone; an Admin for the fleet.
- **What a write does.**
  - It is audited with what it replaced: `{before, seconds}`.
  - It judges the cabinets it reaches again in the same transaction, so their alerts open or close at once.
  - It answers with what applies, read back from the database.
  - A failure rolls the whole change back. Undoing a change is setting the `before` its audit entry names.
- **Also changed.** The setting-origins read lists the tolerance after the time zone, and the console edits it on the site page, the
  client page, the Admin device defaults and the cabinet's Standards tab. The diagnosis gives an offset under two minutes in seconds
  (it said "0 minutes"). The closing sentence and a sync's verified text say "within its site's tolerance" in place of "within two minutes".
- **Unchanged:** the alert is still the cabinet's own and minor. With nothing set, every cabinet is judged at 120 as before.
- **No new debt.** `time.ts` was already listed for `sites`, `clients` and `settings`.

**Proof:**
- **`server/test/clock-tolerance.test.ts`** (new, 7 tests, against the database):
  - **The levels.** Each level applies in turn, and the alert opens with the site's write and closes when the site's own is cleared.
  - **The heartbeat.** A heartbeat checks the clock against the site's 20 seconds.
  - **Sync and diagnosis.** A fleet sync is verified only within the site's 30, and the diagnosis says "45 seconds ahead".
  - **Permissions.** Each refused role, and nobody signed in, writes nothing.
  - **Audit.** Each change is audited with its before.
  - **Hostile values.** 15 bodies are refused on each of the three routes, and 3 hostile site ids. Eight values reach the service on a
    connection that throws if used, and each is refused with its own message.
  - **Backstop.** The column checks refuse values outside the range, and five fleet rows edited outside the platform are ignored.
- **Red checks.** Each of these 11 edits fails that file:
  - the alert, the heartbeat, the verification or the diagnosis back on a fixed 120;
  - the title back to minutes;
  - the service check disabled;
  - the site route at Tier 1, or the fleet route at Tier 2;
  - the fleet row's range guard removed;
  - the audit's `before` dropped;
  - the site route answering what it was sent instead of reading back.

  Restored and `cmp` identical, 7 of 7 pass.

---

## D108. The demo simulator and usb-sql.ts are accepted writers, not debt (2026-11-17)

**What the code did** (at `4e84a42`; the ownership debt list, F21.R2):
- **The list.** `server/src/db/table-owners.ts` named every file other than a table's owner that writes it, as debt to move behind the
  owner: 76 entries.
- **Thirty of them were not meant to move.**
  - `demo/demo.ts` (24 tables), `demo/troubleshooting.ts` (4) and `demo/config.ts` (1) are the demo simulator, which seeds its own
    simulated cabinets' rows across the schema. The file's own header already said its reach is listed "so it stays visible".
  - `services/usb-sql.ts` (alerts and settings) keeps the USB layer's statements as data, in a module with no database driver, so
    `usb-sql.test.ts` checks each one against the migrations without a database; `usb-store.ts` runs them. Moving them behind
    `alerts.ts` would end that check.

**The decision** (the owner's, asked 2026-11-17: accept them as exceptions):
- **Accepted, with a reason.** Each table that one of these files writes lists it under a new `accepted`, and `ACCEPTED_WRITERS` names
  the reason for each of the four files. They are no longer counted as debt.
- **Still checked.** `table-ownership.test.ts` treats an accepted writer as allowed, holds it to the same "no longer writes" rule as debt,
  and adds a test: every accepted file has a reason, every reason is used by a table, no file is both debt and accepted, and no owner is
  accepted for its own table. A new write by one of these files to a table that does not accept it still fails the ownership test.
- **Debt list:** 45 entries on main after #303, with 30 accepted. Spec 01 "Module boundaries" says so.

**Proof** (`table-ownership.test.ts`, 6 tests):
- With usb-sql.ts's reason removed, with a reason no table uses, or with `demo/troubleshooting.ts` listed for `case_notes` as both debt
  and accepted, the new test fails.
- With a file accepted for a table it does not write, the "no longer writes" test fails.
- With `usb-sql.ts` taken off the `alerts` table's accepted list, the unlisted-write test fails.
- Restored and `cmp` identical, 6 of 6 pass.

---

## D107. The firewall alert opens and closes through alerts.ts, by named condition (2026-11-17)

**What the code did** (at D106's head, `b7b9c8b`; an entry on the ownership debt list, F21.R2):
- **The writes.** `evaluateDrift` in `server/src/services/firewall-policy.ts:93-117` opened each cabinet's minor "Firewall differs from
  client policy" alert with its own `MERGE alerts`, and closed it with its own `UPDATE alerts` through `closeAutomatically`, both built
  from its own condition text (`DIFFERS_SQL`, with the fleet policy as `$1`).
- **Who owns that table.** `alerts` belongs to `services/alerts.ts`.

**The decision** (the owner's, as for D106; spec 09 "Where the time zone, clock and firewall alerts live"):
- **A third named condition.** The condition text moves to `cabinet-conditions.ts` as `firewallDiffersSql(n)` and `firewallPolicySql(n)`,
  where `n` numbers the fleet policy's placeholder. At `n = 1` both are the same text as before, compared character for character.
  `firewall-policy.ts` builds its own reads (the heartbeat's pre-read, the bulk candidates) from them at `$1`, as before.
- **The fleet policy is a value, not SQL.** `foldCabinetCondition` takes it as `{ fleetPolicy }` and checks it before the database is
  touched: an object whose three profiles are each "on" or "off". A stored policy can hold more keys (`isPolicy` in `firewall-policy.ts`
  allows them); only the three profiles are passed on, and nothing that holds them is refused.
- **What each condition judges.** The time checks judge only cabinets heard from within the offline window; the firewall check judges
  every active cabinet, as it did. Each condition says which (`recentOnly`).
- **Per cabinet, adjustable per site.** The alert stays the cabinet's own, minor. The policy it is judged against is the site's own, else
  its client's, else the fleet's, so it is set site by site, as the owner asked.
- **Unchanged:** which cabinets get or lose the alert, the sentence, the closer (`firewall-policy`), the audit and the transaction.
- **One existing assertion changed:** D106's hostile-input test listed "firewall" among the names `alerts.ts` does not know. It now
  knows it, so that case names "firewallPolicy" instead; the count of 27 there is unchanged, and nine firewall refusals are added (36).
- **Debt list:** the `services/firewall-policy.ts` entry for `alerts` comes off, which leaves 75 once D106 has merged.

**Proof:**
- **The owner function.** `server/test/cabinet-condition-alerts.test.ts`, new firewall tests, against the database:
  - A site with its own all-on policy: both of its cabinets that differ get a minor alert, one of them not heard from in the offline
    window. A site following the fleet's all-off policy judges its all-on cabinet against that. Put right, the first site's alerts close,
    each audited by `firewall-policy` with its sentence, and the other client's alert stays.
  - A fleet policy holding a fourth key is judged on the three profiles, and a matching cabinet gets no alert.
  - Nine malformed fleet policies (missing, null, two profiles, "yes", booleans, a JSON string, an array) are refused before a connection
    that throws if used.
- **Load order.** `module-load-order.test.ts` also loads `firewall-policy.js` first; all six orders pass.
- **Red checks** (`cabinet-condition-alerts`, `firewall-policy`, `table-ownership`, `module-load-order`; 23 tests):
  - With `firewall-policy.ts` as at D106's head, `table-ownership.test.ts` fails.
  - With the firewall judged only on cabinets heard from recently, the site test fails.
  - With the site's own policy left out of `firewallPolicySql`, the site test fails.
  - With the fleet-policy check disabled, the hostile-input test fails.
  - With a policy of more than three keys refused, the fourth-key test fails.
  - Restored and `cmp` identical, 23 of 23 pass.
- **Neighbours.** The 21 non-browser files that import `services/firewall-policy.js`, `services/alerts.js` or
  `services/cabinet-conditions.js` (chosen by that exact import), with `module-load-order`, `table-ownership`, `audit-sweep` and
  `import-cycles`: 185 of 185.

---

## D106. The time zone and clock alerts open and close through alerts.ts, by named condition (2026-11-17)

**What the code did** (at `ee44fe6`; an entry on the ownership debt list, F21.R2):
- **The writes.** `evaluateTime` in `server/src/services/time.ts:42-67` opened each cabinet's minor time-zone or clock alert with its own
  `MERGE alerts`, and closed it with its own `UPDATE alerts` through `closeAutomatically`. Both statements were assembled in `time.ts`
  from its own condition text (`ZONE_WRONG`, `CLOCK_OFF`) and a scope fragment.
- **Who owns that table.** `alerts` belongs to `services/alerts.ts`. Moving the statements there as they were would have meant
  `alerts.ts` taking SQL from its callers.

**The decision** (the owner's, asked 2026-11-17; spec 09 "Where the time zone, clock and firewall alerts live"):
- **Named conditions.** The condition texts move to a new `services/cabinet-conditions.ts`, which imports nothing. `alerts.ts` gains
  `foldCabinetCondition(db, name, scope, { open, close })`: the caller names the condition (`timeZone` or `clock`) and a typed scope (one
  cabinet, site or client by id, or all), and `alerts.ts` builds the same MERGE and close from its own table of conditions. No caller
  passes SQL.
- **What `time.ts` keeps.** The lock-free read a heartbeat makes first, which says whether either statement is needed, and the zone
  rules. It re-exports `SITE_ZONE_SQL` and `CLOCK_TOLERANCE_SECONDS`, so `fleet-jobs.ts`, `replacement-reapply.ts` and
  `diagnose/cabinet.ts` are unchanged.
- **Checked before the database.** The name must be one of the table's own (not an inherited name such as `toString`), the scope's id a
  uuid, and the open and close flags booleans.
- **Load order.** `alerts.ts` and `rules.ts` import each other, and the table names `rules.ts`'s `ISSUE`, so it is built on first use, as
  D104 did for the event insert. With it built at load, a process that loads `rules.js` first stops.
- **Unchanged:** which cabinets get or lose an alert and when, the minor severity, the sentences, the closer (`time-check`), the audit and
  the transaction. No existing assertion changed.
- **Debt list:** the `services/time.ts` entry for `alerts` comes off, which leaves 76 on main after #300.

**Proof:**
- **The owner function.** `server/test/cabinet-condition-alerts.test.ts`, against the database:
  - A cabinet in the wrong zone gets one minor alert; one in the right zone, one not heard from in the offline window, and a cabinet at
    another site do not. Again, the alert is kept, not doubled. Put right, it closes, audited once by `time-check` with its sentence.
  - A clock 300 seconds off opens the clock alert (119 seconds does not, nor the zone's). Asked only to close, nothing opens; asked only
    to open, nothing closes. A removed cabinet's alert closes.
  - A fold in a transaction that rolls back leaves no alert.
  - 27 hostile inputs (unknown and inherited names, a SQL fragment as a name, an injection string as an id, malformed scopes and flags)
    are refused before a connection that throws if used, each by its own message. Asked to run neither, nothing reaches the database.
- **Load order.** `module-load-order.test.ts` now also loads `time.js` and `cabinet-conditions.js` first; all five orders pass.
- **Red checks** (`cabinet-condition-alerts`, `module-load-order`, `table-ownership`; 14 tests):
  - With `time.ts` as on main, `table-ownership.test.ts` fails.
  - With the table of conditions built at load, the `rules.js` load-order case fails.
  - With the MERGE's scope, or its offline window, dropped, the zone test fails.
  - Each of the three input checks disabled on its own fails the hostile-input test.
  - Restored and `cmp` identical, 14 of 14 pass.
- **Neighbours.** The 20 non-browser files that import `services/time.js`, `services/alerts.js` or `services/cabinet-conditions.js`
  (chosen by that exact import), with `module-load-order`, `table-ownership`, `audit-sweep` and `import-cycles`: 172 of 172.

---

## D105. An alert folded into itself keeps its events, as before D104 (2026-11-16)

**What the code did** (at `ee44fe6`, since #300):
- `moveAlertEvents` in `server/src/services/events.ts:114` refused a move whose two alerts are the same, and so stopped the rule's
  activation that called it.
- Before #300 (D104), `rules.ts` ran the statement in that case: the events stayed on the alert and recorded the rule
  (`UPDATE events SET alert_id = $2, matched_rule = $3 WHERE alert_id = $1` with `$1 = $2`).
- The #300 review found the difference. No path builds that case today: the regroup folds only alerts with no issue type, under an issue
  signature they do not carry.

**The decision** (the owner's, asked 2026-11-16: go back to the earlier behaviour):
- The refusal is removed. The statement runs as it did, so an alert folded into itself keeps its events and they record the rule, and a
  rule going live never fails on it. The three uuid checks stay.
- **Assertions changed:** the hostile-input test in `alert-events-move.test.ts` no longer expects the same-alert refusal, so its count
  goes from 22 to 21 and its title drops "two alerts that differ". That is the behaviour this entry changes back.

**Proof:**
- `server/test/alert-events-move.test.ts`, new test "an alert folded into itself keeps its events and records the rule": with the same
  alert in other letter case on both sides, both of its events stay on it and record the rule, and another alert's event is untouched.
- **Red check:** with the refusal put back, that test fails. Restored and `cmp` identical, the file passes 4 of 4.

---

## D104. A rule's regroup moves the alert's events through events.ts, the events' owner (2026-11-16)

**What the code did** (at `ca8e7c0`; an entry on the ownership debt list, F21.R2):
- **The write.** When a rule goes live, `regroupOpen` in `server/src/services/rules.ts:354` folds each matching unrecognized alert into
  its issue's alert and moved that alert's events with its own `UPDATE events SET alert_id = $2, matched_rule = $3 WHERE alert_id = $1`.
- **Who owns that table.** `events` belongs to `services/events.ts`. The regroup is audited by the rule's activation; the event move
  itself writes no audit row, then or now.

**The decision:**
- **A new owner function.** `moveAlertEvents(c, fromAlertId, toAlertId, ruleId)` in `events.ts` holds the same statement, in the caller's
  transaction, and returns how many events moved. The three ids must be uuids and the two alerts must differ, checked before the
  database is touched.
- **An import both ways, and what it needed.** `events.ts` already imports `rules.ts`, so `rules.ts` importing `events.ts` makes them
  import each other. `events.ts` built its event insert when the module loaded, from `rules.ts`'s `RULES_STAMP_SQL`. With the import
  added, a process that loads `rules.js` or `alerts.js` first stopped with "Cannot access 'RULES_STAMP_SQL' before initialization", the
  failure D73 met in another pair. Main loads in all three orders. The insert is now built on first use and kept
  (`insertEventsSql()`), so the order modules load in no longer matters. The statement's text is the same.
- **Unchanged:** which events move, the rule they record, and the transaction. No existing assertion changed.
- **Debt list:** the `services/rules.ts` entry for `events` comes off, which leaves 77 on main after #299.

**Proof:**
- **Load order.** `server/test/module-load-order.test.ts` loads `rules.js`, `events.js` and `alerts.js` each first, in a fresh process.
  With the insert built at load again, the `rules.js` and `alerts.js` cases fail with the error above; with it built on first use, all
  three pass.
- **The owner function.** `server/test/alert-events-move.test.ts`, against the database:
  - Both events of the alert moved from go to the alert moved to, with the rule, including one that had matched an earlier rule. An
    event already on the target keeps its rule; another alert's event and an event with no alert are untouched. A repeat moves nothing.
  - A move in a transaction that rolls back leaves the events where they were.
  - 22 hostile inputs (ids including an injection string, an array and a number, and the same alert in other letter case) are refused
    before a connection that throws if used, each by its own check's message.
- **Red checks** (`alert-events-move`, `module-load-order`, `table-ownership`; 11 tests):
  - With `rules.ts` as on main, `table-ownership.test.ts` fails.
  - With the insert built at load again, the two load-order cases fail.
  - With the move's `WHERE` made always true, the move test and the rollback test fail.
  - With the id check, or the same-alert check, disabled, the hostile-input test fails.
  - Restored and `cmp` identical, 11 of 11 pass.
- **Neighbours.** The 30 non-browser files that import `services/rules.js` or `services/events.js` (chosen by that exact import), with
  `module-load-order`, `table-ownership`, `audit-sweep` and `import-cycles`: 282 of 282.

---

## D103. A fleet job withdraws its outstanding commands through commands.ts, the commands' owner (2026-11-16)

**What the code did** (at `73c8fcd`; an entry on the ownership debt list, F21.R2):
- **The write.** While following a batch, `followUp` in `server/src/services/fleet-jobs.ts:343-360` withdrew the batch's commands that
  were overdue, or still queued for a cabinet not heard from, with its own `UPDATE commands`. One delivered, or whose cabinet is offline,
  became `expired`; one undelivered to an online cabinet became `failed`. Its expiry was pulled in to now, kept above its issue time.
- **Its own audit.** It then wrote its own `command.expire` rows with `auditMany`: actor `command-expiry`, naming the job, why
  (`fleet-job-withdrawal`) and whether the command had been delivered.
- **Who owns that table.** `commands` belongs to `services/commands.ts`. With the insert moved by D102, this was the last write to
  `commands` in `fleet-jobs.ts`.

**The decision:**
- **A new owner function.** `withdrawJobCommands(tx, jobId, commandIds, offlineAfterSeconds, batchMs)` in `commands.ts` holds the same
  statement and the same audit, in the caller's transaction. `fleet-jobs.ts` keeps the read of the commands' outcomes that follows it.
- **Checked before the database.** The job and every command id must be uuids, 1 to 200 of them (a job covers at most 200 cabinets,
  `fleet-job.schema.json`), the offline window 1 to 86,400 whole seconds, and the batch budget 0 to 86,400,000 whole milliseconds.
  Tests run jobs with a budget of 0, so 0 is allowed.
- **A target without a command.** A target a restart left as answered but unverified has no command id, and `followUp` used to pass
  its null key to the statement along with the others, where it matched nothing. The first version of this change refused the null, and
  `fleet-jobs-sync-last.test.ts` "a satellite left waiting for verification by a server restart" failed (the sync cabinet stayed
  pending instead of skipped). `followUp` now passes only the real ids, and skips the call when there are none. Nothing changes: the
  read that follows still finds that target missing, as before.
- **Unchanged:** which commands are withdrawn, their new status and expiry, the audit, and the transaction. No existing assertion
  changed.
- **Debt list:** the `services/fleet-jobs.ts` entry for `commands` comes off, which leaves 78 on main after #298. `commands` now lists
  only `demo/demo.ts`.

**Proof:**
- **The owner function.** `server/test/job-command-withdrawal.test.ts`, against the database:
  - Of five commands given, the one queued to an offline cabinet is withdrawn at once as expired, the one overdue to an online cabinet
    as failed, and the delivered overdue one as expired. The one within its budget and the finished one are left alone, as is one not
    given. Each withdrawal is audited once, with the job, the cabinet, the reason and whether it was delivered. Every expiry stays after
    its issue time. A repeat withdraws nothing.
  - A budget of 0 withdraws a command issued that moment, with its expiry still after its issue time.
  - A withdrawal in a transaction that rolls back leaves the command queued and unaudited.
  - 30 hostile inputs (ids including an injection string and 201 of them, windows and budgets that are negative, fractional, NaN,
    infinite, too large or strings) are refused before a connection that throws if used, each by its own check's message.
- **Red checks** (`job-command-withdrawal`, `fleet-jobs-sync-last`, `table-ownership`; 15 tests):
  - With `fleet-jobs.ts` as on main, `table-ownership.test.ts` fails.
  - With the filter of null ids removed, the restart test above fails.
  - With the offline rule removed, the withdrawal test and the rollback test fail.
  - With the audit disabled, the withdrawal test fails.
  - Each of the four input checks disabled on its own fails the hostile-input test.
  - Restored and `cmp` identical, 15 of 15 pass.
- **Neighbours.** The 20 non-browser files that import `services/commands.js` or `services/fleet-jobs.js` (chosen by that exact
  import), with `table-ownership`, `audit-sweep` and `import-cycles`: 217 of 217.

---

## D102. Bulk changes queue their commands through commands.ts, the commands' owner (2026-11-16)

**What the code did** (at `10a9972`; entries on the ownership debt list, F21.R2):
- **The writes.** Two bulk paths inserted queued commands into `commands` themselves, each with its own `INSERT INTO commands …
  'queued', bulk_id`: the bulk firewall change (`server/src/services/firewall-policy.ts:190-191`) and each fleet-job batch
  (`server/src/services/fleet-jobs.ts:297-298`).
- **Who owns that table.** `commands` belongs to `services/commands.ts`. Its single-command path, `issueCommand`, checks the operation
  against the catalog and the parameters against the operation's schema before anything is stored. The two bulk inserts stored what
  they were given.

**The decision:**
- **A new owner function.** `queueBulkCommand(c, cmd)` in `commands.ts` holds the insert both paths shared, in the caller's transaction.
  The callers keep what is theirs: the person, the fleet pause, the write limit, each cabinet's state, and the audit of what they queued.
- **Checked where it is stored.** Before the database is touched it checks, as `issueCommand` does, that the operation is a catalog
  write, that the parameters match its schema, that the four ids are uuids, and that the expiry is after the issue time.
- **What that changes.** Both paths build their parameters on the server (a fleet job's plan, `fleet-jobs.ts:94-132`, where the
  network fixes are already schema-checked; the firewall switches from the policy), so every command they queue today passes. A command
  that did not, which only a server defect or a hand-edited `fleet_job_targets` row could produce, is now not stored: the batch's
  transaction rolls back with the error, where before it was queued for the agent to refuse. Spec 05 "Fleet safety controls" says so.
- **Debt list:** the `services/firewall-policy.ts` entry for `commands` comes off, which leaves 79 on main after #296. `services/fleet-jobs.ts` stays on it: it also withdraws a batch's unanswered commands with its own `UPDATE commands`
  (`fleet-jobs.ts:345`), which is its own entry to move.
- **No import cycle:** `commands.ts` reaches neither `fleet-jobs.ts` nor `firewall-policy.ts`.

**Proof:**
- **The owner function.** `server/test/bulk-command-queue.test.ts`, against the database:
  - A command is stored as given: queued, in its bulk, by its issuer, with its parameters and times.
  - One queued in a transaction that rolls back is not stored.
  - 45 hostile inputs are refused before a connection that throws if used, each by its own check's message: ids (an injection string, a
    number), operations (not in the catalog, a shell-like name, the wrong case, and a read with parameters its schema accepts),
    parameters, and times (equal, earlier, invalid, strings).
- **Red checks** (`bulk-command-queue`, `table-ownership`):
  - With `firewall-policy.ts` as on main, `table-ownership.test.ts` fails.
  - Each of the six checks disabled on its own fails the hostile-input test. The first version of that test accepted any refusal, and
    two checks stayed green when disabled (a later check, or a `TypeError`, refused the same value); it now asks for each check's own
    message.
  - Restored and `cmp` identical, it passes.
- **Neighbours.** The 23 non-browser files that import `services/commands.js`, `services/fleet-jobs.js` or
  `services/firewall-policy.js`, with `table-ownership`, `audit-sweep` and `import-cycles`: 255 of 255 on the second run. On the first
  run, `fleet-jobs.test.ts` "a cabinet that took the command and never answered is failed" failed once. That file passed 3 of 3 alone.
  The test waits a fixed 300 ms for the batch to queue its command before marking it taken. That timing is not proven to be the cause.

---

## D101. A cabinet replacement closes the old cabinet's alerts through alerts.ts, the alerts' owner (2026-11-16)

**What the code did** (at `dbee3d3`; an entry on the ownership debt list, F21.R2):
- **The write.** `completeReplacement` in `server/src/services/replacement.ts:86-93` retires the replaced cabinet. It resolved every
  unresolved alert of that cabinet itself, with its own `UPDATE alerts … WHERE cabinet_id = $1 AND state <> 'resolved'`, resolution
  "Replaced by <name>.".
- **Its own audit.** It then wrote its own `alert.resolve` rows with `auditMany`: actor the user who approved the replacement, with
  `issueTypeId`, `resolution`, `automatic: true` and `replacedBy`.
- **Who owns that table.** `alerts` belongs to `services/alerts.ts`. `replacement.ts` wrote `alerts` nowhere else.

**The decision:**
- **A new owner function.** As with D100, it is a user's action that closes these alerts, and the audit names the replacing cabinet, so
  `closeAutomatically` (actor system) does not fit. `closeReplacedCabinetAlerts(db, userId, cabinetId, replacedBy, resolution)` in
  `alerts.ts` holds the same statement and audits each close by that user with the same details, in the caller's transaction.
- **Checked before the database.** The user and both cabinets (each a uuid, and the two cabinets different), and the resolution (1 to 500
  characters, no control characters), are checked before any query.
- **Why the resolution check refuses nothing real.** The resolution is built from the new cabinet's name. The approval contract
  (`contracts/schemas/console/approve-enrollment.schema.json`, `cabinet`) already allows only 1 to 128 characters with no control
  characters, so every name a replacement can carry passes.
- **Unchanged:** which alerts close and when, the sentence, the actor, the details and the transaction. No existing assertion changed.
  `replacement.ts` drops `auditMany`, which nothing else there used. No import cycle: `alerts.ts` does not import `replacement.ts`.
- **Debt list:** the `services/replacement.ts` entry for `alerts` comes off, which leaves 80 on main after #295.

**Proof:**
- **Behaviour.** `server/test/cabinet-replacement.test.ts` asserts the old cabinet's alert is resolved as "Replaced by SYNC." and the
  replacement reports one alert resolved. It passes through the new call.
- **The owner function.** `server/test/replaced-cabinet-alert-close.test.ts`, against the database:
  - Every unresolved alert of the replaced cabinet closes, with an issue type or without, a claimed one included. Each is audited once by
    the user with its issue type, the resolution, `automatic: true` and `replacedBy`. One resolved already and another cabinet's alert
    are left alone. A repeat closes nothing.
  - A close in a transaction that rolls back leaves the alert open and unaudited.
  - 30 hostile inputs (ids including an injection string, an array and a number; a cabinet replacing itself in other letter case;
    resolutions) are refused before a connection that throws if used.
- **Red checks** (`replaced-cabinet-alert-close`, `cabinet-replacement`, `table-ownership`, `audit-sweep`, `import-cycles`; 19 tests):
  - With `replacement.ts` as on main, `table-ownership.test.ts` fails.
  - With the cabinet scope made always true, the new close test fails.
  - With the audit disabled, the new close test fails.
  - With the self-replacement check disabled, the hostile-input test fails.
  - Restored and `cmp` identical, 19 of 19 pass.
- **Neighbours.** The 34 non-browser files that import `services/alerts.js`, `services/replacement.js` or `services/enrollment.js`
  (chosen by that exact import), with `table-ownership`, `audit-sweep` and `import-cycles`, at main with #295 merged in: 347 of 349
  pass, with 2 skipped that need `TEST_AGENT_DLL`. The first commit's message gives 344 of 346 for 36 files chosen by a looser text
  match, which also caught files that only mention the words.

---

## D100. Switching a client's fingerprint scanner off closes its alerts through alerts.ts, the alerts' owner (2026-11-16)

**What the code did** (at `82d6e84`; an entry on the ownership debt list, F21.R2):
- **The write.** `applyScannerChoice` in `server/src/services/client-scanner.ts:57-68`, when an Admin switches a client's scanner off,
  resolved the unresolved scanner alerts on every cabinet of that client itself: its own `UPDATE a … FROM alerts a JOIN cabinets k JOIN
  sites s WHERE s.client_id = $1`.
- **Its own audit.** It then wrote its own `alert.resolve` rows with `auditMany`: actor the user who switched it off, with `issueTypeId`,
  `resolution` and `automatic: true`.
- **Who owns that table.** `alerts` belongs to `services/alerts.ts`. `client-scanner.ts` wrote `alerts` nowhere else.

**The decision:**
- **A new owner function.** The existing closes are by one cabinet, and they audit as the system through `closeAutomatically`. This one
  spans a client's cabinets, and it is a user's choice that closes the alerts. `closeClientIssueAlerts(db, userId, clientId,
  issueTypeId, resolution)` in `alerts.ts` holds the same statement, and audits each close as `alert.resolve` by that user with the same
  details, in the caller's transaction.
- **Checked before the database.** The user, the client and the issue type (each a uuid), and the resolution (1 to 500 characters, no
  control characters), are checked before any query.
- **An import both ways.** `alerts.ts` already imports `scannerUsedFor` from `client-scanner.ts`, and now `client-scanner.ts` imports
  `closeClientIssueAlerts` from `alerts.ts`. As with `crashes.ts` since #292, neither calls the other while loading, so the order they
  load in does not matter. `import-cycles.test.ts` guards `maintenance.ts` only, and still passes.
- **Unchanged:** which alerts close and when, the sentence, the actor, the details and the transaction. No existing assertion changed.
  `client-scanner.ts` drops `auditMany`, which nothing else there used.
- **Debt list:** the `services/client-scanner.ts` entry for `alerts` comes off, which leaves 81 on main after #294.

**Proof:**
- **Behaviour.** `server/test/client-scanner-sql.test.ts`, "switching off: … open scanner alerts resolved and audited", passes through the
  new call.
- **The owner function.** `server/test/client-issue-alert-close.test.ts`, against the database:
  - The client's open and claimed scanner alerts, on cabinets at two sites, close and are audited once each by the user, with the
    details as before. Another issue's alert, another client's alert and one resolved already are left alone. A repeat closes nothing.
  - A close in a transaction that rolls back leaves the alert open and unaudited.
  - 29 hostile inputs (ids including an injection string, an array and a number; resolutions) are refused before a connection that
    throws if used.
- **Red checks** (`client-issue-alert-close`, `client-scanner-sql`, `table-ownership`, `audit-sweep`, `import-cycles`; 24 tests):
  - With `client-scanner.ts` as on main, `table-ownership.test.ts` fails.
  - With the client scope made always true, the new close test fails.
  - With the audit disabled, the new close test and the switch-off test fail.
  - With the user id check disabled, the hostile-input test fails.
  - Restored and `cmp` identical, 24 of 24 pass.
- **Neighbours.** The 17 non-browser files that reach `alerts.ts`, `client-scanner.ts` or `fleet.ts` pass: 141 of 141.

---

## D99. The site-outage check closes its alerts through alerts.ts, the alerts' owner (2026-11-16)

**What the code did** (at `e8c176d`; an entry on the ownership debt list, F21.R2):
- **The write.** `checkSiteOutages` in `server/src/services/site-outage.ts:51-71` closed the site-outage alerts of sites heard from again
  itself: up to 500 ids per statement, with its own `UPDATE a … FROM alerts a JOIN cabinets k`, and the site's liveness checked again in
  that statement.
- **Its own audit.** It then wrote its own `alert.resolve` rows with `auditMany`: actor `site-outage`, with `issueTypeId`, `resolution`
  and `automatic: true`.
- **Who owns that table.** `alerts` belongs to `services/alerts.ts`. `site-outage.ts` raises the alert through `foldAlert` and wrote
  `alerts` nowhere else.

**The decision:**
- **A new owner function.** None of the existing closes re-checks a site's liveness, and that re-check is what keeps an alert about a
  site that went quiet again open. `closeSiteOutageAlerts(db, by, alertIds, liveWithinSeconds, resolution)` in `alerts.ts` holds the
  same statement. It closes only the ids given, at most `SITE_OUTAGE_CLOSE_SLICE` (500) at a time.
- **Checked before the database.** The closer, every id (a uuid), the window (1 to 86,400 whole seconds) and the resolution (1 to 500
  characters, no control characters) are checked before any query. Only the placeholders are composed, from the count; every value is a
  parameter.
- **The audit through `closeAutomatically`.** Each close is still audited as `alert.resolve` by `site-outage`, with `automatic: true`,
  in the caller's transaction.
- **What `site-outage.ts` keeps.** The snapshot read of which alerts to close, and the slicing. It drops `auditMany`.
- **One difference in what is recorded.** The audit details now carry `cabinetId` and `verifiedFix` (null: no platform write fixes a
  site outage) instead of `issueTypeId`, as every automatic close does (`automatic-close.ts`). The alert the entry targets still holds
  its issue type. Nothing reads `issueTypeId` from an `alert.resolve` entry.
- **Unchanged:** which alerts close and when, the sentence, the actor and the transaction. No existing assertion changed.
- **Debt list:** the `services/site-outage.ts` entry for `alerts` comes off, which leaves 82 on main after #293.

**Proof:**
- **The owner function.** `server/test/site-outage-close.test.ts`, against the database:
  - Given alerts at a live site close and are audited once each by `site-outage`. Those at a site not heard from in the window, at a
    site where only a removed cabinet reports, or not given, stay open. One resolved already is not rewritten. A repeat closes nothing.
  - The window is the one given: a cabinet heard from 400 seconds ago does not make its site live in a 300-second window, and does in
    a 500-second one.
  - A close in a transaction that rolls back leaves the alert open and unaudited.
  - 36 hostile inputs (closers, ids including an injection string and 501 of them, windows, resolutions) are refused before a
    connection that throws if used. A full slice of 500 is accepted.
- **The check.** `server/test/integrity-system-audit.test.ts` still finds the close re-checking the site and one audited
  `alert.resolve`. Its stand-in database now answers the close with the cabinet and resolution columns `closeAutomatically` reads back.
  That is a change to the stand-in, not to an assertion.
- **Red checks** (`site-outage-close`, `integrity-system-audit`, `table-ownership`, `audit-sweep`; 17 tests):
  - With `site-outage.ts` as on main, `table-ownership.test.ts` fails.
  - With the liveness re-check made always true, the first two tests above fail.
  - With the id check disabled, and separately the window check, the hostile-input test fails.
  - Restored and `cmp` identical, 17 of 17 pass.
- **Neighbours.** The 14 non-browser files that reach `alerts.ts` or `site-outage.ts` (among them `alerts-sql`, `scale` and `demo`)
  pass: 122 of 122.

---

## D98. The disk-filling forecast closes its alert through alerts.ts, the alerts' owner (2026-11-16)

**What the code did** (at `e8c176d`; an entry on the ownership debt list, F21.R2):
- **The write.** When the system drive stops filling, `checkDiskForecast` in `server/src/services/drives.ts:79-87` closed the cabinet's
  unresolved `disk-forecast` alert itself, inside `inTransaction`, with its own
  `UPDATE alerts … WHERE cabinet_id = $1 AND signature = 'disk-forecast' AND state <> 'resolved'`.
- **Its own audit.** It then wrote its own `alert.resolve` rows with `auditMany`: actor `drive-forecast`, with `cabinetId`, `resolution`
  and `automatic: true`.
- **Who owns that table.** `alerts` belongs to `services/alerts.ts`. `drives.ts` raises the alert through `upsertAlert` and writes
  `alerts` nowhere else.

**The decision:**
- **The owner function from D94.** The statement is the close by signature that `closeSignatureAlert` holds. `drives.ts` now calls it
  with closer `drive-forecast`, the cabinet, `disk-forecast` and the same sentence.
- **The audit through `closeAutomatically`.** Each close is still audited as `alert.resolve` by `drive-forecast`, with `automatic: true`,
  in the caller's transaction or a new one.
- **Imports.** `drives.ts` drops `auditMany` and `inTransaction`, which nothing else there used.
- **One difference in what is recorded.** The audit details now also carry `verifiedFix`, as every automatic close does
  (`automatic-close.ts`, F18.R1). It names the platform fix that explains the close, or null. Nothing reads its absence.
- **Unchanged:** which alert closes and when, the sentence, the actor and the transaction. No existing assertion changed.
- **Debt list:** the `services/drives.ts` entry for `alerts` comes off, which leaves 83 on main after #292.

**Proof:**
- **Behaviour.** `server/test/drives.test.ts`, "the disk-filling forecast resolves itself once the system drive stops filling", asserts
  the alert closes and is audited once by the system with `automatic: true`. It passes through the new call.
- **Red checks** (`drives`, `table-ownership`, `audit-sweep`, `import-cycles`; 20 tests):
  - With `drives.ts` as on main, `table-ownership.test.ts` fails.
  - With the signature passed as `disk_forecast`, the forecast test fails, so it watches this close.
  - Restored and `cmp` identical, 20 of 20 pass.
- **Neighbours.** The 25 files that test `drives.ts` and the modules that call it (`cabinets.ts`, `maintenance.ts`, the reading routes,
  the demo) pass: 291 of 298, with 7 skipped that need `TEST_AGENT_DLL`.

---

## D97. The baseline-alert ordering test locks the alert by its id (2026-11-15)

**What the test did** (`server/test/network-troubleshooting.test.ts:270`, at `2f45af4`, after D93):
- **The holder.** It locked the alert with `SELECT … WITH (UPDLOCK, ROWLOCK) WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <>
  'resolved'`.
- **The probe.** D93's probe checked for that lock with `UPDLOCK, READPAST` on the same predicate, and gave up after 10 s with "the
  holder never took the alert row".
- **Seen.** That failure, once, in the #285 gate (non-browser files at concurrency 2). The re-run passed.

**What I found:**
- **Not the login.** D93 put the late holder down to a slow login. With the holder's acquire limit forced to 1 ms, the test fails with
  the timeout itself ("operation timed out"), not with "never took". A holder batch that fails is also reported with its own error. So
  neither produces this message.
- **A mechanism that does.** On the test database the holder's read by cabinet and issue type reads other alert rows too, so it blocks on
  another cabinet's alert held by another transaction, while the probe skips that row and sees this alert free. With another cabinet's
  baseline alert held for 11 s from a third connection, main's version failed 2 of 2: once "the holder never took the alert row", once
  with the diagnosis failing after the holder got through late.
- **Not proven:** that this is what happened in the #285 gate. What held a lock that long there is not known.

**The decision:**
- **Lock and look up by id.** The test reads the alert's id once, then the holder locks `WHERE id = $2` and the probe looks it up by the
  same id. That is a primary-key seek that reads the alert alone, so another cabinet's locks no longer reach the test.
- **D93's comment** no longer blames the login. It says the holder was late taking the row.
- **Unchanged:** the order the test proves, the 7 s hold, the 10 s wait and every assertion.
- **Noted, not changed:** on the test database the diagnosis's own close (`closeIssueAlert`, D92) blocked on that other cabinet's lock too,
  although `alerts_open_issue` covers it. That points at a scan on a table with few rows; whether it happens at production size is not
  measured, so no product change is made.

**Proof** (that one test, run alone):
- **Another cabinet's alert held for 11 s:** the fixed test passes 2 of 2. Main's version fails 2 of 2, as above.
- **Red check:** with `finishDiagnosis` moved before `reconcileBaselineAlert` in `network.ts`, the fixed test fails. Restored and `cmp`
  identical, it passes 3 of 3.
- **The whole file:** 13 of 13.

---

## D96. The heartbeat closes a reboot-loop alert through alerts.ts, the alerts' owner (2026-11-15)

**What the code did** (on #284's head, `467d79f`; an entry on the ownership debt list, F21.R2):
- **The write.** `bootFromHeartbeat` in `server/src/services/crashes.ts:67` closed the cabinet's unresolved `reboot_loop` alert once the
  cabinet had run for 2 hours, with its own `UPDATE alerts … WHERE cabinet_id = $1 AND signature = 'reboot_loop' AND state <> 'resolved'`
  passed to `closeAutomatically`, resolution "Running for 2 hours without restarting."
- **Who owns that table.** `alerts` belongs to `services/alerts.ts`. `crashes.ts` raises through `upsertAlert` and writes `alerts`
  nowhere else.

**The decision:**
- **The owner function from D94.** The statement is exactly the close by signature that `closeSignatureAlert` holds, so `crashes.ts`
  calls it with closer `reboot-loop`, the cabinet, `reboot_loop` and the same sentence. The close is still audited as `alert.resolve` by
  `reboot-loop` through `closeAutomatically`. `crashes.ts` drops its now-unused `automatic-close.js` import.
- **Unchanged:** which alert closes and when, the audit, and the input check, which is `closeSignatureAlert`'s (D94).
- **No new owner code and no existing assertion changed.**
- **Debt list:** the `services/crashes.ts` entry for `alerts` comes off, which leaves 84 after #285.
- **Depends on #284**, which adds `closeSignatureAlert`. This branch started from #284's head; main, with #284 and #285, is merged in.

**Proof:**
- **Behaviour:** `server/test/crashes.test.ts` "3 in an hour is a reboot loop, 2 hours up ends it" asserts the loop alert is resolved
  after 2 hours up. It passes through the new call.
- **Red checks** (`crashes`, `table-ownership`, `audit-sweep`, `import-cycles`; 27 tests):
  - With `crashes.ts` as on #284's head, `table-ownership.test.ts` fails.
  - With the signature passed as `reboot-loop` instead of `reboot_loop`, the 2-hour test and the went-quiet test fail, so the existing
    tests watch this close.
  - Restored and `cmp` identical, 27 of 27 pass.
- **Neighbours:** `crashes`, `alerts-sql`, `fleet-patterns`, `scale` and `signature-alert-writes` pass, 62 of 62.

---

## D95. A rule going live closes the alerts it regroups through alerts.ts, the alerts' owner (2026-11-15)

**What the code did** (at `dd7190c`; an entry on the ownership debt list, F21.R2):
- **The write.** When a rule goes live, `regroup` in `server/src/services/rules.ts` folds each matching open unrecognized alert into the
  issue's alert with `foldAlert`, which is the owner's. It then closed the old alert itself (`:356`): `UPDATE alerts … WHERE id = $1`,
  passed to `closeAutomatically` with the resolution "Regrouped under <issue name>."
- **Who owns that table.** `alerts` belongs to `services/alerts.ts`. `rules.ts` writes `alerts` nowhere else. (It also moves the old
  alert's events to the new one with `UPDATE events`, an entry under `events` that this does not touch.)

**The decision:**
- **An owner function.** `alerts.ts` exports `closeAlertById(db, by, alertId, resolution)`. It holds the same statement, by id alone,
  because the caller has just read the alert as unresolved in the same transaction. It runs through `closeAutomatically`, so the close is
  still audited as `alert.resolve` by `rule-regroup`, with `automatic: true`, in the caller's transaction.
- **The caller** passes what it passed before. `rules.ts` drops its now-unused `automatic-close.js` import.
- **Input check, before the database is touched:**
  - the closer is a lower-case name of 1 to 64 letters, digits and hyphens;
  - the alert is an id;
  - the resolution is 1 to 500 characters, not blank, with no control characters, as in `closeIssueAlert` (D92). The longest one
    `regroup` writes is "Regrouped under " and an issue name of at most 128 characters (`issue_types.name`).
- **Unchanged:** which alert closes, the audit and the transaction. No existing assertion changed.
- **Debt list:** the `services/rules.ts` entry for `alerts` comes off, which leaves 85 after #284 (89 against main at `dd7190c`).

**Proof** (`server/test/alert-close-by-id.test.ts`, three tests):
- **Closing:** that alert is closed with the resolution and audited once by the closer, with its cabinet and the resolution. Another
  alert of the cabinet stays open. An unknown id closes nothing.
- **Rollback:** a close in a transaction that rolls back leaves the alert open and unaudited.
- **Bad input:** 22 bad calls are refused through a connection that fails the test if it is used, including an injection string, a line
  feed and a NUL. Nothing is closed.
- **Red checks** (`alert-close-by-id`, `table-ownership`, `audit-sweep`, `import-cycles`; 15 tests):
  - With `rules.ts` as on main, `table-ownership.test.ts` fails.
  - With the id check disabled (`false && …`), the bad-input test fails.
  - Restored and `cmp` identical, 15 of 15 pass.
- **Neighbours:** `alerts`, `alerts-sql`, `crash-signatures` and every file that imports `rules.ts` (26 files) pass, 243 of 248, with 5
  skipped that need `TEST_AGENT_DLL`.

---

## D94. Service recovery, peer differences and firmware drift retitle and close their alerts through alerts.ts (2026-11-15)

**What the code did** (at `dd7190c`; three entries on the ownership debt list, F21.R2):
- **Three writers of `alerts`, the same two statements each.** Each check raises its alert with `upsertAlert`, which is the owner's,
  then wrote `alerts` itself twice:
  - **a retitle**, `UPDATE alerts SET title = $2 WHERE id = $1 AND title <> $2`, because the fold keeps an alert's first title and these
    titles name what the latest reading found;
  - **a close by signature**, `UPDATE alerts … WHERE cabinet_id = $1 AND signature = $3 AND state <> 'resolved'`, passed to
    `closeAutomatically`, when the condition was gone.
- **Where:** `server/src/services/service-recovery.ts:37` and `:40`; `server/src/services/peer-differences.ts:115` and `:118`;
  `server/src/services/baseline-drift.ts:112` and `:115`. None of the three writes `alerts` anywhere else.

**The decision:**
- **Two owner functions** in `alerts.ts`, holding the same statements:
  - `retitleAlert(db, alertId, title)`;
  - `closeSignatureAlert(db, by, cabinetId, signature, resolution)`, through `closeAutomatically`, so each close is still audited as
    `alert.resolve` by `by`, with `automatic: true`, in the caller's transaction or a new one.
- **The callers** pass what they passed before: the closer (`service-recovery`, `peer-difference`, `firmware-drift`), the cabinet, the
  signature constant and the same sentence. All three drop their now-unused `automatic-close.js` import.
- **Input check, before the database is touched:**
  - the alert id and the cabinet are ids, and the closer is a lower-case name of 1 to 64 letters, digits and hyphens;
  - the signature is 1 to 450 characters (the column's width), not blank, with no control characters;
  - the resolution is 1 to 500 characters, not blank, with no control characters, as in `closeIssueAlert` (D92);
  - the title must be a non-blank string. It has no upper bound here: it is the title `upsertAlert` has just stored, which has none, so
    a bound would refuse a retitle the insert accepted.
- **Unchanged:** which alerts close (open and claimed, not resolved), the audit, the transactions, and when each check retitles.
- **No existing assertion changed.**
- **Debt list:** the three entries for `alerts` come off, which leaves 86.

**Proof** (`server/test/signature-alert-writes.test.ts`, four tests):
- **Retitle:** that alert takes the new title, and another alert keeps its own. A retitle with the title it already has is the same
  statement again, and its guard is in the statement, so the test does not claim it changed nothing.
- **Close:** the cabinet's open alert of the signature is closed with the sentence and audited once by the closer. Another cabinet's,
  another signature's and an already resolved alert are left as they were. A claimed alert counts as unresolved, and a repeat closes and
  audits nothing.
- **Rollback:** a close in a transaction that rolls back leaves the alert open and unaudited.
- **Bad input:** 41 bad calls are refused through a connection that fails the test if it is used, including an injection string, a line
  feed, a tab and a NUL. Nothing is changed.
- **Red checks** (`signature-alert-writes`, `table-ownership`, `audit-sweep`, `import-cycles`; 16 tests):
  - With the three callers as on main, `table-ownership.test.ts` fails.
  - With the signature check disabled (`false && …`), the bad-input test fails; so it does with the retitle's id check disabled.
  - Restored and `cmp` identical, 16 of 16 pass.
- **Neighbours:** `alerts`, `alerts-sql`, `issue-alert-close`, `firmware-drift`, `peer-differences` and `service-reboot-recovery` pass,
  46 of 46. The 14 files that import the three changed modules pass, 111 of 111 (one of them is a benchmark).

---

## D93. The baseline-alert ordering test starts the diagnosis only once its holder holds the alert (2026-11-15)

**What the test did** (`server/test/network-troubleshooting.test.ts:270`, at `6d2d73a`):
- **What it proves.** D64: a diagnosis is shown as done only once its baseline alert is settled. Another connection, from a new pool,
  takes an `UPDLOCK` on the alert row and reports whether the diagnosis said done while the row was held.
- **The race.** The test waited a fixed 300 ms after starting that connection, then started the diagnosis. Under load, the new pool's
  login can take longer. The diagnosis then closed the alert and said done before the holder ran. The holder locked no row, saw done and
  reported `done_while_held = 1`, which failed the test although the code's order was right.
- **Seen.** Once in the gate for #282 (non-browser files at concurrency 2). In a scratch copy with the holder started 4 s late, it failed
  the same way and printed `held = null`.

**The decision:**
- **Wait for the lock, not for a time.** Before starting the diagnosis, the test polls the alert with `UPDLOCK, READPAST`, which skips
  a row someone holds. It goes on only once the row is skipped, and fails after 10 s with "the holder never took the alert row".
- **Say what was held.** The holder returns the id it locked, and the test asserts it held one.
- **Unchanged.** The order it proves, the 7 s hold and every other assertion.

**Proof** (that one test, run alone):
- **Fixed test:** 3 of 3 pass.
- **Holder started 4 s late:** passes, where the old test failed.
- **Red check:** with `finishDiagnosis` moved before `reconcileBaselineAlert` in `network.ts`, it fails with "the diagnosis said done while
  its alert was still being settled". Restored and `cmp` identical, it passes.
- **The whole file:** passes.

---

## D92. The network diagnosis and the file-version check close their alerts through alerts.ts, the alerts' owner (2026-11-15)

**What the code did** (at `6d2d73a`; two entries on the ownership debt list, F21.R2):
- **Two writers of `alerts`, one statement.** When the condition its check raises was gone, each closed the cabinet's unresolved alert
  of one issue type. Each did it with its own `UPDATE alerts … WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved'`,
  passed to `closeAutomatically`:
  - `server/src/diagnose/network.ts:209`, `reconcileBaselineAlert`, for the network-baseline alert;
  - `server/src/services/filefacts-ingest.ts:233`, `reconcileVersionAlert`, for the file-version alert.
- **Who owns that table:** `alerts` belongs to `services/alerts.ts`. Neither file writes `alerts` anywhere else; each raises through
  `upsertAlert`, which is already the owner's.

**The decision:**
- **One owner function.** `alerts.ts` exports `closeIssueAlert(db, by, cabinetId, issueTypeId, resolution)`. It runs the same statement
  through `closeAutomatically`, so each close is still audited as `alert.resolve` by `by`, with `automatic: true`, in the caller's
  transaction or a new one. The resolution sentence is now a parameter instead of a literal in the SQL.
- **The callers** pass what they passed before: closer `network-diagnosis` or `file-versions`, the cabinet, the issue type and the same
  sentence. Both drop their now-unused `automatic-close.js` import.
- **Input check, before the database is touched:**
  - the closer is a lower-case name of 1 to 64 letters, digits and hyphens;
  - the cabinet and the issue type are ids;
  - the resolution is 1 to 500 characters, not blank, with no control characters.
- **Unchanged:** which alerts close (open and claimed, not resolved), the audit, and the transaction.
- **An existing assertion changed:** `filefacts-ingest.test.ts` checked the close's parameters as `[cabinet, issue type]`. It now checks
  `[cabinet, issue type, the resolution sentence]`, which also covers the sentence.
- **Debt list:** the `diagnose/network.ts` and `services/filefacts-ingest.ts` entries for `alerts` come off, which leaves 89.

**Proof** (`server/test/issue-alert-close.test.ts`, three tests):
- **Closing:** the cabinet's open alert of the issue type is closed with the sentence and audited once by the closer. Another cabinet's,
  another issue type's and an already resolved alert are left as they were. A claimed alert counts as unresolved, and a repeat closes and
  audits nothing.
- **Rollback:** a close in a transaction that rolls back leaves the alert open and unaudited.
- **Bad input:** 29 bad calls are refused through a connection that fails the test if it is used: bad closers, cabinets, issue types and
  resolutions, including an injection string, a line feed and a NUL. Nothing is closed.
- **Red checks** (`issue-alert-close`, `table-ownership`, `audit-sweep`, `import-cycles`; 15 tests):
  - With both callers as on main, `table-ownership.test.ts` fails.
  - With the resolution check disabled (`false && …`), the bad-input test fails.
  - Restored and `cmp` identical, 15 of 15 pass.
- **Neighbours:** `alerts`, `alerts-sql`, the four `filefacts` files, `network-troubleshooting` and `troubleshooting` pass, 107 of 107.

---

## D91. A diagnosis that has finished stays as it finished (2026-11-15)

**What the code did** (at `fdee60e`):
- **The path.** `run` in `server/src/diagnose/network.ts` marks the diagnosis done (`:185`), then counts the known fixes it showed
  (`fixesForFindings` and `markSeen`, `:187-188`).
- **What a failure there did.** An error in that count rejects `run`, and the handler at `:120-122` calls `failDiagnosis`. That rewrote
  the done row as failed, with "The diagnosis stopped because of a server error", while its findings and readings stayed stored.
- **The misreport.** The console showed a failure for a run that had finished and found what it found.

**The decision:**
- **At the store.** `failDiagnosis` in `server/src/diagnose/diagnoses.ts` changes only a diagnosis that is still running
  (`AND state = 'running'`), and returns whether it did. A done, failed or offline diagnosis keeps what it finished with.
- **Why there, not in `network.ts`:** the rule holds for both callers and for any later one. It needs no second handler.
- **Unchanged:** a run that never finished is still marked failed, as before. The cabinet diagnosis's own path cannot reach this, because
  marking it done is the last thing its `run` does.
- **Left as is:** when the known-fix count fails, the network incident is not recorded for that run, as before. The error is logged.
- **Spec:** `docs/spec/16-network-troubleshooting.md` says a finished diagnosis stays as it finished.

**Proof** (`server/test/diagnosis-writes.test.ts`, a fifth test):
- A done diagnosis stays done with its findings and no failure when `failDiagnosis` is called, which returns false.
- A running one is marked failed. A second failure does not rewrite the first, and an offline batch member stays offline.
- **Red check:** with the `state = 'running'` condition removed, this test fails. Restored and `cmp` identical, `diagnosis-writes`,
  `table-ownership` and `audit-sweep` pass, 15 of 15.
- **Neighbours:** `network-troubleshooting`, `troubleshooting`, `diagnosis-incidents` and `owner-retention` pass, 36 of 36.

---

## D90. Every write to diagnoses goes through diagnose/diagnoses.ts, the table's new owner (2026-11-15)

**What the code did** (at `74ac54f`; an entry on the ownership debt list, F21.R2):
- **Two writers of one table.** `diagnose/cabinet.ts` owned `diagnoses` and wrote its own runs, and kept the retention delete.
  `diagnose/network.ts` wrote its own runs with six statements of its own: the start, the full command list, done, failed, and two
  inserts for batch members that never ran (offline, or could not start).
- **Why it stayed on the list.** `cabinet.ts` imports `network.ts` (`beginDiagnosis`, `waitFor`). Moving network's writes into `cabinet.ts`
  would make `network.ts` import it back, a cycle.

**The decision:**
- **A store below both.** `server/src/diagnose/diagnoses.ts` holds every write to the table and becomes its owner in `table-owners.ts`:
  - `startDiagnosis`: a running diagnosis of either kind, with its first commands and its batch, if any.
  - `recordDiagnosisCommands`: the full command list once all are issued.
  - `finishDiagnosis` and `failDiagnosis`: done with findings and readings, or failed with the sentence the console shows.
  - `recordUnstartedDiagnosis`: a batch member that never ran, stored finished as offline or failed.
  - `pruneOldDiagnoses`: the retention delete, moved unchanged from `cabinet.ts`. `maintenance.ts` and `owner-retention.test.ts` import it
    from the new file.
- **The statements are the ones the callers ran.** No `WHERE` clause changed, and each caller keeps its `.catch(() => undefined)` where it
  had one. A command's label and params are still not stored: only key, operation and command id, as both callers wrote them.
- **Input check, before the database is touched:**
  - every id must be an id, the kind network or cabinet, and an unstarted state offline or failed;
  - a command list holds at most 200 commands, each with a key and an operation of 1 to 64 characters and a command id;
  - findings must be a list, and readings must be given;
  - a failure is 1 to 1,000 characters, not blank, with no control characters other than tab and line feed.
- **The audit sweep** lists the done and failed updates under the new file with the same reason as before: a read-only diagnosis's
  progress, whose every read is audited as `command.issue`.
- **Debt list:** the `diagnose/network.ts` entry for `diagnoses` comes off, which leaves 91.
- **Not changed here:** `failDiagnosis` can still overwrite a diagnosis that is already done, because `run` marks it done and then counts
  known fixes, and a failure in that count reaches the failure handler. Whether a done diagnosis may become failed is a behaviour question,
  not part of moving the writes. D91 settles it.

**Proof** (`server/test/diagnosis-writes.test.ts`, four tests):
- **A run:** started with its first commands and batch, then all its commands, then done with findings and readings. A cabinet run with no
  batch fails with its sentence.
- **Unstarted members:** offline and failed members are stored finished in their batch.
- **Rollback:** a start in a transaction that rolls back leaves nothing.
- **Bad input:** bad ids, kinds, command lists, findings, failures and states are refused through a connection that fails the test if it
  is used, so each refusal comes from the check. Nothing is stored.
- **Red checks** (`diagnosis-writes`, `table-ownership`, `audit-sweep`, `import-cycles`; 16 tests):
  - With `network.ts` as on main, `table-ownership.test.ts` and `audit-sweep.test.ts` fail.
  - With the failure check disabled (`false && …`), the bad-input test fails.
  - Restored and `cmp` identical, 16 of 16 pass.

---

## D89. Every place that checks a certificate serial uses one rule, the table's: upper-case hex, 2 to 64 digits (2026-11-15)

**What the code did** (at `41e30e7`):
- **Three rules for one value:**
  - `recordIssuedCertificate` in `server/src/services/cabinets.ts` (D87) allowed 1 to 40 digits.
  - `authenticate`, in the same file, allowed 2 to 64.
  - `server/src/agent-api/server.ts:355` and `:495` read the serial a TLS peer presents, also 2 to 64.
- **What the table allows:** `cabinet_certificates_serial_check` (`server/migrations/0001_baseline.sql:281`) allows 2 to 64.
- **The effect:**
  - A 1-digit serial passed the service check and was refused by the constraint, as a database error rather than the check's refusal.
  - A serial of 41 to 64 digits was refused when recorded, though the table, `authenticate` and the agent API accept it.
  - Our CA issues 32 digits (`server/src/pki/x509.ts:126`, 16 random bytes), so no cabinet met either case.

**The decision:**
- **One rule.** `cabinets.ts` exports `CERTIFICATE_SERIAL = /^[0-9A-F]{2,64}$/`, the table's range.
- **Who uses it:** `recordIssuedCertificate`, `authenticate` and both agent-API reads. The agent API upper-cases the peer's serial
  before testing it, which is what its old case-blind pattern did.
- **`authenticate` also refuses a value that is not a string**, as `recordIssuedCertificate` does.
- **What changes:** only the serials a recording accepts. 1 digit is now refused by the check, before the database is touched, and 41
  to 64 digits are now recorded. Nothing else accepts or refuses differently.
- **An existing assertion changed with the rule:** D87's bad-input test listed 41 digits as a bad serial. It now lists 1 and 65 digits.

**Proof** (`server/test/certificate-writes.test.ts`):
- **New test:** serials of 2, 32, 41 and 64 digits are recorded and then authenticate. 1 and 65 digits are refused by both
  `recordIssuedCertificate` and `authenticate`.
- **Red checks** (`certificate-writes`, 4 tests):
  - With D87's 1-to-40 rule back in `recordIssuedCertificate`, the new test fails.
  - With the serial check disabled (`false && …`), the bad-input test fails.
  - Restored and `cmp` identical, 4 of 4 pass.
- **Neighbours:** `certificate-writes`, `agent-api`, `table-ownership` and `enrollment-decision` pass, 34 of 34.

---
## D88. The operations checks resolve their alerts through security.ts, the alerts' owner (2026-11-15)

**What the code did** (`server/src/services/ops-health.ts`, `settle`, at `430cf57`; an entry on the ownership debt list, F21.R2):
- **What `settle` did itself:** when an operations check passed again, it resolved the open alert of that kind with its own
  `UPDATE security_alerts`. It audited each resolved row as `security_alert.auto_resolve`.
- **Who owns that table:** `security_alerts` belongs to `services/security.ts`.

**The decision:**
- **The statement and its audit move.** `security.ts` exports `autoResolveSecurityAlert(c, signature, { actorId, details })`, which
  holds the same statement and the same audit per row. It works in the caller's transaction and returns the ids it resolved.
- **`settle` calls it** with actor `ops-check` and `{ kind }`, as before.
- **Input check:** the signature must be 1 to 256 characters with no control characters, and the actor 1 to 64 characters. Anything else
  is refused before the database is touched.
- **Left on the list:** `db/migrate.ts` still writes `security_alerts` directly. It raises the migration-failed alert through the raw
  owner connection, at a point where the schema may be half built. Moving it into a service would make the database layer depend on that
  service, so it stays.
- **Debt count:** the `ops-health.ts` entry comes off, which leaves 92 on this branch.

**Proof** (`server/test/security-auto-resolve.test.ts`, three tests):
- **Resolving:** the open alert of a signature is resolved and audited once with the actor and details given. Another signature stays
  open, and a repeat resolves and audits nothing.
- **Rollback:** a resolve in a transaction that rolls back leaves the alert open and unaudited.
- **Bad input:** 8 bad signatures and 6 bad actors are refused with nothing resolved. The bad signatures include one of 257 characters,
  a NUL, a line feed and a number.
- **Red checks:**
  - With the signature check disabled (`false && …`), the bad-input test fails.
  - With `ops-health.ts` as on main, `table-ownership.test.ts` fails.
  - Restored and `cmp` identical, these and `operations` and `security-stale` pass, 33 of 33.

---


## D87. Enrollment and replacement record and revoke certificates through cabinets.ts, their owner (2026-11-15)

**What the code did** (at `28b2cd1`; two entries on the ownership debt list, F21.R2):
- **`services/enrollment.ts:282`** inserted the certificate it had just issued into `cabinet_certificates`, in the transaction that
  approves the cabinet.
- **`services/replacement.ts:82`** revoked every certificate of the cabinet being replaced. It used the same statement as `revokeCabinet`
  in `services/cabinets.ts`, the table's owner.

**The decision:**
- **Two writers in `cabinets.ts`:** `recordIssuedCertificate(c, cabinetId, serialHex, notAfter)` and `revokeCabinetCertificates(c,
  cabinetId)`. They hold those statements, and the callers use them in the same transactions as before.
- **One revoke statement:** `revokeCabinet` uses `revokeCabinetCertificates` too, so the statement is written once.
- **Input check:**
  - the cabinet id must be an id;
  - the serial must be upper-case hex of at most 40 digits, which is 20 bytes (RFC 5280), as `x509.ts` gives it (D89 later made it
    2 to 64, the table's range);
  - the expiry must be a real date.
  - Anything else is refused before the database is touched.
- **Unchanged:** the REVOCATION_CHANNEL notification and the audit, which stay with each caller, and what each flow does.
- **No import cycle:** `enrollment.ts` and `replacement.ts` now import `cabinets.ts`, and nothing it imports reaches either.
  `import-cycles.test.ts` passes.
- **Debt list:** the `cabinet_certificates` entries come off it, which leaves 93.

**Proof** (`server/test/certificate-writes.test.ts`, three tests):
- **Recording:** the certificate issued at enrollment is recorded with its serial and expiry.
- **Revoking:** it revokes all three of a cabinet's certificates and not another cabinet's. A repeat revokes none.
- **Bad input:** 8 bad cabinet ids, 9 bad serials and 5 bad expiries are refused with nothing recorded. The bad serials include
  lower-case hex, a space, 41 digits, an injection string and a number.
- **Red checks:**
  - With the serial and expiry checks disabled (`false && …`), the bad-input test fails.
  - With `enrollment.ts` and `replacement.ts` as on main, `table-ownership.test.ts` fails.
  - Restored and `cmp` identical, these and the enrollment, replacement and agent-API tests pass, 70 of 70.

---

## D86. The console routes' two writes to sessions go through auth/sessions.ts, its owner (2026-11-15)

**What the code did** (at `e5465f7`; two entries on the ownership debt list, F21.R2):
- **`console-api/fleet-routes.ts:52`** set `current_cabinet` on the viewer's session when a cabinet view was opened, in the transaction that
  audits `cabinet.view`.
- **`console-api/auth-routes.ts:208`** deleted every other session of a user who changed their own password, in the transaction that
  audits `auth.password.change`.
- **`sessions` is owned by `auth/sessions.ts`** (`server/src/db/table-owners.ts`).

**The decision:**
- **`auth/sessions.ts` exports `setCurrentCabinet(db, sessionHash, cabinetId)` and `endOtherSessions(db, userId, keepSessionHash)`.**
  They hold the same statements, and the routes call them in the same transactions as before.
- **Input check:** the session hash must be a 32-byte buffer, as `hashId` makes it, and the cabinet id and user id must be ids. Anything
  else is refused before the database is touched.
- **Unchanged:** what each route does, and its audit.
- **The audit sweep's listed exception** for `DELETE FROM sessions WHERE user_id` now names `auth-routes.ts` among the callers that audit
  it.
- **The debt list:** `sessions` comes off it, which leaves 95.

**Proof** (`server/test/session-writes.test.ts`, three tests):
- **The cabinet:** a session records the cabinet it has open, and another session of the same user does not change.
- **Other sessions:** ending a user's other sessions keeps the one given and leaves another user's alone, and a repeat ends nothing.
- **Bad input:** 9 bad session hashes and 8 bad ids are refused by both functions, with nothing recorded and nothing ended. They include
  a hex string, buffers of 0, 31 and 33 bytes, an injection string and a number.
- **Red checks:**
  - With both hash checks disabled (`false && …`), the bad-input test fails.
  - With both route files as on main, `table-ownership.test.ts` fails.
  - Restored and `cmp` identical, these and `console-api` and `auth` pass, 31 of 31.

---

## D85. A screen that picks one of a site's cabinets offers every cabinet of the site (2026-11-15)

**What the code did** (at `e5465f7`; left out of scope in #269, D81):
- **Two pickers were built from one answer of `GET /api/fleet/sites/:id`.** Asked without a page, the route sends the site's first 200
  cabinets (D81).
  - `console/src/pages/admin/ApprovedApps.tsx:22`: the approved-programs cabinet picker.
  - `console/src/pages/admin/Admin.tsx:161`: the cabinet an enrollment replaces.
- **So on a site of more than 200 cabinets, cabinet 201 and later could not be chosen** in either.

**The decision:**
- **One full read.** `console/src/lib/site-cabinets.ts`, `everySiteCabinet`, reads the first page exactly as before, with no query
  string, then the rest 500 at a time (`?limit=500&offset=…`) until the server says there are no more. It returns the first answer
  with `cabinets` holding all of them.
- **A partial list is never offered.**
  - It stops with "The site's cabinets could not be read in full" when a page that says there is more comes back empty, or after 200
    pages.
  - A page that fails fails the whole read.
- **Both screens use it.** The approved-programs picker goes through `useEverySiteCabinet`, which has `useLoad`'s shape, so its
  existing "Try again" path is unchanged.
- **A site of 200 or fewer is still one request.**
- **A failed read says so on the enrollment approval** (review of #275). `Admin.tsx` used to discard the read's failure. The cabinets
  for "Replaces" and the sync cabinets both come from that read, so on a large site a failed second page would leave both lists empty
  with nothing on screen, which reads as "this site has nothing to replace". It now shows "This site's cabinets could not be read, so
  the cabinet this replaces and the sync cabinet cannot be offered", with "Try again".
- **Not a snapshot of one moment.** The pages are read by offset, so a cabinet added or removed between two pages can shift the list
  under the read. A picker is a snapshot, and the route has no cursor, so this is left as is.

**Alternative.** A search box in the pickers. Rejected for now: the site route has no search, and a picker that offers every cabinet
of one site is what these two screens were written to do. A site of thousands of cabinets would want one.

**Proof:**
- **`console/test/site-cabinets.test.ts`, five tests:**
  - a site of 1,234 is read in four requests, every cabinet once and in order;
  - a site of 200 or fewer is one request;
  - a server that never stops saying "more", or an empty "more" page, ends in the error;
  - a failed page fails the read;
  - the site id goes into the path encoded.
  - With the paging loop disabled (`false && page.cabinetsPage.hasMore`), three of the five fail.
- **`server/test/console-site-picker-e2e.test.ts`, in a real browser:** on a site of 230, the approved-programs cabinet picker offers
  all 230 in name order, and the requests are the bare first page and then `?limit=500&offset=200`.
  - With `ApprovedApps.tsx` as on main, the test fails waiting for "Cab 230".
- **`console-approved-apps-e2e`**, whose "Try again" check intercepts the bare site URL, still passes.
- **A second browser test, the enrollment approval on a site of 230 with the second page failing once:** the alert appears and no
  "Replaces" list is offered. After "Try again", all 230 are offered and the alert is gone.
  - With `Admin.tsx` as it was before the review, the test fails waiting for the alert.

---


---

## D84. An agent's firewall event is recorded by commands.ts, the firewall history's owner (2026-11-15)

**What the code did:** `storeEvents` in `services/events.ts` wrote `firewall_changes` (owner `commands.ts`) for each `firewall_changed`
event it had just stored:
- **Event for a platform write:** if the event named a command whose history row had no event yet, it set the event on that row. The
  row was recorded from the write's own result, so the event confirms that change.
- **Any other event:** otherwise it added a row, marked explained when the event named a command.

**The decision** (F21.R2):
- **`commands.ts` exports `recordFirewallEvent(c, cabinetId, event)`.** It holds both statements, unchanged.
- **`storeEvents` calls it** in the batch's transaction, for each `firewall_changed` event it has just stored, as before. An event
  already stored by an earlier batch is still not recorded again.
- **Input check:**
  - The cabinet id must be an id.
  - The event is checked against `event.schema.json` with the contract's own validator, and must be a `firewall_changed` event.
  - Anything else is refused before the database is touched.
  - The agent API already checks each batch against its contract, so a stored event always passes. The check guards the function's
    own boundary, for any later caller.
- **No new cycle:** `events.ts` now imports `commands.ts`, and nothing `commands.ts` imports leads back to `events.ts`.
  `import-cycles.test.ts` passes.
- One entry comes off the debt list, which leaves 97.

**Proof.** `test/firewall-history.test.ts`, three tests:
- **The cases:** a platform write's first event confirms its row and adds none. A later event for the same command is a further
  change, and one with no command is an unexplained one.
- **Through `storeEvents`:** an event goes in once, and a repeat of the same event or another kind adds nothing.
- **Hostile input:** 8 bad cabinet ids and 13 bad events are refused with nothing recorded. The bad events include an injection string
  in the event id, a bad command id, a bad time, an unknown field, a message over its length and a missing field. So is an event of
  another kind.
- **Red check:** with the contract check disabled in place (`false && envelopes.event.parse(event)`), the hostile-input test fails
  (8 tests, 7 pass, 1 fail). With the old `events.ts` back, `table-ownership.test.ts` fails with "services/events.ts writes firewall_changes (owned by
  services/commands.ts)".

---

## D83. A cancelled fleet job's page follows it until the batch already sent has finished (2026-11-14)

**What the code did** (`console/src/pages/FleetOperations.tsx`, `FleetJob`, at `91d64d3`; finding 6 of the 2026-11-13 fleet audit):
- **The page refreshed the job every 1.5 s only while it was `running`.**
- **Cancelling set the state to `cancelled` at once** (`cancelJob`), but the batch already sent goes on: its commands are followed up and
  verified, and only then does the runner end the job and set its finish time.
- **So the page stopped refreshing at the moment it mattered.** It showed "Cancelled" over cabinets still marked "Sent" or "Done;
  verifying", and stayed like that until someone reloaded it. That is the freeze the audit saw.
- **The server was not the cause:** the cancel route is one short transaction, and the job's own answer already carries `finishedAt`.

**The decision** (console only):
- **`console/src/lib/fleet-job-status.ts` gives a job one of four phases:** running, cancelling (cancelled with no finish time),
  cancelled, or finished.
- **The page keeps refreshing while the job is running or cancelling.**
- **The badge says what is happening:**
  - "Cancelling: finishing the N cabinets already sent", counting the cabinets sent and not yet answered or verified;
  - "Cancelling: ending the job" once none is left;
  - "Cancelled" once the job has ended.
- **"Cancel the rest" is shown only while the job runs,** as before.
- **A count that is not a whole positive number counts as none,** so a bad answer cannot make up cabinets.

**Proof:**
- **`console/test/fleet-job-status.test.ts`, three tests:** the phases and their wording; running and finished jobs read as before; nine
  bad counts read as none.
- **`server/test/console-fleet-cancel-e2e.test.ts`, in a real browser:** a job in the state a cancel leaves (one cabinet sent, two
  cancelled, no finish time).
  - The page says "Cancelling: finishing the cabinet already sent", with no cancel button.
  - When the cabinet is verified, the page shows "Verified" and "Cancelling: ending the job" without a reload.
  - When the job ends, it shows "Cancelled" and the finish time.
  - The runner's own part (following up, verifying, ending) is covered by `fleet-jobs.test.ts`; here it is two statements.
- **Red check:** with the cancelling phase disabled in place (a cancelled job read as ended at once), the console test fails (2 pass,
  1 fail) and the browser test fails waiting for "Cancelling: finishing the cabinet already sent". Restored and `cmp` identical, both
  pass.

---


---

## D82. A rollout batch whose every cabinet stays offline moves on, rather than holding the rollout open (2026-11-15)

**What the code did** (`server/src/services/rollouts.ts`, `evaluate`, at `d669848`; found in review of #268, and on main before it):
- **The rate is measured over the counted cabinets:** `counted` is the batch's targets minus those waiting offline and those skipped.
- **A batch of offline cabinets has nothing to count.** While they wait out their 24 hours, `counted` is 0, and `evaluate` returns while
  it is 0. After the day, the skip moves them to `skipped`, and `counted` is still 0.
- **So the batch never reached its rate, and the rollout stayed `running` for good.** One rollout runs at a time, so every later
  rollout was refused with `rollout_active`. The reviewer measured it: a rollout whose batch 2 was two offline cabinets was still at
  batch 2 twenty-five hours later.

**The decision:**
- **A batch whose every target was skipped moves on:** nothing is waiting offline any more, at least one target was skipped, and none
  was counted. It goes to the next batch, or the rollout completes, through the same path and audit (`rollout.batch` with `counted: 0`,
  or `rollout.complete`).
- **Unchanged:** while any cabinet is still waiting out its day, the batch waits as before. A batch with anything counted needs its rate
  as before. Offline cabinets still do not count against the rate.

**Alternative.** Counting skipped cabinets as failures, which would pause the rollout. Rejected: the spec says offline cabinets do not
count against a batch, and a pause would still need an Admin to resume a rollout that has nothing left to try in that batch.

**Proof** (`server/test/upgrades.test.ts`, one new test, the reviewer's case):
- the pilot upgrades, and batch 2 is two offline cabinets;
- within the day the rollout stays at batch 2;
- with the batch started 25 hours ago, the two are skipped as `offline` and the rollout moves past batch 2, audited with `counted: 0`;
- the last cabinet upgrades and the rollout completes;
- a second rollout then starts.
- **Red check:** with `allSkipped` disabled (`false && …`), the new test fails (14 tests, 11 pass, 1 fail, 2 skipped). Restored and
  `cmp` identical, 12 pass, 0 fail, 2 skipped.

---


---

## D81. A site's cabinets are paged by the server, from the route to the site page (2026-11-14)

**What the code did** (finding 7 of the 2026-11-13 fleet audit, at `91d64d3`):
- **The service pages; the route never asked.** `fleet.site(db, id, page)` reads one page of a site's cabinets and the site's full
  count. `GET /api/fleet/sites/:id` (`server/src/console-api/fleet-routes.ts:39`) never passed a page, so it always sent the first
  `SITE_CABINET_PAGE` (200).
- **The site page paged those 200 in the browser** (`console/src/pages/Fleet.tsx`, `SitePage`). For a site with more than 200
  cabinets it showed "of 200", and the rest could not be reached.
- **The network standard panels were told the wrong count:** they were given the length of that list as the site's cabinet count, on
  the site page and on the cabinet's Standards tab.

**The decision:**
- **The route takes `limit` and `offset` from the query string,** checked against a new contract, `site-page-query`, before anything
  else: `limit` 1 to 500, `offset` 0 to 999999, both as whole numbers in plain digits.
- **Anything else is refused with 400.** That includes an unknown parameter, a repeated one and a leading zero. Left out, it is 200
  from the first, as before, so every other caller is unchanged.
- **The site page asks the server for each page of 25,** and its pager counts from `cabinetCount`. While the next page loads, the site
  stays on screen, so the panels below it keep what is being typed in them.
- **Both network standard panels are given `cabinetCount`.**

**Not changed here** (each its own finding): two pickers still list only the first 200 cabinets of a site, the approved-programs
cabinet picker (`ApprovedApps.tsx:22`) and the site-cabinet list on the Admin page (`Admin.tsx:161`). A list that long wants a search,
not pages; noted on the tracker.

**Proof** (`server/test/console-site-paging-e2e.test.ts`, a site with 230 cabinets, in a real browser):
- **The route:** the default page is 200 of 230 with `hasMore`. The last page, 25 from 225, holds the last five. Pages of 60 return
  every cabinet once, in name order.
- **Refused with 400:** 11 queries outside the contract, among them an injection string, `1e3`, a repeated `limit` and an unknown
  `page`.
- **The page:** it shows "1–25 of 230 · page 1 of 10", and nine clicks on Next reach "226–230 of 230" with the last five rows.
- **Red checks** (each disabled in place, rebuilt, run, then restored and confirmed identical with `cmp`):
  - The route's page replaced by `false ? page : {}`: the test fails at the API checks.
  - The page's count replaced by `false ? cabinetCount : rows on hand`: it fails waiting for "1–25 of 230".
  - Restored: it passes.
- **Contracts:** 1,261 tests, 0 fail, with three valid and nine invalid examples for the new schema.
## D80. A rollout completes only with every offer answered, and closes every target still waiting (2026-11-14)

**What the code did** (`server/src/services/rollouts.ts`, `evaluate`, at `91d64d3`; finding 4 of the 2026-11-13 fleet audit):
- **A batch advances on its success rate.** Offline cabinets are not counted, so a batch can move on with targets still `pending`
  (offline, or online but not yet offered) and with offers still open.
- **Completion looked at the last batch only:** its rate, and `offered === 0` in that batch.
- **Nothing reached the earlier batches afterwards.** The 24-hour offline skip applies to the current batch only, and the 30-minute
  timeout in `checkRollouts` only to running or paused rollouts.
- **The result:** once a rollout completed, every earlier-batch target still `pending` or `offered`, and every offline target in the
  last batch, kept that state for good. A completed rollout offers nothing, so they could never move. The existing staged-rollout test
  said as much: "complete, the offline one skipped later".

**The decision** (no migration: `skipped` and the `offline` outcome already exist):
- **Completion also waits for any offer still open in an earlier batch.** It gets its outcome, or times out after 30 minutes as before.
- **At completion, in the same transaction, every target still `pending`, in any batch, is closed as `skipped`.** The outcome is
  `offline` with "Offline when the rollout completed: not upgraded." when the cabinet was out of contact. Otherwise there is no outcome,
  with "The rollout completed before this cabinet took the version."
- **The `rollout.complete` audit entry counts both** (`closedOffline`, `closedNotReached`).
- **The Upgrades screen tells the two kinds apart** (review of #268). It called every skipped cabinet "Skipped (offline)", true until
  now, and showed a target's message only when it had an outcome. `console/src/lib/rollout-target.ts` now gives "Skipped (offline)"
  for outcome `offline` and "Skipped (not reached)" otherwise, and shows the message of a cabinet skipped with no outcome. The
  screen's state filter calls the option "Skipped".
- **Unchanged:** stopping a rollout, which an Admin does on purpose and which leaves its targets as they were; the batch rules; the
  thresholds; and the offer to a cabinet that comes back while the rollout still runs.

**Proof** (`server/test/upgrades.test.ts`):
- **New test.** It runs at a 50% rate, so batch 2 advances with one target offered and one offline. The last batch has one offline, one
  online that never takes the offer, and one that upgrades. Then:
  - the rollout stays running until batch 2's offer times out;
  - it completes, with nothing pending or offered;
  - the two offline cabinets are skipped as `offline`, and the idle one is skipped with no outcome;
  - `rollout.complete` is written once with 2 and 1;
  - a cabinet that comes back afterwards is offered nothing.
- **Red check:** with `rollouts.ts` as on main, the new test fails.
- **The staged-rollout test** now also asserts that its offline cabinet ends `skipped` / `offline`, and its comment says so. No
  existing assertion was changed.
- `upgrades.test.ts` passes 11 of 11, with two real-agent tests skipped, and `audit-sweep.test.ts` passes 5 of 5.

---


---

## D79. The browser tests' sign-in helper returns only once the sign-in is complete (2026-11-10)

**What the code did:** `signInAs` in `server/test/browser-console.ts` filled in the code step, clicked Continue and returned. It did not
wait for the answer. `console-cabinet-system-e2e.test.ts` calls `page.goto` straight after, and that navigation can cancel the code
request still in flight. The page then reloads half signed in, on the code form, and the System panel never appears. It is a test
fault, not a product one: a person does not navigate away in the moment between Continue and the answer.

**How it was found** (**measured**, 2026-11-10):
- The full suite at `f648960` failed the System panel test once: it timed out after 30 s waiting for the System region.
- Run alone, it failed 1 of 3 times. With a probe on the wait it passed 8 of 8 alone, and failed 3 of 9 with three copies at once.
- All three failures were on the cabinet's address with the page showing "Enter your code".

**The decision:**
- **`signInAs` waits for the answer:** it waits for the answer to `POST /api/auth/totp`, then for the code form to close.
- **A refused code is reported:** if the code step is refused, it fails with "signing in as <user>: the code step answered <status>",
  rather than returning on the code form.
- **No product change.**

**Proof:**
- **New file `test/console-sign-in-helper-e2e.test.ts`,** two tests:
  - The code request is held back 1.5 s and the test navigates straight after. It must arrive signed in, with the only session
    `complete`.
  - A refused code must make the helper fail.
  - With the old helper, both fail: the first times out on the code form, and the second finds no failure.
- **The fix under load:** with three copies at once, as above, the System panel test passed 9 of 9. `console-welcome-tour-e2e`, the
  other user of `signInAs`, passes.

**Not covered:** the intermittent `console-approved-apps-e2e` timeout. That test signs in through `signIn`, which already waits for
the Fleet heading, so this is not its cause.

---

## D78. Load samples are stored only by the heartbeat in cabinets.ts (2026-11-10)

**What the code did:** `recordHealth` in `services/readings.ts` inserted a load sample into `health_samples` (owner `cabinets.ts`)
unless one was stored in the last 15 minutes. No server code called it. Heartbeats store their sample through the same insert inside
`recordHeartbeat` in `cabinets.ts`. The only caller was the race test in `test/scale.test.ts`, so that test covered code the agents
never reach, and the path they do take had no race test.

**The decision** (F21.R2):
- **`recordHealth` is removed.** It is a second copy of the owner's statement with no caller.
- **The race test calls `recordHeartbeat`:** twelve heartbeats for one cabinet at once, 25 rounds, must store exactly one sample. It
  now fails if the fixture has no cabinet, where it used to pass without running.
- **Unchanged:** the heartbeat's insert, its 15-minute guard and its locks.
- One entry comes off the debt list, which leaves 98.

**What the test showed.** It fails when the 15-minute guard is taken out of the heartbeat's insert. It still passes with both lock
hints taken out (`UPDLOCK, ROWLOCK` on the cabinet row and `UPDLOCK, HOLDLOCK` on the samples), because the heartbeat updates the cabinet's row
before the insert, and that update alone makes two heartbeats for one cabinet wait for each other. The hints stay: removing them is a
separate change with its own proof, not part of this one.

**Alternative.** Moving `recordHealth` into `cabinets.ts` and having the heartbeat call it. Rejected for this PR: the insert runs
inside the heartbeat's single T-SQL batch, its transaction and its TRY/CATCH, and splitting it out adds a round trip on the hottest path.

**Proof.** With `recordHealth` back in `readings.ts`, `table-ownership.test.ts` fails with "services/readings.ts writes
health_samples (owned by services/cabinets.ts)".

---

## D77. Old drive and load samples removed by drives.ts and cabinets.ts (2026-11-10)

**What the code did:** `rollUpAndTrimSamples` in `services/maintenance.ts` wrote two tables it does not own:
- **`drive_samples`** (owner `drives.ts`): it deleted a chunk of cabinets' samples older than the drive history, through `inBatches`.
- **`health_samples`** (owner `cabinets.ts`): it deleted a chunk of cabinets' raw samples once they were folded into `health_hourly`,
  in the same transaction as the fold.

**The decision** (F21.R2, the D71 pattern, helpers from `db/batches.ts`):
- **`drives.ts`** gets `pruneOldDriveSamples(db, cabinetIds, cutoff, o)`, which runs the same statement through `inBatches`. Every
  batch that removes anything is audited as `retention.batch` for `drive_samples`, as before.
- **`cabinets.ts`** gets `dropRolledUpHealthSamples(c, cabinetIds, before, o)`, which runs the same delete on the connection it is
  given. The roll-up passes its transaction, so the fold and the delete still commit or roll back together.
- **Unchanged:** the statements, the cut-offs (whole hours for the load samples), the chunks of 40 cabinets, the order, and the
  `health_hourly` insert and trim, which `maintenance.ts` owns.
- **Input check:** the cabinet ids must be a list of ids, and the time must be one that has already passed. The load-sample delete
  also needs a whole-number timeout. Anything else is refused before the database is touched. An empty list does nothing.
- **Safe to repeat:** a second run removes nothing more.
- **No new cycle:** `import-cycles.test.ts` passes. `maintenance.ts` now imports `drives.ts` and `cabinets.ts`, and neither leads back.
- Two entries come off the debt list, which leaves 99. With these, `maintenance.ts` writes no table it does not own.
- **The audit sweep:** the listed exception for the load-sample delete moves to `cabinets.ts`, with the same reason. The one for the
  drive-sample delete is dropped: the sweep counts a change run through `inBatches` with its audit argument as audited (D71).

**Alternative.** Moving the whole roll-up to `cabinets.ts`. Rejected: `health_hourly` is the retention run's own table, and the fold
and the trim are one retention step.

**Proof.** `test/sample-retention.test.ts`: three tests (the drive batches and their audit rows, the load delete inside a transaction
that rolls back, and 12 bad id lists, 6 bad times and 6 bad options refused with nothing removed). With the old `maintenance.ts` back,
`table-ownership.test.ts` and `audit-sweep.test.ts` fail.

---

## D76. Old notifications are removed by db.ts, their owner (2026-11-09)

**What the code did:** `pruneNotifications` in `services/maintenance.ts` deleted notifications older than an hour, hourly and in the
nightly run, through `inBatches`. The table is owned by `db/db.ts`.

**The decision** (F21.R2):
- **`db.ts` exports `pruneOldNotifications(db, o)`,** which holds the statement and its own batch loop. The batching helper in
  `db/batches.ts` imports `db.ts`, so `db.ts` importing it back would be the cycle D73 removed. It writes the shape of the batch
  options out itself and imports nothing from the helper.
- **`maintenance.ts` keeps `pruneNotifications`** as a wrapper with no SQL, so the hourly timer and the tests that call it are
  unchanged.
- **Not audited batch by batch,** as before. A notification only wakes other server processes, and the nightly run records the count.
  The audit sweep's listed exception moves with the statement, from `services/maintenance.ts` to `db/db.ts`, with the same reason.
- **Input check:** the batch size, pause and timeout must be whole numbers (a batch of at least 1, a timeout of at least 1 ms), so a
  bad option can never spin the loop. A repeat removes nothing more.
- The entry comes off the debt list, which leaves 101. Two of those are what `maintenance.ts` still writes: drive samples and load
  samples, both inside the sample roll-up.

**Proven by:** `notify.test.ts` adds two tests:
- five old notifications go in batches of two while the new one stays, and a repeat removes nothing;
- seven bad option sets are refused with nothing removed.

The existing retention, scale and service tests that call `pruneNotifications` pass unchanged, with the audit sweep and
`import-cycles`: 76 of 76.

**Red checks:**
- Without the option check, the refusal test fails.
- With the old statement back in `maintenance.ts`, `table-ownership.test.ts` fails with "services/maintenance.ts writes notifications
  (owned by db/db.ts)".

---

## D75. Event and alert retention run by events.ts and alerts.ts (2026-11-09)

**What the code did:** `runRetention` in `services/maintenance.ts` wrote two tables it does not own:
- **`events`** (owner `events.ts`) in three ways: it deleted old events; it cleared the detail and source of events older than 30 days
  (`clearOldEventDetail`, with its cursor in settings); and it unlinked events from old resolved alerts.
- **`alerts`** (owner `alerts.ts`): it deleted old resolved alerts that no event pointed at any more.

**The decision** (F21.R2, the D71 pattern, helpers from `db/batches.ts`):
- **`events.ts`** gets `pruneOldEvents` and `unlinkEventsOfOldAlerts`, and `clearOldEventDetail` moves there whole, together with
  `EVENT_DETAIL_DAYS` and its cursor. `maintenance.ts` re-exports both for the callers that import them there.
- **`alerts.ts`** gets `pruneResolvedAlerts`.
- **Unchanged:** the statements, cut-offs, order, audit table names (`events`, `events.detail`, `events.alert_id`, `alerts`) and the
  per-batch transaction of the detail clearing.
- **Order still matters:** an old alert goes only once its events are unlinked, so an event kept longer than its alert never points
  at nothing. An open alert is never removed.
- **Input check:** a cut-off that is not a time already passed is refused. `clearOldEventDetail` keeps its own `now` and `days`
  arguments, as before.
- **Safe to repeat:** a second run changes nothing more.
- **No new cycle:** `import-cycles.test.ts` passes. `events.ts` now imports `settings.ts` and `crashes.ts`, and neither leads back to
  `maintenance.ts`.
- Two entries come off the debt list, which leaves 102. Three of them are what `maintenance.ts` still writes: drive samples and load
  samples (both inside the sample roll-up) and notifications.

**Proven by:** `event-alert-retention.test.ts`, a new file:
- old events go and recent ones stay;
- a resolved alert with an event pointing at it stays until the event is unlinked, then goes, and the event stays;
- an open alert and its events keep theirs;
- every repeat changes nothing;
- five bad cut-offs are refused by each of the three, with nothing changed.

The existing event-detail, retention, operations and alert tests pass unchanged (`operations`, `admin`, `alerts`, `alerts-sql`), as
do `server-roles`, `audit-sweep` and `import-cycles`: 94 of 94.

**Red checks:**
- Without the cut-off check in `alerts.ts`, the refusal test fails.
- With the old statements back in `maintenance.ts`, `table-ownership.test.ts` fails with "services/maintenance.ts writes alerts (owned
  by services/alerts.ts)" and the same for `events`.

---

## D74. Five more retention sweeps run by their tables' owners (2026-11-09)

**What the code did:** `runRetention` in `services/maintenance.ts` deleted old rows from five more tables that other modules own, each with
one `DELETE TOP`:

| Table | Owner | Which rows |
|---|---|---|
| `cabinet_boots` | `crashes.ts` | boot records |
| `config_changes` | `config-ingest.ts` | configuration changes |
| `diagnoses` | `diagnose/cabinet.ts` | diagnoses |
| `health_transitions` | `cabinet-health.ts` | health transitions |
| `incidents` | `incidents.ts` | closed incidents only |

**The decision** (F21.R2, the D71 pattern, with the helpers from `db/batches.ts` as D73 requires):
- **One prune in each owner:** `pruneOldBoots`, `pruneOldConfigChanges`, `pruneOldDiagnoses`, `pruneOldHealthTransitions` and
  `pruneClosedIncidents`. Each holds the same statement as before and runs it through `inBatches` with the same audit table name.
- **Same cut-offs:** `maintenance.ts` still passes them from the retention settings.
- **Input check:** a cut-off that is not a time already passed is refused.
- **Safe to repeat:** a second run removes nothing more.
- **An open incident is never removed,** however old, as before.
- **No new import cycle:** `maintenance.ts` now imports `diagnose/cabinet.ts`, which pulls in `fleet.ts`, the module from D73's load
  failure. `import-cycles.test.ts` passes, so none of the five imports `maintenance.ts` back.
- Five entries come off the debt list, which leaves 104. Three of those are the remaining sweeps: alerts, drive samples (inside the
  sample roll-up) and notifications.

**Proven by:** `owner-retention.test.ts`, a new file:
- one test per table: five bad cut-offs are refused with nothing removed; only rows older than the cut-off go, in one audited batch;
  a repeat removes nothing;
- one more: an open incident 2,000 days old stays.

**Red checks:**
- Without the cut-off check in `incidents.ts`, that table's test fails.
- With the old statements back in `maintenance.ts`, `table-ownership.test.ts` names all five, for example "services/maintenance.ts
  writes incidents (owned by services/incidents.ts)".
- The retention test in `admin.test.ts`, the audit sweep, `import-cycles`, `replacement-reapply`, `sync-cabinets` and `server-roles`
  pass.

---

## D73. Finished fleet jobs and their results are retained by fleet-jobs.ts (2026-11-09)

**What the code did:** `runRetention` in `services/maintenance.ts` deleted a finished job's per-cabinet results, then the job itself, once
both were older than the job retention setting. Both tables are owned by `services/fleet-jobs.ts`.

**The decision** (F21.R2, the D71 pattern):
- `fleet-jobs.ts` exports `pruneFinishedJobs`. It runs the two statements in the same order as before (targets first, so no job loses
  its results while it is still there), each through `inBatches` with the same audit table names, and returns the number of jobs
  removed.
- **A running job is never removed,** as before.
- **The commands a job sent, and the audit log, stay.**
- **Input check:** a cut-off that is not a time already passed is refused.
- **Safe to repeat:** a second run removes nothing more.
- Two entries come off the debt list, which leaves 109. Eight of those are the remaining sweeps.

**What went wrong first, and the fix.** The first version had `fleet-jobs.ts` import the batching helpers from `maintenance.ts`, which
imports `fleet-jobs.ts` back. The full suite at 8556807 failed six files before any test ran: "Cannot access 'LIVE_LINK' before
initialization". In that cycle, `fleet.ts` ran before `sync-cabinets.ts` had set the constant it reads while loading. D71 had judged
such a cycle harmless because each side only calls the other later. That holds only until the cycle drags in a module that reads a
constant while it loads, so the judgement was wrong.
- **The fix:** the batching helpers (`inBatches`, `BatchOptions`, `RETENTION_BATCH`, `BatchAudit`, `checkRetentionCutoff`) move to
  `db/batches.ts`, which imports nothing but `db.ts`. Every owner's prune takes them from there: the two auth modules from #229,
  `commands.ts` from #230, and `fleet-jobs.ts`. `maintenance.ts` re-exports them for its other callers.
- **The guard:** `import-cycles.test.ts` reads the import graph of `src/` and fails when `maintenance.ts` is part of any cycle, naming
  the module that leads back. Loading a few files is not a guard: with `fleet-jobs.ts` pointed back at `maintenance.ts`, the two files
  that had failed loaded fine, because whether a cycle bites depends on load order. The graph test names `services/fleet-jobs.ts` every
  time.

**Proven by:** `fleet-jobs-retention.test.ts`, a new file:
- an old done job and an old cancelled job go with their results;
- an old running job and a recent job stay, results and all;
- one audited batch per table, and a repeat removes nothing;
- 6 bad cut-offs are refused with nothing removed.

**Red checks:**
- Without the cut-off check, the refusal test fails.
- With the old statements back in `maintenance.ts`, `table-ownership.test.ts` fails with "services/maintenance.ts writes
  fleet_job_targets (owned by services/fleet-jobs.ts)" and the same for `fleet_jobs`.
- With `fleet-jobs.ts` importing `maintenance.ts` again, `import-cycles.test.ts` fails, naming `services/fleet-jobs.ts`.
- The retention test in `admin.test.ts`, the audit sweep, `replacement-reapply`, `sync-cabinets` and `server-roles` pass.

---

## D72. Old command results and firewall history are retained by commands.ts (2026-11-09)

**What the code did:** `runRetention` in `services/maintenance.ts` cleared old command results (`UPDATE TOP … commands SET result =
NULL, search_text = NULL`) and deleted old firewall changes. Both tables are owned by `services/commands.ts`.

**The decision** (F21.R2, the D71 pattern):
- `commands.ts` exports `clearOldCommandResults` and `pruneFirewallChanges`. Each runs its own statement through `inBatches`, with the
  same table name in the batch audit as before (`commands.result`, `firewall_changes`).
- `maintenance.ts` passes the cut-offs from the retention settings, as before.
- **Input check:** a cut-off that is not a time already passed is refused (`checkRetentionCutoff`).
- **Safe to repeat:** a second run changes nothing more.
- **The command itself stays:** what was asked, who asked, when, and the outcome. Only the stored answer and its search text are
  cleared, as before.
- Two entries come off the debt list, which leaves 111. Ten of those are the remaining sweeps.

**Proven by:** `commands-retention.test.ts`, a new file:
- old results are cleared together with their search text, while the commands and the newer results stay;
- old firewall history goes and newer stays;
- each has one audited batch, and a repeat changes nothing;
- 5 bad cut-offs are refused for both, with nothing changed.

**Red checks:**
- Without the cut-off check, the refusal test fails.
- With the old statements back in `maintenance.ts`, `table-ownership.test.ts` fails with "services/maintenance.ts writes commands (owned
  by services/commands.ts)" and the same for `firewall_changes`.
- The retention test in `admin.test.ts`, the audit sweep and `server-roles` pass.

---

## D71. Retention sweeps move to the tables' owners, starting with sessions and step-up tokens (2026-11-09)

**What the code did:** `runRetention` in `services/maintenance.ts` deleted old rows from 14 tables other modules own, each with its own
`DELETE TOP` (D66 found them). Expired sessions and step-up tokens were two of them (lines 242 and 243 before this change).

**The decision** (F21.R2; the pattern is mine, and the other twelve sweeps follow it):
- **Each owner exports a prune.** The prune holds its own statement and runs it through `inBatches`, which keeps the batching and the
  audit entry per batch. `maintenance.ts` decides when to prune and with which cut-off; the owner decides how its own rows are removed.
  Here: `pruneExpiredSessions` in `auth/sessions.ts` and `pruneExpiredStepUpTokens` in `auth/stepup.ts`.
- **Input check:** a cut-off is refused unless it is a real time that has already passed (`checkRetentionCutoff`, shared). A mistaken
  call can never remove what is still live.
- **Safe to repeat:** a prune only removes rows older than its cut-off, so running it again removes nothing more. A batch that removes
  nothing writes no audit entry.
- **Behaviour unchanged:** the same statements, cut-offs, batches and audit entries.
- **Import cycle:** the auth modules import the batching helper from `maintenance.ts`, which imports their prunes back. Each uses the
  other only when called, never while loading. `server-roles.test.ts` starts the real built server and passes.
- Two entries come off the debt list, which leaves 113. Twelve of those are the remaining sweeps.
- **The audit sweep learns what `inBatches` does.** `audit-sweep.test.ts` accepted the old sweeps only because `runRetention`, around
  them, called `audit(`. A prune calls no `audit(` of its own: it passes `{ table, cutoff }` to `inBatches`, which writes a
  `retention.batch` row for every batch that removed anything. The full suite at 826989f failed on exactly the two prunes. The sweep now
  counts a change as audited when it runs through `inBatches` with that argument, on the statement's line or the two after. Without the
  argument the batches are not logged, and the change still fails. A test holds the rule both ways, so the next twelve sweeps need no
  exception each.

**Proven by:**
- `auth-retention.test.ts`, a new file, run for each table:
  - only what expired before the cut-off goes, audited as one batch, and a repeat removes nothing and logs nothing;
  - a cut-off in the future, an invalid date, a string, a number, `null` and `undefined` are refused with nothing removed.
- The existing retention, account and sign-in tests pass, with `server-roles`: 62 of 62.

**Red checks:**
- Without the cut-off check, the two refusal tests fail.
- Without the sweep's new rule, the audit sweep names `auth/sessions.ts` and `auth/stepup.ts` as unaudited deletes.
- With the old sweeps back in `maintenance.ts`, `table-ownership.test.ts` fails with "services/maintenance.ts writes sessions (owned by
  auth/sessions.ts)" and the same for `step_up_tokens`.

---

## D70. sign_ins and user_devices: each auth module stops writing the other's table (2026-11-09)

**What the code did:** the two sign-in tables are owned by two modules (D56), and each wrote the other's:
- **`sign_ins`** is owned by `auth/sessions.ts`, but `auth/devices.ts` inserted the row in `recordSignIn` (line 69 before this change).
- **`user_devices`** is owned by `auth/devices.ts`, but `endAllSessions` in `auth/sessions.ts` cleared every trusted browser of the
  account with its own `UPDATE` (line 62). That was the same statement as `forgetTrustedDevices` in the owner, with nothing kept.

**The decision** (F21.R2):
- **`sign_ins`:** the insert moves into `sessions.ts` as `addSignIn`. Before anything is written, it checks the input against the
  table's own rules:
  - the user's id;
  - an address and a network of 1 to 64 characters;
  - a device label of 1 to 120 characters;
  - the two new-or-not flags as booleans.
  Each call is one sign-in, so each records a row of its own; that is the table's purpose, not a repeat to suppress.
- **`user_devices`:** `endAllSessions` calls `forgetTrustedDevices(db, userId)`, so the owner's statement does the work. It is safe to
  repeat: a browser already forgotten stays forgotten.
- The two modules now import each other, as `alerts.ts` and `crashes.ts` already do. Each uses the other's function only when called,
  never while loading.
- Both come off the debt list, which leaves 115 entries.

**Proven by:**
- `sign-in-record.test.ts`, a new file: a sign-in is recorded and returned by its id; 13 malformed or hostile sign-ins are refused with
  nothing written.
- The existing sign-in, sign-in limit, account and settings tests pass unchanged, 60 of 60. That includes "changing the password
  forgets every other trusted browser; ending all sessions forgets them all".

**Red checks:**
- Without `addSignIn`'s check, the hostile test fails.
- With `endAllSessions` no longer forgetting, "ending all sessions forgets them all" fails.
- With the old `devices.ts`, and separately the old `sessions.ts`, `table-ownership.test.ts` names the cross write: "auth/devices.ts
  writes sign_ins" and "auth/sessions.ts writes user_devices".

---

## D69. Every write to issue_types goes through rules.ts (2026-11-09)

**What the code did:** `issue_types` is owned by `services/rules.ts` (D56). Two places wrote it, in two different ways:
- **`services/admin.ts`**, for the Admin's create and edit, took a name lock and checked the exact name before writing.
- **`rules.ts` itself**, when an Admin mapping a symptom created a new issue type, inserted it with neither and relied on the table's
  unique key.

**The decision** (F21.R2):
- **Two writers in the owner:**
  - `addIssueType`: check, lock the names, check the exact name, insert, audit `issue_type.create`, noting `from` when it came from a
    mapping.
  - `editIssueType`: check, lock the row, take the same name lock and exact-name check, update, audit `issue_type.update` with what the
    issue type was.
- **Callers:** both the Admin routes and the mapping path use them, so every new name goes through one lock. `admin.ts` keeps the
  step-up check and calls the owner.
- **Input checked first, by the table's own rules:**
  - a name of 1 to 128 characters that is not blank;
  - major or minor;
  - a description of up to 1,024 characters.
- **Safe to repeat:**
  - A repeated create is refused by name (`name_taken`) and leaves one issue type.
  - An edit with the same values writes and audits nothing.

**What changes for a person:**
- An edit that changes nothing is no longer written to the audit log.
- A mapping that creates an issue type now waits on the same name lock as the Admin's list. Its answer to a name already taken is the
  same `name_taken`.

`admin.ts` comes off the debt list for `issue_types`, which leaves 117 entries.

**Proven by:**
- `issue-types.test.ts`, a new file:
  - a created type is audited once, and the same name again is refused;
  - an edit is audited with what it was, a repeat audits nothing, and a taken name and an unknown id are refused;
  - 10 malformed or hostile issue types are refused with nothing written.
- The existing issue type, alert and rule tests pass unchanged: `sqlserver-services`, `admin`, `alerts` and `alerts-sql`, 77 of 77
  with `table-ownership`.

**Red checks:**
- Without the input check, the hostile test fails.
- Without the unchanged-edit check, the edit test fails.
- With the old `admin.ts` back, `table-ownership.test.ts` fails with "services/admin.ts writes issue_types (owned by services/rules.ts)".

---

## D68. The certificate check's write to notifications goes through notify() (2026-11-09)

**What the code did:** `notifications` is owned by `db/db.ts`, whose `notify()` every other caller already used. The one exception was
`authenticate` in `services/cabinets.ts`. When a renewed certificate was used for the first time, it retired the certificate it
replaced and, in the same batch, inserted the revocation notice itself (`IF @@ROWCOUNT > 0 INSERT INTO notifications`).

**The decision** (F21.R2):
- **The batch reports instead of writing.** It returns how many certificates it retired, and `authenticate` calls
  `notify(REVOCATION_CHANNEL, cabinetId)` when that is more than 0. This adds one round trip, only on the first use of a renewed
  certificate, never per request.
- **`notify()` checks its input before writing.** A channel is a name of 1 to 40 lower-case letters and underscores, as every channel
  in the code is. The payload must be text, and is still cut to the column.
- **Repeating is safe.** A notification is a wake-up call: every listener re-reads what changed, so one sent twice does no harm.
- `services/cabinets.ts` comes off the debt list for `notifications`, which leaves 118 entries.

**Proven by:**
- `notify.test.ts`, a new file: a notification is written with its payload cut to 450 characters, and 9 malformed or hostile channels
  and 4 non-text payloads are refused with nothing written.
- `agent-api.test.ts`, the renewal test, now also checks the notice: the first use of the new certificate sends exactly one, and a
  later use sends none.

**Red checks:**
- Without the channel check, the notify test fails.
- Without the notice in `authenticate`, the renewal test fails.
- With the old inline `INSERT` back, `table-ownership.test.ts` fails with "services/cabinets.ts writes notifications (owned by db/db.ts)".

---

## D67. Approval's write to enrollment_baselines goes through its owner (2026-11-09)

**What the code did:** `enrollment_baselines` is owned by `services/baselines.ts` (D56), which reads it and moves a capture from
waiting to drafted or failed. Approving a cabinet in `services/enrollment.ts` inserted the cabinet's baseline decision itself (line 278
before this change).

**The decision** (F21.R2): the insert moves into the owner as `recordEnrollmentDecision`, called in the approval transaction as before.
- **Input check, before anything is written:** the cabinet, the site and the deciding user are ids; the decision is inherited, attach
  or capture; only an attach names a version. These are the same rules as the table's own CHECKs.
- **A repeat is safe:** the same decision recorded again writes nothing.
- **A conflict is refused:** a different decision for a cabinet that already has one is refused, never overwritten. Approval records
  a decision once, for a new cabinet, inside its own transaction, so in service neither case arises today; the writer holds the rule
  for whoever calls it next.
- `enrollment.ts` comes off the debt list, which leaves 119 entries.

**Proven by:** `enrollment-decision.test.ts`, a new file:
- each decision is recorded as the table has it (a capture as waiting);
- the same decision again writes nothing, and a different one is refused with the first standing;
- 12 malformed or hostile decisions are refused with nothing written.

**Red checks:**
- Without the input check, the hostile test fails.
- Without the repeat handling, the repeat test fails.
- With the old `INSERT` back in `enrollment.ts`, `table-ownership.test.ts` fails with "services/enrollment.ts writes enrollment_baselines
  (owned by services/baselines.ts)".
- The enrollment and baselines tests pass unchanged.

---

## D66. The write to config_changes from the drift check goes through its owner (2026-11-09)

**What the code did:** `config_changes` is owned by `services/config-ingest.ts` (D56). After working out a cabinet's drift,
`services/baseline-drift.ts` set `violates_baseline` on the cabinet's changes of the last 30 days with its own `UPDATE` (line 69
before this change).

**The decision** (F21.R2): the statement moves into the owner as `markBaselineViolations(c, cabinetId)`, called in the same
transaction as before, so behaviour is unchanged.
- **Input check:** anything but a cabinet id is refused before the database is touched.
- **Safe to repeat:** the flag is set from the drift as it stands, so calling it again changes nothing.
- **Debt list:** `baseline-drift.ts` comes off it.
- **The reader was blind to a row limit, and the list was short by 14 (review of #224).** `test/table-writes.ts` took a write's
  table to follow its verb (or `FROM`/`INTO`) directly, so `DELETE TOP ($1) FROM t` and `UPDATE TOP ($1) t` were never seen. The
  retention sweeps in `services/maintenance.ts` write that way. The reviewer proved it with a planted `DELETE TOP ($1) FROM cabinets`
  in a file nobody listed, and the ownership test stayed green. The reader now takes an optional `TOP (…)` between the verb and the
  table, in both the literal and the run-time reader. It finds 14 more writes, all `maintenance.ts` sweeps:
  - alerts, cabinet_boots, commands and config_changes;
  - diagnoses, drive_samples and firewall_changes;
  - fleet_jobs and fleet_job_targets;
  - health_transitions, incidents and notifications;
  - sessions and step_up_tokens.

  They are listed as debt. The list holds 120 cross-module writes, not the 108 that D56 counted or the 106 this change first said.

**Proven by:**
- `table-ownership.test.ts`: the reader test now plants four writes with a row limit (a `DELETE TOP … FROM`, an `UPDATE TOP` on a
  table, an `UPDATE TOP` through an alias, and one on a table named at run time). With the old reader that test fails, and so does
  the stale-entry test, since the 14 entries would read as writes that are not there.
- `config-changes.test.ts`, a new file, since no test checked the flag before.
- A change against its baseline is marked and a matching one is not.
- A change older than 30 days and another cabinet's change are left alone.
- A repeat changes nothing, and a cleared drift clears the flag.
- 8 hostile or malformed ids are refused.

**Red checks:**
- Without the id check, the hostile test fails.
- With the old `UPDATE` back in `baseline-drift.ts`, `table-ownership.test.ts` fails with "services/baseline-drift.ts writes config_changes (owned by services/config-ingest.ts)".
- The baselines tests pass unchanged.

---

## D65. The first cross-module write paid down: every write to fleet_patterns goes through its owner (2026-11-09)

**What the code did:** `fleet_patterns` is owned by `services/fleet-patterns.ts` (D56), but `services/crash-clusters.ts` opened,
counted up and resolved its own patterns with its own SQL. The same three writes appeared twice more inside the owner, in the
minute sweep and the rising-errors pass, each with its own copy of the insert, the audit, the alarm and the notification.

**The decision** (F21.R2; the shape is mine):
- **Three writers in the owner:**
  - `openPattern`: insert, audit `fleet_pattern.open`, ring if it deserves to (D25), notify every console.
  - `countUpPattern`: counts only grow while the pattern is open, and a major reading makes it major.
  - `resolvePattern`: resolve one by id, audit, notify.
- **All three callers use them:** the sweep, the rising errors and the new-kind pass. Behaviour is unchanged. The sweep's own
  bulk resolve, which runs one statement over many patterns, stays as it is, inside the owner.
- **Input checked at the boundary**, before anything is written:
  - a key of 1 to 450 characters;
  - a title of 1 to 300;
  - major or minor;
  - counts that are whole numbers from 1;
  - real times.
- **Each write can be repeated safely.** A second open of the same key returns null and writes nothing (the unique key on open
  patterns). A second resolve does nothing and audits nothing. Counting up a resolved pattern finds none open.
- `crash-clusters.ts` comes off the debt list in `table-owners.ts`, which now holds 107 cross-module writes. The ownership test fails
  if it is listed again without a write.

**Proven by:**
- `fleet-patterns.test.ts`, "the pattern writers": 13 malformed or hostile inputs are refused with nothing written; a repeated open,
  count-up and resolve behave as above, with one audit row each. It fails without the input check, and fails without the
  duplicate-open handling.
- `table-ownership.test.ts` fails with `crash-clusters.ts` still listed ("no longer writes fleet_patterns").
- The existing fleet-pattern, crash-cluster and rising-error tests pass unchanged, 18 of 18.
- The full suite run for this change caught a race in `fleet-patterns.test.ts` itself. It swept straight after storing events, while the
  background check that storing events asks for (`checkFleetSoon`) could run at the same moment. The losing sweep counts nothing
  until the next one, so it read 50 occurrences against 51. The race is on main too; in service the next minute's sweep counts the
  difference. Every sweep in that test now waits for the background check first (`fleetCheckSettled`), as one already did.

---

## D64. A network diagnosis settles its baseline alert before it says it is done (2026-11-09)

**What the code did:** `run` in `server/src/diagnose/network.ts` (lines 182 to 183) wrote the diagnosis as done, then raised or closed the
cabinet's network-baseline alert in a second statement. Anyone who saw the diagnosis done in between, the console or a batch, saw
the alert it was about to close still open. The review of #219 found it as a failure under load in `network-troubleshooting.test.ts`
("Uptown Exam 1: the baseline alert closed"), which passed 10 of 10 alone.

**The decision:** settle the alert first, then write the diagnosis as done. Nothing else changes. If settling the alert fails, the
diagnosis is marked failed, as it already was, since the error handler overwrote "done" with "failed".

**Proven by:** a new test in `network-troubleshooting.test.ts`. A second connection holds the cabinet's open baseline alert until
the diagnosis says done, for at most 7 s. The test fails if the diagnosis was done while the alert was held. With the old order it fails
(2 of 2 runs); with the new order it passes (3 of 3), and the alert is closed when the diagnosis finishes.

---

## D63. The readings search reads each answer's names, not its stored JSON (2026-11-09)

**What the code did:** a fleet search by name (`searchReadings` in `server/src/services/readings.ts`) took the newest stored answer
of each cabinet and opened its JSON (`OPENJSON`) to compare every name in it. At 10,000 cabinets, a software search took a median
of 9,256 ms with 81 programs a cabinet (measured below). Real software lists are longer, so it ran past the pools' 10 s statement
limit and near the console's 15 s search limit.

**The decision** (F21.R4; the approach is mine):
- **The searchable names are stored beside the answer**, in a new `commands.search_text` column (migration 0032). They are written in
  the same statement as the result (`storeResult`), in lower case, one value per line. The fields are exactly those the search
  compares, defined once in `server/src/services/reading-search-text.ts`. A test holds that list equal to the readings searched by
  name.
- **The search reads that text**, with a binary `CHARINDEX`, and opens the JSON only for the matches it shows. Each cabinet's newest
  answer is chosen from the index alone.
- **An answer stored before this has no text** and is read from its JSON as before, so nothing is lost while the fleet re-reads.
  Retention clears the text with the result.
- **Case:** both sides are lower-cased by the server's JavaScript, so a match no longer depends on SQL Server's `LOWER` for
  non-ASCII text.

**Measured** (`server/test/readings-search-at-scale.bench.ts`, by hand; 4 cores, 15 GB, SQL Server 2022 in Docker; 10,000
active cabinets, two software lists each of 81 programs, 100 of them match; 5 runs after one warm-up): without the text (as before)
median 9,256 ms (best 8,440, worst 9,602); with it, median 943 ms (best 832, worst 1,128).

**Tried first, and dropped** (each measured on the same data):
- **Choosing the newest answer by the index alone:** 8,896 ms, no gain on its own.
- **A text check of the stored JSON before opening it:** 13,583 ms; 20,938 ms with the column's own collation. A case-insensitive
  search of 70 MB of text costs more than it saves.

**Alternatives:** a table of one row per name, which is a second table to keep in step for no measured gain over a column. A full-text
index, which needs the full-text feature (not in every SQL Server Express install) and matches words, not parts of names.

**Proven by:** `readings.test.ts`:
- An answer stored through `storeResult` carries its names, and a reading the search does not cover by name keeps none.
- `%`, `_`, `[` and `'` are plain text, and non-ASCII matches without case.
- A text that disagrees with its JSON is what the search follows, which shows the text is read. With the old condition, that test
  fails. Without the write in `storeResult`, it fails too.
- `admin.test.ts`: retention clears the text; without that, it fails.

---

## D62. The line a client's own database would follow, written down and tested (2026-11-09)

**What the code did:** every table is in one database, with nothing saying which data belongs to a client and which to the platform.
Moving one client's data to its own database (F21.R5) would have started with working that out, table by table, under pressure.

**The decision** (F21.R5; the placement is mine, from the schema's own foreign keys):
- **Three placements**, in `server/src/db/client-data.ts`:
  - **platform**: one database for the whole platform;
  - **directory**: `clients`, `sites` and `cabinets`, held by the platform database for routing and copied into each client database
    for that client's rows, so its foreign keys still hold;
  - **client**: what a client's cabinets produce.
- **Kept with the platform although they name a cabinet:**
  - **Certificates, enrollment requests and site tokens.** A cabinet is resolved to its client through them before anything else is
    known.
  - **Security alerts.** They are about people and sign-ins as much as cabinets.
  - **Fleet jobs, rollouts and fleet patterns.** They span clients; only their per-cabinet rows go with a client.
- **Settings and baselines stay with the platform at every scope.** A cabinet's value is resolved from the fleet's, its client's, its
  site's and its own in one read (D38). Splitting the rows by scope would turn that one read into reads from two databases.
- **The 11 foreign keys from a client table to a platform table are listed** (`CROSS_REFERENCES`). In a split each becomes a reference
  the code checks on write, because SQL Server cannot enforce a foreign key across databases.

**Not built here:** the connection resolved per client (the second half of F21.R5), migrations per client database, and fleet views
that read each client database in turn. Whether and when a client moves is the owner's decision (open decisions, "Per-client
databases").

**Alternatives:** a `client_id` on every table and row-level security in one database. That isolates reads but not storage, size or
backups, and changes every query. Who may see which client is a separate question, already decided as one organization
(`archive/diagnostic-engine-execution.md`, decision 5). Separate databases per module rather than per client: that is F21.R2's direction, and does not help a client that needs
its data apart.

**Proven by:** `client-data.test.ts`. It reads the foreign keys and columns of a freshly migrated database, as its owner, and fails on
each rule. Red checks: with `events` placed with the platform, two tests fail (the platform would depend on `alerts`). With
`commands -> users` taken off the list, they fail with "unlisted cross reference: commands -> users".

---

## D61. The kinds of blue screen are read through their alerts, not from every event (2026-11-09)

**What the code did:** the console's list of blue-screen kinds and each kind's report (`crashesIn` in
`server/src/services/crash-signatures.ts`) loaded every active cabinet of the scope with its names, then scanned every event in the
window for those cabinets, filtering each one's JSON source for BugCheck 1001. The cost grew with the fleet and its event volume,
not with the number of crashes.

**The decision** (F21.R4; the approach is mine):
- **Read the events the blue-screen alerts hold.** The alerts are found by issue type (`alerts_issue_recent`) and their events
  through the filtered `events_alert` index, as the hourly new-kind pass already does (`crash-clusters.ts`). Both BugCheck sources
  map to the blue-screen issue in the built-in rules, and the engine links every event to the alert it raised or folded into.
- **Two statements, not one.** The cabinets' names are read second, for the crashed cabinets only. A filter on the JSON source in the
  first statement made SQL Server scan every event (1,849 ms against 4 ms without it, measured below), and a filter on
  `cabinets.status` made it start from every active cabinet (189 ms against 3 ms). So the source and event ID are read in the
  select list and checked in code, over the alerts' rows only.
- **The report's comparison group** (the active cabinets of the same kind, real or demo) is fetched on its own, only when a report
  is asked for.

**What changes for a person:** a blue screen that an approved rule hides, or files under another issue, is no longer on the list,
since no blue-screen alert holds it. Every alert view and the hourly new-kind pass (D52) already work this way. Nothing else changes.

**Measured** (`server/test/crash-kinds-at-scale.bench.ts`, by hand; 4 cores, 15 GB, SQL Server 2022 in Docker; 10,000 active
cabinets, 300,050 events, 50 blue screens, 5 runs after one warm-up): the old query median 3,861 ms (best 3,534, worst 4,102); the
whole list now median 11 ms (best 10, worst 12). Recorded in `performance.md`.

**Alternatives:** an aggregate table of crashes per cabinet and signature, kept by the ingest. Not needed at these numbers, and a new
write with its own rollback; the alerts already are the aggregate. A computed, indexed column for the event source: a schema change
to the largest table for a query that no longer needs it.

**Proven by:** `crash-signatures.test.ts`, "the list reads what the alerts engine filed as a blue screen". It fails with the old
query (an unfiled entry is listed) and without the check in code (an entry from another source held by the alert is counted).

---

## D60. The cabinets' ingest and the console run apart when asked to (2026-11-09)

**What the code did** (F21.R3, "the agent-facing ingest can be deployed separately from the console API: separate port and process,
same codebase, no shared in-process state"): `main.ts` always started the agent API and, in the same process, the console and the
background jobs. With `AGENT_API_WORKERS` above 1 the agent API ran in forked workers, but the primary still ran both of the others.
Restarting the console meant restarting the process that also answered every cabinet.

**What was already true:** the separate port and the "no shared in-process state". The agent API and the console have their own
listeners. Everything that crosses between them goes through the database:
- commands and results, woken by the notifications table;
- alerts;
- the fleet checks;
- contact, which the jobs read back from the database.

The jobs take leases (F21.R1). Each process flushes its own rule-hit counts. So the only missing piece was a way to start a process
with less than everything.

**The decision** (mine, within the brief):
- **`SERVER_ROLES`**, a comma-separated list of `agent`, `console` and `jobs`. Unset means all three, so every existing deployment is
  unchanged.
- **`processPlan` decides what a process runs.** It is a pure function of the roles, the worker count and whether the process is the
  primary. `main.ts` opens only the pools, listeners and jobs that plan names. Workers serve agents only, and only a process with the
  `agent` role forks them.
- **A primary that only forks serves nothing, so it opens nothing.** With `SERVER_ROLES=agent` and `AGENT_API_WORKERS` above 1 the
  primary has no pool, no notification feed and no operations counters; it forks the workers and replaces any that stop. Each worker
  reports its own counters, as before. (Found in review of #218: the primary handed a null pool to the feed and died before forking.)
  The alternative, a pool of its own, would keep a connection and a poll open for a process that reads nothing.
- **Refuse what cannot work, at start.** An empty or unknown role stops the server. So does `console` named without the console's
  settings, which would otherwise start a process that serves nothing and says nothing.
- **Rejected:** a separate entry point per part (two builds to keep in step, and the brief asks for one codebase); splitting the
  repository (nothing is extracted before F21.R1 and F21.R2, per the brief's ordering rule).

**How it was proven.** `server-roles.test.ts` starts the real built server twice against one test database: `SERVER_ROLES=agent`, and
`SERVER_ROLES=console,jobs`.
- It stops the console process: the console port closes, and the agent port keeps accepting.
- It starts the console again, then stops the ingest: the agent port closes, and the console keeps answering.
- It starts the ingest again.
- It starts `SERVER_ROLES=agent` with `AGENT_API_WORKERS=2`: the workers listen, the primary is still running 3 s later, and the port
  closes when it is stopped. Without the fix, this fails with the review's `TypeError`.

Plus the role parsing with hostile values, the plan for every combination, and the start-up refusals.

The red check: with the plan ignoring the roles, the plan test and the two-process test fail. The second process takes ports and work
that belong to the first.

---

## D59. A read-only acceptance check on the cabinet itself (2026-11-09)

**What the code did:** a freshly installed agent was checked from the console only ("Test <cabinet>": read-only operations through the
platform). That proves the agent answers. It cannot show whether the install itself is sound: which accounts the services run as,
whether a non-administrator can change the programs or the data folder, whether the cabinet reaches the server at all. Those were
checked by hand during the real-machine tests.

**The decision** (the owner asked for a test ready to run when the agent is on a machine; the shape is mine):
- **`agent/install/Test-CabinetAgent.ps1`**, shipped in the package and left by the installer beside the uninstaller in
  `C:\Program Files\Mashura`, so it is on every cabinet and runs from the remote management tool as SYSTEM.
- **What it checks** is the install's own security promises, read back: the two services and their accounts, the network service
  outside the Administrators group, signatures, folder owners and who can write, the configuration and CA, the path to the server,
  and a recent log.
- **Read only.** It changes nothing, writes only its results file, never opens a token, a key or the certificate store, and prints
  only the server address from the configuration.
- **Held to that by an allowlist, not a list of forbidden commands.** A test in `installer-scripts.test.ts` removes the comments, the
  help block and every string's contents from the script. It then requires each word left to be on a reviewed vocabulary: keywords,
  its own functions and parameters, and the read-only cmdlets, .NET types, methods and properties it calls. Any new word fails,
  whatever it does. The forms that could run text are held to their one reading use:
  - the call operator only as `& $Body`;
  - `.Invoke` only as `.Invoke('Members')`;
  - `InvokeMember` only as `'GetProperty'`;
  - nothing dot-sourced.

  Its writes are held to their single use: `New-Item` for its results folder, `WriteAllText` to its results file. The test also holds
  the script to ASCII (Windows PowerShell 5.1 reads a BOM-less script as ANSI).
- **The review of #217** showed the first version of that test was a list of forbidden verbs, which stayed green for a download, a
  registry delete, a service disabled through a script block built from Base64, .NET file writes, `icacls` and more. Those thirteen
  forms are now probes the test must catch.
- **The program folder is checked item by item,** owner and who can write, as the installer checks it. A loosened permission on one
  program inside a sound folder is caught; the first version read only the folder's own permissions.
- **Exit 0 or 1,** with a JSON results file, so the remote management tool and support read the same thing.
- **The uninstaller removes it**, and with `-RemoveData` its results.
- **Rejected:** a new agent operation that reports the same facts (an agent change, which cannot be built here, and a new write path
  to the server for what a local read-only script answers); a check of every catalog read on the cabinet itself (that is the
  console's "Test <cabinet>", through the real path).

**What is not proven here.** The script is Windows PowerShell and this environment has no Windows. The parse test runs where
PowerShell 7 is installed, and is skipped here. Its first run on a real cabinet is its proof.

The red checks:
- the review's three lines (a download, a registry delete, a script block from Base64) added to the script fail the read-only test;
- dropping the script from the package fails the same test;
- a non-ASCII character fails the ASCII test.

The per-item walk is PowerShell and runs only on Windows, so it has no test here; its first run on a cabinet is its proof.

## D58. The cabinet at a glance, and a denser console (2026-11-09)

**What the code did:** the cabinet Overview had a summary (contact, agent version, uptime, alerts) and a Details list. The machine's
memory, storage, processor and Windows were on separate tabs (Windows information, Services and processes), each read on demand. A
person had to open two tabs, and ask the cabinet twice, to see how much memory and disk it had left.

**The decision** (the owner asked for every user to see a cabinet's memory, storage and other useful facts, in a compact, professional
layout; the shape is mine):
- **One System panel at the top of the Overview, for every role.** It shows Windows, the processor, memory, the machine and each
  drive.
- **Read from what is already stored.** It uses the latest stored answer of `system.hardware`, `system.info` and
  `system.performance`, and the latest heartbeat load sample (`GET /api/cabinets/:id/summary`). Opening a cabinet asks it nothing,
  and an offline cabinet still shows its last known figures.
  - Every figure carries how long ago it was read.
  - A part never read says so.
  - A malformed stored answer is dropped field by field, never shown as a wrong figure.
  - "Read now" runs the two reads again, as the existing tabs do.
- **Meters with a number beside them.** The meter colours are status colours (amber at 85% used, red at 95%, 92% for a drive) and
  always sit next to the figure, so colour is never the only signal.
- **Denser everywhere, from the tokens.** Table cells, panel padding, the key-value grid and page margins are tightened in the
  design tokens (`--cell-y`, `--cell-x`, `--panel-pad`), so every page gets more on screen without a page-by-page change. The type
  scale and control heights are unchanged, so nothing gets harder to read or to hit.
- **Fixtures come from the contract.** The tests start from the contract's example answers, and check every stored answer against
  the operation's output contract before storing it. The first version read Secure Boot as a boolean. The contract stores `"on"`,
  `"off"` or `"unsupported"`, so the tile said "unknown" on every cabinet. Its fixtures used `true`, a value the agent cannot send,
  so the tests passed (review of #215). The panel now reads the three states, words "unsupported" as "not supported" as the
  Windows tab does, and treats any other value as unknown.
- **Rejected:** a new periodic read for these figures. The stored reads and the heartbeat already carry them. A new stream would need
  its own line in the capacity budget, and the brief allows none without one.

The red checks:
- taking the oldest stored answer instead of the newest fails the first server test;
- accepting volumes without a drive and real sizes fails the malformed-answer test.

The browser test checks the panel's text, drive rows and meters for a Tier 1 user.
## D57. A site installer as a script a remote management tool runs as SYSTEM (2026-11-09)

**What the code did** (F6, "a site set up end to end in one sitting"): the installer for a site was a `.cmd` launcher
(`installer-launcher.ts`) a person runs on each cabinet. It needs the agent package downloaded beside it, an elevation prompt, and a
folder in the person's profile. The fleet is managed with a remote management tool that runs PowerShell scripts as SYSTEM (the owner's,
2026-11-09), so installing a site meant visiting every cabinet.

**The decision** (the owner asked for the fewest steps to get the agent on the fleet; the shape is mine):
- **One script per site installer**, made on Admin → Setup with the same limits and the same authenticator confirmation. The format is
  part of what the code confirms, so a code confirmed for a launcher cannot make a script. A script is made only for a site installer:
  a one-cabinet token in a script meant for many cabinets would be used once and then fail everywhere else.
- **The script downloads the package itself**, from the console over HTTPS (`GET /api/install/package`), with the site installer's
  token in the `Authorization` header.
  - Why the console address: it carries the certificate Windows already trusts. The agent API's certificate is issued by the platform's
    own CA, which Windows PowerShell 5.1 cannot be told to trust for one request without weakening TLS for the whole process.
  - What the server checks: the token must still be able to enroll a cabinet. A one-cabinet token is refused. A download is never
    counted as a use, so a failed install followed by a retry costs nothing. Each download is audited (`install.package`).
- **Integrity does not rest on the transport.** The script refuses any package whose SHA-256 is not the one built into it, then unpacks
  it in a new folder only SYSTEM and Administrators can change, and runs the same installer as the launcher, which checks the programs'
  signatures before it creates a service.
- **Built for a tool, not a person:** no parameters, no questions, plain output. It exits with 0 when installed or already installed
  (so a re-run is harmless), and with 1 when not, with the reason and the next step on the last two lines.
- **Rejected:**
  - pushing the package file with the tool and pointing the script at it (one more manual step for every agent release);
  - a download from the agent API (the TLS trust above);
  - a token in the URL (it would land in proxy and server logs).

**What is not proven here.** The script is Windows PowerShell and this environment has no Windows. What the tests prove:
- the script is made from checked values only;
- it pins the right SHA-256 and the console address;
- it keeps the token out of the URL;
- the download route serves only to a usable site token and never counts a use.

Running the script on a real cabinet is the first item of the on-machine test, with the agent build.

The red checks:
- accepting a one-cabinet token fails the refusal test;
- counting the download as a use fails the download test;
- making a script without a site fails the first test.

## D56. Each table has one owner, written down; today's cross-module writes are listed debt that can only shrink (2026-11-08)

**What the code did** (F21.R2, "a module owns its tables and nothing else writes them"): nothing said which module owns a table, and
nothing stopped any file from writing any table. Read from the source (the new `test/table-writes.ts`), the migrations create 62
tables:
- 34 are written from more than one file, 108 cross-module writes in all;
- `alerts` is written from 17 files, `cabinets` from 14, `clients` and `sites` from 12 each, `settings` from 10;
- the three audit tables are written only through the `audit_append` procedures.

Sixteen of those writes name their table at run time, in five files. Four settings services update `clients`, `sites` or `cabinets`
through a per-level lookup (`approved-apps.ts`, `device-settings.ts`, `filefacts-allowlist.ts`, `watched-services.ts`), and the demo's
seeding and clearing helpers insert and delete by table name (`demo/demo.ts`).

**The decision** (mine, within the brief):
- **Write the ownership down and enforce it as a ratchet, rather than move 108 writes in one change.** `src/db/table-owners.ts` names
  one owner per table and lists every other writer today under `also`. `table-ownership.test.ts` fails on:
  - a write by a file not listed: a new cross-module write;
  - a listed writer that no longer writes: the debt was paid, so the entry must come off;
  - a table without an owner;
  - a write whose table is named at run time, in a file that does not declare the tables it can write (`RUNTIME_TABLE_WRITES`).

  So the boundary holds from now on, and the debt is visible and can only go down. Moving the writes one table at a time behind their
  owners is later work, each a PR of its own.
- **The owner** is the module named for the table where there is one (`alerts.ts` for alerts, `cabinets.ts` for cabinets, `admin.ts`
  for clients and sites, `settings.ts` for settings, `users.ts`, `commands.ts`, `events.ts`, `auth/sessions.ts`), otherwise the main
  writer.
- **The demo simulator** seeds its own demo rows across the schema. It is listed like any other writer rather than exempted, so its
  reach stays visible.
- **How it reads:** statement text (INSERT INTO, UPDATE, DELETE, MERGE), against the tables the migrations create, with an UPDATE or
  DELETE through an alias followed to its table. A statement whose table is interpolated at run time is found too. The reader cannot
  tell which table such a statement writes, so its file declares the tables in `RUNTIME_TABLE_WRITES`. Those count as writes like any
  other, and a declaration whose file no longer has such a statement must come off. The reader is a test helper, never run at run
  time. It errs towards counting: a statement inside a string or comment counts. Run-time writes are matched on upper-case keywords
  only, as this codebase writes SQL, so prose such as "Update KB…" is not taken for a statement.
- **The review of #213** found that the first version saw only literal table names. Five files writing through a run-time name passed
  unseen, and a write to `alerts` through a variable left every test green. This entry first said no file wrote a table that way,
  which was wrong.
- **Rejected:**
  - moving every write now (a change across dozens of files with no behaviour to show for it, too large to review);
  - a lint rule (no linter in the repository, and the rule CLAUDE.md sets against new dependencies).

The red checks:
- an added "UPDATE alerts" in `job-lease.ts` fails the unlisted-write test;
- the same write through a variable (the review's case) fails the run-time test;
- a declared run-time write missing from `also` fails the unlisted-write test;
- a file with a run-time write left undeclared fails the run-time and shrink tests;
- a stale `also` entry fails the shrink test;
- a table removed from the map fails the owner test;
- the reader's own test covers alias forms and reads that do not write.

Boundary input validation and idempotent writers (the rest of F21.R2) are not part of this change.

## D55. Which Windows the fleet runs, from what it already reports; what F20 leaves open (2026-11-08)

**What the code did** (F20): the brief's F20 "today" lists four gaps. Three are already closed in the code, so this entry records them,
naming the file and line, rather than building them again:
- **Release uploads isolated per attempt:** each upload streams to its own file, `uploadTempName(version, architecture, randomUUID())`
  opened with `wx` (`server/src/services/releases.ts:169`, `:231`, `:242`). Tested in `integrity-release-upload.test.ts`, "streams to a
  temporary file of its own, named for that upload".
- **Bounded, paginated list paths:** site and cabinet detail page their cabinets with `pageWindow`, `OFFSET … FETCH`, and `hasMore`
  (`server/src/services/fleet.ts:138` and `:167`).
- **A bounded fleet-wide read search:** two searches at once and four waiting, then 429; a match cap; a time limit
  (`server/src/services/readings.ts:146`, `SEARCH_CONCURRENCY`, `SEARCH_QUEUE`, `MAX_MATCHES`, `limitMs`).

What was missing is the distribution report: which Windows the fleet runs.

**The decision** (mine, within the brief):
- **Built from what cabinets already report.** The edition and build come from each cabinet's latest `system.info` answer (`osVersion`,
  `osBuild`), and the architecture from the one recorded at approval. Grouped by edition, build family (before the first dot) and
  architecture, with the lowest and highest full build in each family. The revision is compared as a number, because 19044.999 is older
  than 19044.5011. At most 200 groups. Demo cabinets are left out.
- **Honest about what it does not know.** Cabinets never read are counted apart. The update source is not read by any operation, so
  the report says so rather than guessing.
- **Cost.** One grouped statement over the latest answer per cabinet, through the existing `commands_result_by_operation` index. No new
  table or stream.
- **Left open, and why:**
  - **The update source** needs an agent operation (the agent cannot be built here: NU3018 behind the HTTPS-only proxy).
  - **The real-cabinet smoke test per build family** needs real cabinets of each family.

  Both stay open in the tracker.

The red checks:
- counting every answer instead of the newest fails the first test;
- comparing revisions as text fails it;
- letting demo cabinets in fails it;
- hiding the panel fails the browser test.

## D54. A change that leaves a cabinet unlike all its peers is an alert, where no baseline declares the setting (2026-11-08)

**What the code did** (F17, "mine new cabinet-level differences as they appear"): drift (`baseline-drift.ts`) needs a baseline to say
what a setting should be, and the Differences view counts drift across the fleet. A setting no baseline declares was recorded as a
change (`config_changes`) and nothing else: a cabinet that changed so that it no longer matched every other cabinet at its site was
visible only to someone comparing two cabinets by hand.

**The decision** (mine, the recommended choice):
- **The peers are the expectation.** The other active cabinets of the same role at the same site: the narrowest group that should be
  set up alike, and the one a person would compare with. Not the client or the fleet, where sites legitimately differ.
- **Only where the peers agree, all of them, and at least two report it.** Unanimous peers are a clear signal and simple to explain;
  a majority rule needs a threshold to defend, and one peer is a comparison of two, not a group. Peers that disagree among themselves
  give nothing to stand out from.
- **As it appears.** Only items this cabinet changed in the last 30 days are compared, checked when an upload changed something. A
  cabinet that always differed is not raised the day this ships; one that just changed is. The limit: a cabinet left behind when its
  peers all change (it did not change, they did) is not raised by this. The peers' own changes are checked against it instead, so the
  ones that changed alone are caught.
- **What is never compared.** The fields a baseline capture already leaves out because they differ from cabinet to cabinet
  (`CAPTURE_SKIP`, `PER_CABINET`, now exported from `baselines.ts`), the devices category, and an item a baseline in force declares,
  which is drift's job. One rule set, so a baseline captured later never disagrees with this about what is per-cabinet.
- **One minor alert per cabinet** (issue type 129 `peer_difference`, migration 0031), the first difference in its title and a count of
  the rest; it says "may be deliberate" and suggests capturing a baseline. Closed automatically, audited, once nothing differs or a
  baseline declares the setting. Peers with it open are re-checked when this cabinet changes.
- **Cost.** One check per upload that changed something: the cabinet's and at most 50 peers' current configuration, for the categories
  it changed in the last 30 days. Uploads are on change only, so this follows the rate of change, not the fleet. No table, no stream.
- **Rejected:** a nightly fleet-wide scan (every cabinet's configuration against every peer group every night, mostly finding nothing
  new); a list page only (nobody is told); comparing with the client's or the fleet's cabinets (sites differ on purpose).

The red checks, each guard taken out in turn:
- not checking after an upload fails the first two tests;
- comparing the per-cabinet fields fails the second (a stopped service raised);
- not requiring the peers to agree fails the second (raised at a site whose peers disagree);
- one peer enough fails the second;
- comparing a declared item fails the third.

## D53. The site-baseline offer, and what "healthy" means where no baseline applies (2026-11-08)

**What the code did** (F17, "offer capture this cabinet's configuration as the site baseline where a cabinet is healthy and the site has
none"): the capture exists (`captureDraft`, the Baseline page's "Capture a baseline from this cabinet" form, Tier 2), but nothing offered
it. A cabinet with no baseline is never judged healthy at all: `judge` (`cabinet-health.ts`) returns "unknown" with `no_baseline`, so
"healthy" had no meaning in exactly the case the offer is for. This is the decision the tracker said was needed.

**The decision** (mine, the recommended choice, as the owner asked):
- **Healthy, where no baseline applies, is the health judgement with the configuration part counted as met.** In contact within the
  health settings' offline limit, its configuration reported, no required item drifting from a baseline that does apply (a client's, a
  model's), and no major alert open (offline and site outage aside). These are the checks `judge` already makes; the only change is that
  "no baseline" does not stop the judgement. Where a baseline applies, it is the same as the judgement itself, so there is one meaning.
- **Rejected:** "no alerts open at all" (a minor alert is not a reason to doubt a configuration, and the health judgement does not count
  it either); "healthy for a stretch of time" (a new rule with a new threshold to defend, and the capture is reviewed by a person and
  approved by an Admin before it judges anything, which is the real check); "never offer without a baseline" (that is the case the brief
  names).
- **The site has none** means no site baseline approved, pending or in draft: an offer while one is being drafted would make a second.
  A client or model baseline does not count; the brief asks for the site's.
- **The categories it captures, reported.** Accepting captures the capture form's six defaults (network, services, firewall, time,
  drivers, hosts), the settings a site's cabinets share; the offer waits for exactly those six. (As first built it waited for all ten a
  site baseline can hold while capturing the six: the review of #207 caught the mismatch. Waiting for four it does not capture only
  delayed the offer. The server now names the six once, `OFFER_CATEGORIES`, returns them with the offer, and the console captures
  what it returns, so the two cannot drift apart. A test checks the draft holds those six, no more and no less.) Updates,
  applications, scheduled tasks and the hardware differ from cabinet to cabinet and stay a hand capture.
- **Accepting is the existing capture**, for the site, with the capture form's six default categories: a draft, reviewed, and approved by
  an Admin with step-up. No new write, permission or route; the offer is a field on `/condition`, computed on the server, and the
  console shows the button to Tier 2 and above (the route enforces Tier 2).
- **Why not offered** is returned, one sentence per unmet condition, so a person who expects the offer can see what is missing.

The red checks:
- judging without the configuration part counted as met makes all three server tests fail (no cabinet without a baseline is healthy);
- dropping the site check makes the first fail (offered again while the site's draft exists);
- hiding the offer in the console makes the browser test fail.
## D52. A new kind of blue screen on two cabinets is its own fleet pattern (2026-11-08)

**What the code did** (F17, "cluster new crash signatures"): crash signatures (D26) group blue screens by stop code and the exception or
subtype, and the Incidents page lists the kinds with a 24-hour trend. But a blue-screen alert is one per cabinet whatever the kind
(issue type 109, folded), so the fleet pattern for blue screens (`fleet-patterns.ts`, `KEY` is `issue:<id>`) held every kind at once, and
opened only at the site threshold. A new failure that starts on a few cabinets after a driver or update read as more of the usual crashes
until someone opened the kinds list.

**The decision** (mine, within the brief):
- **A fleet pattern per new kind.** Once an hour a pass groups the crashes the platform alerted on by signature. A kind new to the fleet
  (its first crash at most 7 days old) that has reached 2 or more cabinets opens one major pattern, keyed `crash:<signature>`, while one
  of those cabinets still has a blue-screen alert open.
- **Why 2 cabinets and 7 days.** One cabinet's new crash is already its own major alert; the second cabinet is what makes it a cluster.
  Seven days matches the rising mark's week (D50). "New" looks back 90 days, as far as events are kept; crash events are kept whole.
- **Why major.** Blue screens are major alerts; a new one spreading is not less.
- **Read through the alerts.** The pass reads only BugCheck 1001 events linked to a blue-screen alert (the filtered `events_alert` index),
  never a scan of all events, so its cost follows the number of crashes, not the fleet. No new table, column or stream.
  Only the two sources the kinds list reads count (BugCheck and WER-SystemErrorReporting), so the pass and the list count the same
  crashes even if another source is ever mapped to a blue screen (review of #206; the follow-up's test goes red without the filter).
- **Its own resolution.** No alert carries a kind, so the minute sweep would resolve the pattern a minute after it opened. The sweep now
  leaves `crash:` keys to this pass, which resolves one once none of its cabinets has a blue-screen alert open. That is a second
  resolution path, the cost of not splitting blue-screen alerts by kind; splitting them would change every cabinet's crash alert and
  crash incident (D21).
- **The report.** A crash pattern's report reads its cabinets through their blue-screen alerts, so the common-factors comparison works as
  for any pattern.
- **Rejected:** a "new" mark on the kinds list only (nobody is told); a pattern per kind for every kind, new or not (the blue-screen
  pattern already covers the usual ones, and it would double them).

The red checks:
- with the sweep's `crash:` exclusion removed, the first test fails: the sweep resolves the pattern;
- with the pass never opening one, the first and third fail;
- with "new" not required, the second fails: a kind first seen 10 days ago opens one.

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

## D50. A rising unrecognised error opens a fleet pattern (2026-11-08)

**What the code did** (F17, first requirement): a new unrecognised error opens a minor alert on its cabinet as it arrives, and the nightly
trends mark each error group (log, source, event ID) new or rising. The trends page and the triage queue show the mark. But a group
that grows, at one or two sites, never alerted. Fleet patterns open only at the site threshold within hours (D22), and the rising mark was
only something a person might notice.

**The decision** (mine, within the brief):
- **A fleet pattern per rising group.** After each nightly trend run, each unrecognised group marked rising fleet-wide opens one minor
  fleet pattern, while any active cabinet still has its alert open. The title reads "Rising: Disk event 153 (System), 21 events in the last
  7 days, 1 the 7 before".
- **Why a fleet pattern, not per-cabinet alerts.** The cabinet alerts already exist; what was missing is the fleet seeing the growth. A
  fleet pattern is that alert, with its report, its list and its notification, and it is the one place the console already shows a
  problem across cabinets.
- **The alerts' own signature as its key.** So the minute sweep counts it up while it spreads, and resolves it once none of its alerts is
  open, exactly as it does every pattern. No second resolution path.
- **Crash and hang groups: one pattern per program** (review of #204). An Application Error 1000 or Application Hang 1002 alert carries
  its program in its signature ("…|1000~cabinetui.exe", D29); the trends count the group without it, so keying by the group's signature
  matched no alert and opened nothing for the very case F17 names. The pattern now opens for each program whose alert is open in that
  group, keyed by that alert's signature. Rejected: one pattern for the whole group (the sweep would find no alert with that key and
  resolve it at once) and a program taken from the group's one stored sample (a group can hold more than one program). The cost: the week
  counts in the title are the group's, not the program's, and the title says "the group" so it is not read otherwise. Splitting the trends
  by program would change the trends tables and is not part of this change.
- **No duplicates.** A group already open as a pattern, rising or spread, is left alone.
- **Nothing open, nothing opened.** A group with no open alert opens nothing: there is nothing to look at.
- **Bounded.** At most 50 open in a night.
- **Minor.** Rising is a sign to look, not a failure. It rings like any minor pattern only from the alarm level (D25).

**How it was proven.** `server/test/rising-errors.test.ts`, through the real nightly run and sweep:
- A group at 1 event in the week before and 21 this week, open on one cabinet at one site, opens one minor pattern with that title and
  an audit carrying both counts. A second night does not open another.
- A steady group and a rising group with no open alert open nothing. Closing the alert lets the sweep resolve the pattern.

`fleet-patterns.test.ts` and `troubleshooting.test.ts` still pass.

The red check: without the rising step in the nightly run, both tests fail (the second depends on the first's pattern).

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
than asserted, which is what the incident record was for (archive/diagnostic-engine-audit.md, section 7).

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
(`archive/diagnostic-engine-execution.md`, decision 7). These are the choices made while building it.

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

---

## D10. The code is what gets you into the platform, not a toll on each write (2026-11-13)

**Decision.** The operator command line signs in the way the console does: `platform-admin sign-in --as <username> --password <their password>
[--code <6 digits>]` establishes one session, kept in a file only that person can read (`~/.cabinet-cli/session`, mode 0600, overridable with
`CABINET_CLI_SESSION_FILE`), and every later command takes `--as <username>` alone. A per-command `--code` still works and is still checked
exactly as before. `sign-out` ends the session on the server as well as deleting the file. Removing the console's per-action step-up for writes
follows the same policy in its own change.

**Why.** The owner's instruction, 2026-11-13: all writes should not need the code; a code is what gets you into the platform. Until now every
write at the command line demanded a fresh one-use code, so a full sweep of one cabinet (38 reads, ~35 writes, 8 checks that need an Admin's
approved-programs list) would have needed roughly 70 codes from a person, and the platform's own testing depended on somebody sitting at an
authenticator.

**What still holds.** A person is named by their own credential, not by shell access. Both proofs are that person's; role checks are unchanged;
a session is the console's own session row, so it expires on the same idle and absolute windows, a locked account cannot act, an account with no
authenticator set up or one still holding a temporary password cannot sign in from the command line at all, `sign-out` deletes the session row,
and every authorisation is audited as `cli.authenticate` with `proof: "session"` or `"authenticator"`.

**Residual risk.** Whoever holds the file can act as that person until the session expires or is ended — the same exposure as a stolen browser
session. That is why the file is 0600, the session is as short-lived as a browser one, and every command it authorises is on the audit chain
with its proof named.

**Proof.** `server/test/cli-authority.test.ts`: a signed-in person's later command needs no code and is audited with `proof: "session"`; a
session cannot authorise a command for somebody else; the wrong password or the wrong code signs nobody in and leaves no file behind;
`sign-out` ends the session on the server, so a copy of the file is worth nothing; an account with no authenticator set up, and one still
holding a temporary password, cannot sign in. All six are red with `src/cli.ts` and `src/auth/cli-session.ts` reverted.
