# Security invariants

Nine properties this platform is not allowed to lose. Each is stated here with
where it is enforced and which test holds it, because a property verified once
by reading the code is a property that decays.

Two of them changed shape when process management arrived and when the hardware
scaffold was reserved. Neither was relaxed: invariant 1 became narrower and
sharper, and invariant 8 moved from "the names do not exist" to "the names exist
and are arranged so nothing can run them". Both changes are written out below,
because an invariant that is quietly rewritten to match the code is not an
invariant.

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
their interpolated forms exist outside the migrations.

### The launch surface

Support needs Task Manager equivalence, so `RestartApplication` does now start
something. That is the one launch in the product, and the invariant it lives
under is therefore stated in terms of what would make a launch dangerous rather
than as a blanket absence:

- **No shell and no interpreter.** `cmd`, `powershell`, `pwsh`, `wscript`,
  `cscript`, `rundll32`. Any of these is arbitrary execution by definition,
  whatever is passed to it.
- **No command-line utility standing in for an API.** `taskkill`, `netsh`,
  `sc`, `wmic`, `reg`, `ping.exe`, `tracert`. Each of these appearing would
  mean somebody reached for a process where a typed interface existed, which is
  how a general mechanism gets reintroduced by accident. It is why the trace
  route is built from `Ping` with an increasing TTL, why services go through
  `ServiceController` and `Win32_Service.ChangeStartMode`, why the network
  actions go through `Win32_NetworkAdapterConfiguration`, and why a process is
  killed through `System.Diagnostics.Process` rather than `taskkill`.
- **No shell resolution.** `UseShellExecute = true` appears nowhere, so no PATH
  lookup, no file associations, no URL schemes.
- **No arguments.** Arguments are the payload a launch would carry. The one
  launch passes none, and nothing sets `Arguments` or `ArgumentList` anywhere.
- **One call site.** Every `Process.Start(` in the product is in the agent's
  `IProcessControlGateway.cs`, and the count is asserted, not just the location.
  One call site can be read in a minute; five scattered ones are a general
  mechanism nobody noticed growing.

What it launches is not a command line either: `RestartApplication` takes an
application *name* from a server-side allow-list, and the agent resolves that
name to an absolute install path registered in its own configuration. A request
cannot supply a path, and a path that is not Windows-absolute is refused.

*Held by* `ActionCatalogTests.Nothing_on_the_action_path_carries_a_command_script_or_query_field`,
which closes over every type reachable from a request, a dispatch or a result;
`ActionCatalogTests.The_only_command_shaped_contract_field_is_inbound_observation`,
which asserts that field is the only one and that no action path can reach it;
`SecurityInvariantTests.The_server_never_executes_SQL_it_composed_from_text`;
`SecurityInvariantTests.Nothing_in_the_product_starts_a_process`, which now
forbids the five properties above rather than the method name; and
`SecurityInvariantTests.Only_the_agents_process_gateway_launches_anything`,
which pins the call-site count at one.

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

## 8. No hardware actuation happens, and the reserved names prove it

Nothing opens a drawer, releases a lock or opens a cubie. No method in the
agent, the server or the console does so, and no DLL is loaded or called.

What changed is that the three names now exist. `OpenDrawer`, `UnlockLock` and
`OpenCubie` are reserved in `ActionName` at 900–902 so that nobody can later
claim them for something else, and so the refusal is a property with a test
rather than an absence with a comment. Every gate around them is set to its
most restrictive value at once:

- Each is marked `IsReservedHardwareActuation` in the catalog, and
  `ActionRequestService.PrepareAsync` refuses on that flag **first**, before
  role, approval, safety interlocks or anything else is considered. There is no
  ordering in which some other check could pass one through.
- The refusal writes an `AuditEvent.HardwareActuationRefused` row recording
  whether the actor held the `HardwareActuation` grant — so an attempt is
  visible whether or not the grant had been given.
- No executor is registered for any of the three in the agent's registry, and
  invariant 2 says an unregistered name resolves to nothing. Even a request
  that somehow reached a cabinet would find nothing to run it.
- A Supervisor is refused exactly as a Tier1 is. Rank does not enter into it.

The `HardwareActuation` permission is a real, separately grantable claim with
its own audit events on grant and revoke, and it is consumed by nothing. It
exists so the day actuation is built, the permission it needs already has a
history and a shape, rather than being invented in the same diff as the code it
guards.

The hardware interfaces — `IDrawerController`, `ILockController`,
`ICubieController`, `ISensorReader` — declare read methods only, asserted by
reflection over their members rather than by review. The single registered
implementation, `NullHardwareAdapter`, returns `HardwareAvailability.Unavailable`
from all eight reads.

`ActionRequest` carries `OnSiteConfirmedByUserId`, `OnSiteConfirmedUtc` and a
short `ExpiresUtc`. All three are unused today. They are there because an
actuation that is authorised remotely and executed minutes later, with nobody
at the cabinet, is the failure mode this product must never have.

*Held by* `SecurityInvariantTests.Nothing_actuates_cabinet_hardware`, narrowed to
actuation verbs now that the names are legitimately present;
`…The_reserved_actuation_actions_are_arranged_so_nothing_can_run_them`;
`…The_hardware_interfaces_only_read`;
`…The_shipped_hardware_adapter_reports_everything_unavailable`; and
`ActionApprovalTests.A_reserved_actuation_action_is_refused_for_a_supervisor`.

## 9. A critical Windows process is never a target

`KillProcess`, `KillProcessByName` and `RestartApplication` are checked against a
deny-list before they are checked against anything else: `system`, `smss`,
`csrss`, `wininit`, `winlogon`, `services`, `lsass`, and the agent's own process.
Killing `lsass` bluescreens the machine; the rest are various shades of the
same.

The list is enforced twice and independently. The server consults it in
`CriticalProcessDenyList` during parameter validation, *before* the allow-list,
so a name that somehow appeared in both is still refused. The agent consults its
own compiled-in copy in `ProcessTargetPolicy` when the action arrives, so a
server that was misconfigured, downgraded or impersonated does not get a kill it
should not have. Neither copy defers to the other.

Two properties sit alongside it:

- **The agent refuses to kill itself**, by process name *and* by process id, and
  refuses process id 4 outright. A kill of the agent would leave a cabinet with
  no way back short of a site visit.
- **An empty allow-list denies everything.** A missing or blanked configuration
  section is the state a misconfigured deployment is actually in, and the safe
  reading of "no processes are listed" is "no process may be targeted", not "any
  may".

`KillProcess` takes a process id *and* the name the requester expected, and the
agent re-reads the live name for that id and refuses on any mismatch. Windows
reuses process ids; between a rep reading a list and approving a kill, the id
they are aiming at can belong to something else.

*Held by* `ActionParameterPolicyTests` on the server side and
`ProcessExecutorTests` in the agent suite, which covers the mismatch refusal,
the self-kill refusal by both name and id, and the empty-allow-list case.

## The one they all rest on

No credential, hash, token or connection string is collected, logged or written
to the audit trail. An audit trail that echoed a password would make every
guarantee above beside the point.

*Held by* `AuditTrailTests.A_failed_login_is_audited_without_recording_the_password`,
which asserts the attempted password appears in no field of any resulting
record, and `SecurityInvariantTests.No_audit_or_log_field_is_named_for_a_secret`.
