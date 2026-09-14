# Installing the cabinet agent

The agent is a .NET Worker Service that runs on each cabinet PC as a Windows
Service under `LocalSystem`, with no interactive session required.

Use an authorized disposable Windows lab machine first. Do not install this
revision on a production cabinet. Verify every path, service identity and
configuration value before running an installation command.

## What the agent is allowed to do

Worth reading before installing it on a machine that dispenses controlled
substances:

- It makes **outbound connections only**. It never listens on a port, so
  installing it opens no inbound surface on the cabinet.
- It performs **only the actions it has compiled-in executors for**, named by
  the `ActionName` enum. An action outside that list is refused. There is no
  command execution path.
- It **actuates no hardware**. No drawer, lock or cubie control exists in this
  build.
- It **reads no biometric data**, ever.
- Until the server approves the cabinet, it reports **its identity and nothing
  else** — no inventory, no logs, no diagnostics.

## Publishing

Publish self-contained so that the cabinet needs no .NET runtime installed and
a runtime upgrade elsewhere cannot change the agent's behaviour.

```
dotnet publish src\CabinetPlatform.Agent\CabinetPlatform.Agent.csproj ^
  -c Release ^
  -r win-x64 ^
  --self-contained true ^
  -p:PublishSingleFile=false ^
  -o publish\agent
```

Copy `publish\agent` to the cabinet at `C:\Program Files\Mashura\CabinetAgent`.

## Configuration before first start

Edit `appsettings.json` in the install directory, or drop an
`appsettings.Production.json` beside it. At minimum set the server address:

```json
{
  "Agent": {
    "ServerBaseUrl": "https://cabinet-support.example.org"
  }
}
```

The agent refuses to start if `ServerBaseUrl` is missing, is not absolute, or
is not `https`. It refuses at startup rather than at the first check-in, so a
misconfigured install is visible immediately instead of looking healthy and
reporting nothing.

Set the service allow-list to the services support may actually restart on this
cabinet model. It is deliberately conservative by default:

```json
{
  "Agent": {
    "Actions": {
      "ServiceAllowList": [ "Spooler", "Dnscache", "wuauserv", "BITS", "W32Time" ]
    }
  }
}
```

An **empty allow-list denies every service action**. That is intentional: an
agent that silently permitted every service because nobody configured it would
be worse than one that refuses until somebody does.

No credentials go in this file. Secrets belong in the machine's own secret
store; `appsettings.Local.json` and `secrets.json` are git-ignored.

## Verifying the collectors before installing the service

Run one collection pass only in the lab. This command can probe the configured
server and create local state and log files. It is not an offline or stateless
inspection command:

```
CabinetPlatform.Agent.exe --collect-once > payload.json
```

All log output goes to standard error, so `payload.json` is valid JSON on its
own. Any collector that failed is listed on stderr and in the payload's
`sectionErrors`.

This is the step that confirms the collectors work against **this cabinet's
actual hardware**. In particular, check that `disks[].smart` is populated and
`healthStatus` is not `Unknown`: virtual machines, RAID controllers and USB
bridges often do not expose SMART at all, and the agent reports `Unknown`
rather than inventing a clean bill of health.

Run it from an elevated prompt. The Security event log needs elevation, which
the installed service gets from `LocalSystem` but an ordinary prompt does not.

## Creating the service

Run from an elevated command prompt. The `binPath=` spacing is significant to
`sc.exe` — the space after the equals sign is required and the one before it
must not be there.

```
sc create CabinetPlatformAgent ^
  binPath= "\"C:\Program Files\Mashura\CabinetAgent\CabinetPlatform.Agent.exe\"" ^
  DisplayName= "Mashura Cabinet Support Agent" ^
  start= auto ^
  obj= LocalSystem

sc description CabinetPlatformAgent "Collects diagnostics from this cabinet and performs approved IT actions. Outbound only; no hardware control."
```

`start= auto` makes the service start at boot. `obj= LocalSystem` gives it the
rights it needs to read the Security event log, query BitLocker and SMART, and
restart services.

