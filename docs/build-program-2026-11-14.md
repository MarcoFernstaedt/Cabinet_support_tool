# Build program: everything still missing, in PR-sized items

Written 2026-11-14. Owner: Marco. Builders: Claude sessions and Codex CLI runs. Aster writes the briefs, reviews the
diffs, runs the gates and commits. Nothing here is speculative scope — every item is either a named defect from the
fleet-hardening audit or a gap verified absent from source in `module-status-2026-11-14.md`.

**Correction, 2026-11-14:** items 4, 5 and 8 were listed from that file's "verified gaps", but the operations exist: each row now names
the file that has it. Item 12 is partly built. The file's pattern scan missed them because they live inside `network.config` and
`storage.health` under other names.

Sequence Marco asked for: **build all of it, then test, then dev check.**

## The professional bar — every item, no exceptions

The single source is `CONTRIBUTING.md` in the repo root: it states the definition of done, the test rules, and the
invariants that do not bend. This section is that standard applied to this program, and no item is exempt because a tool
wrote it.

1. **One item, one PR, one purpose.** No drive-by reformatting, no unrelated tidying. Untouched code stays untouched.
2. **The test ships with the change.** A behaviour with no test is not done. A changed assertion in an *existing* test is
   a finding, not plumbing — report it, do not weaken it.
3. **Contracts and migrations move with the code.** A new operation gets its schema in `contracts/schemas/operations/`
   and its migration in the same PR, or the PR does not merge.
4. **Red/green is proven, not asserted.** The new mechanism is neutered (`if (false)`, or the guard removed), the test
   must go red, the file is restored byte-identical (`cmp`), and the suite goes green. Numbers go in the PR body.
5. **The gate is green at the reviewed head.** `~/.hermes/scripts/gate-run.sh <worktree> <log>` — server suite, console
   suite, labelled, on a quiet-enough box. Actions is red repo-wide here and is never cited as evidence.
6. **Commit only after review.** Conventional commit subject, body that states what the defect was and what proves it
   fixed. Nothing is pushed or committed by the builder; the reviewed diff is landed by Aster.
7. **No secrets, ever** — no keys, tokens, passwords or connection strings in code, tests, fixtures or PR bodies.
8. **Dev check is a separate pass.** After Marco says the item is done, an independent reviewer (different agent, cold
   context) reads the diff against the spec and reports findings; Marco's dev gets the last word.

## Item 1–3: defects first (they bite at fleet scale)

| # | Item | Where | Scope |
|---|---|---|---|
| 1 | Job recovery after a runner dies | `server/src/services/fleet-jobs.ts`, `job-lease.ts` | `resumeJobs` and `scheduleFleetRecovery` retry only startup acquisition, from a snapshot taken once at boot. A job whose runner dies, or one started after boot, is never resumed until the process restarts. Cancelled jobs keep no reconciliation. Brief: `docs/codex-tasks/fleet-job-recovery.md` |
| 2 | One answer budget per cabinet | `fleet-jobs.ts` (`followUp:333` hard-coded 150 s for the whole batch) | Built, gate and merge pending. Each target carries its own budget, measured from its own durable `commands.issued_at` and configurable through `Timing`; a target that exhausts it reaches a terminal state while the job runs; a cabinet known to be offline settles promptly with its command withdrawn in the same statement, so "nothing was changed on it" cannot be contradicted later. Review caught three real findings, each now a test: A (an offline report a waking cabinet could still contradict), B (a runner polling forever while holding the job's lease, after a command row was pruned), C (`fleet-jobs-sync-last` hanging on B's mechanism). Briefs: `docs/codex-tasks/fleet-batch-deadline.md`, `-fix.md`, `-fix-2.md`. |
| 3 | Fleet cabinet list keeps its limit on screen | `server/src/console-api/fleet-ops-routes.ts:15`, `server/src/services/fleet-jobs.ts:37`, `console/src/pages/FleetOperations.tsx` | `fleetCabinets` returns every matching cabinet, so a filter with no site (a client alone, a problem alone) takes the whole fleet in one response and nothing in the answer says it was cut. Wanted: a cap with the house `limits: { cabinets: { shown, matched, limit } }` report, the shape `error-trends.ts:207` already uses for F17/D51 (`docs/spec/12-milestones-8-to-12.md:198`), plus the console note `Triage.tsx:28` already renders. Brief: `docs/codex-tasks/fleet-cabinet-list-limit.md`. (This row previously said the service could paginate sites; it cannot — nothing in the server paginates.) |

