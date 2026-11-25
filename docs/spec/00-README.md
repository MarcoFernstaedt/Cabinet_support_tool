# Cabinet Diagnostics Platform: Build Specs

These files are the build specification for the Mashura cabinet diagnostics platform. They are written to be coded from directly, by you or by a coding agent.

## Order to go through them

Read them in number order. Files 01 and 02 give the shape and the security rules everything else follows; 03 through 07 are the component specs; 08 is the build order; 09 lists choices to confirm; 11 is the summary for your head of development. 12 and 13 are the later milestone specifications, and 14, 15 and 16 cover work specified after them.

The platform as it actually is — what is proven, what is left, and how it runs — is documented separately, starting at [../platform/README.md](../platform/README.md). **What is left lives in [../platform/plan-to-completion.md](../platform/plan-to-completion.md).**

## Files

- 01-architecture.md: the three components, request flow, cabinet roles, what is in and out of scope
- 02-security-model.md: the threat model and every security control, in one place
- 03-protocol.md: the contract between agent and server: message formats, polling, replay protection
- 04-agent-spec.md: the Windows service on each cabinet, with the full operation catalog
- 05-server-spec.md: the Node server: agent API, console API, enrollment, alerts engine, audit log, the platform database
- 06-console-spec.md: the React web console: navigation, views, alerts, admin screens
- 07-upgrade-channel.md: signed remote agent upgrades and staged rollout
- 08-build-plan.md: milestones in build order, with what "done" means for each
- 09-open-decisions.md: choices still to make, each with a recommended default
- 11-security-review-brief.md: what the platform can and cannot do to a cabinet, worst cases, remaining risks and rollout gates, written for approval
- 12-milestones-8-to-12.md: confirmation levels, the client firewall policy and bulk apply, services and watched services, network diagnostics and automatic diagnosis, health snapshots, trends, triage, runbooks and resolution notes
- 13-roadmap.md: the October 2026 module list (modules 1 to 47) mapped to what exists, the phase that builds the rest, and how each fits the security rules
- 14-emergency-access.md: the local console on the cabinet for when it cannot reach the platform, and the short single-use authorization that unlocks it (milestone 14, not built yet)
- 15-baselines-and-config.md: configuration baselines and snapshots, and how a cabinet's settings are compared against them
- 16-network-troubleshooting.md: finding a network problem on one cabinet, several, or a whole site, and fixing it
- 17-phase-7-and-beyond.md: fleet correlation, known errors and self-healing, proposed and not approved
- 18-built-designs.md: the built designs code cites for its reasons: the 32-bit build, the diagnostic engine, network targets, the file-facts read, the USB watch, the server side of a control request

## Stack

- Agent: C# on .NET 10 (moved from .NET 8 in October 2026, before .NET 8 support ended), running as a Windows service on Windows 10 and 11
- Server: Node.js 22 LTS with TypeScript and the Fastify framework
- Console: React with TypeScript, built with Vite, served as static files
- Contracts: JSON Schema files shared by all three, the single source of truth for every operation
- Platform database: Microsoft SQL Server 2022, holding the support team accounts, fleet records, alerts and activity logs. Not the cabinet application's database, which the platform never touches.

## Why Node instead of ASP.NET Core

Both are secure when used with discipline, so neither wins on security alone. ASP.NET Core's real advantages are mature built-in authentication and client-certificate handling, and sharing C# types with the agent. Node's real advantages are your existing fluency and one language across server and console. Security comes more from how well you know the framework than from the framework, so Node is the better pick here, with three conditions:

- Every route validates its input against a schema before any handler code runs. Fastify does this natively.
- Dependencies stay minimal, pinned by lockfile, and checked with npm audit on every build.
- The operation contracts live in shared JSON Schema files, so the agent and server cannot silently drift apart.

## Why plain React instead of Next.js

No genuine benefit here, and a real cost. Next.js earns its keep with search engine visibility and server rendering, and this is an internal console behind a login, so neither matters. Next.js also adds a second server-side runtime with its own attack surface; in 2025 its middleware had an authentication bypass flaw (CVE-2025-29927). A static React app talking to one API keeps the attack surface to a single server you control.

## Ground rules for whoever writes the code

- The agent never executes anything not in its operation catalog. No shell, no eval, no generic run command, ever.
- No general file transfer. Files reach a cabinet only as signed packages from the approved library.
- External programs the agent calls are launched with argument arrays, never a composed command string.
- Every security decision is enforced on the server or the agent, never only in the console.
- Anything not specified here is a question, not a guess. Add it to 09-open-decisions.md.
