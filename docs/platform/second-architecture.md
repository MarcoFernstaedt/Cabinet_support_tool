# The second Windows architecture (32-bit), to production

Companion to [control-half-plan.md](control-half-plan.md), Sessions 8 and 9. Where this stands on 2026-10-24, the decisions
it needs before any code is written, and the order it is done in.

## The question: do we need different versions of the agent?

No code fork. One source tree, two builds from it. Windows cannot run a 64-bit program on 32-bit Windows, and a .NET
self-contained build carries the architecture it was published for, so a 32-bit cabinet needs a 32-bit *archive* of the same
agent: same version number, same operations, same signing flow. What differs is packaging and six pieces of wiring. The code
needs no change — measured, not assumed: all four programs publish for `win-x86` from this source with no edit, and the
executables come out i386 (PE machine `0x014c`), single-file and self-contained.

## Already there, so it is not rebuilt

- **The installer reads the real architecture.** `agent/install/Install-CabinetAgent.ps1` reads the PE machine of the programs
  it is handed and refuses a package that cannot start on the machine: a 64-bit package on 32-bit Windows, a 32-bit package on
  64-bit Windows, ARM64 both ways, each with the line to send to support. Nothing there needs inventing.
- **The Setup page already selects a package** by name and proves its hash in the launcher
  (`console/src/pages/admin/Setup.tsx`, `server/src/console-api/setup-routes.ts`, `installer-launcher.ts`). It serves exactly
  one archive today (`AGENT_PACKAGE`, `setup-routes.ts:12`).
- **The 32-bit programs build.** What has never happened is running them. The P/Invoke into Windows was written pointer-size
  correct (`IntPtr` and `Marshal.SizeOf<T>`, never fixed-width stand-ins) — a reading of the code, not a machine result.

## The plan, in order

