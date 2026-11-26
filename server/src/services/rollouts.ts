// Staged rollouts (docs/spec/07-upgrade-channel.md "Staged rollout"): an Admin starts one, with step-up, for one
// ready release, which is one version of one Windows architecture (docs/spec/18-built-designs.md §1). Batch 1 is
// one cabinet the Admin names, batch 2 the in-office cabinets, batch 3 about 5 percent of the rest, batch 4 everyone
// else. The server offers the version in its heartbeat answer to cabinets in the batches reached so far; each agent
// reports how its upgrade ended. A batch must reach the success rate before the next starts, and failures above the
// limit pause the rollout on their own. Offers are data: the agent installs only a release that passes its own checks
// against keys the server never holds.
//
// Only cabinets that can run the release are targets: an x86 package is never offered to an x64 cabinet, which Windows
// could not run, and the ones left out are counted in the audit next to the cabinets that are too old for it.
import { randomInt, randomUUID } from "node:crypto";
import { consumeStepUpToken } from "../auth/stepup.js";
import type { UpgradeStatus } from "../contracts.js";
import { audit, transaction, type Pool, type Queryable } from "../db/db.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";
import { Refused } from "./errors.js";
import type { Architecture } from "./package-architecture.js";
import { compareVersions, isVersion } from "./releases.js";

export const BATCH_NAMES = ["", "One cabinet", "In-office cabinets", "About 5% of the field", "Everyone else"] as const;
/** An offered cabinet that has not reported within this long is counted as failed. */
export const OUTCOME_TIMEOUT_MINUTES = 30;
/** Cabinets still offline this long after their batch started are skipped, so they cannot hold the rollout. */
export const OFFLINE_SKIP_HOURS = 24;

type Authority = string | null;
const viaCli = (a: Authority) => (a === null ? { via: "cli" } : {});

/** Which cabinets a rollout is for (plan item 2.11, D161); the whole fleet when none is given. */
export type RolloutTarget = { kind: "fleet" } | { kind: "client" | "site"; id: string } | { kind: "cabinets"; cabinetIds: string[] };
/** One batch after the canary: a number of cabinets, or a share of those left after the canary. */
export type BatchSpec = { cabinets: number } | { percent: number };
/** What a rollout was planned as: kept with it for the console and the audit (migration 0042). */
export interface RolloutPlan { target: RolloutTarget; batches: { batch: number; label: string; cabinets: number }[] }
export const MAX_BATCHES = 10;

export interface RolloutRequest {
  version: string; architecture: Architecture; pilotCabinetId: string; successRatePercent: number; failureLimitPercent: number;
  target?: RolloutTarget | undefined; batches?: BatchSpec[] | undefined;
}

/** A batch's name: from the rollout's plan, or the four fixed batches of a rollout from before it had one. */
export const batchLabel = (plan: RolloutPlan | null | undefined, batch: number): string =>
  plan?.batches.find(b => b.batch === batch)?.label ?? BATCH_NAMES[batch] ?? `Batch ${batch}`;

/**
 * The batches after the canary as asked: in-office cabinets first, then the field in an order nobody can predict; each spec takes
 * its number or its share of all of them, and whatever is left is one more batch.
 */
export function plannedBatches<T extends { in_office: boolean }>(rest: readonly T[], specs: readonly BatchSpec[]): [number, T[], string][] {
  const ordered = [...rest.filter(k => k.in_office), ...shuffle(rest.filter(k => !k.in_office))];
  const out: [number, T[], string][] = [];
  let at = 0;
  for (const s of specs) {
    const n = "cabinets" in s ? s.cabinets : Math.max(1, Math.ceil(rest.length * s.percent / 100));
    out.push([out.length + 2, ordered.slice(at, at + n), "cabinets" in s ? `${s.cabinets} cabinet${s.cabinets === 1 ? "" : "s"}` : `${s.percent}% of the rest`]);
    at += n;
  }
  if (at < ordered.length) out.push([out.length + 2, ordered.slice(at), "Everyone else"]);
  return out;
}

