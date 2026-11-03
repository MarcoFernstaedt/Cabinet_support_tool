# Agent Specification

## Runtime

- C# on .NET 10 (LTS), published self-contained so cabinets need no separate .NET install
- Supported on Windows 10 and 11. Not deployed to Windows 7.
- Installs to Program Files; data, queue and logs live under ProgramData. Both folders are writable only by SYSTEM and Administrators.
- The binaries are Authenticode-signed. At startup the agent checks the signature on its own files and reports any mismatch as a security event.
- Makes outbound HTTPS connections to one hostname only. Cabinets need no inbound firewall ports opened for the agent.

## Privilege separation

The agent runs as two processes, so the code that handles data from the network never has administrator rights.

- Network process: runs under a dedicated low-privilege service account. It talks to the server, parses every message, validates every command, and runs read operations that need no special rights.
- Broker process: runs as LocalSystem, because installing drivers and changing firewall and network settings require it. It never opens a network connection. It accepts requests only from the network process, over a local named pipe whose access list admits only that one service account, and only as typed operation requests. It validates each request again itself before acting.
- Read operations that need administrator rights, such as drive health data, also go through the broker.
- Why it matters: if an attacker finds a bug in how the agent parses messages, they land in a process with almost no rights. The privileged code is small, never sees raw network data, and is easy to review line by line.

## Read-only mode

The agent can be installed in read-only mode, set in its local protected configuration. In this mode it rejects every write operation, whatever the server sends. This suits clients who allow diagnostics but not remote changes. Only reinstalling or a local administrator can change it.

## Main loops

- Command loop: long poll for commands, validate, execute, post results
- Heartbeat loop: every 60 seconds against a 1.0 server; once the server sends any Protocol 1.1 field, at the interval it names (default 300 seconds; see 03-protocol.md, Protocol 1.1)
- Monitor loop: background watchers that produce events
- Event sender: drains the on-disk event queue to the server

## Command validation, in order

1. The operation name is in the catalog
2. The cabinet ID is this cabinet's
3. The command has not expired
4. The command ID has not been seen before
5. The parameters pass the operation's schema
6. For write operations: the agent is not in read-only mode, and the local write limit is not exceeded

Any failure produces a rejected result with the matching code, and nothing runs.

## Local rate limits

Enforced by the agent itself, so even a compromised server cannot flood a cabinet:

- At most 20 write operations per hour
- At most 10 network tests per minute
- At most 60 read operations per minute

## Allowed event logs

The agent reads only these logs. The list is compiled into the agent; adding a log requires a signed agent upgrade.

- System, Application and Setup
- Device and driver: Microsoft-Windows-Kernel-PnP/Configuration, Microsoft-Windows-DriverFrameworks-UserMode/Operational
- Hardware errors: Microsoft-Windows-Kernel-WHEA/Errors
- Storage: Microsoft-Windows-Storage-Storport/Operational, Microsoft-Windows-Ntfs/Operational
- Network: Microsoft-Windows-NetworkProfile/Operational, Microsoft-Windows-Dhcp-Client/Admin, Microsoft-Windows-DNS-Client/Operational
- Firewall: Microsoft-Windows-Windows Firewall With Advanced Security/Firewall
- Updates: Microsoft-Windows-WindowsUpdateClient/Operational

Never readable: the Security log, which holds sign-in and credential activity. Some channels above are turned off by default in Windows; the agent reports which ones, and whether to turn them on is a separate decision (09-open-decisions.md). Channel names are confirmed on a real cabinet during milestone 1.

## Read operations (Tier 1 and up)

