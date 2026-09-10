# The cabinet agent

`CabinetPlatform.Agent` runs on each cabinet PC. It collects diagnostics, sends
them to the server, and performs the small set of routine IT actions the server
approves. Installation is in [agent-install.md](agent-install.md).

## Shape

```
Worker  (timer loop: collect, deliver, poll, wait)
  |
  +-- CheckInBuilder ---- ICollector x7 ---- IWmiRepository / IRegistryReader /
  |                                          IEventLogReader / IProcessProvider /
  |                                          IWindowsUpdateGateway / ...
  |
  +-- IServerClient ------ IPayloadBuffer (capped disk spool)
  |
  +-- ActionDispatcher --- ActionExecutorRegistry --- IActionExecutor x9
```

Everything is registered in DI in `AgentServiceRegistration`. There is no static
state and no service locator. Every Windows API the agent touches sits behind an
interface, which is what lets each collector and executor be constructed in a
test with fixtures in place of WMI.

## Collectors

Each is one `ICollector`. `CheckInBuilder` runs them all, catches each one's
exceptions against its section name in `SectionErrors`, and returns a complete
`CheckInPayload` regardless. A partial payload is worth much more than none: if
the Windows Update COM surface hangs, that is itself a symptom worth seeing,
alongside the disk and event-log data that collected perfectly well.

| Collector       | Sources |
|-----------------|---------|
| System          | `Win32_OperatingSystem`, `Win32_ComputerSystem`, `TimeZoneInfo.Local`, `Win32_LogonSession` joined to `Win32_LoggedOnUser`, both registry uninstall paths |
| Performance     | `Win32_PerfFormattedData_PerfOS_Processor`, `Win32_OperatingSystem`, `Win32_PageFileUsage`, `System.Diagnostics.Process`, `Win32_StartupCommand` |
| Services        | `Win32_Service` |
| Disks           | `MSFT_Volume` (falling back to `DriveInfo`), `Win32_EncryptableVolume`, `MSStorageDriver_FailurePredictStatus` and `MSStorageDriver_FailurePredictData` |
| EventLogs       | `EventLogQuery` with an XPath level and time filter |
| WindowsUpdate   | Windows Update Agent COM API, plus registry for reboot-pending and policy |
| Network         | `NetworkInterface`, `MSFT_NetFirewallProfile`, WinINET registry, HTTP HEAD probe |

Two collection details are worth knowing because getting them wrong is
invisible:

**Both uninstall paths are read.** `HKLM\...\Uninstall` and the `WOW6432Node`
path. Reading only the native one returns a tidy, short and badly wrong
inventory that omits every 32-bit application — which on a cabinet is most of
the clinical software.

**Rates need two samples.** Processor and per-process CPU are both rates. The
collector takes a baseline, waits, and samples again. One sample of a cumulative
counter says how busy a process has been over its whole life, not how busy it is
now; this is the same reason a `PerformanceCounter`'s first read is always zero.

## SMART decoding

The most error-prone code here, and the hardest to notice when wrong, so it is
isolated in `SmartAttributeDecoder` and covered directly by tests.

`MSStorageDriver_FailurePredictData.VendorSpecific` is the drive's raw 512-byte
SMART structure. The first two bytes are a revision word; the attribute table
starts at **offset 2** and holds up to 30 fixed **12-byte** records:

```
+0   attribute id      (1 byte, 0 means unused slot)
+1   status flags      (2 bytes, little-endian)
+3   current value     (1 byte, normalised)
+4   worst value       (1 byte, normalised)
+5   raw value         (6 bytes, little-endian)
+11  reserved          (1 byte)
```

Two mistakes are easy to make and nearly undetectable afterwards: starting the
table at offset 0, which shifts every attribute by one record and reports
plausible numbers for the wrong attributes entirely; and reading the raw value
as 4 bytes rather than 6, which is correct for most drives right up until a
power-on-hours count exceeds 32 bits. Both have tests.

Attributes mapped: `0x05` reallocated sectors, `0xC5` pending sectors, `0xC6`
uncorrectable, `0x09` power-on hours, `0xC2` temperature. Temperature reads the
**low byte only** — drives pack lifetime minimum and maximum into the upper
bytes of the same raw field, so reading all six gives values in the thousands.

An attribute the drive did not report is `null`. Nothing substitutes zero for a
value it could not read: on a reallocated-sector count, zero is the reading that
means the drive is fine.

`DiskHealthEvaluator` then derives:

- **Failing** — the drive predicts its own failure.
- **Watch** — reallocated, pending or uncorrectable sectors above zero.
- **Healthy** — something was read and everything read was clean.
- **Unknown** — SMART was unreadable. Never `Healthy` by default.

## Identity

