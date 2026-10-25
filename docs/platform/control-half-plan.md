# The control half, to production

Where this stands on 2026-10-23, what is left, and the order it is done in. Nine focused working sessions, plus the time
Marco spends on the two cabinet machines themselves.

## Status on 2026-10-25

**Done since this plan was written.** Session 1 (the server's side of a control request: the console's control routes gate
on the entry key, step-up is bound to it, one audit row per request — `server/src/console-api/control-routes.ts`).
Session 3 (the console's Services and Processes pages: watched services per cabinet, site, client and fleet, start/stop,
before and after state on every control action). Session 4 (errors and before/after snapshots only — the row is written
before the refusal is thrown, and a change that moved nothing stores nothing). Session 8 (the second Windows
architecture: both archives built, hashed and published; architecture reported at enrollment and on every check-in,
stored, and shown in the fleet views; a release carries the architecture of the programs inside it, and a
cross-architecture rollout is refused before any row is created).

**Five sessions left — 2, 5, 6, 7 and 9.** `app.restart` is still absent from the catalog (Session 2). `network.test`
takes a count and returns loss and jitter, but the 30-minute loop with a named peer and a platform-set duration is not
built (Session 5). Session 6 is part done: the read-only install and the read path were proven on real hardware, but the
full acceptance (enroll, approve, control, deliberately break it, watch the console explain it) has not run. Session 7's
audit windows and unattended monitoring profile are not built. Session 9 still waits on a real 32-bit cabinet on the
cabinets' own network.

The guided-demo browser test that stalls on the demo confirmation step still belongs to Session 6; it passes on a clean
run and fails when the suite is run alongside other work, so it is a flake to fix, not a broken feature.


## Done

1. **The list, on the platform.** `contracts/schemas/console/approved-apps.schema.json`, migration `0006_approved_apps.sql`,
   `server/src/services/approved-apps.ts`, the tier-gated route, step-up, audit. One JSON column per level (fleet → client
   → site → cabinet), the most specific level with a list winning whole.
2. **The list, delivered.** The resolved list rides the heartbeat next to the scanner IDs and the watched services
   (`contracts/schemas/envelopes/heartbeat-response.schema.json`). It is optional in the envelope, so a cabinet talking to
   an older server gets an empty list and touches nothing; a directly tampered database column can only narrow a level,
   never widen it.
3. **The list, enforced on the cabinet.** The agent holds its own copy, re-validates every entry, and refuses before
   Windows is called: a service is matched by key name *and* by the program its registered path points at right now, a
   program by its whole path, and `process.end` is checked inside the broker by reading the program running under the
   process ID.
4. **Failures in words.** 95 platform refusals, every HTTP status a console can meet, the network failures, and the
   installer failures this project actually hit — each with what happened, what it means, and the next action, naming
   Admin or Tier 2 when the action needs a permission. An unknown failure is never guessed at.
5. **The test data out of the live platform.** The `PetFolk` client and its `Scottsdale` site are soft-removed
   (`removed_at`), the way `admin.removeClient` does it; its three cabinets were already `status = 'removed'` with their
   certificates revoked. The `Home` client, its `North Phoenix` site and the `deviceb` cabinet followed on 2026-10-23, so
   the platform now lists nothing: every cabinet from here is a real one Marco enrolls by hand on the cabinets' own
   network and approves himself. Cleanup is at the database layer, so it leaves no audit row; `audit-verify` passes.
6. **The console owns the domain root.** `https://marcofernstaedt.com` serves the console (built with `CONSOLE_BASE=/`),
   `/console*` redirects to the root so links already sent keep working, and the apex is answered by a Vercel project
   that only routes to the console's front. Marco's portfolio keeps its repository and its own address.
7. **Installing an agent is a generated launcher.** A cabinet is `Download agent` → `Create token` → `Download`
   (`token.txt`, `platform-ca.pem`) → `Copy commands` into an administrator PowerShell, and the pasted block unpacks the
   package itself, puts the two files where the installer reads them, and installs. The setup page also hands out
   `Install-CabinetAgent.cmd`, which does those three steps on a double-click; it carries no secret.