/** Fisher-Yates with a cryptographic source, so nobody can predict or steer which cabinets land in batch 3. */
function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) { const j = randomInt(i + 1); [items[i], items[j]] = [items[j]!, items[i]!]; }
  return items;
}

export async function startRollout(pool: Pool, adminId: string, req: RolloutRequest, stepUpToken: Authority): Promise<string> {
  return transaction(pool, async c => {
    if (stepUpToken !== null) await consumeStepUpToken(c, stepUpToken, adminId, "rollout.start", "fleet");
    const release = (await c.query<{ state: string; minimum_version: string }>("SELECT state, minimum_version FROM agent_releases WHERE version = $1 AND architecture = $2", [req.version, req.architecture])).rows[0];
    if (!release) throw new Refused("not_found", 404, `no ${req.architecture} release ${req.version}`);
    if (release.state !== "ready") throw new Refused("release_not_ready", 409, "this release has no verified package yet");
    if ((await c.query("SELECT 1 FROM rollouts WHERE state IN ('running', 'paused')")).rows[0])
      throw new Refused("rollout_active", 409, "another rollout is running or paused; finish or stop it first");

    // Every active cabinet whose agent is older than the release (or has not reported a version yet), except those older
    // than the release's minimum version: they would refuse it, and those refusals would pause the rollout for nothing.
    // Neither are cabinets built for the other architecture, which cannot run this package at all; a cabinet whose agent
    // never reported an architecture is treated as windows-x64, which is what it is (see releases.ts cabinetArchitecture).
    // No row locks: holding them would stall every heartbeat while the rollout is written.
    const target: RolloutTarget = req.target ?? { kind: "fleet" };
    if ((target.kind === "client" || target.kind === "site")
        && !(await c.query(`SELECT 1 FROM ${target.kind === "client" ? "clients" : "sites"} WHERE id = $1`, [target.id])).rows[0])
      throw new Refused("not_found", 404, `no such ${target.kind}`);
    const all = (await c.query<{ id: string; agent_version: string | null; in_office: boolean; architecture: string; site_id: string; client_id: string }>(
      `SELECT k.id, k.agent_version, k.in_office, COALESCE(k.architecture, 'windows-x64') AS architecture, k.site_id, s.client_id
         FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.status = 'active' AND k.demo_scenario IS NULL`)).rows;
    // The target, before anything else: a cabinet outside it is never a candidate, whatever its version (D161).
    const chosen = target.kind === "cabinets" ? new Set(target.cabinetIds.map(x => x.toLowerCase())) : null;
    if (chosen) {
      const known = new Set(all.map(k => k.id.toLowerCase()));
      const unknown = [...chosen].filter(x => !known.has(x));
      if (unknown.length) throw new Refused("target_not_found", 404, `${unknown.length} of the chosen cabinets ${unknown.length === 1 ? "is" : "are"} not an active cabinet`);
    }
    const inTarget = (k: (typeof all)[number]) => target.kind === "fleet" ? true : target.kind === "client" ? k.client_id.toLowerCase() === target.id.toLowerCase()
      : target.kind === "site" ? k.site_id.toLowerCase() === target.id.toLowerCase() : chosen!.has(k.id.toLowerCase());
    if (!all.some(k => k.id.toLowerCase() === req.pilotCabinetId.toLowerCase() && inTarget(k)) && all.some(k => k.id.toLowerCase() === req.pilotCabinetId.toLowerCase()))
      throw new Refused("pilot_outside_target", 409, "the first cabinet must be one of the cabinets the rollout is for");
    const older = all.filter(inTarget)
      .filter(k => k.agent_version === null || !isVersion(k.agent_version) || compareVersions(k.agent_version, req.version) < 0);
    const belowMinimum = (k: { agent_version: string | null }): boolean =>
      k.agent_version !== null && isVersion(k.agent_version) && isVersion(release.minimum_version) && compareVersions(k.agent_version, release.minimum_version) < 0;
    const sameArchitecture = older.filter(k => k.architecture === req.architecture);
    const wrongArchitecture = older.length - sameArchitecture.length;
    const cabinets = sameArchitecture.filter(k => !belowMinimum(k));
    const pilot = cabinets.find(k => k.id === req.pilotCabinetId);
    const rejected = older.find(k => k.id === req.pilotCabinetId);
    if (!pilot) throw new Refused("pilot_not_eligible", 409, rejected && rejected.architecture !== req.architecture
      ? `the first cabinet's agent is built for ${rejected.architecture}, not ${req.architecture}`
      : rejected
        ? `the first cabinet runs an agent older than this release's minimum version (${release.minimum_version})`
        : "the first cabinet must be an active cabinet running an older agent");
    const rest = cabinets.filter(k => k.id !== pilot.id);
    let batches: [number, typeof cabinets][];
    let labels: string[];
    if (req.batches && req.batches.length > 0) {
      if (req.batches.length > MAX_BATCHES - 2) throw new Refused("invalid_request", 400, `at most ${MAX_BATCHES - 2} batches after the first cabinet`);
      const planned = plannedBatches(rest, req.batches);
      batches = [[1, [pilot]], ...planned.map(([b, m]) => [b, m] as [number, typeof cabinets])];
      labels = [BATCH_NAMES[1], ...planned.map(([, , l]) => l)];
    } else {
      const office = rest.filter(k => k.in_office);
      const field = shuffle(rest.filter(k => !k.in_office));
      const slice = field.length === 0 ? 0 : Math.max(1, Math.ceil(field.length * 0.05));
      batches = [[1, [pilot]], [2, office], [3, field.slice(0, slice)], [4, field.slice(slice)]];
      labels = [BATCH_NAMES[1], BATCH_NAMES[2], BATCH_NAMES[3], BATCH_NAMES[4]];
    }
    const plan: RolloutPlan = { target, batches: batches.map(([b, m], i) => ({ batch: b, label: labels[i]!, cabinets: m.length })) };

    const id = randomUUID();
    await c.query(`INSERT INTO rollouts (id, version, architecture, state, current_batch, success_rate_percent, failure_limit_percent, started_by, [plan])
                   VALUES ($1, $2, $3, 'running', 1, $4, $5, $6, $7)`, [id, req.version, req.architecture, req.successRatePercent, req.failureLimitPercent, adminId, JSON.stringify(plan)]);
    const targets = batches.flatMap(([batch, members]) => members.map(k => ({ batch, id: k.id, from: k.agent_version })));
    await c.query(`INSERT INTO rollout_targets (rollout_id, cabinet_id, batch, state, from_version)
                   SELECT $1, t.cabinet_id, t.batch, 'pending', t.from_version
                     FROM OPENJSON($2) WITH (cabinet_id uniqueidentifier '$.id', batch int '$.batch', from_version nvarchar(max) '$.from') AS t`,
      [id, targets.map(t => ({ id: t.id, batch: t.batch, from: t.from }))]);
    // Audited on its own (docs/spec/07-upgrade-channel.md step 4).
    await audit(c, { actorKind: "user", actorId: adminId, action: "rollout.start", targetKind: "rollout", targetId: id, outcome: "succeeded",
      details: { rolloutId: id, version: req.version, architecture: req.architecture, pilotCabinetId: pilot.id, successRatePercent: req.successRatePercent, failureLimitPercent: req.failureLimitPercent,
        target, batches: plan.batches, belowMinimumVersion: sameArchitecture.length - cabinets.length, wrongArchitecture, ...viaCli(stepUpToken) } });
    return id;
  });
}

