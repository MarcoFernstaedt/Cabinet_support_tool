# Network troubleshooting

Find where a network problem is, on one cabinet, several, or a whole site, and fix it. Built in October 2026 on the diagnosis from milestone 11. (Emergency offline access, in [14-emergency-access.md](14-emergency-access.md), is a separate milestone.)

## The site baseline

Each site can have a baseline: what its network should look like.

| Setting | Meaning |
|---|---|
| Addressing | Cabinets take their address from DHCP, or have fixed addresses |
| Gateway and prefix length | The site's router and the size of its network (for example 10.21.4.1 and /24) |
| DNS servers | Up to four |

A Tier 2 or Admin person sets it on the site page, with an authenticator code bound to the exact baseline. Setting it changes nothing on a cabinet. Without a baseline, the diagnosis still runs every check but cannot say whether an address, gateway or DNS server is wrong.

## What a diagnosis does

For each cabinet it reads the network settings and firewall, then tests the gateway, every DNS server, the platform server's name, and (on a satellite) the sync cabinet's ping and ports. Then it compares:

- the **address** with the baseline's network (an address from another network, a 169.254 address from a failed DHCP lease, a fixed address where the site uses DHCP);
- the **gateway** with the baseline's;
- the **DNS servers** with the baseline's;
- the **firewall** with the client policy, and the sync cabinet's firewall when a satellite cannot reach it.

Every finding says how sure it is (confirmed, probable, possible, could not check) and where it sits in the path: link, address, gateway, DNS, platform, sync cabinet, firewall. A failed test that follows from a wrong address, gateway or DNS server is marked as probably a result of it and is not listed as a separate problem. A cabinet that differs from its baseline gets a minor "Network settings differ from the site baseline" alert, which a later clean diagnosis closes.

## Fixes

| Finding | Fix | Operation | Confirmation |
|---|---|---|---|
| Firewall differs from policy, or blocks the sync cabinet | Apply the client's policy (on the sync cabinet when it is the one blocking) | `firewall.applyPolicy` | One click (Tier 1 and up) |
| DNS servers differ from the baseline | Set the baseline's DNS servers | `network.setDns` | Authenticator code (Tier 2 and up) |
| No DHCP lease (a 169.254 address) on an adapter that uses DHCP | Renew the DHCP lease | `network.renewLease` | A click (Tier 1 and up); no setting changes, so no safety net |
| Address from another network, or a fixed address at a DHCP site | Switch to DHCP | `network.setIp` | Authenticator code (Tier 2 and up) |
| Wrong gateway on a fixed address | Set the baseline's gateway, keeping the address | `network.setIp` | Authenticator code (Tier 2 and up) |
| Link at 100 Mbps, no link, a wrong DHCP scope | No remote fix: what to check is stated | none | none |

The network changes keep the safety net: if the cabinet cannot reach the platform after the change, it goes back to its old settings by itself. The same change on several cabinets runs as a fleet operation, confirmed with the password: the server takes each cabinet's change from its latest diagnosis (at most 30 minutes old), changes the cabinets a few at a time, and reads each cabinet's settings back to check the change. Cabinets with no current finding are skipped.

## Many cabinets at once

A change made on many cabinets covers the cabinets of **one site**: the server refuses a job whose cabinets are from two sites (`one_site_only`), and Fleet operations starts by choosing the site, then ticking the cabinets in it (3 of 8, say), each listed with the IPv4 address it last reported. The address is kept from every `network.config` answer, so a cabinet that has not been read yet shows "Not read yet".


"Diagnose network" on the site page checks every cabinet at the site; on Fleet operations it checks the selected cabinets (up to 60). At most 8 are checked at once; offline cabinets are listed, not waited for; one batch runs at a time per person. The result page groups the same problem on many cabinets into one row with its fix, and shows each cabinet's path in a table.

## Renewing a lease (`network.renewLease`)

Added after the first network release. The agent asks the adapter itself (its `RenewDHCPLease` method, through the same management interface the other network writes use), so no program is launched. It changes no setting, which is why it is a click and has no safety net. An adapter with a fixed address answers `not_dhcp` and nothing happens; an answer that leaves the cabinet with a 169.254 address, or a non-zero code, is `failed`, never "renewed". The fleet job reads the adapter back to confirm a real address.

