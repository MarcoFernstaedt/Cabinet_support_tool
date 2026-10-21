# Windows troubleshooting coverage: what the platform reads, and what is missing

Reviewed against the usual causes of a POS or biometric cabinet call. Every addition must stay inside the fixed operation catalog (a new read-only operation with a JSON Schema in `contracts/`), never a generic command or file transfer.

## Covered today

System info, performance (CPU, memory, disks, volumes), security (Defender, BitLocker, activation, pending restart, certificates), services and processes, event logs (with fleet counts), crashes and boots, devices and drivers, USB ports and the fingerprint scanner, drive health (SMART) with trends, network (adapters, DHCP, routes, ARP, DNS, packet loss, path, listening ports, firewall), time, Windows updates, installed software, startup items and tasks, sessions, shares, reliability history, power settings, DNS cache, folder sizes.

## Gaps, in priority order

| # | Gap | Why it matters on a cabinet | Proposed operation (read-only) |
|---|---|---|---|
| 1 | **Printers and the print spooler** | Receipt and label printers are the most common POS fault: stopped spooler, stuck queue, offline printer, wrong port or driver | `printer.list`: printers, state, port, driver, default, queued jobs (count, oldest age, error state). Fix actions reuse `service.control` on Spooler |
| 2 | **Hardware identity** | Model, manufacturer, BIOS version and date, CPU model, RAM size and modules, TPM and Secure Boot state, last boot time. `system.info` has only host name, OS, serial, uptime. Needed to match drivers and spot a bad batch | Extend `system.info` (or add `system.hardware`) |
| 3 | **Domain and identity** | "Trust relationship failed", wrong domain, local administrators, auto-logon account, last group-policy run and errors | `system.identity`: domain or workgroup, secure channel result, local admin members, auto-logon user, last GPO time and status |
| 4 | **Serial and COM ports, displays** | Cash drawers and customer displays often sit on COM ports; wrong port number is a common fault | Add COM ports (name, device, driver) to `devices.list`; add monitor count and resolution to `system.hardware` |
| 5 | **Hosts file and proxy** | A stale hosts entry silently breaks sync; the WinHTTP proxy is already shown, the hosts file is not | `network.hosts`: entries only, no other file content |
| 6 | **Windows Update source and service health** | Update failures from WSUS or policy, stopped update or BITS services, low disk for updates | Extend `updates.status` with policy source and the health of the update services |
| 7 | **Volume integrity** | Dirty bit, file system errors, volume shadow copy and System Restore state | Extend `system.performance` volumes (dirty flag) and `system.security` (restore points) |
| 8 | **Application logs** | The cabinet application's own log is often the answer. A bounded text read is a file transfer in disguise and stays out | Not proposed. Use event-log mapping and the application's own tooling |

## Decision needed

Items 1 to 4 are the best value. Each needs a contract, Windows agent code (which can only be tested on a Windows machine, see the Windows CI job), server storage, a console section, demo data and tests. Recorded in `docs/spec/09-open-decisions.md` as a question; not built.
