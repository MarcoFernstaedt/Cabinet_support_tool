# Restricted process demo mode

The default remains `DiagnosticOnly`. An explicit, case-sensitive `Demo` value permits the four observational actions (`GetProcessList`, `CollectEventLogs`, `RunEventLogView`, `GetScheduledUpdates`) plus `KillProcess`. It does not enable `MaintenanceEnabled`. Unknown values continue to permit only observations.

For an authorized disposable lab only, configure `Actions__ExecutionMode=Demo` on the server and independently configure `Agent__Actions__ExecutionMode=Demo` on the agent before starting each component. Do not replace either with `Maintenance` to make an unavailable control appear. Default diagnostic setup instructions in `demo.md` remain observational.

## Boundaries

* The server filters the catalog and checks requests and approvals with its compiled mode allowlist. Queued actions are checked again at agent collection. In Demo, selected termination operands are revalidated before dispatch so old PID-only requests are cancelled rather than forwarded.
* The agent dispatcher independently uses its local compiled mode allowlist before invoking an executor. Server configuration cannot change that local decision. A Demo server with a DiagnosticOnly agent produces a denied termination result without opening a process handle.
* The existing selected-process executor requires PID, exact creation FILETIME, observed executable path and expected process name. Local process allowlisting, self/critical-process protection and retained-handle identity checks remain in force. Only the selected process is targeted, not descendants or all processes sharing its name.
* Existing role, second-person approval, occupancy and durable result controls remain unchanged. Demo is not an approval bypass.
* Legacy bulk process termination, application restart, service changes, update installation, network changes and reboot actions remain unavailable. Scheduled installs and startup network rollback stay suspended outside Maintenance; their stored records are retained. An outstanding network rollback requires on-site attention, not automatic changes under Demo.
* `Maintenance` semantics are unchanged. No interactive application launch action or contract is introduced by this change.

## Evidence and limits

`SelectedProcessAcceptanceTests` exercises real authenticated Console API creation, second-person approval, server dispatch, the actual agent dispatcher and selected executor, result ingestion, persistence and Console refresh under Demo. Only native process inputs and handles are synthetic. Tests cover exact identity, PID reuse, path mismatch, inaccessible identity, local allowlist denial, critical processes, default-agent mismatch and unconfirmed exit outcomes. Policy tests exercise queued legacy actions, approval refusal and persisted schedule/recovery suppression.

This does not establish native Windows 10/11 process behavior, WPF interaction, or a complete Notepad launch/stop/restore demo. Those remain separate acceptance gates. Do not update or publish a ZIP until the parent integrator has verified the entire demo, including Notepad.

To roll back the configuration, stop the lab components and restore `DiagnosticOnly` on both before restarting. Persisted scheduled work and network rollback records remain present; switching to Maintenance can make those effects eligible again.