## Demo

Every simulated site has a baseline. The demo's network faults:

| Where | Fault | Fix |
|---|---|---|
| Dallas Uptown (3 of 4 cabinets) | Still pointing at the old DNS servers | One bulk fix |
| New York, Pharmacy Sync | Firewall on, blocking its satellites | One click |
| New York, Lab | Fixed address from another network | Switch to DHCP |
| Phoenix, Front Desk | No DHCP lease (169.254) | Renew the DHCP lease (`network.renewLease`) |
| Chicago (fixed addresses), Triage | Wrong gateway | Set the baseline gateway |
| Chicago, ER North | One DNS server that no longer answers | Set the baseline DNS servers |
| Denver, Rounds | Link at 100 Mbps | None: replace the cable |

A fix changes the simulated cabinet's own settings, so the next diagnosis shows it fixed.

## The full read

A diagnosis keeps everything it read (`diagnoses.readings`), whether or not anything differs from the baseline. The cabinet's diagnosis shows it under "Everything that was read", and the batch page has a "Full read" button per cabinet. It holds:

- each card's DHCP server, lease start and end, MTU, and packet, error and discard counters;
- the routing table and the ARP table;
- five pings to the gateway, with loss, minimum, average, maximum and jitter, and a lookup through each DNS server;
- a path to the platform server and one to the sync cabinet (`network.trace`).

`server/src/diagnose/network-observations.ts` turns that into findings that don't need a baseline. It flags a lease that has run out or ends within two hours, a non-standard MTU, error and discard counts, packet loss (a problem from 20%), slow or uneven replies, ARP entries that never completed, more than one default route, and whether the sync cabinet and the platform server can be reached. Each says what was seen and what it often means. None is a verdict.

## Site standards

A site is compared with three standards: a network baseline, a time zone and the client's firewall policy. When one isn't set, the site page shows "Standards for <site>" and offers to adopt what a cabinet there already reports. `GET /api/sites/:id/standards` works the suggestions out and saves nothing. Saving goes through the usual routes with the usual confirmations: an authenticator code bound to the exact baseline or policy, and a plain save for the time zone.

## Known fixes

Some problems have no click-to-fix because the baseline can't tell what is wrong. A person solves one, then saves what fixed it: a name, the solution in plain text (up to 2,000 characters), the problem, and the cabinet. The server records that cabinet's environment itself, and the console never sends it: role, agent version, time zone, firewall profiles, and the card, gateway, DNS, addressing, link speed and MTU from its latest read.

- **Matching is exact.** A fix belongs to a diagnosis finding's key (the finding id without a trailing interface number, so `obs-errors-12` is `obs-errors`) or to an issue type. There are no patterns.
- **A fix applies to every cabinet in the fleet**, at any client or site. It is shown beside the finding on the diagnosis and batch pages, and on the alert page of that issue, with a list of what differs from the cabinet it was fixed on. An alert whose issue has fixes carries a "possible fix" mark in every alert list. Fixes don't expire.
- **Approval.** A member's fix is `pending` and only they can see it. An Admin, or a Tier 2 with `can_approve_fixes` (Users, "Approves fixes"), approves or rejects it from the Fixes page. A rejection can carry a reason the submitter reads. A fix from someone who can approve is approved straight away, after a confirmation dialog, and logged under their name. Tier 2 and up can remove a fix.
- **The alert's resolution.** A fix saved from an alert is tied to it (`alertId`). Resolving that alert without typing a note uses the fix's words, cut to the first 256 characters on one line. The resolve form can also keep a typed note as a possible fix.
- **It works on real cabinets.** Nothing here is limited to demo ones. `server/test/real-cabinet-fixes.test.ts` runs the whole thing on cabinets with no demo scenario, answering commands through the queue and result paths the agent API uses. The answers in that test are synthetic. On Windows they come from the machine.

Contracts: `console/known-fix-create`, `known-fix-query` and `known-fix-reject`. Audit actions: `known_fix.save`, `known_fix.approve`, `known_fix.reject`, `known_fix.remove`.
