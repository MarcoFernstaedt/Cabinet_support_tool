# Firewall inspection and governed repair

## Release boundary

The office direction explicitly includes manual per-site Windows firewall configuration, selected process stopping and preapproved repair after repeated connectivity failure. This is a deliberate extension of the original fleet specification's observation posture (§3), not permission to enable all historical maintenance code. The original separation of reachability and application sync (§§5, 19), unknown readings (§19), site authorization (§§13, 17), audit (§36) and containment (§46) still matters.

This revision ships **read-only inspection only**. It adds `InspectFirewall = 29` to the compiled observation allowlist. It does not add any firewall mutation action, scheduler, policy persistence endpoint or automatic repair loop. Existing process termination, application restart, service control, global firewall changes and generic shell execution remain unavailable in normal Debug/Release composition. Automatic repair is OFF. `Demo` and `Maintenance` configuration values cannot expand the shipping boundary.

No host or cabinet firewall was changed to build or test this feature. Linux tests use synthetic native inputs and temporary test databases. Windows 10/11 native acceptance and WPF interaction are still required.

## Operator flow

1. Open the intended cabinet and verify the persistent client/site/cabinet identity header.
2. Expand **Windows firewall**, beside Network.
3. Choose **Inspect Windows firewall**, give the audited diagnostic reason and submit. No rule name, address, port, script or enable/disable operand is accepted.
4. Poll **Refresh action results** after the agent collects its action. Accepted/dispatched is not executed.
5. Read the timestamp, overall read outcome, active profile mask, local-policy modify state, each profile's outcome and the bounded rule table. These are historical observations, not a live green health signal.
6. Treat truncated/incomplete, access-denied, unavailable and unsupported results as incomplete knowledge. A newer denied inspection replaces an older readable snapshot with an explicit unknown result. Failed actions remain in history; an older usable result remains labelled historical.
7. Investigate connectivity separately. A failed ICMP probe can be caused by routing, Wi-Fi, a stopped target, address drift, probe policy or other causes. Even repeated failures do not establish a firewall cause.

The UI offers no manual or automatic repair button. The text explaining that block is intentional, not a hidden unfinished write control.

## What the agent reads

`WindowsFirewallGateway` activates the fixed `HNetCfg.FwPolicy2` COM object. `IFirewallGateway` and `IFirewallSession` expose only reads. There is no PowerShell/netsh invocation or setter.

- Active profile mask and `LocalPolicyModifyState`.
- Domain/private/public profile enabled state, block-all-inbound flag and default inbound/outbound action.
- Up to 128 rule rows in native enumeration order: display name, configured enabled flag, profile mask, direction, action, protocol, local/remote ports for TCP/UDP and local/remote address strings.
- No rule descriptions, executable paths, application arguments, file contents, client databases or sensor reads.

The reader caps each returned string at 256 UTF-16 characters and removes control/format characters, including bidirectional override formatting. It checks cancellation and a two-second elapsed budget between profile/rule iterations. It owns/disposes the session and releases native rule/collection references. Exceptions become typed, fixed diagnostic outcomes; native exception text is not transmitted.

**The time bound is cooperative, not a hard deadline.** A single synchronous COM call can exceed two seconds, and the 30-second action timeout cannot forcibly interrupt such a call. Row and emitted-text bounds are real; CPU, COM allocation and worst-case native latency are not certified. There is no fire-and-forget timeout thread that keeps accumulating abandoned COM work. A supervised helper with a measured termination boundary would be needed before promising a hard native time bound.

At exactly 128 rows, completeness is conservatively reported as truncated rather than consuming a 129th native row. A rule read failure keeps preceding observations, marks the result partial and never claims the missing rows are absent. Overall `ActionStatus.Succeeded` means the inspection envelope was collected; `FirewallInspection.Status` describes whether Windows yielded useful facts. Denied/unavailable envelope results are deliberately visible through the same action-result transport.

## What the result does not prove

`INetFwPolicy2` exposes settings, not a complete packet-path authorization decision. Its modify-state indicator may report GPO override or inbound blocking, but this inspection does not establish each rule's policy-store source, effective local-rule merge policy, application/service/IPsec/interface constraints, third-party filtering, or the winning rule for a connection. Rule display names are not unique identifiers. A sampled/truncated table cannot authorize a repair. Enabling a profile is not equivalent to allowing a required connection, and disabling a profile is never a repair offered here.

