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

## The full read, and standards at onboarding (October 2026)

**Everything is read, whether or not it differs from the baseline.** A diagnosis now keeps the whole reading (`diagnoses.readings`) and shows it under "Everything that was read", per cabinet on the cabinet page and as "Full read" on the batch page:

- each card's DHCP server, lease start and end, MTU and packet, error and discard counters;
- the routing table and the ARP table;
- five pings to the gateway with loss, minimum, average, maximum and jitter, and a lookup through each DNS server;
- a path (`network.trace`) to the platform server and to the sync cabinet.

**Observations** (`server/src/diagnose/network-observations.ts`) turn that into findings that do not depend on the baseline: a lease that has run out or ends within two hours, a DHCP server that answered, a non-standard MTU, error and discard counts, packet loss (a problem from 20%), slow or jittery replies, ARP entries that never completed, more than one default route, and whether the sync cabinet and platform server can be reached. They state what was seen and what it often means, not a verdict.

**Standards at onboarding.** A site's three standards (network baseline, time zone, client firewall policy) are suggested from what its cabinets already report (`GET /api/sites/:id/standards`; nothing is saved by that call). The site page offers "Use <cabinet>'s network", the zone most cabinets use, and the firewall profiles most cabinets have. Saving goes through the same routes and confirmations as editing them by hand.

## Known fixes (October 2026)

A problem the baseline cannot fix with a click is still solved by a person. They save what fixed it (`POST /api/known-fixes`: a name, the solution in plain text, the problem it fixes, and the cabinet), and the server records that cabinet's environment itself: role, agent version, time zone, firewall profiles and the network card, gateway, DNS, addressing, link speed and MTU from its latest read. The console never sends the environment.

- **A problem is matched exactly.** Either by a diagnosis finding's key (the finding id without a trailing interface number: `obs-errors-12` is `obs-errors`) or by an issue type. There are no patterns.
- **It is shown when the problem comes back.** On the cabinet's diagnosis and the batch page beside the finding; on alerts of that issue type. Beside it, the differences from the cabinet it was fixed on ("Firewall: all off then, domain on now"), so a person can tell whether it is likely to apply. A diagnosis counts each fix it shows (`seen_count`).
- **Roles.** Tier 1 and up save one; Tier 2 and up remove one (soft: `removed_at`). Both are audited (`known_fix.save`, `known_fix.remove`).
- **Contracts.** `console/known-fix-create` and `console/known-fix-query`; the solution is at most 2,000 characters of text without control characters.
