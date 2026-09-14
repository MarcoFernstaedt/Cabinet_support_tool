# Capability status

This snapshot describes reviewed code `6982cdd338d2faa40ec77f3b95be04e208ba625a`. It is not production approval or Windows runtime acceptance. The published `v0.1.0-demo.1` ZIP predates this snapshot and does not contain the fleet and discovery changes below.

## Fleet navigation

The Fleet tab now displays the existing site groups and their cabinets, including healthy and inactive cabinets. Client and site filters apply to these groups. The existing global finder can locate a cabinet outside those filters. Cabinet opening uses its Guid, not a potentially duplicated hostname.

The enumeration is bounded. A truncation warning means the visible groups and counts are incomplete. Large fleet rendering, keyboard use, accessibility and native WPF interaction remain unverified.

Contextual Audit uses the successfully loaded Machine identity. An independently reproduced stale selection defect now passes against the integrated revision, including navigation outside the current list filter.

## Event logs

Saved event views continue to collect records through the existing authorized action. Their results now carry optional discovery metadata for available native channel names, with readable, disabled, access denied and unavailable outcomes. Partial or truncated discovery is explicit. Existing clients can still deserialize the result without that metadata.

Discovery does not enable channels, alter audit policy or clear logs. It is bounded to 1024 examined names and a cooperative time budget. Synchronous native calls do not have a guaranteed hard timeout.

This is not yet arbitrary channel browsing. The console shows discovery summaries but has no channel picker. Record reads still use the existing saved view enum fields. Selecting a discovered vendor channel, continuation paging, full record details and additional browsing filters remain work to complete.

## Processes

The observational process snapshot workflow remains available in DiagnosticOnly mode. All mutating actions remain blocked by default.

The selected process termination agent foundation now requires PID, process name, exact creation FILETIME and executable path. It checks identity and critical status through a retained Windows handle and does not intentionally terminate unselected descendants. Missing or inconsistent identity refuses execution.

Selected termination is not operational through the current console/server. Discovery does not yet supply the identity, the console does not submit it, and the server catalogue does not accept the new operands. Older selected termination requests fail closed rather than using the unsafe fallback. Keep DiagnosticOnly enabled.

Bulk termination and existing application restart do not acquire the new guarantees. Generic approved launches, user session handling, initial state capture and a recoverable troubleshooting session remain incomplete. No CUBEX specific lifecycle or hardware operation is implemented by this change.

## Verification

The complete integrated solution passed 813 tests with zero failures or skips: Agent 398, Server 291 and Console.Core 124. Both implementation verification and independent integrated review ran the full suite. Explicit WPF compilation passed with zero warnings and errors.

Tests use synthetic Windows gateways and local API fixtures. The independent review also reran the original wrong cabinet Audit reproduction and confirmed the corrected target. None of this establishes native Windows behavior, production performance, customer authorization or deployment readiness.

Follow [the Windows checklist](testing.md) for lab acceptance and [release gates](readiness.md) for the remaining production requirements.
