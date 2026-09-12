# Security invariants

Eight properties this platform is not allowed to lose. Each is stated here with
where it is enforced and which test holds it, because a property verified once
by reading the code is a property that decays.

## 1. Nothing anywhere carries a command, a script or SQL text

No type, field, endpoint, DTO or UI element accepts something a cabinet then
executes. `ActionName` is an enum and *is* the allow-list; an action outside the
catalog cannot be represented on the wire at all.

There is one command-shaped field in the whole product:
`StartupProgramInfo.Command`, the string Windows already recorded for a startup
entry. It travels inbound only, is displayed to support staff, and is never
executed or accepted back as input. Ruling 8 requires startup programs be
stored, and an entry without its command line tells nobody anything.

The server never composes SQL from text: no `ExecuteSqlRaw`, `FromSqlRaw` or
their interpolated forms exist outside the migrations. Nothing in the product
launches a process — no `Process.Start`, no `ProcessStartInfo`. That is why the
trace route is built from `Ping` with an increasing TTL rather than by shelling
out to `tracert`: the shortcut would hand the agent exactly the general
capability it is designed not to have.

*Held by* `ActionCatalogTests.Nothing_on_the_action_path_carries_a_command_script_or_query_field`,
which closes over every type reachable from a request, a dispatch or a result;
`ActionCatalogTests.The_only_command_shaped_contract_field_is_inbound_observation`,
which asserts that field is the only one and that no action path can reach it;
and `SecurityInvariantTests` for the raw-SQL and process-launch absences.

## 2. Executors resolve through a dictionary, with no default

The agent looks up an executor by `ActionName` in a dictionary and returns
`null` when there is none. No default branch, no fallback, no switch with a
default arm. An integer outside the enum resolves to nothing on both sides.

That is what makes the catalog the complete statement of what this product can
do to a cabinet. A fallback would mean an unlisted action could still reach a
machine.

*Held by* `ExecutorResolutionTests` in the agent suite — including a check over
the registry's source, because a currently-unreachable fallback is still a
fallback — and `SecurityInvariantTests.An_action_outside_the_catalogue_resolves_to_nothing`
on the server.

## 3. Default-deny, with an explicit policy on every endpoint

The fallback authorization policy is `RequireAssertion(_ => false)`. Not
"require an authenticated user", which would let any signed-in caller reach an
endpoint whose attribute somebody forgot — an unconditional refusal, so a
forgotten attribute fails closed.

Every controller action carries an explicit `[Authorize(Policy = …)]` naming a
policy the server actually defines. Two endpoints are anonymous and both are on
a reviewed list with the argument for each: `Login`, which must be reachable by
definition and is rate-limited per IP with per-account lockout behind it, and
`Refresh`, which is reached precisely when the access token has expired and
whose refresh token is itself the credential — stored server-side, hashed,
single-use, revalidated against the user's current role, elevated-SQL grant and
active flag on every exchange, with reuse of a consumed token revoking the
whole chain.

*Held by* `EndpointPolicyCoverageTests`, which fails in both directions — an
endpoint that quietly became anonymous, and a listed exemption that no longer
exists — and `SecurityInvariantTests.The_fallback_authorization_policy_denies`.

## 4. The approver is never the requester

Checked on the server, in `ActionRequestService.ApproveAsync`, before anything
else about the approval is considered. Not an assumption that the console hid
the button. A Supervisor — the highest role in the product — cannot sign off
its own request: the rule is about separation, not rank.

A Supervisor's waiver of a *safety interlock* is a different thing and does not
waive this. An override skips the maintenance window or the logged-on check; it
never skips the second pair of eyes.

*Held by* `ActionApprovalTests.Requester_cannot_approve_their_own_action` and
the concurrency suite, which proves that two approvers deciding at once produce
exactly one approval and that the loser is told.

## 5. The audit trail has no update path and no delete path

`AuditEntry` is insert-only. No repository method mutates one, no controller
exposes anything but a read, and `SupportDbContext.SaveChanges` throws
`AuditImmutabilityException` on a modified or deleted entry whatever called it.
The retention service mentions `AuditEntry` nowhere: audit records are never
aggregated and never deleted, at any age.

*Held by* `AuditTrailTests.An_audit_entry_cannot_be_modified`,
`…cannot_be_deleted`, `SecurityInvariantTests.An_audit_entry_can_only_ever_be_inserted`
— which proves it against a real database rather than by reading the override —
and `RetentionServiceTests`, which sweeps a five-year-old audit row and asserts
it survives.

## 6. A denied request still writes an audit row

A refusal is as much an event as a success. An unauthorised attempt that leaves
no trace is the bug this table exists to prevent.

Denials inside the authorization middleware — before any controller runs —
are written by `AuditingAuthorizationResultHandler` under
`AuditEvent.AuthorizationDenied`. Denials inside a controller or service are
written by the code that refuses. A history range refused for exceeding the
policy window is audited too; it was not, and that was fixed during the merge.

*Held by* `AuditTrailTests.An_unauthenticated_request_is_refused_and_audited`,
`A_Tier1_reaching_for_a_Supervisor_endpoint_is_refused_and_audited`,
`ActionSafetyGateTests`, and
`AdministrationFlowTests.A_history_range_wider_than_policy_is_refused_rather_than_clamped`.

## 7. An unapproved agent's check-in is rejected

Presenting a valid agent key proves the caller is *some* agent. It never proves
the caller is a cabinet this fleet has admitted. Every agent endpoint
authenticates and then, separately, resolves the cabinet from the database and
checks that a Supervisor approved it and that it is still active. An unapproved
machine gets 403, nothing is stored, and the attempt is audited.

A deactivated cabinet is refused by the same check, so decommissioning a
machine stops it reporting immediately rather than at the next configuration
change.

*Held by* `AgentEndpointTests.Checkin_from_an_unapproved_machine_is_refused_and_stores_nothing`,
which counts the telemetry tables before and after.

## 8. No hardware actuation exists anywhere

Nothing opens a drawer, releases a lock or opens a cubie. The action catalog —
the whole of what this product can do to a cabinet — names nothing of the kind,
and no such method exists in the agent, the server or the console.

The absence is the design. It is worth a test because the day somebody adds one
is the day it stops being reviewable by reading the diff: the change would look
like any other feature.

*Held by* `SecurityInvariantTests.Nothing_actuates_cabinet_hardware`.

## The one they all rest on

No credential, hash, token or connection string is collected, logged or written
to the audit trail. An audit trail that echoed a password would make every
guarantee above beside the point.

*Held by* `AuditTrailTests.A_failed_login_is_audited_without_recording_the_password`,
which asserts the attempted password appears in no field of any resulting
record, and `SecurityInvariantTests.No_audit_or_log_field_is_named_for_a_secret`.