1. **Two archives per version.** `agent/Directory.Build.props` `RuntimeIdentifiers` becomes `win-x64;win-x86`, and the seven
   committed `packages.lock.json` files are restored again for the added runtime so the restore stays locked.
   `Publish-CabinetAgent.ps1` takes the architecture and publishes one program set; `New-AgentRelease.ps1` publishes both and
   signs one manifest per architecture, each carrying its own SHA-256. A release is not complete until both archives exist
   for the same version.
   **Done** (commit `face016`): both runtimes, all seven lock files, and `Publish-CabinetAgent.ps1 -Architecture`. Both
   publishes verified here — `win-x86` gives four i386 programs, `win-x64` four AMD64, every one single-file and
   self-contained. One trap is recorded in the script: `dotnet restore --runtime` narrows the project's runtime identifiers
   to the one asked for, which a lock file listing both then fails (NU1004), so the restore takes no `--runtime` and the
   publish picks its own. **Done**: `New-AgentRelease.ps1` takes `-Architecture` and refuses a build whose programs are not
   that architecture (it reads each program's PE machine rather than trusting the folder), `deploy/Dockerfile` publishes and
   ships `CabinetAgent-win-x64.zip` and `CabinetAgent-win-x86.zip` with a SHA-256 beside each, and the archive README tells
   the operator to ask the machine which Windows it is.
2. **The architecture on the wire.** It belongs on `contracts/schemas/envelopes/heartbeat.schema.json` and on
   `contracts/schemas/envelopes/enroll-request.schema.json` (under `fingerprints`), as `common.schema.json#/$defs/architecture`
   — `windows-x64` / `windows-x86`, and nothing else. (Not `agent/check-in.schema.json`: that is the agent's own file for
   the update path, not a message.) Both are optional, because an agent built before this work sends neither, and they mean
   exactly one thing: **the architecture of the agent programs installed on that cabinet** — the one an update has to match —
   never a guess from the OS name or the machine model. One migration adds `cabinets.architecture`; the cabinet page, the
   fleet view and the activity report show it.
   **Part done** (commit `face016`): schemas, generated types, migration `0007_architecture.sql`, the check-in write
   (`services/cabinets.ts`) and the enrollment write (`services/enrollment.ts`). The console shows it (`ebb2003`): the fleet
   view under each cabinet's agent version, and a saved fix's environment. Still to do: the agent sends the value.
3. **An update can never cross architectures.** The architecture does **not** go on the signed manifest, and this is the
   correction to the first draft of this plan: the manifest's schema is closed (`additionalProperties: false`) and the agent
   validates the manifest with the copy it was built with, so an *older* agent would refuse a manifest carrying a field it
   has never heard of — and then no older cabinet could ever be updated. The signed bytes stay exactly as they are (product,
   version, minimumVersion, sha256, sizeBytes, releasedAt, notes), one manifest per architecture and version, each hashing
   its own archive. The architecture lives on the **release record** instead, and the platform derives it from the archive's
   own programs when the package is uploaded (the PE machine of `Cabinet.Agent.*.exe` inside the zip), refusing an upload
   whose programs contradict what the release was added as. `startRollout` and `offerFor` (`server/src/services/rollouts.ts`)
   then skip cabinets whose architecture does not match the release, and report how many they left out next to the "below
   the minimum version" count that already exists; a cabinet that has never reported an architecture is counted as 64-bit,
   because that is the only agent that has ever shipped. **And the cabinet checks for itself:** before the swap, the updater
   reads the PE machine of the programs in the downloaded archive and refuses a mismatch as a failed update with its own
   reason (`agent/src/Cabinet.Agent.Core/Upgrades/ReleaseVerifier.cs`). The server-side match is convenience; the
   cabinet-side check is the protection — the same division of labour as everywhere else in this platform.
4. **Setup: choose the install the way the engine is chosen.** An architecture picker beside the PowerShell engine picker; the
   page then offers that architecture's archive, and the launcher and the pasted commands carry that archive's name and hash.
   The default stays 64-bit. The install steps page says which machine takes which archive, in one line.
   **Done**: `INSTALL_ARCHITECTURES` and `ARCHITECTURE_HELP` in `console/src/lib/install-command.ts`, the picker and the
   "Which Windows am I on?" help on `Setup.tsx`, both packages listed by `setup-routes.ts` with a download route that serves
   exactly the architecture asked for and refuses one that is not built for, and tests for all of it. The help asks the
   machine rather than the shell on purpose: `$env:PROCESSOR_ARCHITECTURE` answers `x86` from a 32-bit PowerShell on 64-bit
   Windows, which is the wrong answer to this question.
5. **Installer and updater read the 64-bit registry view.** `HKLM\SOFTWARE` explicitly rather than the `WOW6432Node`
   redirection, so a 32-bit PowerShell and a 64-bit one find the same installation and the same service.
6. **Tests.** A check-in carrying an architecture the contracts do not name is refused, not guessed; a rollout never offers an
   archive to a cabinet of the other architecture, and says how many it left out; the updater refuses a wrong-architecture
   archive without touching the installed programs; the Setup page's command names the archive it is actually serving.

## The two proofs, and which one counts

- **The HP (Marco's desktop, 64-bit Windows).** 64-bit Windows runs 32-bit programs, so installing the 32-bit agent on it
  proves the binaries start, enroll, read, control and take a 32-bit update — the same path Salt lite will walk, without
  waiting for Salt lite. It needs one deliberate exception: the installer refuses a 32-bit package on 64-bit Windows by
  design, so this leg needs a lab-only switch (`-AllowArchitectureMismatch`) that names itself in the install log and is used
  by nothing else. **This is the decision the plan needs before building: yes or no.**
- **Salt lite, the real 32-bit cabinet.** Install the 32-bit archive, enroll it by hand on the cabinets' own network, read it,
  control it, then push a real update and watch it land and report its architecture. This is the acceptance, and it needs
  hands on the machine, not only code.

## What this session is not

Not `app.restart`, the console's control page, the storage rules, the sustained connection check, or the audit windows
(control-half-plan.md, Sessions 2–7). Not ARM64 beyond refusing it politely. Not a new operation the agent may run, and not a
second code path: the agent stays one program, published twice.