`MachineId` is a SHA-256 hash of `Win32_ComputerSystemProduct.UUID`, falling
back to the motherboard serial from `Win32_BaseBoard`, persisted to
`state\agent-state.json`.

Never the hostname. Cabinet hostnames get renamed during clinic re-imaging and
are routinely duplicated across sites; an identity built on one would silently
merge two cabinets' histories, which in a DEA-audited system is a records
integrity problem rather than an inconvenience. Known non-unique OEM UUIDs are
rejected too.

The persisted id wins over a freshly derived one, so a cabinet keeps its
identity and its history through a warranty motherboard swap.

## Registration and approval

On first run the agent posts to `/api/agent/register` and persists whatever the
server returns. Until the server approves the cabinet and returns a `CabinetId`,
every tick sends an **identity-only payload**: no collector runs and nothing
diagnostic leaves the machine. That is the agent's own half of "reports nothing
usable until approved" — it does not depend on the server rejecting the payload.

The agent never assumes approval and never retries its way past a refusal. It
also refuses to start reporting if the server says "approved" but returns no
cabinet id.

## Delivery

**The spool is capped on both axes.** A cabinet checking in every five minutes
produces nearly three hundred payloads a day. Unbounded, a long-weekend server
outage would fill the disk of every cabinet in the estate — a tool bought to
prevent outages causing one, on a machine that dispenses controlled substances.
Both a file count and a total size are enforced, because either alone is
defeated: a few very large payloads pass a count check, and very many small ones
pass a size check. Oldest are dropped first, and the drop is logged as the gap
in the record that it is.

**The interval is jittered and failures back off to a ceiling.** A clinic's
cabinets share a power circuit and boot within seconds of each other after an
outage. Without jitter they would check in in lockstep forever after, delivering
a whole site's payloads in the same second of every interval. Backoff has a
ceiling for the mirror-image reason: unbounded growth would silence a cabinet
for days after a brief outage, and no growth at all would have the whole estate
hammering a server that is already struggling.

## Actions

One `IActionExecutor` per `ActionName`, resolved through a dictionary keyed by
the enum. **An action with no registered executor returns `Denied`.** There is
no generic executor, no interpretation path and no default branch — adding an
action means writing a class and shipping a build, which is the property that
makes the catalog auditable.

Implemented: `ScanForUpdates`, `ScheduleUpdates`, `CollectDiagnosticBundle`,
`FlushDnsCache`, `RenewDhcpLease`, `RestartService`, `StartService`,
`StopService`, `RebootMachine`. Nothing else.

Every executor re-validates its parameters even though the server already did.
That is not redundancy for its own sake: it is what keeps a compromised or
simply buggy server from steering the agent outside its catalog. A request
carrying a parameter the action does not define is denied, because an unexpected
parameter means the agent and server disagree about what was asked for.

`FlushDnsCache` calls `DnsFlushResolverCache` rather than running `ipconfig`.
The difference is not stylistic: shelling out would give the agent a general
mechanism for launching programs, and its safety rests on not having one.

**Service targets are checked against the agent's own allow-list** as well as
the server's. Two independent checks fail independently. An empty allow-list
denies everything.

**Reboot is refused while anybody is signed in**, unless the request carries an
explicit supervisor override — and refused outright if the agent cannot
determine whether anybody is signed in. Somebody standing at a cabinet may be
part-way through pulling a controlled substance against a patient record. An
unnecessary refusal costs a support call; the alternative costs an interrupted
dispense. Only interactive logon types (2, 10, 11) count, since a cabinet runs a
dozen service logons at all times.

**An action in flight when the agent stops is never resumed.** On restart it is
reported as `UnknownResult` and the journal is cleared. The agent cannot know
whether the reboot completed or the machine lost power a moment earlier;
re-running it would be guessing, and reporting success or failure would be
asserting something unknown into a DEA audit trail. A person decides.

## Verifying against real hardware

```
CabinetPlatform.Agent.exe --collect-once > payload.json
```

Runs every collector, prints the payload it would send, and exits. No network
call, no change to the machine. Log output goes to stderr so stdout is valid
JSON on its own.

This is how the collectors are checked against a specific cabinet's hardware —
particularly SMART, which depends entirely on the storage stack in front of it.

## Tests

```
dotnet test tests/CabinetPlatform.Agent.Tests/CabinetPlatform.Agent.Tests.csproj
```

The agent targets `net8.0-windows` because it reads WMI, the registry, the event
log and the service control manager. The tests target the same framework and
still run on non-Windows CI, because the code under test reaches Windows only
through injected interfaces.

That is a deliberate design property rather than a convenience: a collector that
called WMI from a static helper could only be tested on a cabinet, which in
practice means it would not be tested.
