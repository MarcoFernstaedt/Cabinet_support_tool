# Testing a live agent

How to confirm a freshly installed agent is doing the real thing, not demo data.

1. Install and approve the agent (Admin → Set up and demo, steps 2 and 3). A live cabinet says **Live agent** next to its name; demo cabinets say **Demo: simulated cabinet**.
2. Open the cabinet, **Overview**, and click **Run the checks** under *Test <cabinet>*. (The same panel is on the Set up page, step 4.) It runs these read-only operations one after another and never changes the machine:

   | Check | Operation | A pass means |
   |---|---|---|
   | System information | `system.info` | The host name, Windows build and agent version are the machine's own. |
   | Event logs that can be read | `eventlog.channels` | At least one allowed log is listed, with its entry count. |
   | Recent System / Application errors | `eventlog.query` | The log was read (zero errors is a pass). |
   | Windows services | `services.list` | Services were listed. |
   | Windows firewall | `firewall.state` | All three profiles were read. |
   | Time and time zone | `time.status` | The zone and local time were read. |
   | Network adapters, leases, routes and ARP | `network.config` | A connected adapter with its address, gateway, and (on DHCP) its lease. |
   | Ping the gateway | `network.test` | The gateway answered; loss and average time are shown. |
   | Resolve the platform server's name | `network.test` | The name resolved. |
   | Path to the platform server | `network.trace` | At least one hop answered. |

3. Open **What the cabinet sent** under any row to see the raw answer. Compare a few values with the machine itself (`ipconfig /all`, Event Viewer, `Get-Service`, `tracert`).
4. Click **Copy results** and paste the report into a ticket. A failed row shows the agent's error code; an operation the agent does not know (an older agent) shows as failed with that reason.
5. Then use the real pages: **Event logs** (browse and open entries), **Network → Diagnose network** (the layered check, the full read, the path), **Services**, **Firewall**, **Fingerprint scanner**.

Notes:

- The agent is version 0.2.0. A 0.1.x agent has no `network.trace` and a smaller `network.config`; those rows fail or show less, and the diagnosis says "not traced".
- Windows firewalls and routers often drop the probes a path trace uses. Silent hops are normal and are not a failure of the agent.
- The Windows-only readers (leases, routes, ARP, adapter counters) are the least tested part: they compile and have unit tests for their logic but had not run on Windows when this was written. If a row fails there, copy the report.
