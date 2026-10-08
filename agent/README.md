# Cabinet agent

The agent from docs/spec/04-agent-spec.md, built through Milestone 5. It runs every read and write operation, either locally from a command file or from the platform server, and watches the cabinet in the background.

To connect it, the agent first enrolls with a one-time bootstrap token. It keeps its private key non-exportable in the Windows machine key store, and trusts only the platform CA the installer places on the cabinet. Once approved, it sends heartbeats every 60 seconds, long-polls for commands and renews its certificate. Every server command still goes through the agent's own six checks.

## Two services

| Service | Account | What it does |
| --- | --- | --- |
| `CabinetAgentNetwork` | `NT SERVICE\CabinetAgentNetwork` (virtual account, not an administrator, one privilege) | Validates commands and runs the reads that need no rights. Refuses to start as an administrator. |
| `CabinetAgentBroker` | LocalSystem | Runs reads that need administrator rights (event logs, Windows Update status, SMART and files.list), and every write. Has no network code. |

They talk over the named pipe `Mashura.CabinetAgent.Broker`. Each of three locks is enough on its own:

1. The pipe's access list admits only the network service's account and SYSTEM, and denies network logons.
2. Every caller's account is checked again before the broker reads a byte.
3. Every request is validated against `contracts/schemas/agent/broker-request.schema.json`. That schema admits only the six broker reads, the seven writes (each with its command ID) and the safety-net confirmation, with their parameter schemas.

## Writes (Milestone 5)

All writes run in the broker (`src/Cabinet.Agent.Core/Writes`, `src/Cabinet.Agent.Core/Packages`, with the Windows parts in `src/Cabinet.Agent.Windows`).

- **Network and firewall writes** go through WMI and the firewall COM API. `netsh` is used only to export and import whole-firewall snapshots. Programs are launched only from System32 by full path, with argument arrays.
- **The safety net.**
  - Each network or firewall change is recorded in `Broker\safety-net.json` before it is made.
  - The network service confirms it only after the server has accepted the result. Without confirmation within 2 minutes, the broker puts the old settings back, newest first. This holds across a restart or reboot.
  - The command then reports `safety_net_rollback`, and a security event is raised.
- **Firewall.**
  - The last 20 snapshots are kept, along with profile timers that turn a profile back on (also across a reboot).
  - A journal ties each change to its command, so the firewall monitor reports it as the platform's change, not an outside one.
- **Packages.**
  - The network service downloads an approved package into `Downloads`. The broker copies it into `Staging`, which only SYSTEM and Administrators can reach, and checks it there in order:
    1. the SHA-256 hash;
    2. the signature (the driver catalog or the MSI's own), and that every driver file is listed in the catalog;
    3. the publisher, against the trusted list built into the agent;
    4. Windows' own WinVerifyTrust.
  - Only after every check passes does it run `pnputil /add-driver … /install` or `msiexec /i … /qn /norestart`.
  - The staging folder is always emptied. A failed check reports exactly which one (`hash_mismatch`, `signature_invalid`, `publisher_not_trusted`).
- **Read-only cabinets** refuse every write in the command checks, before anything reaches the broker.

## Signed upgrades and the self-check (Milestone 7)

docs/spec/07-upgrade-channel.md. Code in `src/Cabinet.Agent.Core/Upgrades`, with the Windows parts in `src/Cabinet.Agent.Windows/Upgrades.cs` and the updater in `src/Cabinet.Agent.Updater`.

- **What the agent trusts** is compiled in from `contracts/trust/upgrade`: the release signing key (and at most one future key) and the code-signing publisher with its pinned root. The server has no say. A test build can compile in another folder with `-p:UpgradeTrustDir=…`; release builds never do.
- **An upgrade.**
  1. The server offers a version in its heartbeat answer.
  2. The network service downloads the manifest, its signature and the zip into `Downloads\agent-<version>`, then asks the broker to install that version. The request carries the version only, never a path.
  3. The broker copies everything into `Staging\upgrade` and checks, in order: the manifest's signature, the zip's hash, the version, then Authenticode and the publisher on every binary. Any failure is reported with its exact check.
  4. The broker records the release in `Broker\upgrade.json` and starts the updater from a copy in `Broker\updater`.
  5. The updater stops both services, moves the program folder to `CabinetAgent.previous`, puts the new version in place and starts the services.
  6. It waits up to 5 minutes for the new network service to check in (`State\check-in.json`, written after each heartbeat that reaches the server). Otherwise it puts the old version back and starts it.
  7. The network service reports the outcome after the restart.
- **Interrupted upgrades.** Every step is journaled first. If power is lost mid-upgrade, the broker restarts the updater at start-up to finish or undo it.
- **Self-check.** At start-up and daily, the network service checks the Authenticode signature of every binary in its program folder against the pinned publisher, and sends a `self_check` security event for any mismatch. A build with no publisher compiled in (a developer build) says it cannot check itself.
- **Making a release:** `install/Publish-CabinetAgent.ps1 -Version x.y.z`, sign the binaries, then `install/New-AgentRelease.ps1` (signs through AWS KMS or Azure Key Vault). `install/New-UpgradeTrust.ps1` writes the trust folder.

## Background monitors

The network service runs these on its own and queues what they find (`src/Cabinet.Agent.Core/Monitoring`). They only read; none of them can change the cabinet.

| Monitor | How often | Raises |
| --- | --- | --- |
| Event logs | every 2 minutes, through the broker | each new Error or Critical entry in an allowed log |
| Fingerprint scanner | every 60 seconds | when the scanner is disconnected, has no driver or shows a device error, and again when it recovers |
| Drive health | daily, through the broker | early signs of failure (SMART counters, wear, heat), and again only if they get worse |
| Firewall | every 5 minutes, and at once on a firewall-log change event | any change to profiles or rules |

Events wait in `State\events.jsonl` (at most 5,000, oldest dropped first) and are sent oldest first, 100 at a time, with backoff while the server is unreachable. The scanner's hardware IDs come from the console with each heartbeat answer and are kept in `State\monitor-settings.json`.

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

The monitors' logic (the event queue, scanner states, drive trends, firewall differences and event-log bookmarks) is tested on any OS with hostile and damaged input. The Windows tests read each monitor's real source and check that every event it raises passes the contract.

The `agent-windows` CI job runs the Windows tests. It then installs both services and checks the following:

- Both services run under the right accounts.
- An administrator cannot open the broker pipe.
- Every read operation succeeds through the installed services.
- Sending the same commands again is refused as a replay.