/** pause (running → paused), resume (paused → running) and stop (running or paused → stopped). Each with step-up. */
export async function changeRollout(pool: Pool, adminId: string, rolloutId: string, action: "pause" | "resume" | "stop", stepUpToken: Authority): Promise<void> {
  await transaction(pool, async c => {
    if (stepUpToken !== null) await consumeStepUpToken(c, stepUpToken, adminId, `rollout.${action}`, rolloutId);
    const from = action === "resume" ? ["paused"] : action === "pause" ? ["running"] : ["running", "paused"];
    const to = action === "resume" ? "running" : action === "pause" ? "paused" : "stopped";
    const r = await c.query(`UPDATE rollouts SET state = $3, changed_by = $2, paused_reason = CASE WHEN $3 = 'paused' THEN 'Paused by an Admin.' ELSE NULL END,
                               finished_at = CASE WHEN $3 = 'stopped' THEN SYSUTCDATETIME() ELSE finished_at END,
                               batch_started_at = CASE WHEN $3 = 'running' THEN SYSUTCDATETIME() ELSE batch_started_at END
                              WHERE id = $1 AND state IN (SELECT value FROM OPENJSON($4))`, [rolloutId, adminId, to, from]);
    if (r.rowCount !== 1) throw new Refused("not_allowed", 409, `the rollout cannot be ${action === "stop" ? "stopped" : action + "d"} in its current state`);
    // Resuming accepts the failures so far in the current batch; only new ones count toward the limit again.
    if (action === "resume")
      await c.query(`UPDATE r SET accepted_failures = (SELECT COUNT(*) FROM rollout_targets t WHERE t.rollout_id = r.id AND t.batch = r.current_batch AND t.state = 'failed')
                      FROM rollouts r WHERE r.id = $1`, [rolloutId]);
    await audit(c, { actorKind: "user", actorId: adminId, action: `rollout.${action}`, targetKind: "rollout", targetId: rolloutId, outcome: "succeeded", details: { rolloutId, ...viaCli(stepUpToken) } });
    if (action === "resume") await evaluate(c, rolloutId);
  });
}