The service name `CabinetPlatformAgent` must match the name in `Program.cs`.

## Recovery settings

Restart on failure, with a delay, and reset the failure count daily. A cabinet
that stops reporting is invisible, so the service is configured to come back on
its own rather than wait for someone to notice.

```
sc failure CabinetPlatformAgent reset= 86400 actions= restart/60000/restart/120000/restart/300000
sc failureflag CabinetPlatformAgent 1
```

That is: restart after 1 minute, then 2, then 5 on subsequent failures, with
the count resetting after a day without one. `failureflag 1` makes the recovery
actions apply to a clean non-zero exit as well as a crash.

## Starting and checking it

```
sc start CabinetPlatformAgent
sc query CabinetPlatformAgent
```

Logs are written to `logs\agent-<date>.log` in the install directory, rolling
daily and capped at 16 MB per file with 14 files retained. They are separate
from the diagnostic data the agent collects.

On first start the agent will:

1. Derive and persist its machine id to `state\agent-state.json`.
2. `POST /api/agent/register` with that id, the hostname, the OS version and
   its own version.
3. Keep checking in on its interval, sending identity only, until somebody
   approves the cabinet on the server.

Until approval the log will repeatedly say registration is pending. That is the
expected state, not a fault.

## Approving the cabinet

Approval is a human decision made on the server, not something the agent can do
for itself. Once approved, the server returns the assigned `CabinetId`, the
agent persists it, and full check-ins begin on the next tick.

## Runtime directories

Created next to the executable, all of them git-ignored and none of them source:

| Directory  | Contents                                                        |
|------------|-----------------------------------------------------------------|
| `state\`   | Machine id, cabinet id, and the in-flight action journal         |
| `buffer\`  | Check-ins spooled while the server was unreachable               |
| `bundles\` | Diagnostic bundles produced by `CollectDiagnosticBundle`         |
| `logs\`    | The agent's own rolling logs                                     |

The spool is capped at 500 files and 64 MB by default and drops the oldest
payloads beyond that. Both limits are enforced, because a count cap alone is
defeated by a few very large payloads and a size cap alone by very many small
ones. A multi-day server outage will lose the oldest check-ins; it will not
fill the cabinet's disk.

## Upgrading

```
sc stop CabinetPlatformAgent
```

Replace the binaries, keeping `state\` and `appsettings.Production.json`. The
persisted machine id is what keeps the cabinet's identity and its audit history
continuous across an upgrade, so do not delete `state\agent-state.json`.

```
sc start CabinetPlatformAgent
```

If an action was in flight when the service stopped, the agent reports it to
the server as `UnknownResult` on restart. It does **not** re-run it. A reboot
or a service stop that was interrupted mid-flight is not something to repeat on
a guess; a person decides what to do about it.

## Uninstalling

```
sc stop CabinetPlatformAgent
sc delete CabinetPlatformAgent
```

Then remove the install directory. Deleting `state\` means the cabinet will
register as a new machine and need approving again.

## Troubleshooting

**The service starts and immediately stops.** Almost always configuration.
Check `logs\agent-<date>.log` for a validation failure naming the setting.

**`sc create` reports "The specified service already exists".** Delete it first
with `sc delete CabinetPlatformAgent`; the deletion completes only once every
handle to the service is closed, so close Services.msc if it is open.

**Every disk reports `healthStatus: Unknown`.** SMART is not exposed on that
storage stack. This is normal on virtual machines and behind some RAID
controllers, and the agent reports it honestly rather than guessing.

**`sectionErrors` names `WindowsUpdate` with a timeout.** The Windows Update
agent is slow or wedged on that machine, often because it is waiting for a
reboot. The rest of the payload still collected; check `windowsUpdate.
rebootPending`, which is read from the registry and does not depend on the COM
call succeeding.

**A service action is denied.** The service name is not in this agent's
`ServiceAllowList`. The server's permission model and the agent's allow-list
are separate checks and both must permit it.
