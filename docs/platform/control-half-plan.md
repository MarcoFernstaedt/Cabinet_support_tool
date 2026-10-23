# The control half, to production

Where this stands on 2026-10-23, what is left, and the order it is done in. Six focused working sessions, plus the time
Marco spends on the two cabinet machines themselves.

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
   certificates revoked. What is left is one real cabinet — Home / North Phoenix / `deviceb` — which every remaining
   session needs. The console already excludes removed rows (`k.status <> 'removed'`, `removed_at IS NULL`), so the
   platform now lists only that one. Cleanup was done at the database layer, so it left no audit row; `audit-verify`
   passes at 1934 entries.

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