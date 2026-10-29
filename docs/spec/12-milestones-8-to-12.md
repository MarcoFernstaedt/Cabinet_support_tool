# Milestones 8 to 12: faster fixes, deeper diagnostics, proactive monitoring

Requested in October 2026, after milestone 7, the per-client device settings and the repository review. This file is the specification for that work. Where it changes an earlier rule, the earlier file says so and points here. Decisions and their reasons are also in 09-open-decisions.md.

The goal stays the same: support staff find and fix cabinet problems without remote desktop and without searching by hand, and the platform notices problems before a client calls.

## Milestone 8: housekeeping (done)

- The earlier C# demo (`src/`, `tests/`, `tools/` and its documents) is removed; git history keeps it.
- The agent targets .NET 10 (LTS, supported to November 2028). .NET 8 support ends on 10 November 2026.
- Agent packages are locked (`packages.lock.json` in every project). CI restores in locked mode.

## Milestone 9: confirmation levels, the client firewall policy, bulk changes

### Confirmation levels (replaces "every write needs a code" in 02-security-model.md control 8)

Speed matters on the support desk. Most fixes are one click on one cabinet, and the platform already has a safety net, firewall snapshots, write limits and a full audit trail. Confirmation is therefore matched to the risk:

| Level | When | What the person does |
|---|---|---|
| Sign-in | Everyone, every role | Password **and** authenticator code at sign-in. Every account, Tier 1 included, sets up an authenticator at first sign-in. The "require for everyone" setting no longer exists, because it is always on. |
| Click | Single-cabinet changes that are quick to undo or self-healing: firewall profile on/off, applying the client firewall policy, firewall rules, starting/stopping/restarting a service, flushing DNS, renewing DHCP, restarting an adapter, setting the network category | A confirmation dialog that names the cabinet and the change. No code. |
| Code | Single-cabinet changes that are rare and can strand or alter a cabinet: static IP / DNS servers, installing a package, removing a driver, restoring a firewall snapshot; every rule change and admin action | A fresh authenticator code, bound to the action, the target and the exact parameters. |
| Password | Any change to more than one cabinet at once (bulk) | The person's password again, bound to the action, the scope and the exact parameters. Wrong passwords count toward the account lock, like sign-in. |

Every confirmed token is single use, valid for 2 minutes, and bound to `sha256(canonical JSON of the parameters the person saw)`. Canonical JSON means keys sorted at every level and no spaces. A token for one change cannot be used for another change on the same cabinet. Each operation's level is in the catalog (`confirm: "click" | "code"`), so the agent, server and console all read it from one place. The level is enforced by the server.

### Roles (changes 02-security-model.md control 7)

- **Tier 1** gains firewall profile changes and applying the client firewall policy, on one cabinet or in bulk. This includes turning profiles off with no time limit. Everything else Tier 1 can do stays read-only.
- **Tier 2 and Admin** keep every write. Turning a profile off with no time limit is no longer Admin only. Allow-all inbound rules are no longer Admin only: anyone who may turn the firewall off may also open it.

### The client firewall policy

Most satellite-to-sync connection problems are solved by turning the Windows firewall off on the cabinets. That is now the default:

- Each client has a firewall policy: for each of domain, private and public, either `off` or `on`. The default for every client is all three `off`. An Admin can change a client's policy (with a code), for example for a client whose IT requires the firewall on.
- The heartbeat now carries each profile's on/off state (`firewallProfiles`). The server compares it with the client's policy. When a cabinet differs, the cabinet page shows it, and a **minor** alert "Firewall differs from client policy" opens for that cabinet. The alert closes on its own once the cabinet matches again. Read-only cabinets are compared but never changed.
- **Apply policy** (Tier 1 and up, click level) issues `firewall.applyPolicy` to that one cabinet. The browser never sends the profile values: the server fills them from the client's policy, as it already does for the sync cabinet's address. The change goes through the usual firewall snapshot and safety net. Profiles set off by the policy have no timer: the policy *is* the intended state.
- **Bulk apply** (Tier 1 and up, password level): from a site or a client, apply the policy to every online, writable cabinet that differs from it. At most 200 cabinets at a time. The write pause is respected, and each cabinet's own write limit still applies. The bulk counts as **one** write toward the person's hourly limit. It is audited as one `bulk.firewall_policy` entry listing every command, plus each command's own entry. The console shows each cabinet's result as it arrives.
- The policy is never applied automatically. The platform shows drift and a person applies the policy with one click, so every change still has a person behind it.

### Damage limits (changes control 10)

"No bulk writes" becomes: the only bulk write is applying a client's own firewall policy, with password confirmation, at most 200 cabinets, within the write pause.

