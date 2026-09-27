# Connectivity incident queue

The Alerts navigation entry is available to signed-in Tier 1, Tier 2 and Supervisor users. It lists incidents generated from accepted connectivity interval evidence. It does not generate incidents from fabricated telemetry or retrospectively backfill old evidence.

Select an incident and check the source cabinet ID, target ID, client and site. Open source cabinet navigates by the immutable source ID, not the label or target. Enter a reason to acknowledge an Open incident. Select the refreshed Acknowledged incident and enter a reason to resolve it. Resolution is an operator annotation only; it never changes measured reachability. Include resolved and Refresh to inspect closed annotations. Use the source cabinet's audit view to read named actions and reasons.

Observed and received timestamps are distinct and displayed in fixed MST. An unavailable observation time remains unknown. The queue is a historical snapshot, not live health. Refresh explicitly; failure is displayed and stale selected rows are discarded. If a mutation response is lost, refresh before retrying because the server may have committed it. Sign-out clears the queue and cancels/discards in-flight results.

The API serves bounded pages. Queue visibility is limited to 30 days by reception time. Ingestion prunes to 200 rows per source, including unresolved rows, and deletes expired rows for that source. Sources that stop reporting can retain expired storage rows although these are hidden by the API. Immutable evidence has separate 14-day retention, so an alert can outlive its evidence row. Audit records are separate from these queue annotations.

## Migration and rollback

SQLite adds 20260920014945_ConnectivityAlerts; PostgreSQL adds 20260920014949_ConnectivityAlerts. Both are additive table/index migrations. Back up consistently before deployment. Stop the newer application before any downgrade. Alert-only downgrade drops all queue annotations but preserves existing cabinet, connectivity evidence and audit tables. Re-upgrade creates an empty queue, not a reconstruction. Do not restore older credential or consumed-token journals to reverse this feature.

A file-backed SQLite close/reopen, alert-only downgrade and re-upgrade was tested. PostgreSQL was compiled and inspected, not executed. Source rollback should revert the cohesive queue commit without reverting preceding Staff/security fixes or parent packaging work. An old server cannot provide this Console's alert API; deploy matching reviewed versions.

## Remaining acceptance

WPF cross-compilation and binding/source contracts are not native Windows QA. Windows 10/11 keyboard navigation, screen reader announcements, long labels, narrow window layout, DPI and actual interaction remain unperformed. No live deployment or real incident seeding was done. Independent review, final full regression disposition and deployment are separate parent gates.