- system.info: hostname, OS version and build, uptime, agent version, read-only mode, cabinet role, serial number
- eventlog.channels: every allowed log with its entry count, size, newest entry time, and whether it is turned on
- eventlog.query: entries from one allowed log, newest first, filtered by level, time range, source and event ID, 100 per page, capped at 500 per call. Returns summary fields: record ID, time, level, source, event ID, and the first line of the message.
- eventlog.get: the full detail of one entry by log and record ID: complete message, source, event ID, level, task category, keywords, opcode, process and thread IDs, computer name, every event data field, the device instance ID when the event concerns a device, and the raw event XML
- devices.list: every Plug and Play device with class, name, status, Windows error code, hardware IDs and the driver in use. Can be filtered to devices with problems.
- usb.ports: every USB hub and device Windows has a record of (root hubs, hubs and devices; the per-interface MI_ entries are left out), each with the hub and port from its registry location text (`Port_#0002.Hub_#0003`), whether it is connected now, its status and Windows problem code. Devices that were plugged in before and are not now are included with present false, which is how a scanner that has gone from its port is still tied to the port it was last on. Read-only, from WMI and the device registry; no administrator rights.
- service.setStartType (write, Tier 1 and up, click): set one service to automatic, automatic (delayed), manual or disabled. Same refused list and exact key names as service.control; a change that lets the service start (automatic, automatic (delayed), or lifting disabled) needs the same approved-list entry as a start; boot and system services are never changed; sc.exe config by full path; the new start type is read back.
- drivers.list: installed drivers with published name, original name, version, date, provider and signer
- peripheral.status: the fingerprint scanner, read as an ordinary USB Plug and Play device. The agent finds it by the hardware IDs in its local configuration and reports whether it is connected, its status and any Windows error code, and its driver name, version, date and signer.
- system.hardware: manufacturer and model, BIOS vendor, version and date, processor model and logical cores, memory size and modules (up to 32), TPM present, enabled and version, Secure Boot on, off or unsupported, last boot time, connected displays with their native resolution (up to 16), and serial (COM) ports with their device name and driver provider and version (up to 32). Read from WMI and fixed registry keys; every value the cabinet cannot read is null. Served by the broker.
- system.identity: domain or workgroup and its name, whether a domain controller can be found (domain-joined only), the names of the local Administrators group's members (up to 64, names only), whether automatic sign-in is on and the user name it uses, and when Group Policy last applied. The automatic sign-in password and every other secret are never read. Runs in the network process, which needs no administrator rights; the domain controller lookup is a network call, which the broker never makes.
- network.hosts: the entries of the hosts file (address and names), up to 500. Comments and blank lines are dropped. The path is fixed, `%SystemRoot%\System32\drivers\etc\hosts`, built inside the operation; it is not a general file read and takes no path. Served by the broker.
- updates.status: installed update history, pending updates, last check time and last install result
- disk.smart: drive health status, failure prediction flag, and reliability counters such as reallocated sectors, temperature and power-on hours
- files.list: one directory on the C drive at a time, listing names, sizes and dates, paginated. Listing only.
- network.config: every adapter with name, type such as Ethernet or Wi-Fi, connected or disconnected, link speed, MAC address, DHCP or static, IP addresses, subnet prefix, gateway, DNS servers and DNS suffix
- network.test: a ping, DNS lookup or TCP connection test to one of four target kinds only: the default gateway, a configured DNS server, the site's sync cabinet, or the platform server. TCP tests are limited to ports listed in the agent's local configuration. There are no free-form targets, so the test cannot be used to scan a client's network.
- database.connectivity: whether a SQL Server answers on the site's sync cabinet, before any login: a TCP connection, a TDS pre-login and the TLS handshake inside it, to report the server's version, whether it requires encryption, and the certificate it presents. Only the sync cabinet's address (private, on the cabinet's own network) and only ports in the agent's local configuration or the site's sync ports. No credential is ever sent, no login is made, no query runs, and it is never a connection to the cabinet application's database. Runs in the network service (it needs no rights; the broker never opens a network connection) and counts against the network test limit.
- boot.history: the cabinet's starts over 1 to 90 days (30 by default), newest first, at most 200: when Windows started, how the run before it ended (shut down, a requested restart with what asked for it, unexpected with its cause as decision-log D19, or not in the log), and how long that run lasted. Read from the System log (Kernel-General 12 and 13, User32 1074, Kernel-Power 41, EventLog 6008, BugCheck 1001) in the broker; nothing is changed.
- crash.list: the cabinet's crash dumps, metadata only. The small dumps in %SystemRoot%\Minidump (newest first, at most 50): name, time, size, and the stop code and four parameters read from each file's header (its first 4 KB; 64- and 32-bit kernel dump layouts), or why the header could not be read; and whether %SystemRoot%\MEMORY.DMP is there, with its size and time. Fixed paths only, links skipped, no parameters. No dump is copied or sent. The faulting module is not read: a small dump's header does not hold it. In the broker; nothing is changed.
- storage.health: each physical drive's bus and, for an NVMe drive, its own SMART / Health Information log (log page 02h): the critical warning bits, temperature, available spare and its threshold, rated life used, data read and written, power cycles and hours, unsafe shutdowns, media errors and error log entries. Asked for with IOCTL_STORAGE_QUERY_PROPERTY, a query only; no NVMe command is ever passed through. Each fixed volume's health, the repair Windows' own status asks for (scan, spot fix, full repair) and its dirty bit (FSCTL_IS_VOLUME_DIRTY). Drives and volumes are opened by the number and letter Windows reported, never from a command, with no read or write access. SATA SMART counters stay in disk.smart. In the broker; nothing is changed.
- firewall.state: each profile, meaning domain, private and public, with on or off, default inbound and outbound action, and any running timer; then every rule with all its fields; then the list of saved firewall snapshots

## Write operations (Tier 2 and Admin, step-up required)

Every write is one operation on one cabinet. Milestones 9 to 11 add operations, change who may run the firewall ones and set a confirmation level per operation; see 12-milestones-8-to-12.md, which takes precedence over this section where they differ.

Network:

- network.setIp: set one adapter, chosen by interface index, to DHCP or to a static IPv4 address with prefix length and gateway. All values validated strictly.
- network.setDns: set one adapter's DNS servers, up to four IPv4 addresses, or return it to automatic DNS.