## Milestone 10: services and processes, and watched services

### New read operations (Tier 1)

- **services.list**: every Windows service, with:
  - name, display name, state (running, stopped, starting, stopping, paused) and start type (automatic, delayed, manual, disabled);
  - the account it runs as and its process ID;
  - the executable path, without arguments (arguments can carry secrets);
  - the service's description, up to 512 characters;
  - its recovery settings: the first three failure actions and the reset period.

  It runs in the broker.
- **processes.list**: every running process, the Task Manager view: process ID, name, executable path (without arguments), CPU percent over a one-second sample, working-set and private memory, thread and handle counts, start time, session ID, and the owning account name. Command lines are never read. It runs in the broker (only an administrator can read other accounts' processes).

### New write operation

- **service.control**, click level, Tier 2 and up: `start`, `stop` or `restart` one service by its name (`^[A-Za-z0-9_.\-]{1,80}$`). The agent refuses:
  - its own services, which can only be changed by a signed upgrade;
  - services whose start type is Disabled, because starting one would quietly change a cabinet's configuration;
  - remote-access services, which stay off unless an administrator is at the cabinet. The list is compiled into the agent: TermService, UmRdpService, SessionEnv, RemoteRegistry, WinRM, RemoteAccess, sshd, TlntSvr, vncserver and the common VNC services.

  service.control never changes a start type; service.setStartType (Tier 1 and up, one click) does, for automatic, automatic (delayed), manual and disabled only. It applies the same refused list and exact key names, asks the approved list (13-roadmap.md, milestone 10) for any change that lets the service start, never touches driver (boot and system) services, goes through sc.exe config by full path with an argument array, and reads the result back. The watcher still never changes a start type, and it starts a watched service only when that service is also on the approved list.

### Watched services

Some cabinet software runs as a Windows service. The fingerprint scanner's driver host is one; the cabinet application's own services may be others. Those services must always be running.

- **The watch list**: names of services that must be running. It can be set for the fleet, a client, a site or a cabinet, and the most specific level wins, like scanner IDs. Tier 2 and Admin set it, at click level, and every change is audited. Up to 16 services per level. It reaches the agent in the heartbeat response, like scanner IDs.
- **The broker keeps them running.** Every 30 seconds it checks each watched service.
  - **When a service is stopped**, the broker starts it. Start type and remote-access refusals apply here too: a disabled or refused service is reported, never started.
  - **A failed restart** is a start that fails, or a service that stops again within 2 minutes of being started.
  - **After 3 failed restarts in a row**, the broker stops trying for 15 minutes, then tries again. It keeps a count, which a successful start of 10 minutes resets.
  - **The broker's state** survives restarts. It is kept in the broker's own folder.
- **Reporting**: the network service reads the watcher's state from the broker each minute and sends `service` events.
  - `service_restarted`: an automatic restart worked. It shows in the cabinet's history and opens a **minor** alert "Service restarted automatically", so repeat offenders are visible.
  - `service_failing`: 3 restarts in a row failed. It opens a **major** alert "Service will not stay running", naming the service and its last Windows error code.
  - `service_recovered`: the service is running again. It resolves the major alert.
  - `service_missing` or `service_disabled`: the watched service does not exist, or is disabled. It opens a **minor** alert, because the watch list probably names the wrong service.
- **Watch status** for each watched service is shown with services.list on the cabinet page: running, restarted N times today, failing, missing or disabled.

## Milestone 11: network diagnostics

The question support staff ask first is: is it DNS, is it the IP configuration, is the traffic being routed, or is something blocking it? These operations answer that from the cabinet itself. Everything that Windows' own tools (ipconfig, ping, tracert, nslookup, route, arp, netstat, Get-NetConnectionProfile) would show is available, without a shell.

### New read operations (Tier 1)

- **network.routes**: the IPv4 route table. Each route's destination, prefix length, next hop, interface, metric and whether it is persistent.
- **network.neighbors**: the ARP table. IP address, MAC address, state and interface. This shows duplicate addresses and unreachable gateways.
- **network.connections**: TCP connections and listening ports. Local and remote address and port, state, owning process ID and process name. UDP listeners are included.
- **network.stats**: per adapter, bytes, packets, errors and discards (in and out), link speed and media state.
- **network.profile**: each connection's network category (public, private, domain) and its connectivity (none, local network, internet). Also the machine's WinHTTP proxy, and the entries in the hosts file (address and names, without comments).
- **network.resolve**: resolve one host name through each DNS server configured on the cabinet separately, and through the Windows resolver. For each, it returns the answers, the time taken and any error. This shows when one DNS server answers wrongly or not at all.
  - The name is validated as a host name of at most 253 characters.
  - The queries go only to the cabinet's own configured DNS servers.
- **network.traceroute**: hop-by-hop path (up to 30 hops, 3 probes each) to the same four target kinds as network.test. Those are the gateway, a configured DNS server, the site's sync cabinet and the platform server, so the operation cannot be used to map a client's network.

### New write operations (click level, Tier 2 and up)

- **network.flushDns**: empty the DNS cache.
- **network.renewDhcp**: release and renew the address of one DHCP adapter. It goes through the safety net.
- **network.restartAdapter**: turn one adapter off and on again. The broker always turns it back on, even if something fails in between. It goes through the safety net.
- **network.setCategory**: set one connection's category to private or public. Windows applies the firewall profile that matches the category, so a cabinet stuck on "public" often explains a blocked sync.

### Automatic network diagnosis

**Diagnose network** on the cabinet page (Tier 1) runs, in one go:

- network.config, network.profile, network.routes and network.neighbors;
- network.test to the gateway, each DNS server, the sync cabinet (ping and its ports) and the platform server;
- network.resolve of the platform server's name;
- network.traceroute to the sync cabinet, if it does not answer;
- firewall.state.

The server then reads the results with fixed checks, written as code with tests. Each check produces a finding: what is wrong, the evidence, and the fix the console offers. The findings are:

| Finding | Evidence | Offered fix |
|---|---|---|
| No usable IP address | adapter connected but only a 169.254.x.x address, or no IPv4 address | Renew DHCP; check the cable or switch port |
| No default gateway | no 0.0.0.0/0 route | Fix IP settings |
| Gateway unreachable | ping to gateway fails; ARP entry incomplete or missing | Check cable or switch; restart adapter |
| Duplicate IP address | another MAC answers for the cabinet's own address | Change the IP; find the other device |
| DNS server unreachable | ping or DNS query to a configured server fails | Fix DNS servers |
| DNS servers disagree | the same name gives different answers per server | Fix the wrong server |
| Name resolution fails but IP works | resolve fails, IP ping to the same target works | DNS issue: flush DNS, fix DNS servers |
| Hosts file overrides | a hosts entry for the platform server or sync cabinet | Remove the entry (by hand) |
| Sync cabinet on another subnet without a route | sync address outside every local subnet, and no route other than the default | Routing issue: check gateway and VLANs |
| Sync cabinet unreachable | ping fails; the trace stops at hop N | Routing or firewall at hop N |
| Sync port closed | ping works, the TCP port is refused or times out | Firewall on the sync cabinet, or the sync service is stopped |
| Firewall profile on, unlike the client policy | firewall state compared with the client policy | Apply policy |
| Network category is public | profile shows public | Set to private, or apply policy |
| Proxy set | WinHTTP proxy configured | Check the proxy if the platform server is unreachable |
| Adapter errors | errors or discards above 1% of packets | Check cable or switch port |

Each finding has a severity: problem, warning or info. A finding that the evidence cannot confirm is shown as "could not check" and is never guessed.

### Milestone 11 additions (decided October 2026)

New operations:

- **updates.install** (write, Tier 1 and up, click). Search for and install pending security and quality updates through the Windows Update Agent in the broker. Never version upgrades or driver updates. It never restarts the cabinet. The output lists each update with its result, and says whether a restart is now needed. The confirmation says it can take a long time; the command may run for up to 2 hours, and the console shows progress as "installing".
- **system.restart** (write, Tier 2 and up, authenticator code bound to the parameters; a shutdown is Admin only. As built and in the operations catalog; see 09-open-decisions.md "Restarting a cabinet"). Restart (or, for an Admin, shut down) now or after a delay of up to an hour (the console offers right away, 1, 5 or 15 minutes, or 1 hour), with a notice on the cabinet's screen; or cancel one that is waiting. The agent runs `shutdown.exe` with the delay; the waiting restart is Windows' own, not a schedule the broker keeps. Scheduling further ahead (the milestone's original "up to 7 days") is not built and has no operation behind it.
- **Pending restart** (as built: `system.security` reports `pendingReboot`, not `system.info`): whether a restart is pending, and why (Windows Update, component servicing, pending file renames, a computer rename). There is no platform-scheduled restart to report; see system.restart above.
- **network.stats** gains, per adapter: negotiated speed and duplex, the highest speed the adapter supports, and link up and down counts in the last 24 hours from the System log.
- **drivers.list** gains, per driver, the files it installed (path, version, size), read from the driver store.

Bulk: updates.install can be sent to a client or a site like the bulk firewall policy (password, up to 200 cabinets). system.restart is never sent in bulk (the owner's decision, 2026-10-29, for security): one cabinet at a time from its own page. See 09-open-decisions.md "No bulk restarts".

Physical-layer findings in the network diagnosis, each with its fix:

| Finding | Evidence | What to do |
|---|---|---|
| No link | adapter enabled, media disconnected | Check the cable at both ends, try another switch port; if the link light stays off, swap the cable |
| Link slower than the adapter | gigabit adapter linked at 100 Mbps or less | Usually a damaged cable pair: replace the cable; else check the switch port's speed setting |
| Half duplex | duplex is half | Set the switch port to auto-negotiate |
| Rising receive errors | receive errors growing between two readings 60 seconds apart | Replace the cable; move away from power cables; try another switch port |
| Link dropping | 3 or more link-down events in 24 hours | Reseat or replace the cable; check the switch port |
| USB device not detected | the scanner's expected IDs absent from devices.list | Reseat the cable, try another USB port, then another cable |
| USB device failing to start | device present with problem code 43 or 10 | Try another USB port; if it persists, reinstall the driver from the library |

## Console redesign (decided October 2026)

The console is refined with the product owner's brand rather than rebuilt. Every colour, size and radius comes from tokens in one place:

- Backgrounds: #0B111B (page), #131F2D (panels, tables, dialogs). Borders #293849, and a stronger border for form controls so they meet the 3:1 contrast rule.
- Text: #E8F1F5 primary, #A8B8C7 secondary, #75899C tertiary (still 4.6:1 on panels).
- Accent: #22B8CF for primary buttons (dark text), active navigation, links and focus rings only.
- Status: #22C55E healthy, #F5B942 warning, #EF5555 critical, #60A5FA information, always with a text label.
- Compact tables and lists instead of cards; restrained radii; no gradients, glows or heavy shadows.
- Every page keeps its workflows, its checks on the server and its accessibility (keyboard, focus, labels, one main heading).

## Milestone 12: diagnose, trend, triage

Status (October 2026): Diagnose this cabinet, runbooks, resolution notes ("usually fixed by"), case notes, the triage queue and error trends are built; see "The troubleshooting workflow" in [13-roadmap.md](13-roadmap.md) for what they do and what differs from the text below. The daily health snapshot is not part of that change.

- **Diagnose this cabinet** (Tier 1): one button that runs the network diagnosis above together with:
  - system.info and the scanner checklist (peripheral.status);
  - devices with problems, disk health, updates status and services.list;
  - recent errors: eventlog.query, last 24 hours, Error and Critical, from System and Application.

  It shows one summary of findings, worst first. Each finding links to the issue type it matches, if any. Diagnosis runs are stored for 30 days, so the next person can see what was found.
- **Daily health snapshot**: the agent itself collects a compact health snapshot once a day and sends it as a `health` event. No server-issued commands are involved. The snapshot holds:
  - drive health, and free space per fixed drive;
  - days since the last successful Windows update;
  - uptime, scanner state and the watch status of each watched service;
  - firewall profiles and network category.

  The server keeps 90 days. It opens **minor** alerts for: free space below 10%, no update for 60 days, and uptime over 45 days. It shows the trend on the cabinet page.
- **Error trends**: for each issue type and each unrecognized error (log, source, event ID), the number of cabinets and events per day over the last 30 days. It is marked new (first seen in the last 24 hours) or rising (last 7 days more than double the 7 days before). It is shown on the Issues page, with a fleet view and a per-client filter.
- **Triage queue**: unrecognized errors grouped by log, source and event ID across the fleet, sorted by how many cabinets reported them in the last 7 days. Each group shows a sample message and links to Map to issue, so one mapping classifies them all.
- **Runbooks**: each issue type gets a "what to do" text of up to 4,000 characters, plain text with line breaks, and up to 5 links. Tier 2 proposes it; an Admin approves it, as with rules. It is shown on every alert of that type and on matching diagnosis findings.
- **Resolution notes**: resolving an alert asks for the cause (free text, up to 500 characters) and the fix, chosen from the issue type's known fixes or typed in. For each issue type the platform counts which fix resolved its alerts, and shows "usually fixed by…" first on the next alert of that type.

## Engineering items in these milestones

- The server's package and release checks run in a worker thread, with the same limits, so a large upload cannot stall the agent API.
- Console unit tests with Vitest (a dev dependency only, not shipped to browsers), including hostile input for every parser.
- The large files are split by area: the console's cabinet write screens, and the agent's server connection.
