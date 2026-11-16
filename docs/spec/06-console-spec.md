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

- Fleet view: the clients, and **Windows in the fleet** (F20, decision-log D55): the active, non-demo cabinets counted by Windows edition (the version text system.info reports), build family (the build before its first dot), the lowest and highest full build seen in it (the update revision compared as a number), and architecture, from each cabinet's latest system.info; at most 200 groups. It says how many cabinets were never read, and that the update source (Windows Update, WSUS) is not read by any operation yet. `GET /api/fleet/compatibility`, Tier 1 and up.
- Client view: all sites for one client, with each site's open alerts and errors rolled up, and the client's totals at the top
- Site view: all cabinets at one site, each showing name, role, online or offline, agent version, read-only mode and open alert count; a satellite with no sync cabinet is marked "Enrollment incomplete". The cabinets are paged by the server, one screenful at a time - as many rows as fit comfortably - under the site's full count, and Next shows the next page of the same size (`GET /api/fleet/sites/:id?limit=&offset=`, at most 500 a page, checked against `site-page-query`; decision-log D99, which supersedes D81's 25). A screen that picks one of a site's cabinets (the approved-programs cabinet picker, and the cabinet an enrollment replaces) reads every page, so it offers every cabinet of the site (decision-log D85). The site also lists its sync cabinets with each one's address and where it comes from (reported, or set by an Admin), and how many satellites wait for one.
- Cabinet overview: a satellite shows the sync cabinet it reaches, and a sync cabinet its address and satellites. An Admin assigns a satellite, or sets a sync cabinet's address, with an authenticator code.
- Cabinet view: one cabinet in detail

## Screen size

- The console is for desktop and laptop screens, 1024 px wide and up (decided with the owner, October 2026). From 1024 to 1199 px the top bar wraps and the cabinet menu narrows; wide data tables scroll within their own containers. A narrower window keeps the desktop layout, scrolls sideways and shows a one-line notice. There is no tablet or phone layout. Browser tests check 1024, 1280, 1366, 1440, 1920 and 2560 px.

## Cabinet view

- The cabinet's name is always shown clearly at the top, with its client, site and role directly beneath. It stays visible while scrolling.
- A left menu holds the cabinet's tabs in groups (Windows, Hardware, Network, Record), and under it the other cabinets at the same site, each with offline state and alert count, for one-click switching.
- The Overview starts with a summary: online state, last contact, agent version, uptime, scanner state, open alerts, last known healthy, and the three most useful next actions. Last known healthy has one definition (F8.R1, decision-log D41): the configuration health's, from `cabinet_health` ("Now" while it is judged healthy, else the last time it was, linking to the Baseline tab). With no time to give it says why: not judged yet, no configuration reported, no approved baseline, or never seen healthy. It is not worked out from alerts or contact.
- **System** (decision-log D58), under the summary and visible to every role, shows the cabinet at a glance:
  - Windows: edition, build, architecture and uptime;
  - processor: model, logical cores and CPU in use;
  - memory: in use against installed, with a meter, and the number of modules;
  - the machine: make, model, BIOS version and date, TPM and Secure Boot;
  - each drive: used percentage with a meter, free space, size and file system.

  Each figure comes from the latest stored read (`system.hardware`, `system.info`, `system.performance`) or the latest heartbeat load sample, with how long ago it was read. "Read now" asks the cabinet again. `GET /api/cabinets/:id/summary`, Tier 1 and up. Meters turn amber at 85% used and red at 95% (92% for a drive).
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
- Connectivity tests with one button each: gateway, DNS servers, the satellite's sync cabinet, the platform server
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
- Pending queue: each enrollment request with its fingerprints shown in full, with approve and reject. Approval asks for client, site, cabinet name, role and a baseline decision (15-baselines-and-config.md "Baselines at enrollment"); for a new site it shows the firewall policy and time zone the site would inherit, which the approver keeps or sets as the site's own (05-server-spec.md "Site policies"). At a known site it offers "Replaces": the site's active cabinets of the chosen role, the ones not heard from first; choosing one fills in its name, and the confirmation says what happens to it (05-server-spec.md "Replacing a cabinet"). A replaced cabinet's page says what replaced it, with a link, and the replacement's page links back.
- Clients and sites: create, rename, remove; and import in bulk (F6.R4, decision-log D39): a pasted list, one line per site ("client, site", comma or tab separated, a quoted field may hold a comma), previewed against what exists (`POST /api/admin/import/preview`, no code), then imported with one authenticator code bound to exactly those rows (`POST /api/admin/import`, action `fleet.import`). At most 200 rows. A client or site that exists is used as it is, so the list can be imported again; a site listed twice is refused (`duplicate_row`), a demo client refuses the list (`demo_client`), and a list with nothing new is refused (`nothing_to_import`). The import is one transaction: each new client and site gets its own `client.create` / `site.create` audit entry (marked `via: import`) and the import one `fleet.import` entry, or nothing is created. Cabinets are not imported: a cabinet exists once it enrols, and a site installer for many cabinets (F6.R1) with batch approval (F6.R2) is the bulk path for them.
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
