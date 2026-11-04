# Cabinet Diagnostics Platform: status report

**As of 4 November 2026.** Main at `7979c04`. The work started on 1 October 2026.

Every figure here says whether it was **measured** (and where) or **worked out**. Nothing is an estimate presented as a measurement.
The detailed sources are [remaining-phases.md](remaining-phases.md), [performance.md](performance.md), [cost.md](cost.md),
[readiness.md](readiness.md) and the [decision log](decision-log.md).

---

## Summary

- **The platform works end to end and has run on real hardware.** A support person can see a cabinet, diagnose it, and fix it
  safely from the console, with every action audited. Agent 0.3.1 on a real 64-bit Windows 11 machine answered **35 of 35** reads,
  and the reversible writes worked.
- **The build spec is complete; the roadmap is not.**
  - Milestones 0 to 12 are done, and so is roadmap phase 1 (the demo).
  - Roadmap phases 2 to 6 remain. Phases 2 and 3 are mostly built, 4 and 5 partly, and 6 mostly not.
  - About **58 to 63 pull requests** are left (worked out, one per remaining item).
- **It is cheap to run and has been load-tested at fleet size.** 8,000 simulated cabinets ran against one small server with
  **0 failed requests**. Running 8,000 to 10,000 cabinets costs about **$30 to $85 a month**.
- **Six things outside the code block a live clinic.** The biggest are:
  - real release-signing certificates;
  - an independent penetration test;
  - access to the cabinets' own network.

  None needs engineering to start; each needs a purchase, a vendor or access.
- **Risk to watch:** GitHub Actions has been blocked by account billing, so CI has not run. Every PR is checked with the full local
  suite instead, but the Windows-only code is only proven when someone runs it on a Windows machine.

---

## Key metrics

### Delivery