let running: { at: number; value: Promise<boolean> } | null = null;
/**
 * Whether any rollout is running, looked up at most every 5 seconds per server process. A failed lookup answers false (no offer this
 * time: the next heartbeat asks again) and is not remembered, so a struggling database is not handed a rollout transaction per heartbeat.
 */
export function anyRolloutRunning(pool: Queryable): Promise<boolean> {
  if (!running || Date.now() - running.at > 5_000) {
    const value = pool.query("SELECT TOP (1) 1 FROM rollouts WHERE state = 'running'", [], { timeoutMs: 3_000 }).then(r => r.rows.length > 0, () => {
      if (running?.value === value) running = null;
      return false;
    });
    running = { at: Date.now(), value };
  }
  return running.value;
}

/**
 * The heartbeat's part: a cabinet already running the version has succeeded; one in a batch the running rollout has
 * reached, and still older, is offered the version. Returns the version to offer, or null.
 */
export async function offerFor(db: Queryable, cabinetId: string, reportedVersion: string): Promise<string | null> {
  const t = (await db.query<{ rollout_id: string; version: string; state: string }>(
    `SELECT t.rollout_id, r.version, t.state FROM rollout_targets t JOIN rollouts r ON r.id = t.rollout_id
      WHERE t.cabinet_id = $1 AND r.state = 'running' AND t.batch <= r.current_batch AND t.state IN ('pending', 'offered', 'skipped')`, [cabinetId])).rows[0];
  if (!t) return null;
  if (isVersion(reportedVersion) && compareVersions(reportedVersion, t.version) >= 0) {
    await finish(db, t.rollout_id, cabinetId, { outcome: "succeeded", message: `Running ${reportedVersion}.` });
    return null;
  }
  await db.query(`UPDATE rollout_targets SET state = 'offered', offered_at = COALESCE(offered_at, SYSUTCDATETIME()) WHERE rollout_id = $1 AND cabinet_id = $2 AND state IN ('pending', 'skipped')`,
    [t.rollout_id, cabinetId]);
  return t.version;
}

interface Finish { outcome: "succeeded" | "refused" | "rolled_back" | "failed" | "timed_out"; check?: string | null; message: string }