8. **The 32-bit answer, measured.** Publishing all four programs for `win-x86` succeeds with no source change and the
   executables come out i386, single-file and self-contained. What is missing is everything around the build (Session 8);
   the plan for it, with the decisions it needs, is in [second-architecture.md](second-architecture.md).

## Left, in order

**Session 1 — the server's side of a control request.** The console's control routes gate on the entry key, not on a raw
PID or service name; step-up bound to the exact entry; one audit row per request with the outcome. Takes the platform from
"the cabinet would refuse" to "the platform can ask".

**Session 2 — `app.restart`, the second control the milestone names.** Add the operation to the catalog and the contracts,
the handler on the cabinet behind the same allowlist (an application's image path re-checked, its publisher's signature
verified if the entry carries one), the platform route, and the console action.

**Session 3 — the console page.** Services and Processes become what the operator actually uses: watch or approve a
service, approve a program by path, enter a PID only as a pointer that fills the durable fields and is then discarded.
Before/after state for every control action, an entry that has stopped matching flagged on the cabinet that reported it,
and one-click re-pin from that cabinet's own inventory.

**Session 4 — what is stored.** Errors and before/after snapshots only; a healthy cabinet stores almost nothing. Drive
health already keeps one sample a day per drive with reallocated, pending, uncorrectable, wear and temperature, and
`server/src/services/trends.ts` judges the trend (a rise in reallocated sectors in 30 days is urgent, a full-wear
projection is dated). The rule to apply here is to the control actions and the watcher: no rows while nothing is wrong.

**Session 5 — the sustained connection check.** `network.test` takes a count and returns loss and jitter; a 30-minute loop
needs a spec change (the count is capped at 10 today), a named peer and duration from the platform, satellite → sync by
default, satellite → satellite on request, and results that store transitions and failures only.

**Session 6 — cleanup and the hardware proof.** Remove what nothing uses, fix the guided-demo browser test that stalls on
the demo confirmation step, and run the whole thing on the two real machines: enroll, approve, control, break it on
purpose, and watch the console explain it.

**Session 7 — the platform stays dynamic without losing the boundary.** Two things Marco asked for. Audit history gets
real time windows — 15 minutes, 1 hour, 6 hours, 24 hours and a custom range down to the minute — alongside the actor,
action, cabinet and version filters, filtered in SQL with pagination and scoped to what the signed-in operator may see.
And the Setup page's PowerShell picker stops being only about the installer: next to the engine (Windows PowerShell 5.1
or PowerShell 7) sits the **unattended monitoring profile** — which read-only checks the agent runs on its own schedule
and how the watchdog behaves. That is where "which scripts the agent uses to watch things when we are not around" lands
without giving the agent a script engine, which would break the rule that it may only run catalog operations.

**Session 8 — the second Windows architecture.** Some cabinets are 32-bit. The probe says the code itself is fine:
publishing all four programs for `win-x86` succeeds with no source change, and the four executables come out i386
(`machine 0x014c`), single-file and self-contained. What is missing is everything around the build, and each piece is
load-bearing:

- `RuntimeIdentifiers` is `win-x64` only (`agent/Directory.Build.props`), and the release pipeline builds and publishes
  one archive. Two architectures means two archives per version, built and hashed together.
- Nothing knows a cabinet's architecture. `check-in.schema.json` carries `version` and `at`; enrollment does not carry
  it either. Add it to the check-in (and enrollment), store it, show it in the console's fleet views.
- **The upgrade manifest has no architecture field** (`product`, `version`, `minimumVersion`, `sha256`, `sizeBytes`,
  `releasedAt`, `notes`), and a rollout hands a version to every cabinet in the batch. Without an architecture on the
  manifest and a match against the cabinet's own, a rollout stamps the x64 archive onto a 32-bit cabinet — the one
  failure mode that can leave a machine unable to start, on a machine we would then have to fix by hand. This is the
  reason the session exists, not the build.
- The console's install command and the Setup page must hand out the archive for the machine in front of the operator.
- The installer and the updater must read the 64-bit registry view explicitly (`HKLM\SOFTWARE`, not the redirected
  `WOW6432Node`), so a 32-bit PowerShell and a 64-bit one find the same installation.
