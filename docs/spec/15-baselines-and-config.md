# Baselines and configuration snapshots

Status: built (phases 1 and 2 of the earlier `baseline-recovery` design, ported onto the SQL Server code base). Incidents, correlation, playbooks, restore actions, fleet recovery and an offline cache are **not** part of this and are not built. Nothing in this feature changes a cabinet or puts a setting back: every comparison only reports.

The aim: answer, for one cabinet, *how is its configuration, where does it differ from what it should be, what changed and when, and what was it when it last worked*.

Rules that do not bend (CLAUDE.md) apply unchanged: the operation catalog stays fixed (one new read, `config.snapshot`), there is no shell and no file transfer, every input is checked against its contract first, every permission check is on the server, and no secrets or file contents are collected.

## What the agent collects

One read operation, `config.snapshot` (Tier 1, read, expiry 300 s), and one background monitor that runs the same collector in the **network process** (no administrator rights; the broker is not involved). Items are a `key` plus a flat map of values; keys are stable names, never indexes. Eleven categories:

| Category | Items | Source on the cabinet |
|---|---|---|
| `network` | `adapter:<name>`, `route:<destination>/<prefix>` | the `network.config` reader |
| `services` | `service:<name>` (start type, state, account) | the `services.list` reader |
| `drivers` | `driver:<published name>` | the `drivers.list` reader |
| `updates` | `update:<KB>` | the `updates.status` reader |
| `firewall` | `profile:<p>`, `rule:<name>` | the `firewall.state` reader |
| `time` | `time` | the `time.status` reader |
| `devices` | `device:<instance id>` | the `devices.list` reader |
| `applications` | `app:<name>` | the Uninstall keys, read only |
| `hosts` | `host:<name>` | the `network.hosts` reader |
| `tasks` | `task:<name>`, `startup:<name>` | the tasks and startup readers; a startup command is reduced to its program, arguments are dropped |
| `system` | `hardware`, `identity` | the `system.hardware` and `system.identity` readers |

Every category is capped at 2,000 items and 256 KB and says when it is truncated; one snapshot is trimmed to 900 KB. Control characters and lone surrogates are cleaned from text. No registry value outside these readers, no scheduled task action text beyond the program, no file contents.

### Change-only upload

- The agent hashes each category: SHA-256 of the canonical JSON of its items sorted by key. The same rule is implemented in C# and TypeScript and tested against `contracts/vectors/config-hash-vectors.json` (strings escaped as `JSON.stringify` does; numbers must be integers).
- It looks 90 seconds after start and then every 15 minutes. A category whose hash differs from the last one uploaded is queued; a category unchanged for 24 hours is sent again as a refresh. Unchanged categories send nothing.
- Queued snapshots wait in a bounded persistent queue (`config-queue.jsonl`: 30 entries, 4 MB; when the oldest is dropped the gap is recorded), so a cabinet that was offline still reports every distinct configuration it had.
- Upload is `POST /agent/v1/config` over the agent's mutual TLS identity, at most 8 snapshots of 2,000 items each, at most 240 uploads an hour per cabinet (429 above that; the agent waits). The server recomputes every hash from the items and refuses one that does not match.
- The same operation can be run on demand from the console ("Read its configuration now"); its result is stored like an upload (source `refresh`).

## Storage (SQL Server, migration 0005)

- `config_versions`: one row per category and distinct configuration, items stored gzip-compressed in a `varbinary(max)` (16 MB cap on unpacking), with the item count and the source (`agent` or `refresh`). The newest 20 versions per category are kept, plus any version a healthy mark points at.
- `config_current`: the current version of each category per cabinet, read once per upload.
- `config_changes`: one row per changed item with the fields before and after, the window (`not_before`, `observed_at`), whether it was made through the platform, and whether it goes against the baseline. It outlives its versions (no foreign key) and is pruned with the event retention setting.
- `baselines` / `baseline_versions`: one baseline per scope, numbered versions. A trigger enforces the lifecycle in the database: only a draft is editable, and statuses move only along the allowed transitions. Baselines are never deleted, except that a baseline whose client, site or cabinet no longer exists may be (this is what lets the demo be switched off).
- `healthy_marks`, `cabinet_health`, `cabinet_drift`, `health_transitions`.
- Every JSON column has an `ISJSON` check and is listed in `server/src/db/json-columns.ts`. Page compression is on the large tables.
- `cabinets.manufacturer` and `cabinets.model` are set from the `system` category and from `system.hardware`. The model is read from Windows; the platform never guesses it from a name. An Admin override is **not built** (open decision).

All writes for one cabinet take a per-cabinet application lock (`config:<cabinet>`); one transaction covers a batch.

## Time honesty

Each snapshot carries `observedAt` (when the agent looked). A change record stores `observedAt` and `notBefore` (the previous observation). The console says "changed between 09:00 and 09:15" and never shows a precise time it does not have. After an outage the window is the whole outage.

## Baselines

