# Console Specification

## Runtime

- React with TypeScript, built with Vite into static files
- Served from the same origin as the console API, so no cross-origin setup is needed
- Reachable only from Mashura's internal network or VPN
- Holds no secrets. Every permission check also happens on the server.

## Global layout

- Top bar: search, alert badge with the count of open major alerts, signed-in user, sign out
- Main navigation: Fleet, Alerts, Issues, and Admin for admins only
- A clear banner on every page when writes are paused fleet-wide or for the client being viewed
- Live updates arrive over the server's event stream; new major alerts appear without a refresh

## Sign-in

- Username and password first. If the account has two-factor on, a second step asks for the authenticator code.
- Tier 2 and Admin users are taken through authenticator setup at their first login, before anything else.
- Any user can turn two-factor on from their own account page. Tier 2 and Admin users cannot turn it off.

## Navigation hierarchy

- Client view: all sites for one client, with each site's open alerts and errors rolled up, and the client's totals at the top
- Site view: all cabinets at one site, each showing name, role, online or offline, agent version, read-only mode and open alert count
- Cabinet view: one cabinet in detail

## Cabinet view

- The cabinet's name is always shown clearly at the top, with its client, site and role directly beneath. It stays visible while scrolling.
- A sidebar lists the other cabinets at the same site, each with status and alert count, for one-click switching.
- A jump control opens any cabinet at another site or another client without going back up the hierarchy.
- Sections: overview, alerts, event logs, devices and drivers, fingerprint scanner, Windows updates, drive health, network, firewall, software, files, command history.
- Write actions appear only for Tier 2 and Admin, and are hidden on read-only cabinets. Each one opens a confirmation that states exactly what will change on which cabinet, then asks for the authenticator code.
- Opening a cabinet view is recorded in the audit log.

## Event logs

- The section lists every log the agent can read, with entry count, newest entry time, and a note on any log that is turned off in Windows.
- Opening a log shows entries newest first, with time, level, source, event ID and the first line of the message. Filters: level, time range, source and event ID. Results are paged.
- Clicking an entry opens its full detail: the complete message, every event field, the device involved if any, the raw event XML, which issue type it maps to if any, and how many other cabinets reported the same source and event ID in the last 30 days.
- From the detail, Tier 2 and Admin users can choose Map to issue.

## Mapping an error to an issue

The steps follow 05-server-spec.md:

1. Choose Map to issue on an event or an unrecognized alert.
2. Pick the issue type, such as Fingerprint scanner problem.
3. Review the pre-filled match: log, source, event ID, and device hardware ID if present. Each field can be kept or removed, and a message phrase can be added.
4. Read the preview: how many matching events and cabinets across the fleet in the last 30 days.
5. Choose whether to regroup matching open alerts now.
6. Enter the authenticator code and submit. A Tier 2 user sees the rule marked as waiting for Admin approval; an Admin's rule goes live straight away.

## Devices and drivers

- All Plug and Play devices, with a filter for devices with problems, showing status and Windows error code in plain words
- Installed drivers, with signer and version
- Uninstall a third-party driver (Tier 2 and Admin)

## Fingerprint scanner

- Connected or not, status, error code in plain words, driver name, version, date and signer
- Its recent events and alerts
- Install a driver package for it from the software library (Tier 2 and Admin)

## Network

- Each adapter: name, type, connected or disconnected, link speed, MAC address, DHCP or static, IP address, subnet, gateway, DNS servers and DNS suffix
- Connectivity tests with one button each: gateway, DNS servers, the site's sync cabinet, the platform server
- Edit IP settings and Edit DNS for one adapter (Tier 2 and Admin). The confirmation shows current and new values side by side, warns that the cabinet may drop off briefly, and explains that the change reverts itself if the cabinet cannot reach the server within 2 minutes.

## Firewall

- Each profile: on or off, default inbound and outbound actions, and a countdown when a profile is temporarily off
- Turn a profile off: asks for a duration, default 60 minutes, up to 8 hours. Admins can also choose no limit, with a clear warning.
- Rules: every rule, filterable by direction, action, enabled, name and port, with platform-created rules marked
- Add, edit, enable, disable or delete a rule through a structured form with a field for each property
- Firewall history: every change with before and after, marked as made through the platform with who did it, or as an unexplained outside change
- Restore: put back any saved snapshot

## Software

- Packages from the approved library that match this cabinet's hardware, with version, vendor, signer and who approved it
- Install (Tier 2 and Admin), with the result reported back, including the exact check that failed if any

## Alerts area

- Lists every alert, filterable by severity, issue type, state, client, site and assigned person
- Major alerts are highlighted. Clicking an unclaimed major alert claims it and opens its cabinet. If someone else got there first, the console says who.
- Minor alerts appear only in their cabinet's view; major alerts also appear on the home page and in the Alerts tab (decided after Milestone 6, see 09-open-decisions.md).
- Unrecognized errors have their own filter, each with Map to issue.
- Offline filter: shows clients with offline cabinets and how many, then sites, then the cabinets. Cabinets past the admin's offline threshold also appear as real alerts.
- Errors and alerts also appear in the client view and the cabinet view.

## Issues area

- Issue types with their severity, open alert counts and live rules
- Each rule's match fields, history, who proposed and approved it, and how many events it has matched
- Proposals waiting for approval (Admins approve or reject here)

## Admin screens

- Users: create, delete, reset password (forces a change at next login), reset authenticator, change role, set write limit
- Online now: who is signed in, their role, last activity and current cabinet
- Activity: per-user history of cabinets viewed and actions taken, with exact date and time
- Audit log: searchable by user, cabinet, action and date range
- Pending queue: each enrollment request with its fingerprints shown in full, with approve and reject. Approval asks for client, site, cabinet name and role.
- Clients and sites: create, rename, remove
- Software library: upload packages, approve packages uploaded by another admin, retire packages
- Issue types and suppressions: create and edit issue types, review all active suppressions and their expiry dates
- Fleet safety: pause or resume writes fleet-wide or per client, and see users whose writes were paused by their limit
- Security alerts: the security alerts listed in 05-server-spec.md
- Settings: offline alert threshold, session timeouts, retention periods, require two-factor for all accounts
- Upgrades: start, pause and roll back staged rollouts, and see per-cabinet results

Every admin action asks for the authenticator code.

## Time display

All times shown with full date and time to the second, in the viewer's local time zone, with the zone named.

## Accessibility

- Built to WCAG 2.2 AA
- Semantic headings and landmarks on every page; the cabinet name is the page's main heading
- Every control reachable and usable by keyboard alone
- New major alerts and command results announced through polite live regions
- Status never conveyed by color alone; online, offline and severity always carry a text label
- Confirmation dialogs move focus into the dialog and return it afterwards
- Event log entries and firewall rules presented as lists with clear labels, so they read well with a screen reader
