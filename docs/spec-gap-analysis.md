# Spec gap analysis

How the current build compares with the platform specification in [docs/spec](spec/00-README.md) (received 2026-10-06). The spec is the target; this repository is a working demo that predates it. Use this page to decide what to build next.

Legend: **Done** matches the spec · **Partial** exists but differs · **Missing** not built · **Differs** built another way on purpose.

## The big decision first: stack

| Spec | Current build | Status |
|---|---|---|
| Server: Node 22 + TypeScript + Fastify, PostgreSQL | C# ASP.NET Core Server (SQLite for dev, PostgreSQL migrations exist) | **Differs** |
| Console: React + TypeScript + Vite, static, same origin as the console API | Plain JavaScript browser app (no build step) behind a small Node server that holds sessions | **Differs** |
| Contracts: shared JSON Schema files, validated by agent and server | C# `CabinetPlatform.Contracts` types shared by Agent and Server | **Differs** |
| Agent: C# .NET 8 Windows service | C# .NET 8 Windows service | **Done** |

The spec's own reasoning (00-README) says neither server stack wins on security alone, and it picks Node for one language across server and console. Two realistic paths:

1. **Follow the spec's build plan from Milestone 0.** New `contracts/`, `server/` (Fastify) and `console/` (React), reusing what carries over: Agent collectors and gateways, the console's screens and UX, the demo sandbox idea and the install scripts. This is the faithful path and the larger effort.
2. **Keep the C# Server and amend the spec** to record that choice, then close the functional gaps below in place. Faster to a fuller product, but it departs from a decision the spec states explicitly.

This needs your decision before more server work. The demo keeps working either way.

## Agent

| Spec item | Current | Status |
|---|---|---|
| Network process (low privilege) + LocalSystem broker over a locked named pipe | One process running as LocalSystem | **Missing** |
| Fixed operation catalog, compiled in, unknown names rejected | Yes (`ActionName` enum, monitoring boundary) | **Done** |
| Six-step command validation incl. replay (seen-ID store) and expiry (read 5 min, write 2 min) | Server-side expiry is 30 min; no agent-side replay store | **Partial** |
| Local rate limits (writes 20/h, tests 10/min, reads 60/min) | None on the agent | **Missing** |
| Allowed event log list incl. operational channels; never the Security log | Application/System via saved views plus named channels. The historical-process read (`GetHistoricalProcessEvidence`) reads Security log events 4688/4689, which the spec forbids | **Partial**: Security log use must be removed |
| `eventlog.channels` / `eventlog.query` / `eventlog.get` (browse any allowed log, entry detail with raw XML) | Saved-view queries only, bounded message text | **Partial** |
| `devices.list`, `drivers.list`, `peripheral.status` (fingerprint scanner) | Not built | **Missing** |
| `updates.status`, `disk.smart`, `network.config`, `firewall.state`, `system.info` | Covered by check-in inventory, SMART readings and InspectFirewall | **Partial** (shape differs) |
| `files.list` (C: listing only) | Not built | **Missing** |
| `network.test` to four fixed target kinds | Sync-cabinet ICMP probing (retired paths) | **Partial** |
| Write ops: `network.setIp/setDns`, `firewall.setProfile/setRule/restore`, `package.install`, `driver.uninstall` | Deliberately compiled out (monitoring-only build) | **Missing** |
| Safety-net rollback, firewall snapshots and timers, change attribution | Historical code only in the legacy test build | **Missing** |
| Read-only install mode | Monitoring-only by build, not a per-install setting | **Partial** |
| Data under ProgramData, binaries Authenticode-signed, self-check | Data under Program Files (installer), unsigned | **Missing** |
| Background monitors (event watcher, scanner watcher, firewall detector, SMART daily) and on-disk event queue | Periodic check-ins with a payload buffer | **Partial** |

## Protocol and enrollment

