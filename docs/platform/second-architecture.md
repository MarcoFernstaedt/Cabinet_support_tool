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
2. **The architecture on the wire.** `contracts/schemas/agent/check-in.schema.json` carries `version` and `at` today; it gains
   `architecture` (`windows-x64` / `windows-x86`), and the enrollment request carries it too, so the platform knows a
   cabinet's architecture from the moment it appears. One migration adds `cabinets.architecture`; the cabinet page, the fleet
   view and the activity report show it. The value means exactly one thing: **the architecture of the agent programs
   installed on that cabinet** — the one an update has to match — never a guess from the OS name or the machine model.
3. **An update can never cross architectures.** `contracts/schemas/agent/upgrade-manifest.schema.json` gains `architecture`
   (today: product, version, minimumVersion, sha256, sizeBytes, releasedAt, notes). `startRollout` and `offerFor`
   (`server/src/services/rollouts.ts`) skip cabinets whose architecture does not match the release, and report how many they
   left out next to the "below the minimum version" count that already exists. **And the cabinet checks for itself:** before
   the swap, the updater reads the PE machine of the programs in the downloaded archive and refuses a mismatch as a failed
   update with its own reason (`agent/src/Cabinet.Agent.Core/Upgrades/ReleaseVerifier.cs`). The server-side match is
   convenience; the cabinet-side check is the protection — the same division of labour as everywhere else in this platform.
4. **Setup: choose the install the way the engine is chosen.** An architecture picker beside the PowerShell engine picker; the
   page then offers that architecture's archive, and the launcher and the pasted commands carry that archive's name and hash.
   The default stays 64-bit. The install steps page says which machine takes which archive, in one line.
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
