# Cabinet agent

The agent from docs/spec/04-agent-spec.md, built through Milestone 2. It runs every read operation, either locally from a command file or from the platform server.

To connect it, the agent first enrolls with a one-time bootstrap token. It keeps its private key non-exportable in the Windows machine key store, and trusts only the platform CA the installer places on the cabinet. Once approved, it sends heartbeats every 60 seconds, long-polls for commands and renews its certificate. Every server command still goes through the agent's own six checks.

## Two services

| Service | Account | What it does |
| --- | --- | --- |
| `CabinetAgentNetwork` | `NT SERVICE\CabinetAgentNetwork` (virtual account, not an administrator, one privilege) | Validates commands and runs the reads that need no rights. Refuses to start as an administrator. |
| `CabinetAgentBroker` | LocalSystem | Runs reads that need administrator rights: event logs, Windows Update status, SMART and files.list. Has no network code. |

They talk over the named pipe `Mashura.CabinetAgent.Broker`. Each of three locks is enough on its own:

1. The pipe's access list admits only the network service's account and SYSTEM, and denies network logons.
2. Every caller's account is checked again before the broker reads a byte.
3. Every request is validated against `contracts/schemas/agent/broker-request.schema.json`. That schema admits only the six broker reads and their parameter schemas.

## Command checks

Checks run in the order the spec gives:

1. The operation is in the catalog.
2. The command is for this cabinet.
3. It has not expired.
4. It has not been seen before.
5. Its parameters pass the schema.
6. For writes: the agent is not in read-only mode and the write limit has room.

Rate limits are 60 reads a minute, 10 network tests a minute and 20 writes an hour. The code is in `src/Cabinet.Agent.Core/CommandValidator.cs`, and every rejection code has a test in `tests/Cabinet.Agent.Core.Tests`.

## Layout

| Path | Contents |
| --- | --- |
| `src/Cabinet.Agent.Contracts` | C# types for the shared JSON Schemas |
| `src/Cabinet.Agent.Core` | Validation, replay store, rate limits, broker protocol, scanner checklist, network tests. Portable. |
| `src/Cabinet.Agent.Windows` | Windows executors and the locked pipe |
| `src/Cabinet.Agent.Broker`, `src/Cabinet.Agent.Network` | The two services |
| `src/Cabinet.Agent.Harness` | `cabinet-harness`, the local test harness |
| `install/` | Publish, install and uninstall scripts |
| `tests/` | Contract tests and core tests (any OS), and Windows tests (Windows only) |

## Try it on a Windows machine

Run these in an elevated PowerShell, from the repository root:

```powershell
./agent/install/Publish-CabinetAgent.ps1
./agent/install/Install-CabinetAgent.ps1 -EnableLocalHarness
$h = "$env:ProgramFiles\Mashura\CabinetAgent\Cabinet.Agent.Harness\cabinet-harness.exe"
$cfg = "$env:ProgramData\Mashura\CabinetAgent\agent-config.json"
& $h sample --config $cfg --out commands.json        # one command for every read operation
& $h drop --commands commands.json --out results.json # through the installed services and the real pipe
& $h make --config $cfg --operation peripheral.status --out scanner.json
& $h drop --commands scanner.json
& $h probe-broker                                     # prints OK: your account cannot open the broker pipe
```

To connect the cabinet to a platform server (see server/README.md for the server side):

```powershell
./agent/install/Install-CabinetAgent.ps1 -PlatformServerHost <server> -PlatformServerPort 8443 -PlatformCaFile platform-ca.pem -BootstrapToken <token>
```

Once the client supplies the scanner and sync details, reinstall with them:

```powershell
./agent/install/Install-CabinetAgent.ps1 -ScannerHardwareId 'USB\VID_xxxx&PID_xxxx' -SyncCabinetAddress <ip> -AllowedTcpPort <port>
```

Use `-ReadOnly` to refuse every write whatever the server sends. To remove the agent, run `./agent/install/Uninstall-CabinetAgent.ps1 -RemoveData`.

Logs are in `C:\ProgramData\Mashura\CabinetAgent\logs`. They hold command IDs, operation names and outcomes only, never parameters or output.

## Tests

```bash
dotnet test agent/tests/Cabinet.Agent.Contracts.Tests   # any OS
dotnet test agent/tests/Cabinet.Agent.Core.Tests        # any OS
dotnet test agent/tests/Cabinet.Agent.Windows.Tests     # Windows, as an administrator
```

The `agent-windows` CI job runs the Windows tests. It then installs both services and checks the following:

- Both services run under the right accounts.
- An administrator cannot open the broker pipe.
- Every read operation succeeds through the installed services.
- Sending the same commands again is refused as a replay.
