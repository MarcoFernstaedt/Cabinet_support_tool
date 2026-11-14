// Fleet operations (docs/spec/13-roadmap.md modules 21 and 45): one fixed operation on cabinets a person chose, run as a
// job. The target list is a snapshot taken when the job starts; the server fills in each cabinet's parameters (its site's
// zone, its firewall policy) and says why it skips any. The job issues the commands in batches (the next batch
// starts once this one has answered), records each cabinet's result, then verifies it from the cabinet's next report:
// a change that cannot be seen is "not verified", never counted as done. Confirmed with the password, bound to the exact
// operation, cabinets, batch size and preview digest; at most 200 cabinets; the whole job counts as one write against the person's limit.
// Sync cabinets go last, in batches of their own, and only once every satellite in the job checked out: a change that breaks a
// sync cabinet cuts off every satellite at its site, so it is never made while a satellite's result is in doubt (the owner's decision, 8e).
import { ownedPool, takeLease } from "./job-lease.js";
import { parseJson } from "./settings.js";
import { randomUUID } from "node:crypto";
import { catalog, operations } from "../contracts.js";
import { audit, auditMany, lock, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { paramsHash } from "../auth/canonical.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { Refused } from "./errors.js";
import { checkRetentionCutoff, inBatches, RETENTION_BATCH, type BatchOptions } from "../db/batches.js";
import { ISSUE } from "./rules.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";
import { assertUnderWriteLimit, fleetPause, pauseOnWriteLimit } from "./writes.js";
import { BULK_LIMIT, cabinetPolicy, switchesFor } from "./firewall-policy.js";
import { CLOCK_TOLERANCE_SECONDS, SITE_ZONE_SQL } from "./time.js";
import { issueFromConsole, ROLE_RANK, type Role } from "./console-commands.js";
import type { NetworkConfigOutput } from "@mashura/cabinet-contracts/types";

export const JOB_OPERATIONS = ["time.setZone", "time.sync", "firewall.applyPolicy", "network.setDns", "network.setIp", "network.renewLease"] as const;
export type JobOperation = (typeof JOB_OPERATIONS)[number];
type Problem = "any" | "time_zone_wrong" | "clock_off" | "firewall_drift";

interface Timing { pollMs: number; verifyMs: number; batchMs?: number }
/** Poll interval and per-target answer and report verification budgets. batchMs defaults for existing callers. */
export const DEFAULT_TIMING: Timing = { pollMs: 1000, verifyMs: 150_000, batchMs: 150_000 };

// ---- Choosing cabinets --------------------------------------------------------------------------------------------------

// Match the bulk selection budget: the console can choose at most 200 cabinets for a job.
const CABINETS_LIMIT = BULK_LIMIT;

/** The cabinets the page lists: active ones, narrowed by client, site and a problem. */
export async function fleetCabinets(db: Queryable, q: { clientId?: string | undefined; siteId?: string | undefined; problem?: Problem | undefined }) {
  const where: string[] = ["k.status = 'active'"];
  const args: unknown[] = [];
  if (q.clientId) { args.push(q.clientId); where.push(`cl.id = $${args.length}`); }
  if (q.siteId) { args.push(q.siteId); where.push(`s.id = $${args.length}`); }
  const open = (issue: string) => { args.push(issue); return `EXISTS (SELECT 1 FROM alerts a WHERE a.cabinet_id = k.id AND a.issue_type_id = $${args.length} AND a.state <> 'resolved')`; };
  if (q.problem === "time_zone_wrong") where.push(open(ISSUE.timeZone));
  if (q.problem === "clock_off") where.push(open(ISSUE.clock));
  if (q.problem === "firewall_drift") where.push(open(ISSUE.firewallPolicy));
  args.push(OFFLINE_AFTER_MS / 1000);
  const rows = (await db.query<{ id: string; name: string; role: string; site_id: string; site: string; client_id: string; client: string; demo: number; read_only: boolean | null;
    online: number; time_zone_id: string | null; site_zone: string | null; skew: number | null; alerts: string; ipv4: string | null; matched: number }>(
    `SELECT TOP (${CABINETS_LIMIT}) COUNT(*) OVER () AS matched, k.id, k.name, k.role, s.id AS site_id, s.name AS site, cl.id AS client_id, cl.name AS client, CASE WHEN k.demo_scenario IS NOT NULL THEN 1 ELSE 0 END AS demo, k.read_only,
            CASE WHEN k.last_heartbeat_at > DATEADD(second, -$${args.length}, SYSUTCDATETIME()) THEN 1 ELSE 0 END AS online,
            k.time_zone_id, ${SITE_ZONE_SQL} AS site_zone, k.clock_skew_seconds AS skew, k.ipv4,
            (SELECT COUNT(*) FROM alerts a WHERE a.cabinet_id = k.id AND a.state <> 'resolved') AS alerts
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id
      WHERE ${where.join(" AND ")} ORDER BY cl.name, s.name, k.name, k.id`, args)).rows;
  const cabinets = rows.map(r => ({ id: r.id, name: r.name, role: r.role, site: { id: r.site_id, name: r.site, timeZone: r.site_zone }, client: { id: r.client_id, name: r.client },
    demo: r.demo === 1, readOnly: r.read_only, online: r.online === 1, timeZoneId: r.time_zone_id, clockSkewSeconds: r.skew, ipv4: r.ipv4, openAlerts: Number(r.alerts) }));
  return { cabinets, limits: { cabinets: { shown: cabinets.length, matched: Number(rows[0]?.matched ?? 0), limit: CABINETS_LIMIT } } };
}

/** The sites to choose from: a bulk change covers one site, so the page starts by choosing one. */
export async function fleetSites(db: Queryable) {
  const rows = (await db.query<{ id: string; name: string; client_id: string; client: string; demo: boolean; cabinets: string }>(
    `SELECT s.id, s.name, cl.id AS client_id, cl.name AS client, cl.demo, COUNT(k.id) AS cabinets
       FROM sites s JOIN clients cl ON cl.id = s.client_id LEFT JOIN cabinets k ON k.site_id = s.id AND k.status = 'active'
      WHERE s.removed_at IS NULL AND cl.removed_at IS NULL GROUP BY s.id, s.name, cl.id, cl.name, cl.demo ORDER BY cl.name, s.name`)).rows;
  return rows.map(r => ({ id: r.id, name: r.name, client: { id: r.client_id, name: r.client }, demo: r.demo, cabinets: Number(r.cabinets) }));
}

// ---- Planning: what each cabinet would get, or why it is skipped ---------------------------------------------------------

interface Plan { cabinetId: string; name: string; role: string; site: string; client: string; params: Record<string, unknown> | null; skip: string | null; detail?: string }

/** For each chosen cabinet, in the order given: the parameters the server fills in, or why the operation skips it. */
export async function plan(db: Queryable, operation: JobOperation, cabinetIds: string[]): Promise<Plan[]> {
  const rows = new Map((await db.query<{ id: string; site_id: string; name: string; role: string; site: string; client: string; status: string; read_only: boolean | null; paused: boolean;
    online: number; zone: string | null; site_zone: string | null; skew: number | null }>(
    `SELECT k.id, k.site_id, k.name, k.role, s.name AS site, cl.name AS client, k.status, k.read_only, cl.write_paused AS paused,
            CASE WHEN k.last_heartbeat_at > DATEADD(second, -$2, SYSUTCDATETIME()) THEN 1 ELSE 0 END AS online,
            k.time_zone_id AS zone, ${SITE_ZONE_SQL} AS site_zone, k.clock_skew_seconds AS skew
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id WHERE k.id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))`,
    [cabinetIds, OFFLINE_AFTER_MS / 1000])).rows.map(r => [r.id, r]));
  // A bulk change covers the cabinets of one site: a mistake in the choice can only reach one place.
  if (new Set([...rows.values()].map(r => r.site_id)).size > 1)
    throw new Refused("one_site_only", 409, "a fleet operation covers the cabinets of one site; choose the site first, then the cabinets in it");
  const out: Plan[] = [];
  for (const id of cabinetIds) {
    const r = rows.get(id);
    if (!r) throw new Refused("not_found", 404, "one of the chosen cabinets does not exist");
    const base = { cabinetId: id, name: r.name, role: r.role, site: r.site, client: r.client };
    const skip = (why: string): Plan => ({ ...base, params: null, skip: why });
    if (r.status !== "active") { out.push(skip("Not an active cabinet.")); continue; }
    if (r.read_only !== false) { out.push(skip("Installed read-only: it accepts no changes.")); continue; }
    if (r.paused) { out.push(skip("Changes to this client's cabinets are paused.")); continue; }
    if (!r.online) { out.push(skip("Offline: not heard from in the last 5 minutes.")); continue; }
    if (operation === "time.setZone") {
      if (!r.site_zone) { out.push(skip("No time zone is set for its site, its client or the fleet.")); continue; }
      if (r.zone === r.site_zone) { out.push(skip("Already in its site's time zone.")); continue; }
      out.push({ ...base, params: { timeZoneId: r.site_zone }, skip: null });
    } else if (operation === "time.sync") {
      out.push({ ...base, params: {}, skip: null });
    } else if (operation === "network.setDns" || operation === "network.setIp" || operation === "network.renewLease") {
      // The change comes from the cabinet's latest network diagnosis (at most 30 minutes old): the server never takes it from the browser.
      const fix = await networkFix(db, id, operation);
      out.push(fix.params ? { ...base, params: fix.params, skip: null, detail: fix.label } : skip(fix.why));
    } else {
      const p = await cabinetPolicy(db, id);
      if (p.differs === false) { out.push(skip("Already matches its firewall policy.")); continue; }
      out.push({ ...base, params: { profiles: switchesFor(p.policy) }, skip: null });
    }
  }
  // Sync cabinets last, each group keeping the order chosen.
  return [...out.filter(t => t.role !== "sync"), ...out.filter(t => t.role === "sync")];
}

/** The change a cabinet's latest diagnosis found for this operation, as the operation's own parameters. */
async function networkFix(db: Queryable, cabinetId: string, operation: "network.setDns" | "network.setIp" | "network.renewLease"): Promise<{ params: Record<string, unknown>; label: string; why?: undefined } | { params?: undefined; label?: undefined; why: string }> {
  const d = (await db.query<{ findings: { severity: string; action?: Record<string, unknown> }[] | null }>(
    `SELECT TOP (1) findings FROM diagnoses WHERE cabinet_id = $1 AND kind = 'network' AND state = 'done' AND finished_at > DATEADD(minute, -30, SYSUTCDATETIME()) ORDER BY started_at DESC`, [cabinetId])).rows[0];
  if (!d?.findings) return { why: "No network diagnosis from the last 30 minutes: run the diagnosis again first." };
  const wanted = operation === "network.setDns" ? ["set_dns"] : operation === "network.renewLease" ? ["renew_lease"] : ["use_dhcp", "set_static"];
  const a = d.findings.find(f => f.action && wanted.includes(String(f.action.kind)))?.action;
  if (!a) return { why: "The latest diagnosis found nothing this change would fix." };
  const base = { interfaceIndex: a.interfaceIndex };
  const params: Record<string, unknown> = a.kind === "renew_lease" ? { ...base } : a.kind === "set_dns" ? { ...base, mode: "static", servers: a.servers }
    : a.kind === "use_dhcp" ? { ...base, mode: "dhcp" }
    : { ...base, mode: "static", address: a.address, prefixLength: a.prefixLength, gateway: a.gateway };
  const check: unknown = params;
  if (!operations[operation].params.is(check)) return { why: "The diagnosis's suggested change is not valid for this cabinet." };
  return { params, label: String(a.label ?? operation) };
}

/** Only executable decisions are bound; display names and diagnosis labels are not write parameters. */
function planDigest(operation: JobOperation, targets: Plan[]): string {
  return paramsHash({ operation, targets: targets.map(t => ({ cabinetId: t.cabinetId, role: t.role, params: t.params, skip: t.skip })) });
}

export async function preview(db: Queryable, user: { role: Role }, operation: JobOperation, cabinetIds: string[]) {
  checkRole(user.role, operation);
  const p = await plan(db, operation, cabinetIds);
  const ipv4s = new Map((await db.query<{ id: string; ipv4: string | null }>("SELECT id, ipv4 FROM cabinets WHERE id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))", [cabinetIds])).rows.map(r => [r.id, r.ipv4]));
  return { operation, planDigest: planDigest(operation, p), limit: BULK_LIMIT, change: p.filter(x => !x.skip).length, skip: p.filter(x => x.skip).length,
    cabinets: p.map(x => ({ id: x.cabinetId, name: x.name, role: x.role, site: x.site, client: x.client, ipv4: ipv4s.get(x.cabinetId) ?? null, params: x.params, skip: x.skip, detail: x.detail ?? null })) };
}

function checkRole(role: Role, operation: JobOperation): void {
  const entry = catalog.get(operation)!;
  if (ROLE_RANK[role] < ROLE_RANK[entry.minimumRole as Role]) throw new Refused("forbidden", 403, "your role cannot run this operation");
}

// ---- Starting a job -----------------------------------------------------------------------------------------------------

export interface JobRequest { jobId: string; operation: JobOperation; cabinetIds: string[]; batchSize: number; planDigest: string; stepUpToken: string }

/** Starts a job: checks the password confirmation, the pauses and the limit, and fixes its target list. Running it is runJob's. */
export async function startJob(pool: Pool, user: { userId: string; role: Role }, r: JobRequest): Promise<{ jobId: string; change: number; skip: number }> {
  checkRole(user.role, r.operation);
  if (r.cabinetIds.length > BULK_LIMIT) throw new Refused("too_many_cabinets", 409, `a fleet operation covers at most ${BULK_LIMIT} cabinets`);
  return pauseOnWriteLimit(pool, user.userId, () => transaction(pool, async c => {
    await consumeStepUpToken(c, r.stepUpToken, user.userId, "fleet.job", r.jobId, { operation: r.operation, cabinetIds: r.cabinetIds, batchSize: r.batchSize, planDigest: r.planDigest });
    if ((await c.query("SELECT 1 FROM fleet_jobs WHERE id = $1", [r.jobId])).rows[0]) throw new Refused("job_exists", 409, "that job was already started");
    await lock(c, `writes:${user.userId}`);
    if ((await fleetPause(c)).paused) throw new Refused("writes_paused", 409, "writes are paused fleet-wide");
    await assertUnderWriteLimit(c, user.userId);
    let targets: Plan[];
    try { targets = await plan(c, r.operation, r.cabinetIds); }
    catch (e) {
      // A cabinet that is gone since the preview is drift: the operator goes back to a fresh preview. Any other refusal is
      // its own answer and keeps its code (a plan that no longer covers one site, say).
      if (e instanceof Refused && e.code === "not_found")
        throw new Refused("preview_changed", 409, "the fleet plan changed; preview it again before confirming");
      throw e;
    }
    if (planDigest(r.operation, targets) !== r.planDigest)
      throw new Refused("preview_changed", 409, "the fleet plan changed; preview it again before confirming");
    await c.query("INSERT INTO fleet_jobs (id, operation, created_by, batch_size, total) VALUES ($1, $2, $3, $4, $5)",
      [r.jobId, r.operation, user.userId, r.batchSize, targets.length]);
    // Every target in one statement (up to BULK_LIMIT rows), not one round trip each.
    if (targets.length > 0)
      await c.query(`INSERT INTO fleet_job_targets (job_id, cabinet_id, [position], params, state, detail)
                     SELECT $1, j.cabinet_id, j.position, j.params, j.state, j.detail
                       FROM OPENJSON($2) WITH (cabinet_id uniqueidentifier '$.c', position int '$.i', params nvarchar(max) '$.p', state nvarchar(64) '$.s', detail nvarchar(max) '$.d') j`,
        [r.jobId, JSON.stringify(targets.map((t, i) => ({ c: t.cabinetId, i, p: t.params === null ? null : safeJson(t.params), s: t.skip ? "skipped" : "pending", d: t.skip })))]);
    const change = targets.filter(t => !t.skip).length;
    await audit(c, { actorKind: "user", actorId: user.userId, action: "fleet.job.start", targetKind: "job", targetId: r.jobId, outcome: "succeeded",
      details: { operation: r.operation, cabinets: targets.length, change, batchSize: r.batchSize } });
    if (change === 0) await c.query("UPDATE fleet_jobs SET state = 'done', finished_at = SYSUTCDATETIME() WHERE id = $1", [r.jobId]);
    return { jobId: r.jobId, change, skip: targets.length - change };
  }));
}

// ---- Running a job ------------------------------------------------------------------------------------------------------

const running = new Set<string>();
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

const JOB_LEASE_MS = 30_000;
const jobLeaseName = (id: string) => `fleet.job.${id}`;

/** Runs one job to its end, only while holding its database lease, for route and recovery callers alike. */
export async function runJob(pool: Pool, jobId: string, timing: Timing = DEFAULT_TIMING, log: (m: string) => void = () => {}, acquired: () => void = () => {}): Promise<void> {
  if (running.has(jobId)) return;
  running.add(jobId);
  try {
    // A fresh token for every attempt fences even an old invocation in this same process after expiry.
    const holder = randomUUID();
    const name = jobLeaseName(jobId);
    if (!(await takeLease(pool, name, JOB_LEASE_MS, holder))) return;
    acquired();
    pool = ownedPool(pool, name, holder, JOB_LEASE_MS);
    const job = (await pool.query<{ operation: JobOperation; created_by: string; batch_size: number; state: string; role: Role }>(
      "SELECT j.operation, j.created_by, j.batch_size, j.state, u.role FROM fleet_jobs j JOIN users u ON u.id = j.created_by WHERE j.id = $1", [jobId])).rows[0];
    if (!job || (job.state !== "running" && job.state !== "cancelled")) return;
    for (;;) {
      // Issued commands from before a restart are followed up first; then the next batch.
      let batch = (await pool.query<{ cabinet_id: string; command_id: string; params: Record<string, unknown> }>(
        "SELECT cabinet_id, command_id, params FROM fleet_job_targets WHERE job_id = $1 AND state IN ('issued', 'succeeded') ORDER BY [position]", [jobId])).rows;
      if (batch.length === 0) {
        if (await cancelled(pool, jobId)) break;
        batch = await issueBatch(pool, jobId, job);
      }
      if (batch.length === 0) break;
      await followUp(pool, jobId, job.operation, batch, timing, { userId: job.created_by, role: job.role });
    }
    // The job's end is an automatic transition, audited with it in one transaction (F4); the targets it never reached say so.
    await transaction(pool, async c => {
      const notReached = (await c.query(`UPDATE fleet_job_targets SET state = 'cancelled', detail = 'The job was cancelled before this cabinet was reached.', updated_at = SYSUTCDATETIME()
                         WHERE job_id = $1 AND state = 'pending'`, [jobId])).rowCount ?? 0;
      const ended = (await c.query<{ state: string }>(
        "UPDATE fleet_jobs SET state = CASE WHEN state = 'cancelled' THEN 'cancelled' ELSE 'done' END, finished_at = SYSUTCDATETIME() OUTPUT inserted.state WHERE id = $1 AND finished_at IS NULL",
        [jobId])).rows[0];
      if (ended)
        await audit(c, { actorKind: "system", actorId: "fleet-jobs", action: "fleet.job.finish", targetKind: "job", targetId: jobId, outcome: "succeeded",
          details: { state: ended.state, notReached, automatic: true } });
    });
  } catch (e) {
    log(`fleet job ${jobId} stopped: ${(e as Error).message}`);
  } finally {
    running.delete(jobId);
  }
}

const cancelled = async (pool: Pool, jobId: string) =>
  (await pool.query<{ state: string }>("SELECT state FROM fleet_jobs WHERE id = $1", [jobId])).rows[0]?.state !== "running";

/** Issues the next batch's commands in one transaction, re-checking the pauses: a pause that started mid-job skips the rest. */
async function issueBatch(pool: Pool, jobId: string, job: { operation: JobOperation; created_by: string; batch_size: number }): Promise<{ cabinet_id: string; command_id: string; params: Record<string, unknown> }[]> {
  return transaction(pool, async c => {
    // Everything but sync cabinets first; sync cabinets only once every satellite in the job is done and none failed or went unverified.
    const pendingOf = async (sync: boolean) => (await c.query<{ cabinet_id: string; params: Record<string, unknown> }>(
      `SELECT TOP ($2) t.cabinet_id, t.params FROM fleet_job_targets t WITH (UPDLOCK, ROWLOCK) JOIN cabinets k ON k.id = t.cabinet_id
        WHERE t.job_id = $1 AND t.state = 'pending' AND ${sync ? "k.role = 'sync'" : "k.role <> 'sync'"} ORDER BY t.[position]`,
      [jobId, job.batch_size])).rows;
    let next = await pendingOf(false);
    if (next.length === 0) {
      // Doubt is anything but verified or skipped: failed, not verified, and also "succeeded" (the cabinet said it made the change, but
      // nothing verified it, as a server restart inside the verification window leaves it).
      const doubt = (await c.query<{ name: string }>(
        `SELECT k.name FROM fleet_job_targets t JOIN cabinets k ON k.id = t.cabinet_id
          WHERE t.job_id = $1 AND k.role = 'satellite' AND t.state NOT IN ('verified', 'skipped') ORDER BY t.[position]`, [jobId])).rows;
      if (doubt.length > 0) {
        await c.query(`UPDATE t SET t.state = 'skipped', t.detail = $2, t.updated_at = SYSUTCDATETIME()
                         FROM fleet_job_targets t JOIN cabinets k ON k.id = t.cabinet_id WHERE t.job_id = $1 AND t.state = 'pending' AND k.role = 'sync'`,
          [jobId, doubtReason(doubt.map(d => d.name))]);
        return [];
      }
      next = await pendingOf(true);
    }
    if (next.length === 0) return [];
    const stop = async (why: string): Promise<never[]> => {
      await c.query("UPDATE fleet_job_targets SET state = 'skipped', detail = $2, updated_at = SYSUTCDATETIME() WHERE job_id = $1 AND state = 'pending'", [jobId, why]);
      return [];
    };
    if ((await fleetPause(c)).paused) return stop("Writes were paused fleet-wide while the job ran.");
    const entry = catalog.get(job.operation)!;
    const u = (await c.query<{ writes_paused: boolean; status: string; role: Role }>("SELECT writes_paused, status, role FROM users WHERE id = $1", [job.created_by])).rows[0];
    if (!u || u.status !== "active" || u.writes_paused) return stop("The person who started the job can no longer make changes.");
    // The role is read here, in the batch's own transaction, and never cached: a demotion after the job started withdraws the
    // permission the remaining batches would have used (the same check startJob makes). Already-issued commands still finish.
    if (ROLE_RANK[u.role] < ROLE_RANK[entry.minimumRole as Role])
      return stop(`The person who started the job no longer has the role this operation needs (${u.role}), so the rest was not sent.`);
    const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const expiresAt = new Date(issuedAt.getTime() + entry.expirySeconds * 1000);
    const issued: { cabinet_id: string; command_id: string; params: Record<string, unknown> }[] = [];
    for (const t of next) {
      const k = (await c.query<{ paused: boolean; read_only: boolean | null; status: string }>(
        `SELECT cl.write_paused AS paused, k.read_only, k.status FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id WHERE k.id = $1`,
        [t.cabinet_id])).rows[0];
      if (!k || k.status !== "active" || k.paused || k.read_only !== false) {
        await c.query("UPDATE fleet_job_targets SET state = 'skipped', detail = $3, updated_at = SYSUTCDATETIME() WHERE job_id = $1 AND cabinet_id = $2",
          [jobId, t.cabinet_id, "The cabinet stopped accepting changes before its turn (paused, read-only or removed)."]);
        continue;
      }
      const commandId = randomUUID();
      await c.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, bulk_id)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8)`, [commandId, t.cabinet_id, job.operation, safeJson(t.params), job.created_by, issuedAt, expiresAt, jobId]);
      await c.query("UPDATE fleet_job_targets SET state = 'issued', command_id = $3, detail = NULL, updated_at = SYSUTCDATETIME() WHERE job_id = $1 AND cabinet_id = $2",
        [jobId, t.cabinet_id, commandId]);
      issued.push({ cabinet_id: t.cabinet_id, command_id: commandId, params: t.params });
    }
    // The audit entries go last, in one call: the audit chain serializes every writer of the log, so it is held for the shortest
    // time (they still commit or roll back with the commands).
    await auditMany(c, issued.map(t => ({ actorKind: "user" as const, actorId: job.created_by, action: "command.write", targetKind: "cabinet" as const, targetId: t.cabinet_id,
      outcome: "succeeded" as const, details: { commandId: t.command_id, operation: job.operation, params: t.params, bulkId: jobId } })));
    return issued;
  }).then(async issued =>
    // Every cabinet in this batch was skipped: go on to the next batch rather than ending the job.
    issued.length > 0 || !(await pendingLeft(pool, jobId)) ? issued : issueBatch(pool, jobId, job));
}

/** Why the sync cabinets were not changed, naming the satellites in doubt; whole names only, within the column's 300 characters. */
export function doubtReason(names: readonly string[]): string {
  const say = (shown: readonly string[], more: number) => {
    const list = [shown.join(", "), more > 0 ? `${more} more` : ""].filter(Boolean).join(" and ");
    return `Not changed: a satellite in this job did not check out (${list}), and a sync cabinet serves every satellite at its site.`;
  };
  for (let n = names.length; n >= 0; n--) {
    const text = say(names.slice(0, n), names.length - n);
    if (text.length <= 300) return text;
  }
  return say([], names.length);
}

const pendingLeft = async (pool: Pool, jobId: string) =>
  !!(await pool.query("SELECT TOP (1) 1 FROM fleet_job_targets WHERE job_id = $1 AND state = 'pending'", [jobId])).rows[0];

const FAILED_STATUSES = new Set(["failed", "rejected", "expired"]);

/** Waits for a batch's commands, records each result, then verifies the successes from the cabinets' next reports. */
async function followUp(pool: Pool, jobId: string, operation: JobOperation, batch: { cabinet_id: string; command_id: string; params: Record<string, unknown> }[], timing: Timing,
  creator: { userId: string; role: Role }) {
  const waiting = new Map(batch.map(b => [b.command_id, b]));
  const answered: { cabinet_id: string; params: Record<string, unknown>; at: Date; verifyBy: number }[] = [];
  // Budget from the durable issue time: recovery must not grant an unanswered command extra time.
  const batchMs = timing.batchMs ?? DEFAULT_TIMING.batchMs!;
  while (waiting.size > 0 || answered.length > 0) {
    // Withdraw outstanding commands atomically with respect to agent delivery before reporting a terminal outcome.
    // Delivered commands retain expiry's late-result handling; an online, undispatched timeout is a failure.
    // Even an immediate withdrawal must keep expires_at strictly above issued_at (commands_check).
    const rows = waiting.size === 0 ? [] : await transaction(pool, async tx => {
      const retired = (await tx.query<{ id: string; cabinet_id: string; operation: string; status: string; delivered: boolean | number }>(
      `DECLARE @retired TABLE (id uniqueidentifier, cabinet_id uniqueidentifier, operation nvarchar(64), status varchar(16), delivered bit);
       UPDATE commands SET status = CASE WHEN delivered_at IS NOT NULL OR NOT EXISTS
           (SELECT 1 FROM cabinets k WHERE k.id = commands.cabinet_id
             AND k.last_heartbeat_at > DATEADD(second, -$2, SYSUTCDATETIME())) THEN 'expired' ELSE 'failed' END, expires_at = CASE WHEN DATEADD(millisecond, 1, issued_at) > SYSUTCDATETIME() THEN DATEADD(millisecond, 1, issued_at)
           WHEN expires_at > SYSUTCDATETIME() THEN SYSUTCDATETIME() ELSE expires_at END
         OUTPUT inserted.id, inserted.cabinet_id, inserted.operation, inserted.status,
           CAST(CASE WHEN inserted.delivered_at IS NULL THEN 0 ELSE 1 END AS bit) INTO @retired
         WHERE id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1)) AND status IN ('queued', 'delivered')
           AND (issued_at <= DATEADD(millisecond, -$3, SYSUTCDATETIME())
             OR (status = 'queued' AND delivered_at IS NULL AND NOT EXISTS
               (SELECT 1 FROM cabinets k WHERE k.id = commands.cabinet_id
                 AND k.last_heartbeat_at > DATEADD(second, -$2, SYSUTCDATETIME()))));
       SELECT id, cabinet_id, operation, status, delivered FROM @retired`, [[...waiting.keys()], OFFLINE_AFTER_MS / 1000, batchMs])).rows;
      if (retired.length > 0)
        await auditMany(tx, retired.map(r => ({ actorKind: "system", actorId: "command-expiry", action: "command.expire", targetKind: "command", targetId: r.id.toLowerCase(),
          outcome: "succeeded", details: { cabinetId: r.cabinet_id.toLowerCase(), operation: r.operation, jobId, status: r.status,
            why: "fleet-job-withdrawal", delivered: r.delivered === true || r.delivered === 1, automatic: true } })));
      return (await tx.query<{ id: string; status: string; result: { error?: { code: string; message: string } } | null; result_at: Date | null; issued_at: Date; delivered: boolean | number }>(
        `SELECT id, status, issued_at, result, result_at, CAST(CASE WHEN delivered_at IS NULL THEN 0 ELSE 1 END AS bit) AS delivered
         FROM commands WHERE id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))`, [[...waiting.keys()]])).rows;
    });
    // Retention (or a recovered target without a command) must not keep the lease alive forever.
    const present = new Set(rows.map(r => r.id));
    for (const [id, t] of waiting) {
      if (present.has(id)) continue;
      await setTarget(pool, jobId, t.cabinet_id, "failed", "The command is missing; its outcome could not be confirmed.");
      waiting.delete(id);
    }
    for (const r of rows) {
      const t = waiting.get(r.id)!;
      if (r.status === "succeeded") {
        await setTarget(pool, jobId, t.cabinet_id, "succeeded", "The cabinet made the change; waiting for its next report to verify it.");
        answered.push({ cabinet_id: t.cabinet_id, params: t.params, at: r.result_at ?? new Date(), verifyBy: Date.now() + timing.verifyMs });
        waiting.delete(r.id);
      } else if (r.status === "expired" && !(r.delivered === true || r.delivered === 1)) {
        // Never taken: the cabinet was out of contact for the whole job, so nothing was tried on it (F18.R2).
        await setTarget(pool, jobId, t.cabinet_id, "offline", "The cabinet was out of contact and never took the command; nothing was changed on it. Run the job again for it once it is back.");
        waiting.delete(r.id);
      } else if (FAILED_STATUSES.has(r.status)) {
        const why = r.status === "expired" ? "The cabinet took the command but did not answer before it expired; check whether the change was made."
          : r.result?.error ? `${r.result.error.code}: ${r.result.error.message}` : `The command ${r.status}.`;
        await setTarget(pool, jobId, t.cabinet_id, "failed", why);
        waiting.delete(r.id);
      }
    }
    for (let i = answered.length - 1; i >= 0; i--) {
      const a = answered[i]!;
      if (await verified(pool, operation, a, creator)) {
        await setTarget(pool, jobId, a.cabinet_id, "verified", verifiedText[operation]);
      } else if (Date.now() >= a.verifyBy) {
        await setTarget(pool, jobId, a.cabinet_id, "not_verified", "The cabinet said it made the change, but its next report did not show it in time. Check it.");
      } else continue;
      answered.splice(i, 1);
    }
    if (waiting.size > 0 || answered.length > 0) await sleep(timing.pollMs);
  }
}

const verifiedText: Record<JobOperation, string> = {
  "time.setZone": "Verified: the cabinet reports its site's time zone.",
  "time.sync": "Verified: the cabinet's clock is within two minutes of the server's.",
  "firewall.applyPolicy": "Verified: the cabinet's firewall matches its policy.",
  "network.setDns": "Verified: read back from the cabinet, its DNS servers are the baseline's.",
  "network.setIp": "Verified: read back from the cabinet, its address settings are as intended.",
  "network.renewLease": "Verified: read back from the cabinet, it has a real address from the DHCP server.",
};

/** Network changes are verified by reading the settings back from the cabinet (as the person who started the job), not from a heartbeat. */
async function networkVerified(pool: Pool, creator: { userId: string; role: Role }, operation: JobOperation, a: { cabinet_id: string; params: Record<string, unknown> }): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const issued = await issueFromConsole(pool, creator, a.cabinet_id, "network.config", {});
      for (const end = Date.now() + 20_000; Date.now() < end; await sleep(200)) {
        const r = (await pool.query<{ status: string; result: { output?: NetworkConfigOutput } | null }>("SELECT status, result FROM commands WHERE id = $1", [issued.commandId])).rows[0];
        if (r?.status === "succeeded" && r.result?.output) {
          const ad = r.result.output.adapters.find(x => x.interfaceIndex === a.params.interfaceIndex);
          if (!ad) return false;
          const p = a.params;
          if (operation === "network.renewLease") { if (ad.ipv4.dhcp && ad.ipv4.addresses.some(x => !x.address.startsWith("169.254."))) return true; }
          else if (operation === "network.setDns") { const want = [...(p.servers as string[])].sort().join(","); if (ad.dns.servers.slice().sort().join(",") === want) return true; }
          else if (p.mode === "dhcp") { if (ad.ipv4.dhcp && ad.ipv4.addresses.some(x => !x.address.startsWith("169.254."))) return true; }
          else if (ad.ipv4.addresses.some(x => x.address === p.address && x.prefixLength === p.prefixLength) && ad.ipv4.gateways[0] === p.gateway) return true;
          break;
        }
        if (r && r.status !== "queued" && r.status !== "delivered") break;
      }
    } catch { /* a refused or failed read means not verified */ }
    await sleep(1500);
  }
  return false;
}

/** Whether a cabinet's own report after the change shows it; also used by a replacement's re-apply (replacement-reapply.ts). */
export async function verified(db: Pool, operation: JobOperation, a: { cabinet_id: string; params: Record<string, unknown>; at: Date }, creator: { userId: string; role: Role }): Promise<boolean> {
  if (operation === "network.setDns" || operation === "network.setIp" || operation === "network.renewLease") return networkVerified(db, creator, operation, a);
  const k = (await db.query<{ zone: string | null; skew: number | null; last: Date | null; profiles: string | null }>(
    "SELECT time_zone_id AS zone, clock_skew_seconds AS skew, last_heartbeat_at AS [last], firewall_profiles AS profiles FROM cabinets WHERE id = $1", [a.cabinet_id])).rows[0];
  // Only a report made after the change counts.
  if (!k?.last || k.last.getTime() < a.at.getTime()) return false;
  if (operation === "time.setZone") return k.zone === a.params.timeZoneId;
  if (operation === "time.sync") return k.skew !== null && Math.abs(k.skew) <= CLOCK_TOLERANCE_SECONDS;
  const want = a.params.profiles as Record<string, boolean>;
  const have = parseJson<Record<string, boolean>>(k.profiles);
  return !!have && ["domain", "private", "public"].every(p => have[p] === want[p]);
}

const setTarget = (db: Queryable, jobId: string, cabinetId: string, state: string, detail: string) =>
  db.query("UPDATE fleet_job_targets SET state = $3, detail = $4, updated_at = SYSUTCDATETIME() WHERE job_id = $1 AND cabinet_id = $2", [jobId, cabinetId, state, detail.slice(0, 300)]);

/** After a restart: every job still running is picked up again where it stopped. */
export async function resumeJobs(pool: Pool, timing: Timing = DEFAULT_TIMING, log: (m: string) => void = () => {}): Promise<number> {
  const ids = (await pool.query<{ id: string }>("SELECT id FROM fleet_jobs WHERE state = 'running' OR (state = 'cancelled' AND finished_at IS NULL)")).rows.map(r => r.id);
  for (const id of ids) void runJob(pool, id, timing, log);
  return ids.length;
}

/** Discover unfinished jobs every interval, including failed runners and cancelled jobs with work to reconcile.
 * The per-job lease fences all work; failed attempts leave durable progress for the next scan. */
export function scheduleFleetRecovery(pool: Pool, timing: Timing = DEFAULT_TIMING, log: (m: string) => void = () => {}, intervalMs = 10_000): () => void {
  let started = false;
  let busy = false;
  let stopped = false;
  const inFlight = new Set<string>();
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      if (!started) {
        if (!(await takeLease(pool, "jobs.resume-fleet-jobs", 600_000))) return;
        started = true;
      }
      if (stopped) return;
      const ids = (await pool.query<{ id: string }>("SELECT id FROM fleet_jobs WHERE state = 'running' OR (state = 'cancelled' AND finished_at IS NULL)")).rows.map(r => r.id);
      for (const id of ids) {
        if (inFlight.has(id)) continue;
        inFlight.add(id);
        void runJob(pool, id, timing, log)
          .finally(() => { inFlight.delete(id); });
      }
    } catch (e) { log(`fleet recovery acquisition stopped: ${(e as Error).message}`); }
    finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}

/** Stops a job before its next batch (a batch already sent finishes). The person who started it, or an Admin. */
export async function cancelJob(pool: Pool, user: { userId: string; role: Role }, jobId: string): Promise<void> {
  await transaction(pool, async c => {
    const r = await c.query("UPDATE fleet_jobs SET state = 'cancelled', cancelled_by = $2 WHERE id = $1 AND state = 'running' AND (created_by = $2 OR $3 = 1)",
      [jobId, user.userId, user.role === "admin"]);
    if (r.rowCount !== 1) {
      const j = (await c.query<{ state: string }>("SELECT state FROM fleet_jobs WHERE id = $1", [jobId])).rows[0];
      if (!j) throw new Refused("not_found", 404, "no such job");
      throw new Refused(j.state === "running" ? "forbidden" : "job_finished", j.state === "running" ? 403 : 409,
        j.state === "running" ? "only the person who started it, or an Admin, can cancel it" : "the job has already finished");
    }
    // Cabinets not yet reached are cancelled now; a batch already sent finishes and is still verified.
    await c.query(`UPDATE fleet_job_targets SET state = 'cancelled', detail = 'The job was cancelled before this cabinet was reached.', updated_at = SYSUTCDATETIME()
                    WHERE job_id = $1 AND state = 'pending'`, [jobId]);
    await audit(c, { actorKind: "user", actorId: user.userId, action: "fleet.job.cancel", targetKind: "job", targetId: jobId, outcome: "succeeded" });
  });
}

// ---- Reading jobs -------------------------------------------------------------------------------------------------------

export async function job(db: Queryable, jobId: string) {
  const j = (await db.query<{ id: string; operation: string; state: string; created_at: Date; finished_at: Date | null; batch_size: number; total: number; name: string }>(
    `SELECT j.id, j.operation, j.state, j.created_at, j.finished_at, j.batch_size, j.total, u.name
       FROM fleet_jobs j JOIN users u ON u.id = j.created_by WHERE j.id = $1`, [jobId])).rows[0];
  if (!j) return null;
  const targets = (await db.query<{ cabinet_id: string; name: string; site: string; client: string; state: string; detail: string | null; params: unknown; command_id: string | null; updated_at: Date }>(
    `SELECT t.cabinet_id, k.name, s.name AS site, cl.name AS client, t.state, t.detail, t.params, t.command_id, t.updated_at
       FROM fleet_job_targets t JOIN cabinets k ON k.id = t.cabinet_id JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id
      WHERE t.job_id = $1 ORDER BY t.[position]`, [jobId])).rows;
  const counts: Record<string, number> = {};
  for (const t of targets) counts[t.state] = (counts[t.state] ?? 0) + 1;
  return { id: j.id, operation: j.operation, state: j.state, startedBy: j.name, startedAt: j.created_at.toISOString(), finishedAt: j.finished_at?.toISOString() ?? null,
    batchSize: j.batch_size, total: j.total, counts,
    cabinets: targets.map(t => ({ id: t.cabinet_id, name: t.name, site: t.site, client: t.client, state: t.state, detail: t.detail, params: t.params,
      commandId: t.command_id, updatedAt: t.updated_at.toISOString() })) };
}

export async function recentJobs(db: Queryable) {
  return (await db.query<{ id: string; operation: string; state: string; created_at: Date; total: number; name: string; verified: string; failed: string }>(
    `SELECT TOP (20) j.id, j.operation, j.state, j.created_at, j.total, u.name,
            (SELECT COUNT(*) FROM fleet_job_targets t WHERE t.job_id = j.id AND t.state = 'verified') AS verified,
            (SELECT COUNT(*) FROM fleet_job_targets t WHERE t.job_id = j.id AND t.state IN ('failed', 'not_verified', 'offline')) AS failed
       FROM fleet_jobs j JOIN users u ON u.id = j.created_by ORDER BY j.created_at DESC`)).rows
    .map(r => ({ id: r.id, operation: r.operation, state: r.state, startedAt: r.created_at.toISOString(), total: r.total, startedBy: r.name,
      verified: Number(r.verified), problems: Number(r.failed) }));
}

// ---- Retention (F21.R2, decision-log D73) -----------------------------------------------------------------------------------------------

/**
 * Removes fleet jobs that finished and were created before `cutoff`, with their per-cabinet results first; a running job is never
 * removed. The commands they sent and the audit log stay. In batches, each batch audited; a repeat removes nothing more. Returns how
 * many jobs went.
 */
export async function pruneFinishedJobs(db: Queryable, cutoff: Date, o: BatchOptions = RETENTION_BATCH): Promise<number> {
  checkRetentionCutoff(cutoff);
  await inBatches(db, `DELETE TOP ($1) FROM fleet_job_targets WHERE job_id IN
                         (SELECT id FROM fleet_jobs WHERE state <> 'running' AND created_at < $2)`, [cutoff], o, { table: "fleet_job_targets", cutoff });
  return inBatches(db, `DELETE TOP ($1) FROM fleet_jobs WHERE state <> 'running' AND created_at < $2
                          AND NOT EXISTS (SELECT 1 FROM fleet_job_targets t WHERE t.job_id = fleet_jobs.id)`, [cutoff], o, { table: "fleet_jobs", cutoff });
}
