# Two-site prototype walkthrough

This is an internal support diagnostics and governed-control prototype. It is not a customer portal. The executable walkthrough below is explicitly a **simulation**, not five running Windows cabinets. It exercises the real Agent transport and executors, ASP.NET authentication/authorization and persistence, and Console.Core commands/projections. Native Windows data collection is injected. No live server, network probe, process mutation, firewall change, customer database, sensor or door is contacted.

## Run and inspect

From this checkout on Linux, with the supported .NET SDK:

```sh
python3 tools/run_two_site_demo.py \
  --dotnet /home/marco/tmp/cabinet-audit-dotnet/dotnet \
  --output /home/marco/tmp/two-site-walkthrough-01
```

Choose a new output directory each time. The runner refuses existing paths and source-tree output. It runs the real `TwoSiteOfficeDemoTests` integration case, requires exactly one passing executed case, and leaves private evidence:

- `index.html`: open locally in a browser for the operator walkthrough. This is a static report from the completed run, not a live dashboard.
- `scenario.json`: sanitized observations and assertions, with human-facing timestamps in fixed MST (UTC−7).
- `scenario.trx`, `run.log`: actual .NET execution evidence.
- `evidence.json`: source SHA, dirty-worktree flag, command, exit code and counts.
- `sha256.json`: readback integrity hashes, not signatures.

The SDK may restore dependencies. This is not an offline dependency-distribution package. No administrator privilege is required and no service is installed.

## What the run proves

| Step | Exercised behavior |
|---|---|
| Enrollment | Five separate one-use tokens and persisted per-agent keys, pending enrollment; unapproved plan requests refused |
| Supervisor | Real sign-in, pending queue of five, explicit identity selection/confirmation, site and role assignment, approval command |
| Restart | Agent credential providers reopened from their own local state; five distinct approved cabinet IDs and keys |
| Topology | Q site: SIM-Q-SYNC, SIM-Q-02, SIM-Q-03; Second site: SIM-R-SYNC, SIM-R-02 |
| Filtering | Exact cabinet membership and totals through the authenticated Console API for each site |
| Target configuration | Explicit registered same-site private-IP target for every cabinet; cross-site target rejected and old plan preserved |
| Reachability | Unknown before evidence; three injected failures produce Unreachable; replies recover; elapsed time produces STALE / UNKNOWN |
| Buffer/retry | A real accepted evidence response is deliberately dropped; the file outbox is reopened and replayed without duplicate evidence |
| Diagnostics | SIM-Q-02 submits real process, saved event-view and firewall commands; authenticated dispatch, real executors with injected native inputs, result ingestion and Console refresh |
| Unknown data | Historical high RAM sample, unavailable CPU/SMART, old inventory, unreadable process counters, subsequent denied event read remain explicit |

The event-view case verifies channel/provider/event-ID/severity/window propagation into the native reader seam. It does not establish native Windows query behavior. One high RAM reading is not a sustained trend or deterioration detector. A ping reply is not database synchronization or effective firewall permission.

The first prototype includes firewall observation, not a firewall write. Process start/stop/restart remains disabled in this Release artifact. Historical maintenance-test success is not authority to enable it. A safe dedicated-application lifecycle needs exact identity, approval, durable outcome/recovery and independent Windows acceptance; no broad capability ceiling was removed to make the demonstration appear complete.

## Teardown and repeat

Each run owns an in-process server with a unique synthetic SQLite database and private temporary enrollment/credential/outbox directory. The test disposes the server/providers and deletes that temporary directory in `finally`; it asserts removal. The runner leaves only the sanitized evidence directory. Keep it for review or delete that exact directory when no longer needed. Never delete an installed server's consumed-token journal, revoke a real device or alter a live service as part of this walkthrough.

An abrupt OS/process kill can leave a `two-site-simulation-*` temporary directory; after confirming no test process owns it, remove only that abandoned synthetic directory. Ordinary assertion failures still run cleanup. No power-loss guarantee is claimed.

## Chronology and upgrade limits

For fresh evidence, incident time is the threshold-crossing failure timestamp when the aggregate retains it. With one prior failure followed by three failures, the threshold is the middle sample, whose exact time is absent; `IncidentObservedUtc` is therefore null while `IncidentOpen` and detection reception time remain known. No nominal-cadence timestamp is invented. Recovery is **evidenced by the latest retained reply** in the resolving interval, not necessarily the first moment connectivity returned. Do not calculate exact outage duration from these aggregates.

This demo always uses fresh synthetic configurations. The fix does not retroactively rebuild `StatesJson` from old persisted evidence. An existing installation may still show old contradictory incident history after upgrading; reusing such state is BLOCKED until a separately reviewed, bounded derived-state repair or explicit configuration reset is authorized. Raw evidence must be preserved. Nothing here upgrades or resets a real installation.

The HTTP chronology regression establishes committed SQLite rows and fresh-context readback, not a server disk restart or filesystem power-loss durability. The agent outbox close/reopen is a real filesystem exercise. PostgreSQL and native Windows acceptance remain separate.

## Windows walkthrough remains a separate gate

Build/publish success and the report do not prove installation or a usable native WPF session. Use `docs/testing.md`, `docs/office-bootstrap.md`, and `docs/office-connectivity.md` on separately authorized Windows 10/11 lab machines with matching reviewed HTTPS server, five newly generated per-device enrollment files and correct native ACLs. Verify actual enrollment/navigation, site selection, process/Event Viewer output, IP/resource/SMART availability, ICMP failure/recovery, keyboard/UIA/DPI and teardown. Never reuse expired staging tokens or disable certificate validation. Staging stays private, unsigned and non-distributable until those gates and deployment approval are satisfied.