The integrated server bounds every action-result request to 4 MiB before MVC body binding, including bodies without Content-Length. For InspectFirewall it additionally validates the structured payload before completing or storing the action: at most 1,100,000 UTF-8 bytes, version 1, valid outcome/timestamps, at most three distinct fixed profiles and 128 rules, 256-character sanitized rule fields, 1,024-character note/caveat fields and 8,000-character output. Invalid, unknown or duplicate JSON fields are rejected rather than silently truncated. Maximum escaped Unicode rows are covered by acceptance tests. This is not schema hardening for every historical action or a fleet retention policy.

In explicitly enabled office enrollment mode, connectivity and firewall transport use the persisted per-device credential and reject shared-key fallback and changed-machine impersonation. Outside that mode the legacy shared-secret limitation remains. Office lifetime/revocation limits, production mTLS and absent per-site staff grants remain separate production blockers.

## Design-only policy preview

`FirewallRepairPolicyDraft`, `FirewallRuleScopeDraft`, `FirewallRepairEvidence` and `FirewallRepairPreview` encode a small, non-executing design and its negative tests. They are not HTTP contracts, registered services, saved policy records or agent configuration. `CanExecute` is unconditionally false and every assessment includes `implementation-not-released`, even with all design attestations true. Do not connect these boolean attestations directly to request JSON or interpret them as validated authorization.

The first proposed repair surface is deliberately narrower than general firewall administration:

- One site, one cabinet and one approved immutable policy revision per operation.
- One owned local inbound allow rule, identified independently of its display name. Proposed names use `CabinetSupport.` plus bounded ASCII identifier characters.
- One exact canonical RFC1918 IPv4 local address, one exact registered same-site peer address, one TCP/UDP local port and one Domain or Private profile. No wildcards, CIDR ranges, public profile, global toggles or default-policy edits. The draft conservatively rejects `.0` and `.255` host addresses; actual subnet/address membership still needs trusted validation.
- Only the expected scoped rule may be created/restored/enabled under a separately reviewed implementation. No deletion or modification of unrelated rules, broad address/port openings, firewall disable, bulk maintenance or generic commands.
- Manual and automatic policies default OFF. Automatic policy is a separate explicit, expiring preapproval, not a consequence of turning on manual repair.

The preview rejects missing site/cabinet binding, policy revision mismatch, expired/unapproved policy, broad scope, unverified site authorization/address membership, absent manual approval or automatic preapproval, unverified exact rule drift, unknown/managed effective policy, missing durable prior state, unavailable independent recovery, missing post-verification, stale/future observations, insufficient consecutive failures and active cooldown. The draft bounds automatic thresholds to 3–100 consecutive failures and cooldown to 5 minutes–1 day, with a 30-minute default. These are proposal bounds, not currently deployed detection/repair settings.

### Required implementation before any write can be released

1. Persist versioned per-site policy with client authorization reference, exact scope, authorized cabinet identity, creator, different approver, reason, expiry and explicit manual/automatic mode. Authorization must come from trusted server grants with site isolation, not a cabinet-supplied site ID or the preview booleans. Console editing must show inheritance/overrides and a before/after scope diff. Every approval binds to the exact policy revision and invalidates on edits.
2. Enforce a new explicit compiled feature gate independently at Console request, server authorization/approval/dispatch and agent execution. Never reuse the legacy maintenance switch. Revocation, emergency containment, transfers and policy expiry invalidate queued and in-flight work before effects.
3. Inspect immediately before effect. Confirm unique native rule identity and expected complete prior state, exact local/peer address membership, current active profile, policy source, local merge permission and effective policy. GPO-managed, conflicting, ambiguous, unknown, sampled-only or concurrently changed state must refuse without effects. A rule display-name match or `LocalPolicyModifyState == 0` alone is insufficient.
4. Persist and flush a write-ahead journal containing request ID, approved policy hash/revision, rule identity, full prior state (including absence), intended single change, independent recovery instructions and expiry **before** touching Windows. Journal failure denies effects. Journal storage and rules must be administrator-owned. Record uncertain outcomes across crash, power loss or lost replies; never automatically reapply an ambiguous operation.
5. Apply only the narrow native operation after rechecking authorization and expected prior-state fingerprint. Serialize per cabinet/rule and use request-ID idempotency. No retry loop may widen scope or silently move from inspection to write.
6. Verify by independently rereading both the scoped rule and effective policy, then running the authorized same-site TCP/UDP application-path check appropriate to that rule. Ping alone is not post-verification of a port rule. Show requested, applied, verified, rolled back and unknown as separate states.
7. On failed verification, restore only the exact owned prior state after a compare-and-swap check. Never overwrite a newer operator/GPO change during rollback. A recovery path independent of the affected network and the main agent must survive reboot and journal replay. Stop and escalate on ambiguous state or failed recovery.
8. Automatic repair additionally requires a fresh server-interpreted repeated-failure condition, exact diagnosed rule drift and a still-valid scoped preapproval. Use bounded attempts, durable cooldown/attempt accounting, a circuit breaker and explicit rearm after ambiguous/failed recovery. Delayed buffered failures must not trigger a current repair. Cancellation/containment must stop effects, not just the next scheduling tick.
9. Audit policy changes, approvals, attempt/evidence references, prior/desired fingerprints, native effect and verification/recovery outcomes without database contents. Exercise Windows 10/11, domain GPO precedence, standard/service-account access, concurrency, crash recovery and connectivity loss in an authorized disposable lab before independent review releases the feature.

