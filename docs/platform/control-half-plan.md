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

## Reachability, which has to be settled first because the cabinets are on another network

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