| Metric | Value | Basis |
|---|---|---|
| Duration so far | 5 weeks (1 Oct to 4 Nov 2026) | git history |
| Commits on main | 588 | measured, `git log` |
| Pull requests | numbered up to #155 | GitHub |
| PRs merged in the last 7 days | 44 | measured, merge commits on main since 28 Oct |
| Open PRs awaiting review | 2 (#153 storage health, #155 crash monitors) | GitHub |
| Recorded decisions, each with its reasons | 20 (D1 to D20) | decision log |
| Code | about 95,000 lines (TypeScript, C#, SQL; generated files excluded) | measured |

### Capability

| Metric | Value | Basis |
|---|---|---|
| Operations in the fixed catalog | 55: 37 reads, 18 writes (56 with #153) | measured, `catalog.json` |
| Build milestones | 13 of 13 (0 to 12) | remaining-phases.md |
| Roadmap phases | 1 of 6 complete; phases 2 to 3 mostly built | remaining-phases.md |
| Supported Windows builds | 64-bit and 32-bit | built; the 32-bit build has not been run on a real 32-bit machine |

### Quality

| Metric | Value | Basis |
|---|---|---|
| Server tests | 878 pass, 0 fail | measured at a0f7567 (#155), 4 Nov |
| Agent tests | 879 pass, 0 fail | measured at a0f7567 |
| Contract checks | 1,168 pass, 0 fail | measured at a0f7567 |
| Console tests | 91 pass, 0 fail | measured at a0f7567 |
| Real-hardware reads | 35 of 35 (2 Nov); 34 of 34 (30 Oct) | product test and hardware test |
| Defects from the hardware and product tests | 10 of 11 fixed; 1 is a host task (install the nightly backup job) | remaining-phases.md |
| Bug-fix rule | every fix ships with a test that fails without the fix | house rule; shown in each PR |

### Performance and cost

| Metric | Value | Basis |
|---|---|---|
| Fleet size tested | 8,000 simulated cabinets, each with its own certificate | measured (performance.md) |
| Requests in the test | 177,332, **0 failed**, every command delivered | measured |
| Heartbeat time after ramp-up | p95 10 to 15 ms | measured |
| Server memory and CPU at 8,000 | about 1.4 GB, about 40% of one core | measured |
| Monthly running cost, 8,000 cabinets | about $30 to $65 | worked out from list prices (cost.md) |
| Monthly running cost, 10,000 cabinets | about $45 to $85 | worked out from list prices |
| Database licence | $0 (SQL Server Express) | decided |
| First capacity limit | Express's 10 GB cap, about month 8 to 12 at 10,000 cabinets | worked out; cheap options listed in cost.md |

---

## What is done

- **Fleet and cabinet view.**
  - Enrolment with Admin approval, sites and clients.
  - Cabinet replacement that carries the old cabinet's settings across.
  - Configuration baselines with drift detection.
  - A fleet-wide reading search.
- **Diagnosis.**
  - One-click network diagnosis with ranked findings, evidence and a suggested fix.
  - Cabinet diagnosis.
  - Crash investigation: boots, reboot loops, blue screens with their stop codes, and the timeline of what changed before them.
  - Drive-failure prediction with risk classes.
  - Incidents opened and closed by diagnoses.
- **Safe fixes.**
  - 18 typed write operations, each with a role, a confirmation level and an hourly limit.
  - Fleet jobs that run across many cabinets with per-cabinet results.
  - Approved software only, verified by hash, signature and publisher on the cabinet itself.
- **Alerting.** Rules that map Windows events to issues, with severity, suppressions and claims; scanner, service, firewall and
  drive watchers on the cabinet.
- **Security.**
  - Two-factor sign-in for everyone, and step-up codes bound to the exact action.
  - A tamper-evident audit chain.
  - Mutual TLS between agent and server.
  - An agent that can run only the operations in its fixed catalog.
  - A threat model and a security review.
- **Operations.**
  - Signed agent upgrades with staged rollout and rollback.
  - A demo mode with simulated cabinets.
  - A guided product tour.
  - A deployment kit for a single server.

---

## What is left

### Product work: about 58 to 63 PRs (worked out)

| Phase | What it adds | PRs |
|---|---|---|
| 2: blue screens, storage, drivers | Faulting module of a crash, crash signatures across the fleet, power-loss detail, incident response mode, the crash incident page, the drivers and services engine | ~9 |
| 3: network, services, boot, updates | Process signer, service dependencies, app-crash correlation, boot and recovery, update install and compliance, scanner profiles, preflight checks, the sustained connection check | ~19 |
| 4: support call and remediation | Symptom playbooks and support-call mode, the case report, before-and-after snapshots, site readiness, preventive-maintenance reports | ~10 |
| 5: configuration and agent health | Restoring chosen settings, registry reads and writes, software lifecycle, agent health in the console, self-recovery, maintenance windows | ~10 |
| 6: advanced and fleet intelligence | Bottleneck findings, DISM and SFC repair, packet capture, failure rates per driver, update and model, health scoring | ~10 |
| Open fixes | Demo start time, the CI installer hash check, one intermittent console test | ~3 |

**How long it takes is set by review, not by building.** At the last week's pace (44 merged), the remaining work is about **2 to
3 weeks**. That is worked out, not a commitment: each PR currently gets one careful review round, and that round has found real
defects (four in the last day, all fixed with tests).

### Outside the code: 6 gates before a live clinic

| # | Gate | Who | Cost or effort |
|---|---|---|---|
| 1 | Release-signing certificate (today releases use a development key) | Purchase | about $100 to $400 a year |
| 2 | Agent keys held in the cabinet's TPM | Engineering, after gate 6 | small |
| 3 | Independent penetration test | Vendor | quote needed |
| 4 | The remaining writes run on real hardware (static IP, restart, uninstall, package install, service control) | Test session on a Windows machine | about a day |
| 5 | A real 32-bit cabinet | Access to one | about an hour once available |
| 6 | Reachability of the cabinets' own network | Client IT | decision and access |

---

## Risks and decisions needed

| Risk | Effect | Mitigation or ask |
|---|---|---|
| CI blocked by GitHub account billing | Windows-only code is not proven per PR; reviewers re-run suites by hand | **Ask:** restore Actions billing. Until then the full local suite runs on every PR, and the PR says what was not proven |
| Windows-only code since the last hardware test | Reads added since 2 Nov (crash dumps, storage health) are tested on Linux only | One hardware session covers them together with gate 4 |
| Database size limit | Express stops growing at 10 GB | Cheaper retention settings first; documented in cost.md |
| Single server | A restart briefly drops all connections | Agents reconnect with backoff; a second process can be added later |

**Decisions waiting on leadership**
- **Short-uptime limit** for the reboot-loop monitor: set to 20 minutes, worked out, not measured (D20). Confirm or change.
- **Gates 1, 3 and 6** above need a purchase, a vendor and client IT respectively.

---

## How this report was made

- The figures come from the repository at main `7979c04` and the latest PR heads, the measured load test in performance.md, and
  the list prices in cost.md.
- The test counts are from full local runs on 4 November, because CI could not run.
- The PR estimate and timeline are worked out from the remaining-phases list and the last week's merge count.
