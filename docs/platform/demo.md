# Demo guide

How to show the platform to the support team: your real agent on your own Windows laptop, next to a simulated fleet that shows what the platform does at scale.

## Before the demo (once)

1. **Run the platform on the VPS.**
   - Follow [deploy/README.md](../../deploy/README.md). It takes about 15 minutes.
   - At the end you have the console at `https://<your domain>` and an Admin account with a temporary password.
2. **Sign in as the Admin.** Choose your own password and set up an authenticator app.
3. **Open Admin → Set up and demo.** It walks through four steps:
   1. **Add your support team.**
      - Each person gets a temporary password, shown once.
      - At first sign-in they choose their own password and set up an authenticator.
      - Roles:

        | Role | What it can do |
        |---|---|
        | Tier 1 | Diagnostics, plus the everyday fixes: the firewall policy, scanner checks and restarts. |
        | Tier 2 | Everything Tier 1 can, plus services, firewall rules and network settings. |
        | Admin | Everything Tier 2 can, plus enrolling cabinets and managing accounts. |
   2. **Install the agent on a computer.**
      - Download the agent zip, an install token (`token.txt`) and `platform-ca.pem`.
      - Copy the PowerShell commands shown and run them in an elevated PowerShell on the laptop.
   3. **Approve it.**
      - The laptop shows up on the same page within a minute.
      - Check its host name and serial number, file it under a client and site (for example "Mashura Office" / "Support desk"), and approve.
   4. **See it work.** Links to the laptop's event logs, services, fingerprint scanner checks, firewall and network.
4. **Turn demo mode on**, at the bottom of the same page.

## What demo mode is

