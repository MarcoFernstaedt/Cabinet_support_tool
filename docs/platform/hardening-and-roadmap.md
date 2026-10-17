# Hardening and roadmap, October 2026

Where the platform stands on security, what should happen before it manages real cabinets, and what would help most with everyday Windows troubleshooting. The detailed findings are in [security-review.md](security-review.md); the threat model is in [threat-model.md](threat-model.md).

## Verdict

The design is strong: a fixed operation catalog with no shell or script runner, unprivileged network process with a separate administrator broker, every input checked against its schema on the server and the agent, mutual TLS, signed packages checked on the cabinet, a hash-chained audit log, step-up codes bound to exact parameters, and a safety net that undoes changes that cut a cabinet off. Dependencies show no known vulnerabilities (`npm audit` clean on server, console and contracts).

It is **not yet "strongly hardened" for production** because the security-critical Windows code has never run on a real cabinet, release builds are unsigned, and nobody outside this project has attacked it.

## Hardening: do before real cabinets

| # | What | Why |
|---|---|---|
| 1 | Run the whole agent on one or two real Windows cabinets and test the security properties there: the broker pipe's access list, that the network process cannot reach admin actions, the installer's checks, `sc.exe`, `netsh`, `ipconfig`, `wusa`, WMI reads. | Every Windows-only path is covered by fakes on Linux, not by the real thing. |
| 2 | Get a code-signing certificate; sign the agent binaries, installer and zip. Set up the upgrade signing key in a KMS (A8, C1). | Unsigned builds are refused by the installer without `-AllowUnsigned`; production cannot use that flag. |
| 3 | Independent penetration test of the server, console, agent API and installer. | Our own red-team review found and fixed 30+ issues; a second pair of eyes finds what the first missed. |
| 4 | Review everything added since the October review: `usb.ports`, `service.setStartType` (via `sc.exe`), the drawer check, the Standards tab and its relaxed confirmations, and the demo write-limit exemption. | New code, new paths. |
| 5 | Keep demo mode off on the production server, or run the demo on its own instance. Demo cabinets are exempt from the hourly write limit and pauses; real cabinets cannot be enrolled under a demo client (S5), but a separate server removes the question. | Removes a whole class of mistakes. |
| 6 | Put the cabinet key in the TPM (A10). | A copied key file would otherwise let another machine pose as the cabinet. |
| 7 | Decide C8: may Tier 2 change or delete any Windows firewall rule by name? | A product decision still open. |

## Hardening: soon after

| # | What |
|---|---|
| 8 | Session cookie to the `__Host-` prefix (C6); pin container images by digest (C5) and CI actions by commit (C4); locked NuGet restore in the Dockerfile (C2). |
| 9 | Backups of the database and a tested restore; encryption at rest; secrets in a secret manager, never on disk. |
| 10 | Alert on audit-chain verification failure, repeated step-up failures, and an Admin sign-in from a new network, delivered somewhere people actually look (email or chat). |
| 11 | Require the authenticator for every account (done for Admin); enforce a short idle timeout on Admin sessions; document and test the emergency (break-glass) access. |
| 12 | Software bill of materials and automatic dependency updates; run `npm audit` and the NuGet vulnerability check in CI and fail the build on high findings. |
| 13 | Rate-limit and size-limit the new read operations on the agent side as well as the server; fuzz the contract validators with larger hostile inputs. |
| 14 | A second Admin approval for the two settings that can weaken every cabinet at once (client and fleet firewall policy, sync cabinet address), if the team grows beyond a few Admins. |

## Windows troubleshooting: features that would help most

Each would be a fixed, read-only or confirmed operation, never a shell.

### Reads (fast to build, high value)

1. **Printers and the print queue.** Queue contents and stuck jobs. Printing is the most common clinic complaint after the scanner and the network.
2. **Pending reboot and Windows Update health.** Whether a restart is waiting, the update error code explained, servicing-stack state.
3. **Application crashes and hangs.** Faulting application and module from Windows Error Reporting and Reliability history; the blue-screen code from the last crash.
4. **Antivirus state.** Defender on or off, definitions age, recent detections, scan in progress (a busy scan explains many "slow" calls).
5. **Disk space by folder.** The biggest folders on a full drive, so "disk is full" is answered without a remote session.
6. **Installed software and hotfix inventory** with versions, searchable across the fleet ("which cabinets have this update or driver version").
7. **Startup items and scheduled tasks.** What runs at boot and what runs on a timer.
8. **Who is signed in.** Sessions, and which are disconnected or stuck.
9. **Shares and mapped drives.** Reachability and permissions, for "cannot open the shared folder" calls.
10. **Certificates, activation, BitLocker.** Expiry dates and status, before they become outages.
11. **Network extras.** DNS cache view, per-process bandwidth, VPN adapters, DHCP lease history.
12. **The clinic application's own health.** Its services, its database port, its version and the tail of an approved log file path.

### Confirmed actions (small, bounded)

13. **Restart or shut down the cabinet**, with a delay and a message, through the existing confirmation and safety-net model.
14. **Clear a stuck print queue** and restart the spooler together.
15. **End a process** (Tier 2), with the same refused list as services.
16. **Run a Windows system file check or component health check** in verify-only mode and report the result.
17. **USB power saving and Fast Startup**: read the settings, and set them for a device or the machine. Needs the registry and power-plan decision to be answered.

### Platform and workflow

18. **Fleet search.** Ask "which cabinets have port 1433 closed, driver X, or this update missing" from stored readings.
19. **Trends, not just live numbers.** CPU, memory, disk and packet loss over days, so an intermittent fault shows up.
20. **Notifications.** Email or chat for major alerts, on-call routing, and maintenance windows so planned work does not page anyone.
21. **Case notes into Salesforce.** Today the report is copied and pasted; an integration would attach it to the case.
22. **Other peripherals like the scanner.** Receipt and label printers, card readers, touch screens and serial devices, found by class and shown with the hub and port they use.
23. **Offline cabinets.** Show the last known state and the reason it went quiet (power, network, or the agent), from the `baseline-recovery` branch's offline cache.

## Status, October 2026

Built (the Windows-only code has not yet run on a real cabinet): reads 2 to 11 (pending restart, crashes and hangs, Defender, disk by folder, software and hotfixes, startup and tasks, sessions, shares, certificates, activation, BitLocker, DNS cache); actions 13, 15, 16 and 17; fleet search over stored readings (18); load trends from heartbeats (19); last-known readings on every cabinet, shown also while it is offline (23); peripherals grouped by type of device (22, without printers).
Drive failure prediction (daily SMART history, trend rules, forecast of the system drive filling, alerts, a fleet list of drives to look at) is described in `docs/spec/09-open-decisions.md`.
Not built, by decision: printers and the print queue (1, 14), email or chat notifications, Salesforce (20, 21). Still open: the clinic application's own health (12), per-process bandwidth, VPN adapters and DHCP lease history (part of 11).

## Suggested order

1. Real-cabinet pilot and the security tests on it (items 1, 4, 5).
2. Signing and the penetration test (2, 3).
3. Printers, pending reboot, application crashes, Defender, disk by folder (reads 1 to 5).
4. Restart the cabinet and clear the print queue (actions 13, 14).
5. Notifications and fleet search (19, 20).
