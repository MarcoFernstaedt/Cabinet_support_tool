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
- the owner and permissions of the program folder and every file in it, and of the data folder;
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

## What the real-machine test found (2026-11-13)

The platform was reset to an empty database, a new certificate authority and empty package and release libraries, and the
agent was installed on a real Windows cabinet (a 64-bit desktop) **in read-write mode**. This run is the write half of the
sweep: every write the catalogue has that can be undone on a machine somebody is still using.

**The install failed first, and the reason matters.** The package the platform was serving could not start at all: the
broker refused `boot.history` (`System.ArgumentException: The broker may not run boot.history`), so the Broker service
stopped as it started and the install halted after the programs were laid down. Three reads the broker is registered to
serve — `boot.history`, `crash.list` and `storage.health` — had never been added to the broker's own operation list or to
the broker request contract. That was true of the trunk since 2026-11-03 and of every package built after it, so **no
cabinet could be installed from the platform as it stood**, and no test said so: the one check that guarded the list
compared it with the contract enum, which was missing the same three names. Both lists now carry them, and a new test
reads the registry the broker is actually handed and fails when it names an operation the broker may not run.

**After the fix the install was clean**: both services running, the cabinet enrolled, an Admin approved it (standalone,
baseline `capture`) and it came online in the console.

Of the 44 checks in the write sweep, **21 passed, and each one looked at the change in the machine's own state and put it
back**: `time.sync`; `network.flushDns`; `network.renewLease`; a static DNS server and then back to DHCP; a static address
and then back to DHCP; a firewall rule created, disabled, enabled and deleted; a firewall profile turned off for two
minutes and back on by itself; `power.set` across its modes; the cancel path of a restart; and the rights refusals — a
tier1 user's write is refused, and writes pause and resume.

**Eight checks are waiting on one Admin action, not on code.** `service.control`, `service.setStartType` and the
protected-process refusal all answer `this cabinet has no approved-programs list: none is set for the cabinet, its site,
its client or the fleet, so nothing can be controlled. An Admin sets one in the console under Admin > Approved programs`.
That is the intended default — nothing on a cabinet is controllable until somebody says what is — but it means no service
or process write has run on real hardware yet. One more check (`process.end notepad.exe`) also needs a process of our own
running on the cabinet to end.

**These three were this lab's technique, not the product**, and each was re-run properly and now passes:

- **package verify and package upload**: the sweep copied the fake installer into the server container, whose rootfs is
  read-only by design, so the file was never there and the check never ran. Re-run through the package volume, both
  refused it: `refused verification_failed The file is not an MSI installer.`
- **read-only mode**: the sweep flips the flag by editing `agent-config.json` by hand, which the agent refuses to run on —
  the hand-edit drops the read permission the network service's own identity needs, the agent says exactly that and tells
  the operator to run the installer again, and it started again once the installer was re-run. The supported way to change
  a cabinet's read-only mode is the console, so the sweep should stop editing the file.
- **the timed firewall window**: the sweep's call left out `defaultInbound` and `defaultOutbound`, which the schema
  requires. Called correctly, the public profile went off for two minutes and came back on by itself.

**Deliberately not run**, because a wrong answer costs a site visit or the machine: a static address (the DHCP direction
was run), releasing the DHCP lease, uninstalling a Windows update, uninstalling a driver, installing a package (needs a
second Admin's approval), a reboot (the cancel path was run) and a real firewall restore from a policy snapshot.

**The cross-architecture refusal became a policy on 2026-11-13**, at Marco's instruction, so the 32-bit agent can be
exercised on the 64-bit machine we have: `-AllowArchitectureMismatch` installs the 32-bit package on 64-bit Windows for
development and demo work, and warns in the install log what the platform will record and offer. The default is
unchanged; a 64-bit package on 32-bit Windows is still refused with no switch, because Windows cannot start it.

The refusal's own words were also wrong, and that is worth recording: it said an agent installed as the other
architecture "cannot be updated". It can. The platform follows the architecture the agent reports
(`cabinets.architecture`, migration 0007), and `releaseForAgent`, the release lookups and the rollout pilot all filter on
it, so a deliberately mismatched cabinet is offered its *own* architecture. What is true is narrower: the console's
generated installer reads this machine's Windows when it picks an archive (a 32-bit PowerShell on 64-bit Windows is the
trap it guards), so it would put the other architecture back - and that is what the switch's warning says.

**Run on 2026-11-13, and what it returned.** The 32-bit archive the console serves
(`CabinetAgent-win-x86.zip`, SHA-256 `08d46ba2…53e6c9`) was unpacked on DEVICEB, a 64-bit Windows 11 machine, and
installed over the live read-write install with `-AllowArchitectureMismatch -AllowUnsigned`:

- installer exit **0**; the warning printed as designed; cabinet ID and every setting not given in that run were kept.
- **`CabinetAgentBroker` and `CabinetAgentNetwork`: Running / Automatic**, on the 32-bit programs - the installed
  `Cabinet.Agent.Broker.exe` reads PE machine **0x014C** (i386), SHA-256 `5c1ade84…7c83`.
- the agent's own log: *the broker answers* then *connected to the platform server*.
- the platform's own record, read from the database afterwards: **`architecture` = `windows-x86`**, agent 0.3.1,
  status `active`, heartbeat `2026-11-13T03:55:38Z`.

So the mismatch is coherent, not a hole: a cabinet recorded as `windows-x86` is offered 32-bit releases and nothing
else, which is the same rule that keeps a real 32-bit cabinet updatable. A *real* 32-bit machine is still what gate 5
waits for; this run proves the agent's programs run and the platform follows them, on the hardware to hand.

**Still open after this run**: the read-only path through the console (the supported route), the approved-programs list,
and a re-check of the fifteen reads the 2026-10-25 run found `unavailable` with the 0.3.1 agent.


For development shell acceptance, see [Windows acceptance harness constraints and reviewer commands](windows-acceptance-harness.md).