- **What it adds.** Demo mode adds 4 simulated clients with 121 cabinets, next to your real cabinets. Clients have between 2 and 6 sites; some sites are a single standalone cabinet (San Diego Bay, San Diego Recovery Center, Tucson Walk-in), and the largest, at Harbor, have 20 cabinets each. One of them, Harbor Pet Hospitals, has an overnight crash incident like the 60-cabinet one: 60 of its 80 cabinets blue-screened after a storage driver update, and 12 are still restarting (none of them a site's sync cabinet).
  - The sites are in the Eastern, Central, Mountain, Arizona and Pacific time zones.
  - Each simulated client is named "Demo · …" and carries a purple **Demo** tag.
  - Each simulated cabinet says "Demo: simulated cabinet".
  - A banner on every page says demo mode is on.
- **They behave like real cabinets.**
  - Simulated cabinets send heartbeats and events through the same server code as a real agent.
  - Their alerts come from the real alerts engine.
  - Every answer they give is checked against the same output schema as a real agent's.
  - Fixes take effect:
    - Applying the firewall policy closes the drift alert.
    - Starting the failing scanner service closes its alert.
    - Renewing a DHCP lease, setting the DNS servers or a fixed address changes what the next network check sees.
  - The offline cabinet never answers, so its commands stay queued, exactly as with a real offline cabinet.
- **Turning it off** deletes every simulated client, site, cabinet, alert, event and command. Your real cabinets and their history are never touched. The audit log records who turned demo mode on and off.
- **Who can change it.** Only an Admin can turn it on or off, and everyone signed in sees the banner.

| Simulated client and site | Cabinet | What to find |
|---|---|---|
| Riverside Veterinary Group, New York | Pharmacy Sync | The sync cabinet's firewall is on, unlike the client policy, so its satellites cannot sync. Diagnose network on Surgery (a satellite) finds it; the fix is Apply policy on Pharmacy Sync. |
| | Treatment Room | Fingerprint scanner disconnected after repeated reconnects (not in the guided tour: the platform cannot fix a scanner remotely). |
| | Exam 1, Exam 2, Exam 3 | Set to the wrong Windows time zone: three of New York's eight cabinets, for the one-site bulk change. |
| Riverside, Phoenix (Arizona time) | Main Sync | Three blue screens in 3 days (bug check 0x7E) with unexpected shutdowns. |
| | Boarding | The scanner service will not stay running (3 failed restarts). Fix: Restart. |
| Riverside, San Diego | Pharmacy | Drive predicting failure: bad blocks and reallocated sectors. |
| Lakeside Health, Chicago | ER North | DNS lookups failing; the second DNS server does not answer. |
| | Oncology | Windows update KB5050011 failing (0x80070643). |
| Lakeside Health, Denver | ICU Sync | New, unrecognized application errors for the triage view. |
| | Step-down | Offline for 6 days (the only cabinet in the demo that is simply offline). |
| Summit Animal Hospitals, Austin | Isolation | Repeated blue screens: a second cabinet with the same crash. |
| Riverside, New York | ICU | Clock about 7 minutes fast. Fix: Time → Sync the clock. |
| Riverside, Phoenix; Riverside, San Diego; Summit, Austin | Exam Wing, Recovery, Surgery Suite | Also set to the wrong Windows time zone (Phoenix set to Mountain with daylight saving, not Arizona). Fix: Time → Set to the site's zone. |
| Riverside, San Diego | Intake | **A cabinet alert.** Three USB ports, a fingerprint scanner expected on one, nothing detected on any. The alert and its logs (USB hub, device removed) are on this cabinet only: not in the fleet alert list, the badge or the site counts. |
| Lakeside, Denver | Charting | A drive nearly full (Windows event 2013): a minor "Low disk space" alert. |
| Summit, Austin | Billing | Event log errors from five sources: DNS, a retried disk read and a failing update map to issue types by themselves; an export job (BillingExport) and an application crash wait to be mapped. |
| Summit Animal Hospitals, Dallas | Uptown Sync, Exam 1, Exam 2 | Still pointing at the old DNS servers (site-wide DNS drift); Exam 3 is fine. |
| Riverside, New York | Lab | A fixed address from another network. |
| Riverside, Phoenix | Front Desk | No DHCP lease (a 169.254 address). Fix: Renew the DHCP lease (one click; the answer shows the new address). |
| Lakeside, Chicago | Triage | A fixed address with the wrong gateway. |
| Lakeside, Denver | Rounds | The cable negotiated only 100 Mbps (no remote fix). |
| Harbor Pet Hospitals, 4 sites of 20 | 80 cabinets | Overnight: Windows update KB5050011 on almost all, then a storage driver (Intel RST 19.5) on 16; 15 blue-screened with 0xD1, 5 still restarting. Incidents shows the driver stands out and the update does not. |

## The demo: one story, then your own cabinet

The guided demo (Demo guide, then Start the guided demo) is one story, about 16 steps, ending with onboarding a real agent. Everything else in the demo fleet is background so the Fleet page looks like a real fleet.

1. **Monday morning at Midtown Manhattan.** Check one cabinet (Exam Room 1) on its own, then the whole site at once. Fix the sync cabinet's firewall with one click and watch the site come back clean. Open Operating Room, which matches its baseline but whose full read shows lost packets and card errors, and save what fixed it.
2. **The scanner and the errors nobody has named.** Procedure Room's scanner dropped off three times after a driver install. Reception and Waiting Room keep logging driver errors no rule knows: map one to the Fingerprint scanner issue. Priya, a made-up Tier 1 teammate, has already submitted a fix for that issue; approve it from the Fixes page and it appears beside the alert.
3. **Onboarding last.** Install the agent on a computer, approve it, run *Test the live cabinet*, read its network, and set the site's standards (network baseline, time zone, firewall policy) from that cabinet.

**Known fixes.** When a problem has no click-to-fix because the baseline can't tell what's wrong, a person solves it and clicks *Save what fixed this*. The platform keeps their note with the cabinet's role, agent version, time zone, firewall and network. The next time the same finding comes up (matched by its exact key, never a pattern) or the same issue type raises an alert, the fix is shown beside it with what differs from the cabinet it was fixed on. Tier 1 and up submit one. It stays visible only to its submitter until an Admin, or a Tier 2 an Admin has granted it (Admin → Users → *Approves fixes*), approves it on the **Fixes** page; a fix an approver submits is approved at once, logged under their name, after a confirmation dialog. Tier 2 and up remove one.

1. **Monday morning at Midtown Manhattan.** The exam rooms say they can't sync.
   - Open **Riverside → Midtown Manhattan** and click **Diagnose network**. All seven cabinets are checked at once.
   - Link, address, gateway and DNS are fine everywhere. Every satellite fails at the sync cabinet step, and Midtown Sync's firewall is on when the client's policy says off.
2. **The fix, one click.**
   - Click **Apply the policy on Midtown Sync** and confirm. The cabinet applies the client's firewall policy; if it loses contact afterwards it puts the old setting back by itself.
   - The site is checked again straight away and comes back clean: "7 of 7 cabinets are clean", with a line saying what was done.
3. **The scanner at the same site.** Open **Procedure Room → Fingerprint scanner**.
   - It dropped off three times in the last day and is off now. The Drops section lists each drop and recovery, and shows the scanner's driver was installed about two hours before the first one.
   - That is a lead to check first, not a verdict. The page says it could still be the cable or the port.
4. **Install the agent on a real computer.** Admin → Set up and demo: create the install token, copy the commands, run them in an elevated PowerShell. Then **Pending cabinets** to approve it.
5. **Read its network with no baseline.** On the new cabinet, Network → **Diagnose network**. The site has no baseline yet, so nothing is compared and the page says so. You get the readings straight from the machine: link, address (DHCP or fixed), gateway, DNS, and whether it can reach the platform. Open **Everything that was read** for the lease, DHCP server, MTU, card errors, routes, ARP table, ping loss and jitter, and the path to the platform. Then go to the site page: **Standards for <site>** offers "Use <cabinet>'s network" (with the authenticator code), the site time zone and the client firewall policy, so a new site is set up from a cabinet that is already right. With a baseline set, the same check compares against it.

   *Operating Room* at Midtown shows the other half: it matches its baseline, yet its full read shows packet loss to the gateway and receive errors on the card (a failing patch cable).

The tour covers 1 to 5 in seven steps. Turn demo mode off at the end and only your real cabinet remains.

## Questions you may get

- **Is this live data?**
  - Your laptop: yes.
  - The cabinets tagged Demo: no, they are simulated. They answer through the same code paths and contracts as a real agent, so what you see is what a real cabinet would show.
- **Can it run commands on a cabinet?** Only the fixed operations in its catalog, each with a role check on the server and on the cabinet itself. There is no shell, no script runner and no general file transfer.
- **What does a cabinet need?** Outbound HTTPS to the server on port 8443, and nothing inbound.
