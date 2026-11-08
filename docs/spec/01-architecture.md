# Architecture

## Purpose

An internal support tool that lets Mashura support staff diagnose CUBEX and Zimbis cabinets from a web console instead of remoting into each machine. It reads event logs, devices, drivers, drive health, updates, network and firewall settings, and makes a small set of approved changes: network and DNS settings, firewall settings, and installing signed drivers and installers from an approved library. It does not provide remote control or screen sharing; that stays with LogMeIn Resolve.

## Components

- Console: a React web app support staff sign into. Shows clients, sites, cabinets, alerts and diagnostics, and lets authorized staff trigger operations.
- Server: a Node service that authenticates staff, relays their requests to agents, stores results, raises alerts and keeps the audit log. It originates no command without a person's approval: every command traces back to a person clicking something, or to a change an Admin approved with an authenticator code that names what follows from it (a replaced cabinet's settings put back on its replacement, issued in that Admin's name; 05-server-spec.md "Replacing a cabinet").
- Agent: a C# Windows service on each cabinet, split into a low-privilege network process and a privileged broker that never touches the network. It connects outward to the server, polls for commands, runs only operations in its fixed catalog, and reports results. It also watches the cabinet in the background and reports errors and changes.

## Request flow

1. A support member clicks an action in the console.
2. The console sends the request to the server.
3. The server checks the user's role, and for write operations the step-up verification, then records the command and the audit entry.
4. The agent picks up the command on its next poll.
5. The agent validates the command against its catalog and the replay rules, runs it, and posts the result.
6. The server stores the result and pushes it to the console.

## Background flow

The agent also sends data the server never asked for: heartbeats, detected errors, firewall changes and drive health warnings. This is agent-originated reporting, not a command, so it does not conflict with the rule that the server originates nothing.

## Module ownership of tables

Every table has one owning module, named in `server/src/db/table-owners.ts` (F21.R2, decision-log D56). The other source files that write a table today are listed with it as debt. `table-ownership.test.ts` reads the source and fails on:
- a write by an unlisted file;
- a listed writer that no longer writes the table, so the list only shrinks;
- a table without an owner.

A new table names its owner before anything writes it.

## Cabinet roles

- Sync: the cabinet that synchronizes the site
- Satellite: a cabinet that depends on a sync cabinet
- Standalone: the only cabinet at its site

The role is set by an admin when approving the cabinet and can be changed later by an admin. The console shows it everywhere a cabinet appears, because it changes which diagnostics apply.

## Organization of the fleet

Clients contain sites, and sites contain cabinets. About 8,000 cabinets are in the field.

## Scope

In scope:

- Read diagnostics, a fixed set of write operations, alerts, error telemetry, audit, user administration, signed agent upgrades
- The platform's own database, on the server: support team and admin accounts, cabinet records, alerts, and the log of everything each support member did on each cabinet

Out of scope:

- Windows 7 cabinets. The agent is not deployed to them.
- Remote control or screen sharing. LogMeIn Resolve covers this.
- The cabinet application's database. Each cabinet runs a database that stores the CUBEX application's own data for the client. This platform never reads, queries or changes it.
- Data from the CUBEX, Tester or Pixie applications, including their logs and any drawer, lock or sensor data. The platform reads only what Windows itself reports.
- General file transfer, EXE installers and scripts. Files reach a cabinet only as signed packages from the approved software library.
- The Windows Security event log.
- Bulk changes across many cabinets at once, other than signed agent upgrades.
- External notifications. No SMS, email or Slack; alerts stay inside the console.

## Design principle

Assume the server will be compromised someday, and limit what an attacker can do from there. The fixed operation catalog, the agent's privilege separation, the approved software library, the signed upgrade channel and the audit log all follow from this.
