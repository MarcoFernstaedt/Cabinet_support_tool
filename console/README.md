# Console

The support console from docs/spec/06-console-spec.md: React 19 and TypeScript, built by Vite into static files. The platform server serves those files from the same origin as the console API. The console holds no secrets, and every permission check happens on the server.

## What's in this release (Milestone 4)

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
  - **Network:** adapter settings, with one-button tests to the gateway, DNS servers, the sync cabinet and the platform server.
  - **Firewall:** read-only for now.
  - **Files**
  - **Command history**
- **Settings in the console**, each confirmed with the authenticator code:
  - **Scanner hardware IDs:** a fleet default (Admin) and a per-cabinet override (Tier 2 and Admin).
  - **Each site's sync cabinet address and ports** (Admin). Cabinets accept only a private address on their own network.
- **Admin.** Pending cabinets (approve or reject), install tokens with the platform CA file, the scanner default, and the audit log.
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

The browser end-to-end test lives in `server/test/console-e2e.test.ts`. It runs the built console in Chromium against the real server, PostgreSQL and agent code.

## Accessibility

The console uses semantic landmarks and one main heading per page (the cabinet name on cabinet pages). Status always carries a text label, not just a color. Dialogs move focus in and back out, results are announced through polite live regions, and everything works by keyboard alone. The end-to-end test checks headings and button names on each page it visits.
