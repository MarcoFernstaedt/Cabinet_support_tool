# Testing a live agent

Use this after you install the agent on a real computer, to check that what the console shows is the machine's own data and not a simulation.

## On the cabinet first

Run the read-only acceptance check the installer leaves on every cabinet. Run it as SYSTEM from the remote management tool, or from
an administrator Windows PowerShell:

    & "C:\Program Files\Mashura\Test-CabinetAgent.ps1"

It checks, and prints PASS, WARN or FAIL for each:
- Windows edition, build and architecture;
- both services: installed, running, automatic, and under the right account (the broker as LocalSystem, the network service as
  `NT SERVICE\CabinetAgentNetwork`, which is not in the local Administrators group);
- the programs' signatures (a development build warns);
- the program and data folders' owner and permissions;
- the configuration and the platform CA;
- whether the platform server answers on its port;
- whether the agent wrote its log in the last 15 minutes.

The results are written to `C:\ProgramData\Mashura\CabinetAgent-Acceptance\`, with the exit code 0 when nothing failed and 1 when
something did. Send the file with any report.

## Then from the console

1. Install and approve the agent (Admin, Set up and demo, steps 2 and 3). A live cabinet is tagged **Live agent**. Simulated ones say **Demo: simulated cabinet**.
2. Open the cabinet and look at its **Overview**. Under "Test <cabinet>" click **Run the checks**. The same panel is on the Set up page, step 4. It runs thirteen read-only checks one after another and changes nothing on the machine:

   | Check | What it asks the agent | A pass means |
   |---|---|---|
   | System information | `system.info` | Host name, Windows build and agent version are the machine's. |
   | Event logs that can be read | `eventlog.channels` | At least one allowed log is listed, with its entry count. |
   | Recent System errors, Recent Application errors | `eventlog.query` | The log was read. Zero errors is a pass. |
   | Windows services | `services.list` | Services were listed. |
   | Windows firewall | `firewall.state` | All three profiles were read. |
   | Time and time zone | `time.status` | The zone and local time were read. |
   | Network adapters, leases, routes and ARP | `network.config` | A connected adapter with its address, gateway and, on DHCP, its lease. |
   | Ping the gateway | `network.test` | The gateway answered; loss and average time are shown. |
   | Resolve the platform server's name | `network.test` | The name resolved. |
   | Path to the platform server | `network.trace` | At least one hop answered. |
   | Processor, memory, drives and busiest programs | `system.performance` | Processor use, free memory, free space and busy time per drive, and the heaviest programs were read. The line names anything that looks strained. |
   | USB ports and the fingerprint scanner | `usb.ports` | The hub and port each USB device is on. On a cabinet with a scanner, the line names its port; unplug the scanner and run again: it should say it was last on that port. Plug a faulty cable in to see an "Unknown USB Device" with code 43. |
   | Ports listening and connections in use | `network.listeners` | The TCP ports the machine listens on, with the program that owns each, and how many connections are open. |

3. Open **What the cabinet sent** under a row to see the raw answer, and compare a few values with the machine: `ipconfig /all`, Event Viewer, `Get-Service`, `tracert`, Task Manager (for the performance row) and `Get-NetTCPConnection -State Listen` (for the listeners row).
4. **Copy results** puts a plain report on the clipboard. Paste it into a ticket. A failed row shows the agent's error code.
5. Open **Troubleshoot** on the cabinet, pick a symptom and run it. On a live agent, check the packet loss row against `Test-Connection <gateway> -Count 20` run on the machine itself.
6. Then try the real pages: Event logs, Network and Diagnose network, Services, Firewall and the Fingerprint scanner.

Things to know:

- The agent is version 0.2.5 or later. A 0.1.x agent doesn't have `network.trace` and returns a smaller network read, so those rows fail or show less. The diagnosis says "not traced".
- Firewalls and routers often drop the probes a path trace uses. Silent hops are normal.
- The Windows-only readers for leases, routes, ARP and card counters are the least tested part. They compile and their logic has unit tests, but they hadn't run on Windows when this was written. If a row fails there, copy the report.

## What the real-machine test found (2026-10-25)

The agent was installed **read-only** on a real Windows machine, self-updated from 0.2.4 to 0.2.5, and left running long
enough to answer the reads. Then it was uninstalled (services, program files, data, machine key) and its cabinet revoked.

- **19 of the 34 read operations answered** with the machine's own data, including the Windows-only readers: leases,
  routes, ARP, card counters, services, firewall profiles, event logs, performance, USB ports and listeners.
- **15 read operations answered `unavailable`**: `services.list`, `processes.list`, `time.status`, `system.security`,
  `software.list`, `startup.list`, `sessions.list`, `shares.list`, `reliability.list`, `disk.folders`, `power.status`,
  `system.identity`, `network.hosts`, `config.snapshot` and `system.checkHealth`. On a real cabinet, each one has to be
  checked: they are the reads whose implementations live outside the broker's network registrar, so this is the first thing
  to work through on the next real machine.
- **No write ran.** Read-only mode refused the one write that was tried (`network.flushDns`), which proves the guard, not
  the writes. Nothing about the write path has been tested on real hardware.
- **The cross-architecture refusal held**: a package built for the other architecture was refused by the cabinet, and the
  console reported `pilot_not_eligible`.
- **A self-update works end to end on a live cabinet**: the console showed the network service on 0.2.5 in read-only mode
  afterwards.

