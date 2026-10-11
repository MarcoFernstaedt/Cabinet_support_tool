# Status report, October 2026

Where the platform stands against the October 2026 requirements, each item labelled:

- **Verified**: implemented and verified by automated tests (and, where it says so, in a real browser).
- **Not verified**: implemented, but not yet run where it matters (real Windows, the VPS).
- **Partial**: some of it is built; what is missing is named.
- **Not implemented**, or **Blocked** (waiting on a decision or on something outside the code).

Test counts at the time of writing: contracts 520, agent contracts 692, agent core 384, server 189 (including 7 browser end-to-end test files with Playwright and Chromium, and runs against a real agent process). All pass. The Windows CI job is not running while GitHub Actions minutes are unavailable, so nothing Windows-only has been run on Windows recently.

## Is the demo ready?

Yes, for a demonstration on the VPS:

- Demo mode turns on from Settings (with an authenticator code) and adds 101 simulated cabinets in Arizona, California, Texas, New York and other states, next to the real ones.
- Every scenario A to E is there, with a guided tour and a scenario library, and fixes made on simulated cabinets take effect.
- A real laptop can be enrolled and used next to them.

Before showing it to customers or relying on it for real cabinets, do three things:

1. Run the Windows parts on a real Windows machine: the installer, the broker, time zone changes, Windows Time and service control.
2. Restore GitHub Actions minutes so the Windows CI job runs again.
3. Sign the agent package with a code-signing certificate.

## Demo mode

| Deliverable | Status | Notes |
|---|---|---|
| Demo mode in Settings: on, off, reset | Verified | Admin only, with an authenticator code bound to the change; browser test turns it on and off |
| Guided tour and instructions | Verified (server), partly in browser | Tour steps resolve to the current demo cabinets; the demo guide page lists every scenario |
| Scenario library | Verified | `/api/demo/scenarios`, shown on the demo guide |
| Deterministic fleet, AZ, CA, TX, NY | Verified | 101 cabinets, 4 clients, 15 sites; the same every time it is turned on or reset |
| Isolation from real cabinets | Verified | Real cabinets are never answered by the simulator, never filed under a demo client, and never deleted with it |

## Scenarios

| Scenario | Status | What it shows |
|---|---|---|
| A: fingerprint scanner | Verified | Disconnected scanner with reconnects; a scanner service that will not stay running, fixed with Restart |
| B: network | Verified | A sync cabinet's firewall blocking its satellites (Diagnose network finds it, the fix is offered); site baselines; whole-site diagnosis with one-click and bulk fixes read back from each cabinet; DHCP lease renewal (`network.renewLease`, in the agent, contracts, server and demo; not yet run on a real Windows cabinet) |
| Cabinet alerts and bulk selection | Verified in the simulated fleet | A USB-device-missing alert that stays on its cabinet; bulk changes limited to one site with the cabinets ticked by hand and their IPv4 addresses shown. The agent monitor that reports "no USB device on any port" is not written yet (see 13-roadmap) |
| C: time zones, with bulk correction | Verified, in the browser too | Wrong zones in Arizona, California and Texas and a drifting clock in New York; corrected from Fleet operations with the password, each cabinet verified |
| D: storage | Verified | A drive predicting failure, with bad blocks and retried reads raised before it dies |
| E: mass blue screen, about 60 cabinets | Verified | 60 of 80 cabinets crashed after a driver update, 12 still restarting; the driver stands out, the update does not |

## Operations and onboarding

| Deliverable | Status | Notes |
|---|---|---|
| Simulated operations with progress, per-cabinet results, state changes | Verified | Through the same server paths and contracts as a real agent |
| Fleet operations: select any cabinets, jobs, verification, staggering, partial failure, password | Verified | Time zone to site, clock sync, firewall policy; up to 200 cabinets; resumes after a restart |
| Live agent onboarding without demo mode | Verified with the test agent; Not verified on Windows | Setup page, download, install command, approval |
| Windows Time checks (`time.status`, `time.setZone`, `time.sync`) | Verified in the agent's logic and the simulator; Not verified on Windows | `tzutil` and `w32tm` by full path; only seven allowed zones |

## Evidence

| Deliverable | Status | Notes |
|---|---|---|
| Layered evidence collection | Verified (logic); Not verified on Windows | Event watcher, change watcher, boots, crash timeline; first look reads 30 days of crash, storage and hardware evidence |
| Reboot-loop detection that tells causes apart | Verified | A crash loop, a cabinet simply offline, and a whole site offline each give a different alert |
| Crash dump limits and minidump upload | Blocked | Needs the safeguards in 09-open-decisions.md confirmed (Admin only, encrypted, 30 days, audited) |
| Evidence packages with hashes and provenance | Verified | Per cabinet; tampering is detected; every export audited with its hash |
| Fleet incident evidence in one package | Not implemented | The incident page's case notes cover it for now |

## Data

| Deliverable | Status | Notes |
|---|---|---|
| Data classification | Verified (documented) | [data-classification.md](data-classification.md) |
| Retention per class | Verified | Events, command results, alerts, firewall history, diagnoses, boots, fleet jobs; the audit log is never pruned |
| Local buffering on the cabinet | Verified | 5,000-event queue, flood limit, events kept while the server is away |
| Server quotas | Verified | 3,000 events per cabinet per hour; request size limits; bounded incident queries |

## Security

| Deliverable | Status | Notes |
|---|---|---|
| STRIDE threat model | Verified (documented) | [threat-model.md](threat-model.md) |
| Red-team review and fixes | Partial | [security-review.md](security-review.md): every high and medium finding fixed or partly fixed, except the Docker lock files (C2) and TPM keys (A10), which are open |
| Agent security | Verified (logic); Not verified on Windows | Fixed catalog, broker checks of its own, no shell |
| Fleet operation security | Verified | Password bound to the exact job; limits and pauses; one write per job |
| Tenant isolation | Not implemented, by design | Everyone signed in supports every client; the work needed is recorded in 09 |
| Demo isolation | Verified | |
| Secrets | Verified | None in the repository or logs; sealed or hashed in the database |
| Audit | Verified | Hash chain, daily check; reads of cabinet data are not audited one by one (accepted) |
| Supply chain | Partial | npm and NuGet audits clean, lock files; images pinned by tag, not digest; the agent package is unsigned |
| Automated security tests | Verified | Hostile input on every route and contract; role, confirmation and limit tests |

## Reliability and scale

| Deliverable | Status | Notes |
|---|---|---|
| Outage behaviour | Verified | The agent keeps events while the server is away; jobs resume after a restart; a pause mid-job stops further changes; a cabinet that never answers fails on its own |
| Scale at 10, 60 and 100 affected cabinets | Verified against the simulator | Clock sync jobs: 10 in about 0.4 s, 60 in about 0.7 s, 98 in about 1.1 s, every reachable cabinet verified. The agent API was load-tested earlier with 8,000 simulated agents (performance.md) |
| Real-network timing | Not verified | Real cabinets answer within their poll interval and verify on their next heartbeat (up to a minute) |

## Not started from the module list

The remaining work, including emergency offline access, is planned milestone by milestone in [milestones.md](milestones.md).


Restarts and Windows update installs (decided, not built), support call mode, site readiness, drift baselines, registry and environment reads, packet capture and the other phase 5 and 6 modules in [13-roadmap.md](../spec/13-roadmap.md).
