# Console

The support console from docs/spec/06-console-spec.md: React 19 and TypeScript, built by Vite into static files. The platform server serves those files from the same origin as the console API. The console holds no secrets, and every permission check happens on the server.

## What's in it

- **Sign-in.** Password, then the authenticator code.
  - Tier 2 and Admin set up an authenticator at first sign-in.
  - A temporary password must be changed at first sign-in.
  - A getting-started tour opens at first sign-in and can be re-run from Account.
- **Fleet.** Client → site → cabinet views, plus a jump box at the top of every page that finds any client, site, cabinet or Windows host name.
- **Cabinet view.** The name, client, site and role stay at the top, with a sidebar of the site's other cabinets. Sections:
  - **Overview**
  - **Event logs:** every readable log, with filters, paging and full entry detail including raw XML.
  - **Fingerprint scanner:** the automated troubleshooting checklist, and likely scanners with "Use as this cabinet's scanner".
  - **Devices and drivers**
  - **Windows updates**
  - **Drive health**
  - **Network:** adapter settings, with one-button tests to the gateway, DNS servers, the sync cabinet and the platform server. Edit IP settings and Edit DNS (Tier 2 and Admin).
  - **Firewall:** profiles with a countdown while one is temporarily off, and every rule with filters. Tier 2 and Admin can turn a profile off for a set time, turn it on, and add, edit, enable, disable or delete rules with a structured form. Snapshots can be restored, and the firewall history shows every change: through the platform (and by whom) or from outside.
  - **Software:** approved packages that match the cabinet's hardware, with Install (Tier 2 and Admin). The answer names the exact check that failed, if one did.
  - **Files**
  - **Command history**
- **Diagnosing.** Network has a Diagnose network button that checks the link, address, gateway, DNS, the sync cabinet and the firewall in order, keeps everything it read, and offers the fix where the platform can make one. A site page does the same for every cabinet at once. A cabinet's Overview has a live test that runs eleven read-only checks and copies a plain report.
- **Known fixes.** "Save what fixed this" appears under findings and on alerts. Approved fixes show beside the same problem on any cabinet, and alerts whose issue has fixes carry a "possible fix" mark. Admins, and Tier 2 people they allow, review submissions on the Fixes page.
- **Site standards.** A site page offers to set its network baseline, time zone and firewall policy from a cabinet that is already right.
- **Demo.** The Demo guide and a side-panel tour that walks one story from a firewall fix to onboarding a real agent.
- **Write actions** (Milestone 5) appear only for Tier 2 and Admin, and only on cabinets that accept changes while writes are not paused.
  - Each one opens a confirmation that says exactly what will change on which cabinet, then asks for the authenticator code. Network and IP changes show the old and new values side by side, and explain the 2-minute safety net.
  - Devices and drivers can uninstall a third-party driver.
  - The fingerprint scanner section lists approved driver packages for the scanner's hardware IDs.
  - A banner shows on every page while writes are paused fleet-wide, and on a client's cabinets while that client is paused.
  - The server checks all of this again; hiding a button is never the protection.
- **Settings in the console**, each confirmed with the authenticator code:
  - **Scanner hardware IDs:** a fleet default (Admin) and a per-cabinet override (Tier 2 and Admin).
  - **Each site's sync cabinet address and ports** (Admin). Cabinets accept only a private address on their own network.
- **Admin.** Each change is confirmed with the authenticator code, and the server enforces every rule.
  - Pending cabinets (approve or reject), and install tokens with the platform CA file.
  - The scanner default.
  - The software library: upload a driver package or MSI (the server checks it on arrival), approve another Admin's upload, retire a package.
  - **Milestone 6:**
    - **Users:** create (a temporary password shown once), change role, set the hourly change limit, disable, reset password or authenticator, delete. Each person has an activity page: the cabinets they opened and everything they did.
    - **Online now:** who is active, their role and the cabinet they have open.
    - **Audit log:** search by person, cabinet, action and date, and verify the chain. Each cabinet has a "Who opened this cabinet" link for Admins.
    - **Clients and sites:** create, rename, remove. Admins change a cabinet's role on its overview.
    - **Issue types and suppressions:** create and edit issue types; create, renew and disable suppressions.
    - **Fleet safety:** pause or resume changes fleet-wide or per client, and resume people paused by their limit.
    - **Security alerts:** a count on the Admin link, new ones announced as they happen, and closing one with a note.
    - **Settings:** offline alerts, sign-in timeouts, two-factor for everyone, retention.
- **Alerts** (Milestone 4).
  - The top bar shows how many major alerts are open and unclaimed. New major alerts appear on every console at once, with "Claim and open cabinet", and are announced to screen readers.
  - The Alerts area lists every alert, with filters for severity, issue, state and "claimed by me". It also has an Unrecognized errors view and an Offline view that goes from clients to sites to cabinets.
  - Clicking an unclaimed major alert claims it and opens its cabinet. If someone else got there first, the console says who.
  - Each cabinet has an Alerts section with its alerts and what its monitors reported. The scanner section shows the scanner's alerts. Client, site and cabinet lists show open alert counts.
- **Issues and Map to issue** (Milestone 4).
  - The Issues area lists each issue with its open alerts and live rules. Each rule shows its match, history, who proposed and approved it, and how many events it matched.
  - Admins approve, reject, disable or roll back rules there, with the authenticator code.
  - Map to issue is on any unrecognized alert, reported event or event-log entry (Tier 2 and Admin).
    - Pick the issue, keep or drop each pre-filled field, and optionally add a message phrase.
    - See how many events and cabinets it would have matched in the last 30 days, and choose whether to regroup open alerts.
    - Confirm with the authenticator code.
  - An event-log entry shows which issue it maps to, and how many other cabinets reported it in the last 30 days.

## Develop

```bash
npm ci
npm run dev        # http://localhost:5173, proxying /api to a server on :8080 started with CONSOLE_ORIGIN=http://localhost:5173
npm run build      # strict type-check, then dist/
```

The browser end-to-end tests live in `server/test/console-*-e2e.test.ts`: the main flow, alerts, writes, administration, upgrades and device settings. They run the built console in Chromium against the real server, PostgreSQL and (where needed) the agent code.

## Accessibility

The console uses semantic landmarks and one main heading per page (the cabinet name on cabinet pages). Status always carries a text label, not just a color. Dialogs move focus in and back out, results are announced through polite live regions, and everything works by keyboard alone. The end-to-end test checks headings and button names on each page it visits.