/** Records how a cabinet's upgrade ended (once), then re-evaluates its rollout. */
async function finish(db: Queryable, rolloutId: string, cabinetId: string, f: Finish): Promise<boolean> {
  // The rollout row first, then the target, in every path, so concurrent heartbeats and reports never deadlock.
  await db.query("SELECT 1 FROM rollouts WITH (UPDLOCK, ROWLOCK) WHERE id = $1", [rolloutId]);
  const r = await db.query(`UPDATE rollout_targets SET state = $3, outcome = $4, check_name = $5, message = $6, finished_at = SYSUTCDATETIME()
                             WHERE rollout_id = $1 AND cabinet_id = $2 AND state IN ('pending', 'offered', 'skipped')`,
    [rolloutId, cabinetId, f.outcome === "succeeded" ? "succeeded" : "failed", f.outcome, f.check ?? null, f.message.slice(0, 1024)]);
  if (r.rowCount !== 1) return false;
  await audit(db, { actorKind: "agent", actorId: cabinetId, action: "upgrade.outcome", targetKind: "cabinet", targetId: cabinetId, outcome: f.outcome === "succeeded" ? "succeeded" : "failed",
    details: { rolloutId, outcome: f.outcome, check: f.check ?? null, message: f.message.slice(0, 256) } });
  await evaluate(db, rolloutId);
  return true;
}

/** POST /agent/v1/upgrade-status: the agent's report. Returns false when no rollout offered this cabinet that version. */
export async function recordUpgradeStatus(pool: Pool, cabinetId: string, s: UpgradeStatus): Promise<boolean> {
  return transaction(pool, async c => {
    const t = (await c.query<{ rollout_id: string; state: string }>(
      `SELECT TOP (1) t.rollout_id, t.state FROM rollout_targets t JOIN rollouts r ON r.id = t.rollout_id
        WHERE t.cabinet_id = $1 AND r.version = $2 ORDER BY r.started_at DESC`, [cabinetId, s.version])).rows[0];
    if (!t) return false;
    await finish(c, t.rollout_id, cabinetId, { outcome: s.outcome, check: s.check ?? null, message: s.message });
    return true;
  });
}

/**
 * Applies the rollout's rules to its current batch: failures above the limit pause it (automatically, audited);
 * otherwise, once the batch's success rate is reached, the next non-empty batch starts, or the rollout completes.
 * Offline cabinets do not count against the rate; after OFFLINE_SKIP_HOURS they are skipped (and still offered the
 * version if they come back while the rollout runs).
 */
