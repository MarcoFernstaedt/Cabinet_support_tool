# Windows troubleshooting coverage: what the platform reads, and what is missing

Reviewed against the usual causes of a POS or biometric cabinet call. Every addition must stay inside the fixed operation catalog (a new read-only operation with a JSON Schema in `contracts/`), never a generic command or file transfer.

## Covered today

System info, performance (CPU, memory, disks, volumes), security (Defender, BitLocker, activation, pending restart, certificates), hardware identity (model, BIOS, memory, TPM, Secure Boot, last boot, displays, COM ports), domain and identity (domain or workgroup, local administrators, auto-logon user, last Group Policy time), the hosts file, services and processes, event logs (with fleet counts), crash and boot **evidence** read out of those logs (there is no dedicated crash-list or boot-history operation yet — that gap is phase 2 in [remaining-phases.md](remaining-phases.md)), devices and drivers, USB ports and the fingerprint scanner, drive health (SMART) with trends, network (adapters, DHCP, routes, ARP, DNS, packet loss, path, listening ports, firewall), time, Windows updates, installed software, startup items and tasks, sessions, shares, reliability history, power settings, DNS cache, folder sizes.

## Gaps, in priority order

| # | Gap | Why it matters on a cabinet | Proposed operation (read-only) |
|---|---|---|---|
| 1 | **Windows Update source and service health** | Update failures from WSUS or policy, stopped update or BITS services, low disk for updates | Extend `updates.status` with policy source and the health of the update services |
| 2 | **Volume integrity** | Dirty bit, file system errors, volume shadow copy and System Restore state | Extend `system.performance` volumes (dirty flag) and `system.security` (restore points) |
| 3 | **Application logs** | The cabinet application's own log is often the answer. A bounded text read is a file transfer in disguise and stays out | Not proposed. Use event-log mapping and the application's own tooling |

## Built

Hardware identity (`system.hardware`), domain and identity (`system.identity`) and the hosts file (`network.hosts`) are built as read-only Tier 1 operations with schemas in `contracts/`, agent code, stored last-known readings, fleet search, sections on the cabinet's Windows tab and demo data. They are not yet run on a real cabinet (Windows code compiles on the Linux build machine and is tested on Windows only). Notes:

- COM ports and displays are part of `system.hardware`. Displays report the monitor's native resolution from its EDID, because the service has no desktop to ask for the resolution in use.
- The WinHTTP proxy is already in `network.config`; the remaining part of the old "hosts file and proxy" idea is done.

## Decision needed

The remaining ideas above (update source and service health, volume integrity) each need a contract, Windows agent code (which can only be tested on a Windows machine, see the Windows CI job), server storage, a console section, demo data and tests. Nothing here is built until asked for.