- The P/Invoke used for hardware and services is already pointer-size correct — the structs use `IntPtr` and
  `Marshal.SizeOf<T>`, not fixed-width stand-ins — so nothing there needs rewriting. That is a reading of the code, not
  a measurement on a 32-bit machine.

**Session 9 — a 32-bit cabinet, for real.** Enroll one of the 32-bit machines and run the same acceptance as Session 6:
install, approve, read, control, then push an update and watch it land and report the right architecture. This is the
only step that turns Session 8 from "publishes" into "works", and it needs a real 32-bit cabinet on the network the
cabinets use.

**Windows 7 or 8.1 would change the answer, and that is a decision, not a task.** .NET 10 supports Windows 10 1607 and
later on x86 and x64 (Microsoft's own table lists `Arm64, x64, x86` for Windows 10 and 11). Windows 7 SP1 and 8.1 are
outside that table: no .NET 10 build runs there at all, so a 32-bit cabinet on those versions needs a separate
.NET Framework build of the agent — a second target framework, a WMF 5.1 requirement for PowerShell, TLS 1.2 turned on
by hand, and another acceptance pass. Worth knowing before Session 8 is built rather than after.

## Reachability, which has to be settled first because the cabinets are on another network

**Settled:** Marco chose the second option — the port made public — because the cabinets are on their own network and
will not join the tailnet. It is committed as `27077c6`: `deploy/compose.public.yaml` publishes `0.0.0.0:8443` with
mutual TLS intact, and the port answers `/health` from outside the VPS. The tailnet option is kept below for a fleet
that could join it.

The agent API listens on port 8443 and terminates mutual TLS itself — the cabinet presents the certificate the platform
issued it, and nothing else gets in. It is bound to the tailnet address today, so a cabinet outside the tailnet cannot
reach it at all. Two ways to fix that, in the order I would pick them:

- **Tailscale on each cabinet (recommended).** Nothing becomes public. The cabinets join the tailnet with a tagged key,
  the access rules let a `tag:cabinet` device reach only 8443, and the installer is pointed at
  `https://srv1522777.tail72f980.ts.net:8443` — the value that is already correct and needs no server change at all.
  Certificate authentication stays exactly as it is, layered under the tailnet. It costs one Tailscale install per cabinet
  and their outbound access has to allow it, which a locked-down network usually does because Tailscale dials out.
- **The port made public.** Open 8443 at the provider's firewall and bind the API to all addresses. Mutual TLS still does
  the authenticating, but the port answers the whole internet, and a proper certificate means a DNS name pointing at
  `168.231.67.178` — a record Marco has to add himself.

Funnel is not an option for this port: it terminates TLS, which is where the cabinet's certificate is checked.

## Loose ends that are not sessions

- **Production signing is unproven end to end.** A development cabinet accepts an unsigned upgrade
  (`AllowUnsignedDevelopmentUpgrades=true`) and 0.2.1 → 0.2.2 landed that way; a signed rollout from the release key has
  never been pushed to a real cabinet.
- **`Cabinet.Agent.TestAgent` does not build in Release** (exit 2); only `-c Debug` builds. Any release pipeline that
  runs the agent's tests hits this first.
- **Two suite failures reproduce against sibling work in the tree**, not against the committed tree
  (`upgrades.test.js` "release store", `ResultOutboxTests.Results_survive`). Confirm before treating them as real bugs.
- **`ServiceWatcher` starts watched services without consulting the approved list.** Watching is not approving; decide
  whether a watch implies a start or only observation, because that decides what the approved list has to cover.
- **The guided-demo browser test stalls on the demo confirmation step** (Session 6 clears it).
- **Windows 7 or 8.1 on a 32-bit cabinet would need a second target framework.** .NET 10 starts at Windows 10 1607; if a
  cabinet is older than that, Section 8 grows a .NET Framework build and another acceptance pass.
- **The agent API's certificate names an IP, not a name.** `AGENT_API_HOSTNAMES` covers the addresses the cabinets dial
  and works from outside the tailnet, but a DNS name pointing at `168.231.67.178` would survive a renumber and read
  better in the installer.