export async function evaluate(db: Queryable, rolloutId: string): Promise<void> {
  const r = (await db.query<{ state: string; current_batch: number; success_rate_percent: number; failure_limit_percent: number; batch_started_at: Date; accepted_failures: number; plan: RolloutPlan | null }>(
    "SELECT state, current_batch, success_rate_percent, failure_limit_percent, batch_started_at, accepted_failures, [plan] FROM rollouts WITH (UPDLOCK, ROWLOCK) WHERE id = $1", [rolloutId])).rows[0];
  if (!r || r.state !== "running") return;
  const batch = r.current_batch;
  if (Date.now() - r.batch_started_at.getTime() > OFFLINE_SKIP_HOURS * 3_600_000)
    await db.query(`UPDATE t SET state = 'skipped', outcome = 'offline', message = 'Offline for the whole batch.'
                     FROM rollout_targets t JOIN cabinets k ON k.id = t.cabinet_id WHERE t.rollout_id = $1 AND t.batch = $2 AND t.state = 'pending'
                      AND (k.last_heartbeat_at IS NULL OR k.last_heartbeat_at < DATEADD(second, -$3, SYSUTCDATETIME()))`, [rolloutId, batch, OFFLINE_AFTER_MS / 1000]);
  const n = (await db.query<{ total: string; succeeded: string; failed: string; offered: string; waiting_offline: string; skipped: string }>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN t.state = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded, COALESCE(SUM(CASE WHEN t.state = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
            COALESCE(SUM(CASE WHEN t.state = 'offered' THEN 1 ELSE 0 END), 0) AS offered, COALESCE(SUM(CASE WHEN t.state = 'skipped' THEN 1 ELSE 0 END), 0) AS skipped,
            COALESCE(SUM(CASE WHEN t.state = 'pending' AND (k.last_heartbeat_at IS NULL OR k.last_heartbeat_at < DATEADD(second, -$3, SYSUTCDATETIME())) THEN 1 ELSE 0 END), 0) AS waiting_offline
       FROM rollout_targets t JOIN cabinets k ON k.id = t.cabinet_id WHERE t.rollout_id = $1 AND t.batch = $2`, [rolloutId, batch, OFFLINE_AFTER_MS / 1000])).rows[0]!;
  const total = Number(n.total), succeeded = Number(n.succeeded), failed = Number(n.failed), offered = Number(n.offered);
  const counted = total - Number(n.waiting_offline) - Number(n.skipped);

  const newFailures = failed - r.accepted_failures;
  if (newFailures > 0 && newFailures * 100 > r.failure_limit_percent * total) {
    const reason = `Paused automatically: ${failed} of ${total} cabinet${total === 1 ? "" : "s"} in batch ${batch} (${batchLabel(r.plan, batch)}) failed, above the ${r.failure_limit_percent}% limit.`;
    await db.query("UPDATE rollouts SET state = 'paused', paused_reason = $2 WHERE id = $1", [rolloutId, reason]);
    await audit(db, { actorKind: "system", actorId: "rollout", action: "rollout.auto_pause", targetKind: "rollout", targetId: rolloutId, outcome: "succeeded",
      details: { rolloutId, batch, failed, total, failureLimitPercent: r.failure_limit_percent } });
    return;
  }
  // A batch whose every cabinet was skipped (offline for the whole batch) has no rate to reach: none of it can be counted. It moves on
  // rather than holding the rollout open for good, which would also refuse every later rollout (D82). While any cabinet is still
  // waiting out its day offline, the batch waits as before.
  const allSkipped = counted <= 0 && Number(n.waiting_offline) === 0 && Number(n.skipped) > 0;
  if (!allSkipped && (counted <= 0 || succeeded * 100 < r.success_rate_percent * counted)) return;

  const next = (await db.query<{ batch: number }>("SELECT MIN(batch) AS batch FROM rollout_targets WHERE rollout_id = $1 AND batch > $2", [rolloutId, batch])).rows[0]?.batch;
  if (next) {
    await db.query("UPDATE rollouts SET current_batch = $2, batch_started_at = SYSUTCDATETIME(), accepted_failures = 0 WHERE id = $1", [rolloutId, next]);
    await audit(db, { actorKind: "system", actorId: "rollout", action: "rollout.batch", targetKind: "rollout", targetId: rolloutId, outcome: "succeeded",
      details: { rolloutId, finishedBatch: batch, succeeded, counted, nextBatch: next } });
    await evaluate(db, rolloutId); // an empty or already-upgraded batch moves on at once
  } else if (offered === 0 && !(await offeredEarlier(db, rolloutId, batch))) {
    // The rollout ends here, so nothing is left waiting (D80): every target still pending, in any batch the rollout reached, is closed
    // as skipped, saying whether the cabinet was offline. An offer still open in an earlier batch is waited for first: it gets its
    // outcome, or times out after OUTCOME_TIMEOUT_MINUTES (checkRollouts), before the rollout completes.
    const closed = (await db.query<{ outcome: string | null }>(
      `UPDATE t SET state = 'skipped',
               outcome = CASE WHEN k.last_heartbeat_at IS NULL OR k.last_heartbeat_at < DATEADD(second, -$2, SYSUTCDATETIME()) THEN 'offline' ELSE NULL END,
               message = CASE WHEN k.last_heartbeat_at IS NULL OR k.last_heartbeat_at < DATEADD(second, -$2, SYSUTCDATETIME())
                              THEN 'Offline when the rollout completed: not upgraded.' ELSE 'The rollout completed before this cabinet took the version.' END,
               finished_at = SYSUTCDATETIME()
         OUTPUT inserted.outcome
         FROM rollout_targets t JOIN cabinets k ON k.id = t.cabinet_id WHERE t.rollout_id = $1 AND t.state = 'pending'`, [rolloutId, OFFLINE_AFTER_MS / 1000])).rows;
    await db.query("UPDATE rollouts SET state = 'completed', finished_at = SYSUTCDATETIME() WHERE id = $1", [rolloutId]);
    await audit(db, { actorKind: "system", actorId: "rollout", action: "rollout.complete", targetKind: "rollout", targetId: rolloutId, outcome: "succeeded",
      details: { rolloutId, lastBatch: batch, succeeded, counted, closedOffline: closed.filter(c => c.outcome === "offline").length, closedNotReached: closed.filter(c => c.outcome === null).length } });
  }
}

/** Whether an offer made in an earlier batch than `batch` still has no outcome. */
const offeredEarlier = async (db: Queryable, rolloutId: string, batch: number) =>
  !!(await db.query("SELECT TOP (1) 1 FROM rollout_targets WHERE rollout_id = $1 AND batch < $2 AND state = 'offered'", [rolloutId, batch])).rows[0];

/** Every minute: offers with no outcome after OUTCOME_TIMEOUT_MINUTES count as failed, and running rollouts are re-evaluated. */
export async function checkRollouts(pool: Pool): Promise<void> {
  await transaction(pool, async c => {
    const stale = (await c.query<{ rollout_id: string; cabinet_id: string }>(
      `SELECT t.rollout_id, t.cabinet_id FROM rollout_targets t JOIN rollouts r ON r.id = t.rollout_id
        WHERE r.state IN ('running', 'paused') AND t.state = 'offered' AND t.offered_at < DATEADD(minute, -$1, SYSUTCDATETIME())`, [OUTCOME_TIMEOUT_MINUTES])).rows;
    for (const s of stale)
      await finish(c, s.rollout_id, s.cabinet_id, { outcome: "timed_out", check: null,
        message: `No outcome reported within ${OUTCOME_TIMEOUT_MINUTES} minutes of the offer.` });
    for (const r of (await c.query<{ id: string }>("SELECT id FROM rollouts WHERE state = 'running'")).rows) await evaluate(c, r.id);
  });
}

/** One batch's counts, as the list gives them. */
interface BatchCounts { batch: number; total: number; succeeded: number; failed: number; offered: number; pending: number; skipped: number }

export async function listRollouts(db: Queryable) {
  const rows = (await db.query<{ id: string; version: string; architecture: string; state: string; current_batch: number; success_rate_percent: number; failure_limit_percent: number;
    started_by: string; started_by_name: string; started_at: Date; paused_reason: string | null; finished_at: Date | null; counts: string; plan: RolloutPlan | null }>(
    `SELECT TOP (100) r.id, r.version, r.architecture, r.state, r.current_batch, r.success_rate_percent, r.failure_limit_percent, r.started_by, u.name AS started_by_name, r.started_at,
            r.paused_reason, r.finished_at, r.[plan],
            COALESCE((SELECT x.batch, COUNT(*) AS total, SUM(CASE WHEN x.state = 'succeeded' THEN 1 ELSE 0 END) AS succeeded, SUM(CASE WHEN x.state = 'failed' THEN 1 ELSE 0 END) AS failed,
                             SUM(CASE WHEN x.state = 'offered' THEN 1 ELSE 0 END) AS offered, SUM(CASE WHEN x.state = 'pending' THEN 1 ELSE 0 END) AS pending,
                             SUM(CASE WHEN x.state = 'skipped' THEN 1 ELSE 0 END) AS skipped
                        FROM rollout_targets x WHERE x.rollout_id = r.id GROUP BY x.batch ORDER BY x.batch FOR JSON PATH), '[]') AS counts
       FROM rollouts r JOIN users u ON u.id = r.started_by ORDER BY r.started_at DESC`)).rows;
  return rows.map(r => ({
    id: r.id, version: r.version, architecture: r.architecture, state: r.state, currentBatch: r.current_batch, successRatePercent: r.success_rate_percent, failureLimitPercent: r.failure_limit_percent,
    startedBy: { id: r.started_by, name: r.started_by_name }, startedAt: r.started_at.toISOString(), pausedReason: r.paused_reason, finishedAt: r.finished_at?.toISOString() ?? null,
    // Each batch's counts, with its name: a rollout from before migration 0042 has no plan and the four fixed names.
    batches: (JSON.parse(r.counts) as BatchCounts[]).map(b => ({ ...b, label: batchLabel(r.plan, b.batch) })),
    target: r.plan?.target ?? { kind: "fleet" },
  }));
}

/** Per-cabinet results of one rollout. */
export async function rolloutTargets(db: Queryable, rolloutId: string) {
  return (await db.query<{ cabinet_id: string; cabinet: string; site: string; client: string; batch: number; state: string; from_version: string | null;
    agent_version: string | null; offered_at: Date | null; finished_at: Date | null; outcome: string | null; check_name: string | null; message: string | null; in_office: boolean }>(
    `SELECT TOP (20000) t.cabinet_id, k.name AS cabinet, s.name AS site, cl.name AS client, t.batch, t.state, t.from_version, k.agent_version, t.offered_at, t.finished_at,
            t.outcome, t.check_name, t.message, k.in_office
       FROM rollout_targets t JOIN cabinets k ON k.id = t.cabinet_id JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id
      WHERE t.rollout_id = $1 ORDER BY t.batch, cl.name, s.name, k.name`, [rolloutId])).rows.map(r => ({
    cabinetId: r.cabinet_id, cabinet: r.cabinet, site: r.site, client: r.client, batch: r.batch, state: r.state, fromVersion: r.from_version, agentVersion: r.agent_version,
    offeredAt: r.offered_at?.toISOString() ?? null, finishedAt: r.finished_at?.toISOString() ?? null, outcome: r.outcome, check: r.check_name, message: r.message, inOffice: r.in_office,
  }));
}

/** Marks a cabinet as in the office (batch 2 of every rollout), with step-up. */
export async function setInOffice(pool: Pool, adminId: string, cabinetId: string, inOffice: boolean, stepUpToken: Authority): Promise<void> {
  await transaction(pool, async c => {
    if (stepUpToken !== null) await consumeStepUpToken(c, stepUpToken, adminId, "cabinet.in_office", cabinetId);
    const r = await c.query("UPDATE cabinets SET in_office = $2 WHERE id = $1 AND status = 'active'", [cabinetId, inOffice]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such active cabinet");
    await audit(c, { actorKind: "user", actorId: adminId, action: "cabinet.in_office", targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded",
      details: { inOffice, ...viaCli(stepUpToken) } });
  });
}

/** Active cabinets with their agent version, architecture and in-office flag, for choosing batch 1. */
export async function upgradeCandidates(db: Queryable) {
  return (await db.query<{ id: string; name: string; site: string; client: string; agent_version: string | null; architecture: string; in_office: boolean; last_heartbeat_at: Date | null }>(
    `SELECT TOP (20000) k.id, k.name, s.name AS site, cl.name AS client, k.agent_version, COALESCE(k.architecture, 'windows-x64') AS architecture, k.in_office, k.last_heartbeat_at
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id
      WHERE k.status = 'active' ORDER BY k.in_office DESC, cl.name, s.name, k.name`)).rows.map(r => ({
    id: r.id, name: r.name, site: r.site, client: r.client, agentVersion: r.agent_version, architecture: r.architecture, inOffice: r.in_office,
    online: r.last_heartbeat_at !== null && Date.now() - r.last_heartbeat_at.getTime() < OFFLINE_AFTER_MS,
  }));
}
