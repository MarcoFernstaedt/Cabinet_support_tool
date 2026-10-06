# Build Plan

Build in this order. Each milestone ends with something that runs. Milestones 1 through 3 together are the prototype to demonstrate to the dev team.

## Repository layout

- agent: the C# solution, with separate projects for the network process, the broker, the operation catalog, and tests
- server: the Node and TypeScript service
- console: the React app
- contracts: JSON Schema files for every operation's parameters and output, and for every message envelope
- docs: these spec files

## Milestone 0: contracts

- Write the JSON Schemas for all envelopes and every operation.
- Generate TypeScript types from them for the server and console.
- Add a C# test that checks the agent's types against the same schemas.
- Done when: both sides build against the shared contracts.

## Milestone 1: agent read operations, offline

- Build the network process and the broker as two services, with the locked-down local pipe between them.
- Build the command validation steps and the local rate limits.
- Implement every read operation, including the event log channels, entry detail, device list, fingerprint scanner status and network tests.
- Confirm the allowed event log channel names on a real cabinet.
- Add a local test harness that feeds commands from a file, so operations can be tested on a cabinet without a server.
- Done when: every read operation returns correct output on a real cabinet, every rejection code is covered by a test, and a test proves no process other than the network process can talk to the broker.

## Milestone 2: server and enrollment

- Set up the platform database with migrations, including the insert-only account for the audit table.
- Build the agent API with mutual TLS, enrollment, the pending queue and certificate issuing.
- Add heartbeats and the long-poll command channel.
- Done when: one cabinet enrolls, is approved, and stays online with a valid certificate; a machine without a certificate is refused.

## Milestone 3: console and read diagnostics end to end

- Build login, with the authenticator code step for accounts that have two-factor on and authenticator setup for Tier 2 and Admin, plus sessions, roles, and the client, site and cabinet views with the sidebar and jump control.
- Wire every read operation from console to agent and back, including the event log browser with entry detail.
- Log cabinet views and opened event log entries to the audit log.
- Done when: a Tier 1 user can find a cabinet, browse every allowed event log, open any entry in full, and run every read diagnostic, and the audit log shows each view.

## Milestone 4: alerts, issues and telemetry

- Add the agent's monitors and event queue.
- Build issue types, symptom rules with built-in starting rules, the unrecognized-error list, and the Map to issue flow with fleet preview and Admin approval.
- Build correlation, major and minor alerts, claiming, the live stream, and the offline filter with the threshold alert.
- Done when: a forced fingerprint scanner disconnect raises Fingerprint scanner problem; an unrecognized error can be mapped to that issue, approved, and the next occurrence raises it; a major alert reaches every signed-in console and only one person can claim it.

## Milestone 5: write operations and the software library

- Add step-up tokens.
- Build the software library: upload, server-side signature checks, two-person approval, retirement.
- Implement every write operation: network.setIp, network.setDns, firewall.setProfile with timers, firewall.setRule, firewall.restore with snapshots, package.install and driver.uninstall.
- Add the safety net, firewall change attribution, the write pause and per-user write limits.
- Done when: each write works on a test cabinet; a bad network or firewall change reverts itself; a firewall profile turned off for 5 minutes comes back on, including across a reboot; an unsigned package, a tampered package and a package from an unlisted publisher are each refused by the server and, when forced past it in a test, by the agent; a read-only cabinet refuses every write; and every write is in the audit log.

## Milestone 6: administration and monitoring

- Build user management, online presence, per-user activity, the audit log viewer with chain verification, clients and sites, suppressions, fleet safety controls, settings, and security alerts.
- Done when: an admin can manage accounts, answer "who looked at this cabinet and when" from the console, pause writes, and sees a security alert for each trigger in 05-server-spec.md.

## Milestone 7: signed upgrades

- Set up the KMS key and pipeline signing, the updater, and staged rollouts.
- Done when: a signed upgrade rolls out to a test batch, a tampered package is refused, and a failed upgrade restores the old version on its own.

## Field rollout

Each stage has gates that must be met before it starts.

1. One cabinet: milestones 0 through 5 done, tested on an office cabinet first.
2. All in-office cabinets: everything built, a week on one cabinet with no unexplained failures.
3. Client beta: independent security test done and serious findings fixed, incident response steps written and rehearsed, database restore tested, head of development sign-off, client agreement in place.
4. Wider fleet in stages: beta clean for an agreed period.

## Testing to keep throughout

- Every operation tested against malformed, oversized and hostile parameters
- Replay and expiry tests for commands
- Role tests: every console API route tried by every role
- Audit chain tests that alter an entry and expect detection
- Package tests: unsigned, tampered, wrong publisher, wrong type, oversized
- Broker tests: requests from anything other than the network process are refused
- Rule tests: a rule can never freeze the server, and suppressions expire
- Load test of the agent API with 8,000 simulated agents polling before going wide
