# Shared contracts

`CabinetPlatform.Contracts` is the only assembly the agent, server and console
all reference. It references nothing itself. Everything crossing a process
boundary in this platform is one of these types.

## Rules the types encode

**Missing is not zero.** A value that could not be read is `null`. A SMART
counter, a CPU percentage or a free-space figure that reads `0` means the
agent measured zero, never that it failed to measure. Substituting a default
for an unreadable value silently corrupts every trend built on top of it, so
it is treated as a correctness bug rather than a convenience.

**Absent is not empty.** A `null` section on `CheckInPayload` means the
collector did not produce it; an empty list means the machine genuinely has
none of that thing. When a collector fails it records why in `SectionErrors`
and leaves its section `null`, so one failing collector never costs the whole
check-in.

**Named actions, never described ones.** `ActionName` is an enum and it *is*
the allow-list. There is no field anywhere in these contracts for a command
line, a script body or SQL text, and none will be added — an action outside
the catalog cannot be represented on the wire at all. `ActionRequestDto.
Parameters` carries operands such as a service name; it never carries
something an agent would interpret as executable.

`StartupProgramInfo.Command` is the one place a command string appears, and it
travels the other way: it is something Windows already recorded, reported
inbound for a support engineer to read. The platform never executes it and
never accepts it back as input.

**Observed and Caused are structurally distinct.** `AuditEntryDto.EventKind`
is required and never nullable. "The service was found stopped" and "we
stopped the service" are told apart by a field, never by their wording, and
the kind is written by whoever creates the record rather than inferred at read
time.

**Unknown is the zero value.** Where an enum models something that may be
unreadable — `DiskHealthStatus`, `ServiceState`, `BitLockerStatus`,
`SmartSource`, `CabinetRole`, `CabinetHealthStatus` — `Unknown` (or
`Unavailable`) is `0`, so a default-initialised value can never read as
`Healthy` or `Running`. Enums that model a decision instead — `ActionName`,
`AuditEvent`, `AuditEventKind`, `AuditResult`, `ActionStatus`, `Role`,
`RegistrationStatus` — start at `1`, so a defaulted value is not a valid member
of the set. A test asserts this across every persisted enum.

**Timestamps are `DateTimeOffset` and always UTC.** There is no `DateTime` in
any contract. Local time exists only at the two edges described in
[time-zones.md](time-zones.md): the maintenance-window comparison, made in the
cabinet's zone, and the console's display, made in the reader's. The single
exception is `scheduledForLocal`, the parameter by which an update install is
specified in the cabinet's own local time — and that exception is what makes
the daylight-saving check possible at all.

**Operand names are spelled once.** `ActionParameterKeys` holds every named
operand an action can carry, and both the server's catalog and the agent's
executors read from it. They previously spelled them separately and had
drifted: four of the nine original actions were broken end to end, each
invisibly — the request arrived, the agent declined it as carrying a parameter
it does not define, and the only evidence was work that never happened. Tests
on both sides now assert that neither uses a literal.

**No hardware actuation.** Nothing here opens a drawer, releases a lock or
opens a cubie. `ActionName` reserves `OpenDrawer`, `UnlockLock` and `OpenCubie`
at 900–902 so the names cannot be claimed for anything else, and the server
refuses all three unconditionally with an audit row. Nothing implements them
and nothing is registered to run them. See invariant 8 in
[security-invariants.md](security-invariants.md).

**No biometric data.** Nothing here carries a template, an image or any other
biometric material. That an authentication happened, who it matched and how it
resolved is audit data; the biometric itself never leaves the cabinet.

## Serialization

The types are plain `System.Text.Json` shapes and need no custom converters.
Enums carry `[JsonConverter(typeof(JsonStringEnumConverter))]` so the wire form
is a name rather than an ordinal: it stays readable in an audit trail, it
survives members being added, and an unrecognised name fails to deserialise
instead of silently becoming a number.

`ContractJson` is the one options instance every component uses — the agent's
`AgentJson.SerializerOptions` *is* this instance, not a copy of its settings,
because a second set that merely looked equivalent is how two components drift
into private dialects while both keep returning 200.

`tests/CabinetPlatform.Server.Tests/CheckInRoundTripTests.cs` takes a fully
populated payload through the agent's serializer and the server's reader and
asserts nothing is lost, takes a sparse one through and asserts every absence
is still absent, and then does both again end to end over the real ingest
endpoint, reading back what the server actually persisted.

## Reserved

`CheckInPayload.CabinetData` is `object?` and is always `null` in this build.
Sensor and drawer discovery is incomplete, so the shape is deliberately not
designed yet and must not be populated with placeholder data.

`ActionRequestView.OnSiteConfirmedByUserId`, `OnSiteConfirmedUtc` and
`ExpiresUtc` are carried and never set. They belong to a future in which
something physical moves, where an authorisation granted remotely and executed
some minutes later — with nobody at the cabinet — is the failure mode to design
against. Reserving the fields now means that design starts from a shape that
already exists rather than one invented alongside the code it guards.

## Identifying a cabinet

`CabinetPath` is the one way a cabinet is named to a human anywhere in this
platform: client, site, department, cabinet name, serial number and role,
travelling together. Every search hit, list row, detail header, action request
view and confirmation dialog carries one.

Picking the wrong cabinet is the most likely serious operator error this
product has — 7,000 cabinets across 3,500 organisations produce hostname
collisions as a matter of course — so a bare hostname is never a sufficient
identifier, and the contract makes it awkward to pass one around alone.

`CabinetPath` renders three ways, and all three are on the type rather than in
any one caller: `Display` for a single line on a narrow screen, `Spoken` for a
screen reader (client first, because that is the part that disambiguates), and
`HostnameIsAmbiguous`, which a result set sets via `MarkAmbiguity` when two of
its members share a name. Ambiguity is therefore a property of the result the
rep is looking at, not of the cabinet — which is the honest statement, since the
same cabinet is unambiguous in one search and not in another.

## Payload contracts for the newer actions

`ScheduledUpdateInstallDto`, `UpdateInstallOutcome`, `ProcessActionResultDto`,
`NetworkChangeResultDto` and `EventLogViewResultDto` are the shapes the agent
returns from the process, update, network and event-log actions. Two of them
answer a question the action's status alone cannot:

- `UpdateInstallOutcome` reports what an install *did*, not that it was
  scheduled. It rides the next check-in after execution and the server turns it
  into a `Caused` audit row against the original request. A schedule accepted
  and an update installed are different facts, and the audit trail records both.
- `NetworkChangeOutcome` distinguishes `Confirmed`, `Reverted`, `RevertFailed`
  and `NotApplied`. "The action failed" is not enough when the question a rep
  urgently needs answered is whether the cabinet is still reachable, and by
  which configuration.