## Selected process termination assessment

The historical selected-process path already has important safety code, but it is **not enabled by this revision**:

| Existing component | Verified source behavior / limit |
| --- | --- |
| `ProcessProvider` and `WindowsSelectedProcessHandleFactory.OpenRead` | Collect nullable identity through a query-only retained handle. Inaccessible identities leave diagnostic rows visible but unable to form a complete selection. |
| `ProcessSelectionIdentity` and selected Console operands | PID, exact creation FILETIME transported as decimal text, observed full executable path used for comparison, and image name. Paths are not trimmed or used as launch commands. |
| `ProcessTargetPolicy` | Server/agent name allowlists, empty-list refusal, compiled protected-name refusals and self/PID 4 protection. A filename allowlist is not a code-signing or file-content identity check. |
| `ProcessControlGateway.KillSelected` | Opens one retained handle, compares PID/creation/path/name, obtains `IsProcessCritical`, checks cancellation, calls `TerminateProcess` for only that process object and waits on that same handle. No descendant termination or second PID lookup in this selected path. |
| `KillProcessExecutor` | Carries `TerminationRequested` and `ExitConfirmed`; timeout or post-termination wait failure is not reported as confirmed exit. |
| Historical approval/result flow | Synthetic acceptance tests exercise full selected identity and second-person approval through authenticated transport. These are legacy safety regressions, not permission to enable a shipping action. |

`KillProcessByName` and `RestartApplication` still use the older bulk/tree mechanism. They are not equivalent to selected-process termination and must not be enabled as a shortcut. The retained handle protects against PID reuse; it does not prove application state is safe to lose, no dispensing transaction is active, documents can be restored, or the application can be relaunched in the correct interactive user/session. Termination is irreversible as an operation; app recovery is a separate explicit workflow.

Shipping selected process stopping still requires its own reviewed feature gate, site authorization, exact approval binding, current occupancy/dispensing safety, durable evidence/unknown-outcome handling, recovery agreement and actual Windows native validation of handle rights, critical-process queries, PID reuse and exit waits. No process was stopped on this host or a cabinet during this work.

## Verification and rollback

`FirewallTransportTests` exercises the real Console command, authenticated action creation, agent dispatch, real reader/executor with injected native inputs, `AgentJson` result reporting, durable action readback and Console refresh. It also covers native denial after a readable snapshot, anonymous requests, rejected operands, foreign-machine results and malformed nested JSON. `FirewallReaderTests` covers bounded native projection, profile refusal, cooperative budget, cancellation at the last row and text sanitization. `FirewallRepairPolicyTests` are design-only refusal tests. Normal-release boundary tests continue rejecting all historical mutation actions even under old configuration values.

Build the WPF project explicitly. Linux compilation and XAML binding-source assertions do not establish native keyboard, screen-reader, DPI or Windows/GPO correctness. Manual Windows acceptance: use only an authorized synthetic lab cabinet with matching Server/Agent/Console builds; compare the three profiles and returned metadata against Windows Defender Firewall with Advanced Security, exercise denied access without changing firewall state, and verify that no write controls appear. Domain/GPO behavior needs a domain-managed disposable lab and an independent admin.

No database migration is added. The new enum value and versioned result envelope require matching office builds; older agents may reject the unknown action during polling. Do not request `InspectFirewall` from an older agent, and do not claim mixed-version fleet negotiation is implemented. To revert, cancel outstanding inspection requests before restoring the previous monitoring artifacts; keep retained mutation journals/schedules unchanged and never downgrade to a control-enabled legacy build. This feature has no firewall state to undo.