## Items 4–10: facts the platform cannot see yet

| # | Item | Scope |
|---|---|---|
| 4 | ~~Route table~~ — **built** | Checked 2026-11-14: `network.config` returns `routes` (destination, prefix, next hop, metric, interface; `Win32_IP4RouteTable` in `agent/src/Cabinet.Agent.Windows/NetworkExtras.cs`), and the console shows them (`RoutesTable`, `console/src/components/NetworkReadings.tsx`). Nothing to build. |
| 5 | ~~ARP table~~ — **built** | Checked 2026-11-14: `network.config` returns `neighbors` (address, MAC, state, interface; `MSFT_NetNeighbor` in `NetworkExtras.cs`), shown in `NetworkReadings.tsx`, and the network diagnosis reads the gateway's entry (`server/src/diagnose/network-observations.ts`). Nothing to build. |
| 6 | Process signer and parent | Per process: signature status and parent PID. Today `processes.list` carries neither; `SignedData.cs` is package signing, not processes. |
| 7 | Service dependency graph | The `DependentServices`/`ServicesDependedOn` chain behind a service that will not start. |
| 8 | ~~Volume health~~ — **built** | Checked 2026-11-14: `storage.health` returns each fixed volume's repair state (`MSFT_Volume` `HealthStatus`) and dirty bit (`agent/src/Cabinet.Agent.Windows/StorageOperations.cs`), and the console badges it (`console/src/lib/storage-health.ts`). Distinct from `disk.smart`. Nothing to build. |
| 9 | Read-only boot configuration + WinRE | What the machine does on next boot, and whether the recovery environment is intact. No `bcdedit`/WinRE identifier exists. |
| 10 | Machine variables | Machine environment variables, values that look like secrets hidden, comparable across cabinets. No operation exists. |

## Items 11–14: investigative tools

| # | Item | Scope |
|---|---|---|
| 11 | Packet capture (module 31) | Admin-started `pktmon`, max 60 s, filtered to one host or port, size-capped, deleted after retention. Nothing exists. |
| 12 | DISM and SFC (module 33) | Partly built: `system.checkHealth` already runs `DISM /CheckHealth`, read only (`agent/src/Cabinet.Agent.Windows/ActionOperations.cs`). Left: an SFC scan, and DISM `/ScanHealth` or repair, as Tier 2 operations with a code and a result. |
| 13 | On-demand ETW (modules 17, 33) | Deep tracing, only ever started on demand. Nothing exists. |
| 14 | WER crash-report mining | Read the Windows Error Reporting queue for crash detail the event log does not carry. Crash grouping exists; WER does not. |

## Items 15–20: fleet and management features

| # | Item | Scope |
|---|---|---|
| 15 | `updates.install` | Staged install of approved updates, with restart and verification. `updates.status` deliberately searches only; `updates.uninstall` exists. |
| 16 | Fleet update compliance + "who has KB X" | Follows 15. Which cabinets are behind; which lack a named patch. |
| 17 | AMT / vPro detection (module 27) | Detection only. Wake-on-LAN is excluded by the owner. |
| 18 | Site readiness checklist (module 38) | Per-site checklist from existing checks, on demand and scheduled; "unknown" never counts as ready. |
| 19 | Daily health snapshot + exception reports (modules 12, 44) | One snapshot per cabinet per day, with daily and weekly exception-only reports. `cabinet-health.ts`/`since-healthy.ts` exist but carry no daily snapshot. |
| 20 | Per-model scanner profiles | Profiles per scanner model (services, middleware, ports) so the platform can say "wrong scanner stack for this model". `ScannerWatch.cs` watches; it does not know models. |

## Coordination rule

One writer per file. A Codex run holding `fleet-jobs.ts` and a Claude session editing the same file interleave, and
whoever commits last wins. Before starting an item, check which run holds its files. Items 1–3 touch
`fleet-jobs.ts` / `job-lease.ts`; nothing else in this program may touch those files until item 1 has landed.
