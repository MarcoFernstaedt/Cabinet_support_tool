# Testing a live agent

Use this after you install the agent on a real computer, to check that what the console shows is the machine's own data and not a simulation.

1. Install and approve the agent (Admin, Set up and demo, steps 2 and 3). A live cabinet is tagged **Live agent**. Simulated ones say **Demo: simulated cabinet**.
2. Open the cabinet and look at its **Overview**. Under "Test <cabinet>" click **Run the checks**. The same panel is on the Set up page, step 4. It runs eleven read-only checks one after another and changes nothing on the machine:

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

3. Open **What the cabinet sent** under a row to see the raw answer, and compare a few values with the machine: `ipconfig /all`, Event Viewer, `Get-Service`, `tracert`.
4. **Copy results** puts a plain report on the clipboard. Paste it into a ticket. A failed row shows the agent's error code.
5. Then try the real pages: Event logs, Network and Diagnose network, Services, Firewall and the Fingerprint scanner.

Things to know:

- The agent is version 0.2.0. A 0.1.x agent doesn't have `network.trace` and returns a smaller network read, so those rows fail or show less. The diagnosis says "not traced".
- Firewalls and routers often drop the probes a path trace uses. Silent hops are normal.
- The Windows-only readers for leases, routes, ARP and card counters are the least tested part. They compile and their logic has unit tests, but they hadn't run on Windows when this was written. If a row fails there, copy the report.
