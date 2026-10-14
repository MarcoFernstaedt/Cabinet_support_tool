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

Demo mode adds four made-up clients and 121 cabinets next to your real ones, so the Fleet page looks like a real fleet. Every client is named "Demo · …" and tagged **Demo**, every cabinet says "Demo: simulated cabinet", and a banner on every page says demo mode is on.

The made-up cabinets use the same server code as a real agent. They send heartbeats and events, their alerts come from the real alerts engine, and every answer they give is checked against the same output schema. Fixes work: applying the firewall policy closes its drift alert, starting the failing scanner service closes its alert, and renewing a lease or setting DNS changes what the next network check sees. The offline cabinet never answers, so its commands stay queued, like a real offline cabinet.

Only an Admin can turn it on or off. Turning it off deletes every made-up client, site, cabinet, alert, event, command and the demo teammate. Real cabinets and their history are never touched, and the audit log keeps who did it.

### The fleet

| Client | Sites |
|---|---|
| Riverside Veterinary Group | Upper East Side (8 cabinets), Midtown Manhattan (9), Phoenix Clinic (4), and three single-cabinet sites: San Diego Bay, San Diego Recovery Center, Tucson Walk-in |
| Lakeside Health | Chicago, Main Pharmacy (5, fixed addresses), Denver ICU (4) |
| Summit Animal Hospitals | Austin North (4), Dallas Uptown (4) |
| Harbor Pet Hospitals | Boston Harbor, Portland East, Providence, Hartford: 20 cabinets each |

The cabinets worth looking at:

| Where | Cabinet | What is wrong |
|---|---|---|
| Midtown | Midtown Sync | Its firewall is on, unlike the client policy, so the satellites can't sync. One click fixes it. |
| Midtown | Operating Room | Matches its baseline, but loses packets to the gateway and the card counts errors. A bad cable. |
| Midtown | Procedure Room | Scanner dropped off three times in a day; its driver was installed about two hours before the first drop. |
| Midtown | Reception, Waiting Room | Keep logging errors from the scanner's driver that no rule knows yet. |
| Upper East Side | Pharmacy Sync, Lab, ICU, Treatment Room, Exam 1 to 3 | The same firewall problem as Midtown Sync, a fixed address from another network, a clock 7 minutes fast, a disconnected scanner, the wrong time zone (three of them, for the one-site bulk fix). |
| Phoenix | Main Sync, Boarding, Front Desk, Exam Wing | Repeated blue screens, a scanner service that won't stay running, no DHCP lease, the wrong time zone. |
| San Diego Bay | Pharmacy | Drive predicting failure. |
| San Diego Recovery Center | Recovery | The wrong time zone. |
| Tucson Walk-in | Intake | Three USB ports, a scanner expected, nothing detected. A cabinet alert only. |
| Chicago | ER North, Oncology, Triage | DNS lookups failing, a Windows update failing, a fixed address with the wrong gateway. |
| Denver | ICU Sync, Step-down, Rounds, Charting | Unrecognized errors, offline for 6 days, a 100 Mbps link, a nearly full drive. |
| Austin | Surgery Suite, Isolation, Billing | The wrong time zone, repeated blue screens, errors from five sources (some map by themselves, two wait to be mapped). |
| Dallas | Uptown Sync, Exam 1, Exam 2 | Still on the old DNS servers; Exam 3 is fine. |
| Harbor | 80 cabinets | An overnight incident: a Windows update on almost all, then a storage driver on 16. 60 blue-screened and 12 are still restarting. Incidents shows the driver stands out and the update doesn't. |

## The guided demo

On a fresh install, an Admin opens Admin, then Set up and demo, and clicks **Start the guided demo** (the Demo guide has the same button). If the demo fleet isn't there, or has already been used, the button asks for an authenticator code and sets the demo up or resets it first, so the story always starts from the same place. Someone who isn't an Admin is told to ask one. It is one story of about sixteen steps, in a panel at the side of the real console. Every step opens the right page by itself. **Next** takes you there and outlines the control the step is about, and **Show me** does it again if you've scrolled away. You never type an address. They only point. They never click anything for you, with one exception: if you press Next on the whole-site step without clicking Diagnose network, the tour runs the check and opens its results so the next step has something to show.

1. **Midtown Manhattan: site-wide sync failure.** The exam rooms report sync failures. Check Exam Room 1 on its own, then the whole site at once. Link, address, gateway and DNS are fine, and the sync cabinet's firewall is what blocks the satellites. Apply the client policy with one click and the site checks itself again and comes back clean, apart from Operating Room, whose full read shows the packet loss and card errors. Save what fixed it once someone swaps the cable.
2. **The scanner and the errors nobody has named.** Procedure Room's drops and the driver install. Then the unrecognized errors at Reception and Waiting Room: read the log, map the error to the Fingerprint scanner issue, then approve the fix that Priya (a made-up Tier 1 teammate) already submitted. It now shows up beside the alert as a possible fix.
3. **A real cabinet, last.** Install the agent on a Windows computer, approve it, run the live test, read its network, and set the site's standards from it. The demo ends here, on the new cabinet's network page.

### Known fixes

When a problem has no click-to-fix, a person solves it and clicks **Save what fixed this**. The platform keeps their note with the cabinet's role, agent version, time zone, firewall and network. The next time the same finding or the same issue type comes up on any cabinet, at any client or site, the fix appears beside it as a possible fix, with a list of what differs from the cabinet it was fixed on. An alert whose issue has fixes carries a "possible fix" mark in every alert list.

A member's fix waits for approval and only they can see it. An Admin, or a Tier 2 an Admin has allowed (Admin, Users, "Approves fixes"), approves it on the Fixes page. People who can approve skip the wait: they confirm in a dialog and it is logged under their name. Fixes don't expire. Tier 2 and up can remove one.

## Questions you may get

- **Is this live data?** Your laptop's is. The cabinets tagged Demo are simulated, but they answer through the same code and contracts as a real agent.
- **Can it run commands on a cabinet?** Only the fixed operations in its catalog, each with a role check on the server and again on the cabinet. There is no shell, no script runner and no general file transfer.
- **What does a cabinet need?** Outbound HTTPS to the server on port 8443 and nothing inbound.
