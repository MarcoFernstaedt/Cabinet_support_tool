# Retired office cabinet-to-cabinet ICMP

This page describes a **retired** observational prototype, not a procedure to enable probes. No live cabinet-to-cabinet ICMP monitoring is authorized by this slice. See `docs/office-bootstrap.md` for office enrollment; office authentication and check-in are independent of peer reachability.

## Current boundaries

- The shipped Agent does not register the scheduled `ConnectivityWorker`; its connectivity plan contains no targets and an empty revision even if historical target configuration exists. The retired `PingCabinet` action is not advertised or available through the execution-policy catalog and has no registered Agent executor, including in the historical maintenance-test build. This does not claim to retire generic host probes or every other network diagnostic action.
- `PUT /api/connectivity/cabinets/{id}/targets` returns **410 Gone** for an authorized Supervisor. `POST /api/agent/connectivity/summaries` returns **410 Gone** for an authorized enrolled Agent, including retries of old IDs. A legacy `/api/actions/cabinets/{id}/test-sync-link` request and a direct `PingCabinet` action request return **410 Gone** for an authorized support user. They do not dispatch or generate new peer observations. Authentication and role checks still precede these responses: anonymous requests get 401; a Tier 1 target PUT gets 403; a staff bearer is not an Agent credential and gets 401 on Agent routes.
- Existing configuration, interval evidence, link state and alert rows are **not deleted**. The status, history, chronology and alert read paths still project retained records and identify their historical observation/reception timestamps. A retained failure or firewall-profile clue is not proof of current reachability or firewall causation. No new rows are accepted through the retired ingestion route; retention behavior for already-stored evidence must not be inferred from old ingestion-triggered pruning documentation.
- The earlier plan-refresh lease, interval outbox, three-miss classification and WPF panel descriptions were behavior of the old opt-in prototype. Do not follow earlier target-configuration or manual ping acceptance instructions. No replacement read-only firewall inspection is implemented by this retirement; it requires separate design, authorization and native Windows validation.

## Verification and release limits

In-process Linux tests can verify refusal, enrollment and historical read projection. They do not certify native Windows service behavior, network effects, PostgreSQL concurrency, browser or WPF usability, security of device credentials, or production installation. A full release requires independent review and native acceptance. Do not run experiments on dispensing/customer cabinets or alter firewall rules to demonstrate this retirement.

## Rollback

Do not roll back to an older build that schedules peer ICMP without an explicit safety review: historical configurations remain in storage and an older server/Agent could consume them. For an authorized migration, preserve and back up the historical evidence before any schema change. This slice adds no destructive migration and does not purge historical rows.