Firewall:

- firewall.setProfile: turn one profile on or off and set its default inbound and outbound actions. Turning a profile off requires a duration, default 60 minutes and at most 8 hours, after which the agent turns it back on by itself. The timer is saved to disk, so it survives a reboot. Turning a profile off with no time limit is Admin only.
- firewall.setRule: create, change, enable, disable or delete one rule, including rules that already existed on the cabinet. Uses structured fields only: name, direction, action, protocol, local and remote ports, local and remote addresses, program path and profiles. No free-text rule strings are accepted. Rules the platform creates get names starting with MashuraDiag so they are easy to tell apart.
- firewall.restore: put back one of the firewall snapshots the agent saved itself, chosen by snapshot ID.

Software:

- package.install: install one package from the approved software library (05-server-spec.md). This is the only way files reach a cabinet. Two package types exist, and nothing else is accepted:
- Driver package: a zip containing the driver's INF file, its signed catalog file and its binaries. The agent checks the zip's SHA-256 hash against the command, verifies the catalog signature with Windows trust verification, checks the signer against its trusted publisher list, then installs with pnputil add-driver and install.
- MSI installer: the agent checks the hash, verifies the Authenticode signature, checks the signer against its trusted publisher list, then runs msiexec with fixed silent-install arguments. The server cannot add or change installer arguments.
- driver.uninstall: remove one third-party driver by its published name, which must match the oemNN.inf pattern, using pnputil.
- updates.uninstall: roll back one installed Windows update by KB number (`^KB[0-9]{6,8}$`), using `wusa.exe /uninstall /kb:NNN /quiet /norestart`, run by full path with an argument array. It never restarts the cabinet; when Windows needs a restart it reports `rebootRequired` and waits. Tier 2 and up, confirmed with an authenticator code, no safety net (an uninstalled update is put back by installing it again).

Not supported, on purpose: EXE installers, scripts, and any general file transfer. A vendor EXE usually contains the driver's INF files, which can be extracted and uploaded as a driver package. Anything else the agent needs on disk arrives inside a signed agent upgrade.

## Package handling on the cabinet

- Packages download into a staging folder that only the broker can write to.
- Every check runs before anything is unpacked into place: hash, then signature, then publisher.
- The staging folder is emptied after every install, whether it succeeded or failed.
- Packages are never run from anywhere else, and never kept.

## Trusted publisher list

The list of driver and software signers the agent accepts, such as the fingerprint scanner vendor and Microsoft. It is part of the agent's protected configuration and changes only through a signed agent upgrade, so a compromised server cannot make the agent trust a new signer.

## Firewall snapshots

- Before any firewall change, the agent saves the complete firewall configuration as a snapshot. The last 20 are kept.
- Every firewall write returns the before and after state of what it changed.

## Safety net for network and firewall changes

network.setIp, network.setDns, firewall.setProfile, firewall.setRule and firewall.restore can all cut the agent off from the server. After applying any of them, the agent must reach the server within 2 minutes. If it cannot, it restores the saved settings automatically and reports the rollback once reconnected.

## Change attribution

When the agent changes the firewall itself, the resulting firewall_changed event carries the command ID. The server then records it as an approved change. Changes made outside the platform carry no command ID and are reported as unexplained.

## Running external programs and Windows interfaces

- Prefer Windows programming interfaces over parsing command output: the Windows Firewall interface for firewall work, and the Windows management interfaces for network settings and devices.
- Where a program is needed, such as pnputil or msiexec, it is called by full path from System32 with an argument array, never through a shell.
- Output is captured, size-capped and parsed.
- Every call has a timeout.

## Background monitors

- Event log watcher: subscribes to Error and Critical entries in the allowed logs and queues them as error events.
- Fingerprint scanner watcher: listens for Windows device arrival, removal and status changes. When the scanner disconnects, reports an error code, or loses its driver, it queues an error event with the device's hardware ID, and another when it recovers.
- Firewall change detector: watches the firewall log channel for rule and profile changes, plus a hash of the full configuration every 5 minutes as a backstop. Any change produces a firewall_changed event with what changed.
- Firewall timer: turns profiles back on when their timer ends.
- Drive health check: reads SMART data once a day and queues a smart_warning when failure is predicted or a counter crosses its threshold.

## Local storage

- Seen command IDs, kept for the expiry window plus skew tolerance
- The event queue, size-capped, oldest dropped first if full
- Firewall snapshots and running firewall timers
- Saved settings for the safety net
- Private key and certificate in the Windows machine certificate store, with the key marked non-exportable

## Logging

The agent writes its own operational log under ProgramData with size-based rotation. It never logs secrets, tokens or package contents.

## Uninstall

A clean uninstall removes both services, the certificate and key, and the agent's data. Firewall rules the platform created stay in place unless the person uninstalling chooses to remove them, since the cabinet may depend on them.