| Spec item | Current | Status |
|---|---|---|
| Mutual TLS on a separate agent hostname and port; console internal-only | HTTPS with a shared agent key (live demo) or per-device Office tokens; one Server | **Missing** |
| `/agent/v1/*` endpoints, 25 s long poll, 60 s heartbeat | `/api/agent/*`, poll each check-in (60 s from the installer) | **Partial** |
| Enrollment: agent key pair + CSR + one-time bootstrap token + fingerprints (serial, MACs) → admin approval → certificate (90 days, auto-renew, revocation by serial) | Registration with machine ID, hostname and OS → admin approval with client, site, role | **Partial**: no certificates; fewer fingerprints |
| Result and event envelopes, rejection codes | Different shapes | **Differs** |

## Server

| Spec item | Current | Status |
|---|---|---|
| Argon2id passwords, lockout, per-account and per-address limits | PBKDF2 (210k iterations), lockout, per-IP limit | **Partial** |
| Two-factor (authenticator app); mandatory for Tier 2/Admin; step-up code per write/admin action | None | **Missing** |
| Server-side sessions, HttpOnly/Secure/SameSite=Strict cookie, Origin check, idle 30 min / absolute 12 h | Console server does this; absolute is 8 h | **Done** (absolute timeout differs) |
| Roles: Tier 1 read, Tier 2 writes, Admin admin | Tier 1 = Tier 2 (no writes exist); Supervisor = Admin | **Partial** |
| Last remaining Admin cannot be deleted or demoted | Only self-demotion and self-deactivation are blocked | **Partial** |
| Issue types, symptom rules (no regex), Map to issue, proposals and approvals, suppressions | Not built | **Missing** |
| Alerts engine: correlation, major/minor, atomic claim, SSE live stream, offline threshold alert | Connectivity alerts with acknowledge/resolve; polling | **Partial** |
| Software library with two-person approval and signature checks | Not built | **Missing** |
| Fleet write pause, per-user write limits | Not applicable yet (no writes) | **Missing** |
| Audit: append-only DB account, hash chain, daily verification | Audit log for every action, but no hash chain or insert-only account | **Partial** |
| Security alerts to Admins | Not built | **Missing** |
| Presence (who is online) | Not built | **Missing** |
| Signed upgrade channel and staged rollout | Not built | **Missing** |

## Console

| Spec item | Current | Status |
|---|---|---|
| Sign-in with authenticator step; forced authenticator setup | Sign-in and forced password change; no authenticator | **Partial** |
| Navigation: Fleet, Alerts, Issues, Admin; alert badge | Dashboard, Cabinets, Sites, Alerts, Diagnostics, Audit, Admin; badges | **Partial** |
| Client view (sites with roll-ups) | Sites list and site view; no client roll-up page | **Partial** |
| Cabinet view: sticky name, sidebar of the site's cabinets, jump control | Name and path header, tabs; global search instead of jump; no site sidebar | **Partial** |
| Event log browser per channel with filters, paging and full entry detail | Saved-view results with a level filter | **Partial** |
| Devices and drivers, fingerprint scanner, firewall, software, files, command history sections | Processes, services, storage, network, updates, system, activity | **Partial** |
| Write confirmations with step-up | Not applicable yet | **Missing** |
| Admin: users ✓, pending queue ✓, audit ✓, online now, per-user activity, clients and sites, software library, issue types and suppressions, fleet safety, security alerts, settings, upgrades | Users, pending queue, audit list | **Partial** |
| Times to the second with zone named | Yes | **Done** |
| WCAG 2.2 AA, live regions, focus management | Semantic structure, keyboard and focus handled, status always has text; not formally audited | **Partial** |

## Built here but not in the spec

- **Demo mode** (sample fleet mixed with real cabinets) and the **getting-started tour**. The spec has neither. Both are console-only and easy to carry forward.
- **Saved event log views** (e.g. "Recent errors and warnings"). The spec instead browses whole channels. Views could remain a convenience on top.

## Suggested next steps

1. Decide the stack question above.
2. Whichever path you choose, fix the one spec violation in the current Agent first: remove the Security-log read (`GetHistoricalProcessEvidence`) from the catalog. The Console already hides it from **Run diagnostic**; the Server and Agent still accept it.
3. Then follow the spec's milestones in order. Milestone 3 (console read diagnostics end to end with two-factor and the event log browser) is the next most demo-visible piece.
