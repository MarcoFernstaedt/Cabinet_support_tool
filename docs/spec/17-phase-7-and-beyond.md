<!-- The owner's file, added on 2026-10-27 and kept as written, except that links to the owner's own notes are shown as names.
     Nothing in this file is approved or scheduled; it is the ordered shelf after phases 1-6 (13-roadmap.md). -->

# Phases 7 and beyond

Assembled 2026-10-27 from the project dossier: "Phases - in depth" (owner\'s dossier) and "Future ideas - self-healing and production readiness" (owner\'s dossier).

**Status: nothing here is approved or scheduled.** Phases 1-6 are the committed roadmap (2-6 still outstanding). The only numbered future phase is Phase 7, and it is a candidate, not a commitment. The rest of the file is the ranked shelf of ideas beyond it - there is no Phase 8 or 9 defined, on purpose: the ranking is what orders them, not a phase number.

---

## Phase 7 — fleet correlation, known errors and self-healing (future, not approved)

Nothing in this phase is approved or scheduled. It is here so the ideas have a home in the same shape as the five
phases that are committed, and so the parts of it that belong to an existing phase can be pulled into that phase
without being lost. Sources: "Future ideas - self-healing and production readiness" (owner\'s dossier), and the mechanics the five
phases already build.

### Objective

Solve the problem the other five phases leave open: a change goes out to a hundred cabinets, a third of them start
failing the same way, and the platform — which notices, because it is watching — says nothing, because nothing in the
build connects one cabinet's failure to the next or to the change that preceded it. It exists so that one person
supporting a fleet learns about a bad rollout from the platform, not from fifteen clinics calling.

### Goals

When this phase is done the operator can:

- open one place and see a change (an update, a driver, a package, a configuration push) and, against it, the
  cabinets that took it, the ones that failed after it, and the error they failed with;
- read one record for a fleet-wide failure — the signature, the count, the affected versus unaffected comparison by
  model, build, driver and update, and the linked incidents — instead of fifteen separate tickets;
- attach a known-error article to a signature, so the second occurrence is a lookup with the workaround at hand;
- receive one grouped alert for a fleet-wide event, with the count in it, rather than one alert per cabinet;
- see the same failure classified as **recurring** or **new** the second time it appears, with the first appearance
  linked;
- and let a small set of repairs run without a human — restart a service the cabinet profile says must run, restart
  the agent — inside written policy, with the platform stopping itself the moment the policy is exceeded.

### Already built

- **The change watcher and the cabinet timeline.** The platform already stores what changed on a cabinet and when;
  correlation needs nothing new to be recorded, only to be joined up (phase 2, part built).
- **Event-log counts across the fleet** — the existing fleet view already aggregates one event among cabinets, which
  is the shape correlation generalises.
- **Per-cabinet history and a 72-hour change lead-up.** `server/src/services/scanner-history.ts` already builds
  scanner episodes per cabinet and the changes leading up to them — the gap is comparison *across* cabinets, not
  history within one.
- **Crash-signature grouping across the fleet** and a comparison of affected against unaffected cabinets, recorded as
  built in phase 2's fleet work.
- **The remediation registry, approvals and the protected-device list** — the machinery self-healing must go through
  rather than around (phase 4).
- **Per-cabinet operational state as a fleet job with per-cabinet results** (phase 3), which is the same fan-out
  correlation reporting needs.

### What makes it complete

Testable, and each line is a test:

1. Two cabinets report the same error signature within the window and a problem record exists that names both, with
   the earlier incident linked as recurrent.
2. A cabinet that failed after change X and a cabinet that took X and did not fail both appear in the same
   comparison, with the differing attributes named (model, build, driver, update).
3. An alert storm is suppressed: twenty cabinets failing the same way inside an hour produce one alert carrying the
   count of twenty, not twenty alerts.
4. A known-error article attached to a signature is shown to the operator when that signature next appears, before a
   single read is chosen.
5. A policy action is refused when the cabinet is on the protected-device list, when the operation is not in the
   catalog, when the cabinet is outside its maintenance window, or when the per-cabinet action budget is exhausted —
   each with its own refusal code.
6. A refused or failed self-healing action writes an incident with a before-and-after snapshot, and after two
   failures the same policy on the same cabinet stops and escalates to a human.
7. A false action rate is measured over a shadow period and reported as a number, not an impression.

### Stress points

- **Data volume.** Correlation is a join across every cabinet's incidents, changes and collected readings. On one SQL
  Server Express instance this is the point where it hurts first, so the first design decision is what is aggregated
  when it arrives versus read at query time.
- **Alert volume.** A hundred cabinets failing together is the case that breaks naive alerting, and suppression has to
  be in the design, not bolted on after the first storm.
- **False correlation.** Two cabinets failing the same way for unrelated reasons will be linked if the signature is
  loose, and a wrong problem record is worse than no problem record: it sends one person to the wrong cause across the
  whole fleet.
- **Autonomy on someone else's machine.** Self-healing acts on a clinic's cabinet with no human watching, which is the
  largest trust step in the whole platform.
- **Time and clock skew.** Correlating "after the change" across cabinets depends on their clocks agreeing; the
  time-sync read exists precisely because they do not always.

### Failure points to enforce

- **No new privilege for any of this.** Correlation is server-side analysis; if a step needs a new operation on a
  cabinet, it is a phase change, not an implementation detail.
- **Self-healing goes through the existing path.** Same catalog, same broker, same permission check, same approval
  record, same evidence outbox, same snapshots. A separate path for automated actions would be a second security model
  (`docs/spec/02-security-model.md`).
- **Nothing outside the fixed catalog** — no shell, no script runner, no generic command, no file transfer, however
  convenient an automated repair makes it (CLAUDE.md).
- **The engine never connects to the cabinet application's database**, at any level, including diagnostics
  (CLAUDE.md).
- **One organization stays one organization.** Correlation must not become a second tenant's view of a first tenant's
  evidence (the accepted decision of 2026-10-25).
- **Alerts are not a permission bypass.** A grouped alert tells the operator what happened; it never widens what they
  may do.

### Pitfalls, and what not to do

- Do not start with autonomy. Start with the correlation and the fast answer, which is where the value is and where
  being wrong costs nothing.
- Do not let the problem record become a second ticket system nobody updates. It is generated, and its state changes
  only from real events.
- Do not tune thresholds per customer by hand. Start with one published threshold and change it with evidence.
- Do not measure self-healing by "did it do something". Measure the false-action rate and the actions that were
  right but unnecessary.
- Do not build the notification plumbing twice: grouped alerts belong to whatever alerting the five phases produce.

### How it is verified

- **Shadow mode first.** The engine proposes, a human confirms, and every proposal is recorded — including the ones a
  human rejects. Autonomy is granted one symptom class at a time, after a measured period with no false actions.
- **Fault injection.** A lab ring where a service is stopped, a driver is made to fail, an update is pushed that
  breaks — the only honest way to claim self-healing works.
- **Scale test.** A hundred or more simulated cabinets in one fleet, with a real rollout pattern, checking the
  correlation query, alert suppression and the agent's own overhead.
- **The refusal paths get tests too**, because those are the ones that keep a bad action from a customer's machine.

### Open questions for me

1. How much autonomy do I actually want on a clinic's cabinet — L1 (suggest), L2 (approve each), or L3 (act inside a
   written policy)?
2. Which symptom classes go first if the answer is L3? (My proposal: a service the cabinet profile says must run, and
   the agent's own restart.)
3. Does an automatic rollback after a bad update count as self-healing — or is it a separate, larger decision?
4. At what count does a repeated signature become an alert: three cabinets in a day, five, or a percentage of the
   fleet?


## The end goal — where this lands

Everything above plus "Future ideas - self-healing and production readiness" (owner\'s dossier), with "Gates before a real clinic" (owner\'s dossier)
closed. Written as the picture I am building toward, not as a claim about today.

**The picture.** I open the console and the fleet answers. Every cabinet has one timeline: what changed on it, what
broke, what the platform already did about it, and what still needs a person. When 100 cabinets take an update and 47
of them start failing the same way, I do not get 47 alerts and a morning of clicking — I get one problem record that
names the change, counts the affected, tells me whether the cabinets without the change are fine, offers the rollback,
and knows the workaround from the last time it happened. When a cabinet quietly stops checking in, I am told rather
than discovering it. When a third of the fleet's drives are going to fail this quarter, I find out before the clinics
do.

**What has to be true for that to be the picture:**

1. **The foundation exists** — the diagnostic module contract, the incident record, the capability registry, findings
   as modules — because every phase after phase 2 hangs off it.
2. **The five phases are done** on the terms in this dossier: each phase's completion criteria met, not its file count.
3. **Correlation is first-class** — changes anchored to incidents, incidents linked into problem records, problems
   carrying known-error articles, alerts grouped rather than multiplied.
4. **Self-healing runs inside written policy, not vibes** — L3 autonomy per symptom class, earned in shadow mode,
   proven by fault injection, with the guardrails in the future-ideas note, and never on the protected-device list
   without an approval.
5. **Production is proven, not asserted** — service levels measured, error budget enforced, a 100+ cabinet scale test
   passed, agent upgrades in canary rings with automatic halt, MTTR and MTBF tracked, and a restore actually rehearsed.
6. **The six gates are closed** — production signing in a KMS, TPM-held agent keys, an independent penetration test,
   one writable test on real hardware, a real 32-bit cabinet, and a real clinic network.

**What it is not, and will not become:** a shell on a cabinet, a general file transfer, unattended full autonomy, a
connection to the cabinet application's database, or a screen viewer. Those are refused in the security model, and the
end goal is only worth reaching on those terms — a platform that can do everything to a clinic's machine is not the
product; one that can prove what it did, and can be trusted not to do the rest, is.

---

# Future ideas — beyond the five phases

Not approved, not scheduled, no phase number until I say so. This is the shelf of things the platform could become,
with the industry words for them and, more importantly, the architecture and the guardrails each one needs before it
is allowed anywhere near a clinic. Companion to "Phases - in depth" (owner\'s dossier) and "Gates before a real clinic" (owner\'s dossier).

## What we are, in the industry's words

We are building a **diagnostic-first fleet tool**. The class it belongs to is what the industry calls an **RMM**
(remote monitoring and management), and the discipline it borrows most from is **ITIL problem management**: incidents
are the symptoms, a *problem* is the linked cause, and once a cause is known it becomes a **known error** with a
workaround — held in a **known-error database (KEDB)**. If we later let it repair itself, the correct term is
**self-healing**, and the architecture pattern is **MAPE-K** (Monitor, Analyse, Plan, Execute, Knowledge), from
autonomic computing. Naming this matters because it tells us what a buyer will compare us to (NinjaOne, Action1,
ManageEngine, LogMeIn Central) and which parts of that comparison we deliberately refuse.

## 1. The 100-cabinets case: change-anchored fleet correlation

This is the thing I want most and it is the smallest gap. Today's plan reaches it in pieces — fleet crash comparison
and an incident timeline in phase 2, failure rates per driver, update and model in phase 6 — but nowhere does the
platform say *"this change went to 100 cabinets and 47 of them now share one error."*

How it should work:

- **Anchor every incident to the change that preceded it.** A Windows update, a driver version, a config value, a
  service state, an app install — each is a change record with a timestamp and a fingerprint. The engine already has a
  change watcher and a cabinet timeline to build on; the missing piece is treating the *change* as the axis, not the
  cabinet.
- **Compare cohorts, not cabinets.** For a given error signature, split the fleet by "has the change" and "does not
  have the change". That comparison is the evidence, and it is what turns a guess into a finding with a certainty
  level.
- **Promote, don't just display.** When the same signature appears on a configurable number of cabinets inside a
  window after the same change (say 3 cabinets in 24 hours), the server opens a **problem record** automatically,
  links every incident to it, alerts, and offers the reverse (roll back the update, revert the value) as a registry
  remediation subject to approval.
- **Keep the human-readable side.** A problem record should read as cause, affected count, first seen, the change,
  the workaround — that is the KEDB article, and it is also what gets pasted into Salesforce.
- **Suppress the noise.** One alert per problem, not one per cabinet, or 47 cabinets burn the operator out and the
  alerting gets ignored exactly when it matters.

What it needs to be built: a change table with fingerprints, a signature table, a correlation run (scheduled),
a problem record with a state machine (new → investigating → known error → resolved), and an alert path that groups.
Nothing in this needs a new privilege — it is all server-side analysis over data the agent already sends, which is why
it is a small addition rather than a phase.

## 2. Self-healing, done in a way I could defend

Self-healing is not "let the machine fix things". It is a loop with a written policy at every step, and it earns
autonomy in stages. The pattern is **MAPE-K**, and our pieces already map onto it:

- **Monitor** — the monitors and reads (dumps, uptimes, service state, storage, connectivity).
- **Analyse** — the diagnostic engine's findings, each with severity, certainty and evidence.
- **Plan** — playbooks and the remediation registry: every repair with its precondition check, its approval rule and
  its verification.
- **Execute** — the broker and the fixed catalog. No shell, no generic command, ever.
- **Knowledge** — baselines, trends, known errors, and the outcome of every past repair of the same kind.

**Autonomy levels, and which one we should stop at.** L0 read-only (today). L1 suggest only. L2 act after an approval
(today, after phase 4). **L3 act inside a pre-approved envelope** — this is the real self-healing, and it is the one
worth building. L4 unattended full autonomy: never on a clinic cabinet, and I would refuse it if asked.

What L3 may do unattended, each as its own written policy:

- start or restart a vendor middleware service that the cabinet profile says must be running;
- re-apply an approved configuration value that drifted away from the client's baseline;
- restart the agent itself (already exists);
- roll back the Windows update or driver that matches a known-bad problem record;
- re-run a failed sync or re-establish a dropped connection at a defined threshold;
- clear a stuck spooler or a wedged scanner handle, if and only if that device class has a policy.

Guardrails that never bend, whatever the level:

- nothing outside the fixed operation catalog, and nothing that needs a new privilege;
- never on the protected-device list (scanner class first) without an approval;
- never during a patient-facing hour for anything disruptive — the maintenance window decides, not the engine;
- every self-healing action writes an incident, a before-and-after snapshot and evidence, exactly like a manual fix;
- **two failures and it stops** — no repair loops, with a rate limit (actions per cabinet per hour) and a per-cabinet,
  per-site and global kill switch;
- a self-heal that fails goes straight to a human with the evidence, never to a simpler repair.

How it earns the right to run unattended, and how I want to prove it:

1. **Shadow mode first.** The engine proposes for weeks and a human confirms every time. Measure how often it was
   right, and how often it would have done something I would not have done.
2. **Fault injection on a lab ring.** Break it on purpose — stop the service, disconnect the network, fill the disk,
   corrupt a config value, kill the agent — and check the loop recovers and stops when it should. That is chaos
   engineering, and it is the only honest way to claim self-healing.
3. **A policy earns autonomy one symptom class at a time**, after a stated number of correct shadow proposals and zero
   false actions, and it can be revoked the same way.
4. **Never on a real cabinet before "Gates before a real clinic" (owner\'s dossier) is closed** — no exception.

## 3. What "succeeding in production" has to mean here

- **Written service levels:** cabinets checking in, a diagnosis returning inside a stated time, an alert delivered
  inside a stated time. Then measure them and publish them in the console.
- **Error budget:** if the platform misses its own targets, new feature work pauses in favour of the miss. That is the
  professional term, and it is also the discipline that keeps a one-person operation honest.
- **MTTR and MTBF per cabinet, site and component** — how long repairs actually take, and how often a component fails.
  This is where the fleet data starts paying for itself.
- **Scale proven, not assumed:** a load test with 100+ simulated cabinets through the same lanes the real ones use —
  fleet jobs, evidence upload, alert delivery, database growth and retention. The suite we run today proves
  correctness, not capacity.
- **Agent upgrades in rings:** 1 cabinet, then 10%, then the fleet, with automatic halt if a ring's error rate moves.
  The server can lag behind; the agent is the risky side.
- **Backup and a rehearsed restore** of the platform itself, with the restore actually performed on a schedule.
- **A runbook and an on-call answer for one person:** what to do at 3 am, what can wait, and what pages me.

## 4. Other ideas worth naming (none of them scheduled)

- **Asset spine:** model, serial, firmware, OS build, drive type per cabinet — the table every correlation quietly
  needs, and the basis for "this model, this firmware" failures.
- **Predictive failure:** SMART and NVMe wear trends turned into "replace this drive before it fails", not just
  "this drive is unhealthy". Phase 2 and phase 5 already lay the data down.
- **Observability of the platform itself:** the server and agent health as first-class data, so a silent fleet is not
  mistaken for a healthy fleet.
- **Clinic-facing report:** a plain-language export a clinic manager can read.
- **Remote screen control:** deliberately out. Remote viewing changes the trust boundary of the whole product, needs
  consent, privacy terms and probably a different security review — it is a different product decision, not a feature.

## 5. What I will not add, even as an idea

- a shell, a script runner or any generic command path on a cabinet;
- general file transfer — packages only, signed, hash-checked on the cabinet;
- unattended full autonomy (L4) on a clinic machine;
- connecting the platform to the cabinet application's database;
- screen control without a separate decision and its own security review.

**The framing that matters:** every one of those is something LogMeIn Resolve, NinjaOne and their peers already do, and
do well. We are not building a smaller version of them. We are building the part they do not: evidence-grade diagnosis,
fleet-wide error correlation that names the change and the affected count, and repairs that are allowlisted, approved
and written down — with the breadth they sell deliberately traded away to make that provable.

## What I would actually build, in this order

Ranked by value against effort, and every one of the first group is server-side or policy-only — none of them needs a
new privilege on a cabinet, which is why none of them needs a new phase.

**Do these, and do them before anything else on this page:**

1. **Change-anchored correlation, problem records and grouped alerts.** The 100-cabinet case. It is the clearest thing
   we do that Resolve and NinjaOne do not, and it is analysis over data the agent already sends.
2. **Known-error articles on a signature** — the workaround text, so the second occurrence is a lookup, not an
   investigation.
3. **The asset spine** (model, serial, firmware, OS build, drive type) — correlation is weak without it.
4. **SLOs, an error budget, and MTTR/MTBF per cabinet and site** — measurement only, and it is what turns the fleet
   data into a number I can act on.
5. **Platform observability** — server and agent health as first-class data, so a silent fleet is never mistaken for a
   healthy one.
6. **Agent upgrades in canary rings with automatic halt** — the agent is the risky side of every rollout.
7. **A 100+ cabinet scale test and a rehearsed restore** — the two things that decide whether production is real.

**Later, once the data and the phases exist:**

8. **Self-healing at L3, two policies to start** — restart a service the cabinet profile says must run, and restart the
   agent (already built) — each only after a shadow-mode period with a measured false-action rate.
9. **Predictive drive failure** from the SMART and NVMe trends phase 2 and phase 5 already collect.
10. **A clinic-facing report export** — cheap, and it is what a clinic manager actually reads.
11. **The fault-injection harness** — the only honest way to claim self-healing, so it is the prerequisite for 8.

**Not built at any point without a separate, explicit decision:** the shell and script runner, general file transfer,
L4 unattended autonomy, a connection to the cabinet application's database, and screen control.

## How this could enter the plan

If I want it, it is a **Phase 7 — fleet correlation and self-healing**, and it must come after the five, in this
order: the correlation and problem records first (server-side only, no new privilege, immediate value), then shadow
mode, then L3 autonomy policy by policy. The foundation slice in phase 2 is still the prerequisite for all of it.

Return to "Cabinet Support Tool" (owner\'s dossier).
