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

- **What it adds.** Demo mode adds 3 simulated clients with 17 cabinets, next to your real cabinets.
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
    - Restarting the failing scanner service closes its alert.
  - The offline cabinet never answers, so its commands stay queued, exactly as with a real offline cabinet.
- **Turning it off** deletes every simulated client, site, cabinet, alert, event and command. Your real cabinets and their history are never touched. The audit log records who turned demo mode on and off.
- **Who can change it.** Only an Admin can turn it on or off, and everyone signed in sees the banner.

| Simulated client and site | Cabinet | What to find |
|---|---|---|
| Riverside Veterinary Group, New York | Surgery | Firewall on, unlike the client policy (blocks sync). Fix: Apply policy. |
| | Treatment Room | Fingerprint scanner disconnected after repeated reconnects. |
| Riverside, Phoenix (Arizona time) | Main Sync | Three blue screens in 3 days (bug check 0x7E) with unexpected shutdowns. |
| | Boarding | The scanner service will not stay running (3 failed restarts). Fix: Restart. |
| Riverside, San Diego | Pharmacy | Drive predicting failure: bad blocks and reallocated sectors. |
| Lakeside Health, Chicago | ER North | DNS lookups failing; the second DNS server does not answer. |
| | Oncology | Windows update KB5050011 failing (0x80070643). |
| Lakeside Health, Denver | ICU Sync | New, unrecognized application errors for the triage view. |
| | Step-down | Offline for 6 days. |
| Summit Animal Hospitals, Austin | Isolation | Repeated blue screens: a second cabinet with the same crash. |

## A 15-minute demo script

1. **Your real laptop (3 minutes).**
   - Fleet → Mashura Office → your laptop.
   - Show the event logs: browse System, filter to errors, open one in full.
   - Show the services list (like the Services tab of Task Manager), and watch one service so the agent keeps it running.
   - Run the fingerprint scanner checks.
   - Point out what never happens: no remote desktop session, no shell, nothing connects in to the laptop.
2. **The fleet at a glance (2 minutes).**
   - Turn demo mode on.
   - The Fleet page shows every client, with offline counts and major alerts.
   - The Alerts page lists the major problems across the fleet, worst first, without anyone searching for them.
3. **The satellite that cannot reach its sync cabinet (3 minutes).**
   - Open Surgery → Firewall.
   - The policy panel says **Differs**: all three profiles are on, and the client policy says off.
   - Click **Apply policy**, one click for Tier 1.
   - The profiles change, the drift alert closes by itself, and the firewall history shows who did it.
4. **The scanner (2 minutes).**
   - Open Treatment Room → Fingerprint scanner.
   - The checklist says it is not connected, lists the reconnects, and says what to try next.
   - Then open Boarding → Services: BioScanSvc is watched and failing. Restart it, and the major alert closes.
5. **Proactive (3 minutes).**
   - Main Sync and Isolation both crashed with the same bug check.
   - The San Diego Pharmacy drive is predicting failure.
   - Oncology's update keeps failing.
   - These were all raised without anyone opening those cabinets.
   - On Alerts → Unrecognized errors, the new application errors wait to be mapped to an issue type once, for the whole fleet.
6. **Safety (2 minutes).**
   - Show how each change is confirmed:
     - one click for everyday fixes;
     - the password for a bulk change (Firewall policy across a client);
     - the authenticator code for changes that can cut a cabinet off.
   - Show Admin → Audit log: every action, by name, in a tamper-evident chain.
   - Turn demo mode off. Only your real laptop remains.

## Questions you may get

- **Is this live data?**
  - Your laptop: yes.
  - The cabinets tagged Demo: no, they are simulated. They answer through the same code paths and contracts as a real agent, so what you see is what a real cabinet would show.
- **Can it run commands on a cabinet?** Only the fixed operations in its catalog, each with a role check on the server and on the cabinet itself. There is no shell, no script runner and no general file transfer.
- **What does a cabinet need?** Outbound HTTPS to the server on port 8443, and nothing inbound.
