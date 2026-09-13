# Release gates

Status: production release blocked.

The initial audit covered all 361 tracked files at commit `35f450dde0f3430ad3e3e8119f8b1a782193896b`. Its test run passed 668 tests. The actual WPF application failed its direct build and was absent from the solution. Component repairs are in progress; this baseline is not the final release result.

## Required evidence

1. Build every executable, including WPF, from the final commit. Run all automated suites and retain the commands, exit codes and test results.
2. Complete a real Windows console workflow from cabinet selection to displayed diagnostic result. Exercise mouse, keyboard, screen reader, high contrast and stale response handling.
3. Authenticate each cabinet with its own revocable credential. Prove that one cabinet cannot report or consume another cabinet's work.
4. Prove concurrent support token refresh, logout, password change, role change and account revocation. Old authority must not remain effective after a security revocation.
5. Interrupt dispatch, execution and result delivery. Retain honest outcomes without duplicate disruptive effects.
6. Inject journal write failures, service restarts and power loss. No privileged action may start without its required durable record.
7. Test network changes with partial apply failures, timeouts, cancellation, multiple adapters and exact rollback. Retain console access independent of the changed network.
8. Test process and service controls against inert lab targets, including reused process identifiers, dependencies and user session behavior.
9. Test update occupancy, missed windows, cancellation, interrupted installation and result recovery on disposable Windows machines.
10. Implement and test display rotation with supported mode validation and automatic restoration. Hardware sensor and actuation work remains excluded.
11. Rehearse populated database upgrades and recovery on the intended PostgreSQL version. Check retention under sustained fleet load rather than a single sample per cabinet.
12. Measure idle and active CPU, memory, handles, disk growth and network use. Repeat during a prolonged server outage and stalled Windows APIs.
13. Resolve dependency advisories and review secret handling, installation ACLs, executable signing, transport certificates and deployment privileges.
14. Approve diagnostic data classification, retention, access and backup handling for each deployment jurisdiction.
15. Obtain independent security review and QA on the final revision, then written deployment approval and a rollback plan.

## Evidence rules

Record PASS, FAIL or BLOCKED for each gate with a source artifact. A missing Windows machine is BLOCKED, not PASS. A source review is not a reproduced exploit. A passing fake gateway test is not a native Windows test. Never put credentials or actual customer diagnostics into test evidence.

Keep each commit focused on a behavior or a cohesive repair. Preserve existing history. Use normal reviewed merges without force pushing. The final release record must identify the exact commit and the approved scope; a branch name is not enough.