- **Scopes**, most specific last: `global`, `role`, `model`, `client`, `site`, `cabinet`. One baseline per scope; each has numbered versions. Global, role and model are Admin only.
- **Role** (finding F7, decision-log D33): what every cabinet of one role should be. Its id is the role, `sync`, `satellite` or `standalone`, and nothing else is accepted (the contract and a database check). It applies to every active cabinet of that role, after the fleet's and before a model's, so a model, client, site or cabinet baseline narrows it item by item. It is made like any other: captured from a cabinet known to work (the cabinet's Baseline tab offers "Every <role> cabinet" to an Admin), imported, or written. Its approval also sets the role's watched services: the services it requires running (docs/spec/12-milestones-8-to-12.md "Watched services", decision-log D34).
- **Content**: items by category and key with a mode (`match` the listed fields, `present`, `absent`, `ignore` to cancel a wider expectation), optionally `required`, a `severity` (minor or major) and a short note, plus a `health` section (`maxOfflineMinutes`, `requireRequiredItems`, `requireNoCriticalAlerts`). Nothing is expected that is not listed. At most 5,000 items.
- **Inheritance** is deterministic: items merge by category and key; a more specific scope replaces the whole item from a wider one; every resolved item records its origin (scope and version).
- **Lifecycle**: `draft` then `pending` (proposed) then `approved` (the version in force; the previous one becomes `superseded`) or `rejected`. Approved versions are immutable. A draft can be withdrawn from pending.
- **Who**: Tier 1 reads. Tier 2 and up create drafts, capture, import, edit and propose. An Admin approves or rejects, with a written reason and an authenticator code bound to that reason (step-up actions `baseline.approve` and `baseline.reject`, target the version). An Admin cannot approve their own proposal while another active Admin exists. An approval fails with `stale_base` if a newer version was approved since the draft was made.
- **Three ways to make one**: capture from a cabinet (never in force until approved), import (copy the approved content of another scope as a draft), or the API with explicit content. A capture leaves out values that differ per cabinet (services `state`, network `connected` and `linkSpeedMbps`); for scopes wider than one cabinet it also leaves out addresses, MAC addresses, interface indexes, update install dates and the `devices` category. A capture of over 5,000 items is refused.
- An approval re-evaluates the drift and the health of the cabinets in its scope in the background, one at a time.

## Baselines at enrollment

Every cabinet is approved with a baseline decision, so a new cabinet is never judged against nothing without someone having chosen that.

- **The decision** (`baseline` in `approve-enrollment`, required by the contract, so an approval without one is refused before anything else runs):
  - `inherited`: an approved baseline already applies at the fleet, role, client or site level (the role is the one chosen in the approval). The server checks that one does and refuses with `no_approved_baseline` when none does. A model baseline cannot count yet, because the cabinet has not reported its model when it is approved.
  - `attach` with a `versionId`: an approved fleet, role, model, client or site baseline version is copied to the cabinet's site as the site's approved baseline (origin `attach`, decided by the approver, audited as `baseline.attach`). Its content was approved through its own review; the approver's authenticator code for the whole approval confirms that it now also applies to this site. A version that is not approved is refused (`not_approved`), and so is a site that already has an approved baseline of its own (`site_has_baseline`), since that one applies.
  - `capture`: the cabinet's first full configuration report becomes the site's baseline **draft**, in the approver's name and audited as the platform's doing. It is made once every category a site baseline uses has been reported (every category except `devices`). It is never in force until proposed and approved with the two-person rule. A capture over 5,000 items is marked failed; someone captures a trimmed one by hand.
- **"Baseline required"**: an active cabinet that no approved baseline applies to says so on its Overview (with why, and what happens next) and in the site's cabinet list. Existing cabinets get the same mark from the same rule; nothing is migrated.
- **Where it is kept**: `enrollment_baselines` (migration 0013), one row per cabinet approved through the console or the command line: the decision, who made it, the attached version, and where a capture stands (`waiting`, `drafted`, `failed`).
- **Routes**: `GET /api/admin/enrollments/:id/baseline?client=&site=&role=` (Admin; `role` optional) says which approved baselines would apply and lists the approved versions that could be attached; the approval checks everything again. `GET /api/cabinets/:id/condition` carries `baseline` (in force, from where, and the enrollment decision). The command line's `approve` takes `--baseline inherited|capture|<versionId>`.

## Change detection, drift, health

- **Three comparisons, kept apart**: against the approved baseline (drift: should be), against the previous observation (changes: what changed), against the last known healthy state (what is different from when it worked).
- **Drift** is recomputed (set-based, one DELETE and one MERGE) when a snapshot changes or a baseline is approved. Each row: category, item, field, mode, expected, actual, origin, severity, required, first seen.
- **Health** is judged from meaningful checks, not from the agent being online: `offline` (no contact within the baseline's limit, default per baseline), `unknown` (no configuration reported, or no approved baseline; never shown as healthy), `degraded` (a `required` item is not as the baseline says, or a critical alert is open, as the baseline's `health` section asks), otherwise `healthy`. Each state carries its reasons and the time it began. A sweep every minute re-evaluates cabinets whose stored state disagrees with their contact, and every cabinet at least every 15 minutes.
- **Last known healthy**: when a cabinet is healthy and its configuration differs from the last mark, a mark stores the version of each category in force. Marks are kept 30 days plus the newest 10, within a cap of 60; the mark the cabinet's health points at is always kept, and a foreign key from `cabinet_health.last_mark_id` makes the database refuse to delete it by any path (F8.R2, decision-log D40). The comparison with the last healthy state lists the changes and says which categories are too old to compare. It also lists the items the change records name since the mark that are back as they were then ("changed since then, and back as it was", with how many times and when last), so a value that changed and changed back, or a category that returned to the marked version, is not invisible (F8.R3, decision-log D42); when the mark is older than change records are kept (the events retention, 90 days by default) it says that list may be missing older changes.
- **What changed since it was healthy, in one answer** (F8.R4, decision-log D44): `GET /api/cabinets/:id/since-healthy` (Tier 1 and up) returns the health (state, last known healthy, when the problem was first observed), the drift from the baseline in force, the comparison with the last healthy mark (what differs, what changed and came back) and the configuration changes recorded since the mark (with no mark, since the last healthy time), at most 200, ranked by closeness to when the problem was first observed: the smallest distance first and, at an equal distance, the change before the problem ahead of the one after it; while the cabinet is healthy, newest first. Each change carries its signed distance in minutes. The Baseline tab's "Since last healthy" reads this route and shows the 20 closest with "12 min before" / "3 h after"; closeness is all the order says, never a cause.
- **Timeline**: one list per cabinet merging health transitions, configuration changes, alerts and platform commands, filterable and searchable. Entries within an hour before the first observed problem are marked "shortly before the problem was first observed". Nothing claims a cause.

## Routes (console API)

Reading is Tier 1; every query string and body is checked against its contract.

- `GET /api/baselines`, `/api/baselines/:id`, `/api/baselines/versions/:id` (with the diff against the previous version)
- `POST /api/baselines/drafts`, `/capture`, `/import`; `PUT /api/baselines/versions/:id` (Tier 2); `POST .../versions/:id/propose`, `/withdraw` (Tier 2); `POST .../versions/:id/approve`, `/reject` (Admin, step-up)
- `GET /api/cabinets/:id/baseline`, `/config`, `/condition`, `/drift`, `/config-changes`, `/config-history`, `/compare-healthy`
- `GET /api/fleet/differences` and `/api/fleet/differences/group`: the same difference counted over the fleet, a client or a site, with the cabinets that have it and the number that report the item and do not. Two optional narrowings (F7.R3): `role`, only cabinets of that role; and `from`, only differences from what one level of baseline expects (the level each difference's origin names). `?clientId=…&from=role` answers "which cabinets of this client differ from their role", apart from what their site or they themselves are asked. The cabinets-reporting count follows `role`, not `from`.
- Agent: `POST /agent/v1/config`.

(The cabinet's load samples keep `/api/cabinets/:id/health`; the configuration health is `/condition`.)

## Console

- Cabinet, **Overview**: a Configuration panel (state, since when, last known healthy, problem first observed, changes since, next step), with "Baseline required" and why when no approved baseline applies.
- Admin, **Pending cabinets**: the approval shows which baseline applies at the chosen client and site; with none, Approve waits until the approver attaches an approved baseline or asks for a capture. The site's cabinet list has a Baseline column.
- Cabinet, **Baseline** tab: Differs from baseline, Since last healthy, History, Baseline in force; "Read its configuration now"; capture a baseline (Tier 2).
- Cabinet, **Compare**: modes "another cabinet", "its baseline", "its last healthy state". **What changed** also lists the configuration changes. **Standards** has a Configuration baseline line.
- **Differences** (main menu): the fleet's differences grouped, then one group, narrowed by role and by the level of baseline a difference comes from.
- Admin, **Baselines**: the list, import, a baseline's versions, and the version review (diff, draft editor, propose, withdraw, Admin decision).
- All long lists use the shared pager.

## Demo

The simulator reports plausible configuration for every demo cabinet (one first look at enable time, more after the operations that change configuration). The demo creates an approved client baseline and baselines for two sites. Midtown Sync's firewall profiles and network profile differ from its baseline, with an earlier look showing the change, so the Baseline tab shows drift, "Since last healthy" and a history. The demo baselines belong to the demo's own sites and clients and go away when the demo is switched off.

## Differences from the earlier branch

Eleven categories (hosts, tasks and startup, system added); items stored compressed; no restore, incident, playbook or offline-cache code; the configuration health is served at `/condition`; routes come from `network.config`; startup commands are reduced to the program; there is a per-snapshot size budget and a per-cabinet lock; the model override is not built.

## Performance

A healthy cabinet sends nothing between changes (one refresh a day per category). Storage per cabinet is the current items plus a version only when something changed (20 per category, compressed). Drift is set-based; health is computed on change and swept. Hot lookups use `FORCESEEK` where the plan needs it. Demo enable with the seed takes about 16 s (11 s without it).
