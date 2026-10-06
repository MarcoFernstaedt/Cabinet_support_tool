# Coding Agent Handoff

How to hand this build to a coding agent such as Claude Code, one milestone at a time.

## Setup

The zip is already laid out as the repository: CLAUDE.md at the root and every spec file in the docs folder.

1. Unzip it and use the cabinet-diagnostics-platform folder as the repository.
2. Open that folder in Claude Code. It reads CLAUDE.md automatically at the start of every session; other agents can be told to read it first.
3. Give the agent one milestone prompt at a time, from the list below, in order.
4. After each milestone, review the result against its "done when" line in 08-build-plan.md, test it yourself, and commit before starting the next.

## Standing instructions for CLAUDE.md

This is the text of the CLAUDE.md file at the repository root, kept here for reference. If you change one, change the other.

BEGIN CLAUDE.MD

This repository builds the Mashura cabinet diagnostics platform. The specification lives in the docs folder and is the source of truth. Read docs/00-README.md, docs/01-architecture.md and docs/02-security-model.md before any work, then the spec files for the part you are building.

Rules that never bend:

- The agent runs only operations in its fixed catalog. Never add a shell, eval, script runner or any generic run-a-command path.
- There is no general file transfer. Files reach a cabinet only as approved software library packages, verified by hash, signature and trusted publisher on the cabinet itself.
- The agent's network process never runs with administrator rights. Privileged actions go only through the broker, which never opens a network connection.
- External programs are launched by full path with argument arrays, never through a shell or a composed command string.
- Every input is validated against its JSON Schema in the contracts folder before any other code touches it.
- Every permission check happens on the server or the agent. The console may hide buttons, but that is never the protection.
- Never put secrets, keys or credentials in the repository, in logs, or in code.
- The platform never connects to the cabinet application's database, and never reads the Windows Security log.
- Symptom rules never use regular expressions.
- Do not add dependencies without saying why. Prefer the standard library.

How to work:

- Build only the milestone you were asked for. Do not start the next one.
- If the spec does not answer something, stop and ask rather than guessing, and note the question in docs/09-open-decisions.md.
- Write tests alongside the code, including tests that feed malformed and hostile input.
- At the end, report what was built, what was tested, and anything that differs from the spec, with the reason.

END CLAUDE.MD

## Milestone prompts

Paste one per session, in this order.

### Milestone 0

Build Milestone 0 from docs/08-build-plan.md. Create the repository layout it describes and write the JSON Schemas in the contracts folder for every envelope in docs/03-protocol.md and every operation in docs/04-agent-spec.md, covering both parameters and output. Set up TypeScript type generation from the schemas and a C# test project that validates sample agent messages against them. Stop when both sides build against the shared contracts.

### Milestone 1

Build Milestone 1 from docs/08-build-plan.md: the C# agent per docs/04-agent-spec.md as two Windows services, the low-privilege network process and the LocalSystem broker, connected by a named pipe that only the network process's account can open. Build the six-step command validation, the local rate limits, and every read operation, including the event log channels, entry detail, device list, fingerprint scanner status and network tests. Include the local test harness that feeds commands from a file. No networking to the server yet. Stop when every read operation works through the harness, every rejection code has a test, and a test proves other processes cannot reach the broker.

### Milestone 2

Build Milestone 2 from docs/08-build-plan.md: the platform database with migrations, and the server's agent API per docs/03-protocol.md and docs/05-server-spec.md, with mutual TLS, enrollment, the pending queue, certificate issuing, heartbeats and the long-poll command channel. Use a local development signing key for certificates for now, clearly marked as development only, with the KMS call behind one function so it can be swapped in later. Connect the Milestone 1 agent to it. Stop when one agent enrolls, is approved and stays online, and a machine without a certificate is refused.

### Milestone 3

Build Milestone 3 from docs/08-build-plan.md: the console API's login, with the authenticator code step for accounts that have two-factor on and mandatory authenticator setup for Tier 2 and Admin, plus sessions and roles per docs/02-security-model.md and docs/05-server-spec.md, and the React console per docs/06-console-spec.md with the client, site and cabinet views, the sidebar, the jump control, the cabinet name always at the top, and the event log browser with full entry detail. Wire every read operation end to end and log every cabinet view and opened event log entry to the audit log with its hash chain. Meet the accessibility section of docs/06-console-spec.md. Stop when a Tier 1 user can browse every allowed log, open any entry, run every read diagnostic, and each view appears in the audit log.

### Milestone 4

Build Milestone 4 from docs/08-build-plan.md: the agent's background monitors and on-disk event queue; the server's issue types, symptom rules with the built-in starting rules, unrecognized errors, and the Map to issue flow with fleet preview, Tier 2 proposals and Admin approval; and the alerts engine with correlation, major and minor alerts, atomic claiming, the live event stream, and the offline filter with the threshold alert. Add the Alerts and Issues areas to the console. Stop when the "done when" checks for Milestone 4 in docs/08-build-plan.md all pass.

### Milestone 5

Build Milestone 5 from docs/08-build-plan.md: step-up tokens; the approved software library with server-side hash and signature checks and two-person approval; every write operation in docs/04-agent-spec.md, including firewall profile timers that survive reboots, firewall snapshots and restore, package.install for signed driver packages and MSI files only, and driver.uninstall; the safety net; firewall change attribution; the write pause; and per-user write limits. Stop when the "done when" checks for Milestone 5 in docs/08-build-plan.md all pass.

### Milestone 6

Build Milestone 6 from docs/08-build-plan.md: the admin screens in docs/06-console-spec.md for users, online presence, per-user activity, the audit log viewer with daily chain verification, clients and sites, suppressions, fleet safety controls, settings, and the security alerts in docs/05-server-spec.md. Every admin action requires step-up. Stop when the "done when" checks for Milestone 6 pass.

### Milestone 7

Build Milestone 7 from docs/08-build-plan.md: the signed upgrade channel in docs/07-upgrade-channel.md, with the package and manifest format, agent-side verification, the updater with automatic restore, and staged rollouts in the console. Keep the signing call behind one function with a development key for testing; the real KMS key is set up separately and never enters the repository. Stop when a signed upgrade rolls out to a test batch, a tampered package is refused, and a failed upgrade restores the old version.

## Things only you can do

- Confirm the open decisions in 09-open-decisions.md before the milestone that needs each one.
- Collect the fingerprint scanner's USB hardware IDs and the sync connection ports before Milestone 1 is finished.
- Supply the vendor details for the trusted publisher list before Milestone 5.
- Set up the real KMS keys. The agent should never be given cloud credentials.
- Arrange the independent security test before the client beta.
- Test every milestone on a real cabinet, not only on a development machine.
- Share 11-security-review-brief.md with your head of development, and update it as decisions are made.
