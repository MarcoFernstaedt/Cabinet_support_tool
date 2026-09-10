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
unreadable — `DiskHealthStatus`, `ServiceState`, `BitLockerStatus` — `Unknown`
is `0`, so a default-initialised value can never read as `Healthy` or
`Running`. Enums that model a decision instead — `ActionName`, `AuditEventKind`,
`AuditResult`, `ActionStatus`, `Role`, `RegistrationStatus` — start at `1`, so
a defaulted value is not a valid member of the set.

**No hardware actuation.** Nothing here opens a drawer, releases a lock or
opens a cubie. That absence is by design.

**No biometric data.** Nothing here carries a template, an image or any other
biometric material. That an authentication happened, who it matched and how it
resolved is audit data; the biometric itself never leaves the cabinet.

## Serialization

The types are plain `System.Text.Json` shapes and need no custom converters.
Enums carry `[JsonConverter(typeof(JsonStringEnumConverter))]` so the wire form
is a name rather than an ordinal: it stays readable in an audit trail, it
survives members being added, and an unrecognised name fails to deserialise
instead of silently becoming a number.

Both the library defaults and ASP.NET Core's web defaults (camelCase) are
covered by the round-trip tests in
`tests/CabinetPlatform.Server.Tests/Contracts`.

## Reserved

`CheckInPayload.CabinetData` is `object?` and is always `null` in this build.
Sensor and drawer discovery is incomplete, so the shape is deliberately not
designed yet and must not be populated with placeholder data.
