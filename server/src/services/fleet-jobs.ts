// Fleet operations (docs/spec/13-roadmap.md modules 21 and 45): one fixed operation on cabinets a person chose, run as a
// job. The target list is a snapshot taken when the job starts; the server fills in each cabinet's parameters (its site's
// zone, its client's firewall policy) and says why it skips any. The job issues the commands in batches (the next batch
// starts once this one has answered), records each cabinet's result, then verifies it from the cabinet's next report:
// a change that cannot be seen is "not verified", never counted as done. Confirmed with the password, bound to the exact
// operation, cabinets and batch size; at most 200 cabinets; the whole job counts as one write against the person's limit.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { catalog, operations } from "../contracts.js";
import { audit, safeJson, transaction, type Queryable } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { Refused } from "./errors.js";
import { ISSUE } from "./rules.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";
import { fleetPause, WRITE_OPERATIONS, WriteLimitReached } from "./writes.js";
import { BULK_LIMIT, cabinetPolicy, switchesFor } from "./firewall-policy.js";
import { CLOCK_TOLERANCE_SECONDS } from "./time.js";
import { issueFromConsole, ROLE_RANK, type Role } from "./console-commands.js";
import type { NetworkConfigOutput } from "@mashura/cabinet-contracts/types";

export const JOB_OPERATIONS = ["time.setZone", "time.sync", "firewall.applyPolicy", "network.setDns", "network.setIp", "network.renewLease"] as const;
export type JobOperation = (typeof JOB_OPERATIONS)[number];
type Problem = "any" | "time_zone_wrong" | "clock_off" | "firewall_drift";

interface Timing { pollMs: number; verifyMs: number }
/** How often a running job looks at its commands, and how long it waits for a cabinet's next report to verify a change. */
export const DEFAULT_TIMING: Timing = { pollMs: 1000, verifyMs: 150_000 };

// ---- Choosing cabinets --------------------------------------------------------------------------------------------------

/** The cabinets the page lists: active ones, narrowed by client, site and a problem. At most 500. */
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
  const rows = (await db.query<{ id: string; name: string; role: string; site_id: string; site: string; client_id: string; client: string; demo: boolean; read_only: boolean | null;
    online: boolean; time_zone_id: string | null; site_zone: string | null; skew: number | null; alerts: string; ipv4: string | null }>(
    `SELECT k.id, k.name, k.role, s.id AS site_id, s.name AS site, cl.id AS client_id, cl.name AS client, k.demo_scenario IS NOT NULL AS demo, k.read_only,
            COALESCE(k.last_heartbeat_at > now() - make_interval(secs => $${args.length}), false) AS online,
            k.time_zone_id, s.time_zone AS site_zone, k.clock_skew_seconds AS skew, k.ipv4,
            (SELECT count(*) FROM alerts a WHERE a.cabinet_id = k.id AND a.state <> 'resolved') AS alerts
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id
      WHERE ${where.join(" AND ")} ORDER BY cl.name, s.name, k.name LIMIT 500`, args)).rows;
  return rows.map(r => ({ id: r.id, name: r.name, role: r.role, site: { id: r.site_id, name: r.site, timeZone: r.site_zone }, client: { id: r.client_id, name: r.client },
    demo: r.demo, readOnly: r.read_only, online: r.online, timeZoneId: r.time_zone_id, clockSkewSeconds: r.skew, ipv4: r.ipv4, openAlerts: Number(r.alerts) }));
}

/** The sites to choose from: a bulk change covers one site, so the page starts by choosing one. */
export async function fleetSites(db: Queryable) {
  const rows = (await db.query<{ id: string; name: string; client_id: string; client: string; demo: boolean; cabinets: string }>(
    `SELECT s.id, s.name, cl.id AS client_id, cl.name AS client, cl.demo, count(k.id) AS cabinets
       FROM sites s JOIN clients cl ON cl.id = s.client_id LEFT JOIN cabinets k ON k.site_id = s.id AND k.status = 'active'
      WHERE s.removed_at IS NULL AND cl.removed_at IS NULL GROUP BY s.id, cl.id ORDER BY cl.name, s.name`)).rows;
  return rows.map(r => ({ id: r.id, name: r.name, client: { id: r.client_id, name: r.client }, demo: r.demo, cabinets: Number(r.cabinets) }));
}

// ---- Planning: what each cabinet would get, or why it is skipped ---------------------------------------------------------

interface Plan { cabinetId: string; name: string; site: string; client: string; params: Record<string, unknown> | null; skip: string | null; detail?: string }

/** For each chosen cabinet, in the order given: the parameters the server fills in, or why the operation skips it. */
export async function plan(db: Queryable, operation: JobOperation, cabinetIds: string[]): Promise<Plan[]> {
  const rows = new Map((await db.query<{ id: string; site_id: string; name: string; site: string; client: string; status: string; read_only: boolean | null; paused: boolean;
    online: boolean; zone: string | null; site_zone: string | null; skew: number | null }>(
    `SELECT k.id, k.site_id, k.name, s.name AS site, cl.name AS client, k.status, k.read_only, cl.write_paused AS paused,
            COALESCE(k.last_heartbeat_at > now() - make_interval(secs => $2), false) AS online,
            k.time_zone_id AS zone, s.time_zone AS site_zone, k.clock_skew_seconds AS skew
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id WHERE k.id = ANY($1::uuid[])`,
    [cabinetIds, OFFLINE_AFTER_MS / 1000])).rows.map(r => [r.id, r]));
  // A bulk change covers the cabinets of one site: a mistake in the choice can only reach one place.
  if (new Set([...rows.values()].map(r => r.site_id)).size > 1)
    throw new Refused("one_site_only", 409, "a fleet operation covers the cabinets of one site; choose the site first, then the cabinets in it");
  const out: Plan[] = [];
  for (const id of cabinetIds) {
    const r = rows.get(id);
    if (!r) throw new Refused("not_found", 404, "one of the chosen cabinets does not exist");
    const base = { cabinetId: id, name: r.name, site: r.site, client: r.client };
    const skip = (why: string): Plan => ({ ...base, params: null, skip: why });
    if (r.status !== "active") { out.push(skip("Not an active cabinet.")); continue; }
    if (r.read_only !== false) { out.push(skip("Installed read-only: it accepts no changes.")); continue; }
    if (r.paused) { out.push(skip("Changes to this client's cabinets are paused.")); continue; }
    if (!r.online) { out.push(skip("Offline: not heard from in the last 5 minutes.")); continue; }
    if (operation === "time.setZone") {
      if (!r.site_zone) { out.push(skip("Its site has no time zone set.")); continue; }
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
      if (p.differs === false) { out.push(skip("Already matches its client's firewall policy.")); continue; }
      out.push({ ...base, params: { profiles: switchesFor(p.policy) }, skip: null });
    }
  }
  return out;
}

/** The change a cabinet's latest diagnosis found for this operation, as the operation's own parameters. */
async function networkFix(db: Queryable, cabinetId: string, operation: "network.setDns" | "network.setIp" | "network.renewLease"): Promise<{ params: Record<string, unknown>; label: string; why?: undefined } | { params?: undefined; label?: undefined; why: string }> {
  const d = (await db.query<{ findings: { severity: string; action?: Record<string, unknown> }[] | null }>(
    `SELECT findings FROM diagnoses WHERE cabinet_id = $1 AND kind = 'network' AND state = 'done' AND finished_at > now() - interval '30 minutes' ORDER BY started_at DESC LIMIT 1`, [cabinetId])).rows[0];
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

export async function preview(db: Queryable, user: { role: Role }, operation: JobOperation, cabinetIds: string[]) {
  checkRole(user.role, operation);
  const p = await plan(db, operation, cabinetIds);
  const ipv4s = new Map((await db.query<{ id: string; ipv4: string | null }>("SELECT id, ipv4 FROM cabinets WHERE id = ANY($1::uuid[])", [cabinetIds])).rows.map(r => [r.id, r.ipv4]));
  return { operation, limit: BULK_LIMIT, change: p.filter(x => !x.skip).length, skip: p.filter(x => x.skip).length,
    cabinets: p.map(x => ({ id: x.cabinetId, name: x.name, site: x.site, client: x.client, ipv4: ipv4s.get(x.cabinetId) ?? null, params: x.params, skip: x.skip, detail: x.detail ?? null })) };
}

function checkRole(role: Role, operation: JobOperation): void {
  const entry = catalog.get(operation)!;
  if (ROLE_RANK[role] < ROLE_RANK[entry.minimumRole as Role]) throw new Refused("forbidden", 403, "your role cannot run this operation");
}

// ---- Starting a job -----------------------------------------------------------------------------------------------------

export interface JobRequest { jobId: string; operation: JobOperation; cabinetIds: string[]; batchSize: number; stepUpToken: string }

/** Starts a job: checks the password confirmation, the pauses and the limit, and fixes its target list. Running it is runJob's. */
export async function startJob(pool: pg.Pool, user: { userId: string; role: Role }, r: JobRequest): Promise<{ jobId: string; change: number; skip: number }> {
  checkRole(user.role, r.operation);
  if (r.cabinetIds.length > BULK_LIMIT) throw new Refused("too_many_cabinets", 409, `a fleet operation covers at most ${BULK_LIMIT} cabinets`);
  return transaction(pool, async c => {
    await consumeStepUpToken(c, r.stepUpToken, user.userId, "fleet.job", r.jobId, { operation: r.operation, cabinetIds: r.cabinetIds, batchSize: r.batchSize });
    if ((await c.query("SELECT 1 FROM fleet_jobs WHERE id = $1", [r.jobId])).rows[0]) throw new Refused("job_exists", 409, "that job was already started");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`writes:${user.userId}`]);
    if ((await fleetPause(c)).paused) throw new Refused("writes_paused", 409, "writes are paused fleet-wide");
    const u = (await c.query<{ writes_paused: boolean; write_limit: number }>("SELECT writes_paused, write_limit FROM users WHERE id = $1 AND status = 'active'", [user.userId])).rows[0];
    if (!u) throw new Refused("forbidden", 403, "unknown or disabled user");
    if (u.writes_paused) throw new Refused("writes_paused_for_you", 409, "your writes are paused until an Admin resumes them");
    const used = Number((await c.query<{ n: string }>(
      "SELECT count(DISTINCT COALESCE(bulk_id, m.id)) AS n FROM commands m JOIN cabinets t ON t.id = m.cabinet_id WHERE m.issued_by = $1 AND m.issued_at > now() - interval '1 hour' AND m.operation = ANY($2) AND t.demo_scenario IS NULL",
      [user.userId, WRITE_OPERATIONS])).rows[0]!.n);
    if (used >= u.write_limit) throw new WriteLimitReached();
    const targets = await plan(c, r.operation, r.cabinetIds);
    await c.query("INSERT INTO fleet_jobs (id, operation, created_by, batch_size, total) VALUES ($1, $2, $3, $4, $5)",
      [r.jobId, r.operation, user.userId, r.batchSize, targets.length]);
    for (const [i, t] of targets.entries())
      await c.query("INSERT INTO fleet_job_targets (job_id, cabinet_id, position, params, state, detail) VALUES ($1, $2, $3, $4, $5, $6)",
        [r.jobId, t.cabinetId, i, t.params === null ? null : safeJson(t.params), t.skip ? "skipped" : "pending", t.skip]);
    const change = targets.filter(t => !t.skip).length;
    await audit(c, { actorKind: "user", actorId: user.userId, action: "fleet.job.start", targetKind: "job", targetId: r.jobId, outcome: "succeeded",
      details: { operation: r.operation, cabinets: targets.length, change, batchSize: r.batchSize } });
    if (change === 0) await c.query("UPDATE fleet_jobs SET state = 'done', finished_at = now() WHERE id = $1", [r.jobId]);
    return { jobId: r.jobId, change, skip: targets.length - change };
  });
}

// ---- Running a job ------------------------------------------------------------------------------------------------------

const running = new Set<string>();
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/** Runs (or resumes, after a restart) one job to its end. Safe to call twice: a job runs once per process. */
export async function runJob(pool: pg.Pool, jobId: string, timing: Timing = DEFAULT_TIMING, log: (m: string) => void = () => {}): Promise<void> {
  if (running.has(jobId)) return;
  running.add(jobId);
  try {
    const job = (await pool.query<{ operation: JobOperation; created_by: string; batch_size: number; state: string; role: Role }>(
      "SELECT j.operation, j.created_by, j.batch_size, j.state, u.role FROM fleet_jobs j JOIN users u ON u.id = j.created_by WHERE j.id = $1", [jobId])).rows[0];
    if (!job || job.state !== "running") return;
    for (;;) {
      if (await cancelled(pool, jobId)) break;
      // Issued commands from before a restart are followed up first; then the next batch.
      let batch = (await pool.query<{ cabinet_id: string; command_id: string; params: Record<string, unknown> }>(
        "SELECT cabinet_id, command_id, params FROM fleet_job_targets WHERE job_id = $1 AND state = 'issued' ORDER BY position", [jobId])).rows;
      if (batch.length === 0) batch = await issueBatch(pool, jobId, job);
      if (batch.length === 0) break;
      await followUp(pool, jobId, job.operation, batch, timing, { userId: job.created_by, role: job.role });
    }
    await pool.query(`UPDATE fleet_job_targets SET state = 'cancelled', detail = 'The job was cancelled before this cabinet was reached.', updated_at = now()
                       WHERE job_id = $1 AND state = 'pending'`, [jobId]);
    await pool.query("UPDATE fleet_jobs SET state = CASE WHEN state = 'cancelled' THEN 'cancelled' ELSE 'done' END, finished_at = now() WHERE id = $1", [jobId]);
  } catch (e) {
    log(`fleet job ${jobId} stopped: ${(e as Error).message}`);
  } finally {
    running.delete(jobId);
  }
}

const cancelled = async (pool: pg.Pool, jobId: string) =>
  (await pool.query<{ state: string }>("SELECT state FROM fleet_jobs WHERE id = $1", [jobId])).rows[0]?.state !== "running";

/** Issues the next batch's commands in one transaction, re-checking the pauses: a pause that started mid-job skips the rest. */
async function issueBatch(pool: pg.Pool, jobId: string, job: { operation: JobOperation; created_by: string; batch_size: number }): Promise<{ cabinet_id: string; command_id: string; params: Record<string, unknown> }[]> {
  return transaction(pool, async c => {
    const next = (await c.query<{ cabinet_id: string; params: Record<string, unknown> }>(
      "SELECT cabinet_id, params FROM fleet_job_targets WHERE job_id = $1 AND state = 'pending' ORDER BY position LIMIT $2 FOR UPDATE",
      [jobId, job.batch_size])).rows;
    if (next.length === 0) return [];
    const stop = async (why: string): Promise<never[]> => {
      await c.query("UPDATE fleet_job_targets SET state = 'skipped', detail = $2, updated_at = now() WHERE job_id = $1 AND state = 'pending'", [jobId, why]);
      return [];
    };
    if ((await fleetPause(c)).paused) return stop("Writes were paused fleet-wide while the job ran.");
    const u = (await c.query<{ writes_paused: boolean; status: string }>("SELECT writes_paused, status FROM users WHERE id = $1", [job.created_by])).rows[0];
    if (!u || u.status !== "active" || u.writes_paused) return stop("The person who started the job can no longer make changes.");
    const entry = catalog.get(job.operation)!;
    const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const expiresAt = new Date(issuedAt.getTime() + entry.expirySeconds * 1000);
    const issued: { cabinet_id: string; command_id: string; params: Record<string, unknown> }[] = [];
    for (const t of next) {
      const k = (await c.query<{ paused: boolean; read_only: boolean | null; status: string }>(
        `SELECT cl.write_paused AS paused, k.read_only, k.status FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id WHERE k.id = $1`,
        [t.cabinet_id])).rows[0];
      if (!k || k.status !== "active" || k.paused || k.read_only !== false) {
        await c.query("UPDATE fleet_job_targets SET state = 'skipped', detail = $3, updated_at = now() WHERE job_id = $1 AND cabinet_id = $2",
          [jobId, t.cabinet_id, "The cabinet stopped accepting changes before its turn (paused, read-only or removed)."]);
        continue;
      }
      const commandId = randomUUID();
      await c.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, bulk_id)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8)`, [commandId, t.cabinet_id, job.operation, safeJson(t.params), job.created_by, issuedAt, expiresAt, jobId]);
      await audit(c, { actorKind: "user", actorId: job.created_by, action: "command.write", targetKind: "cabinet", targetId: t.cabinet_id, outcome: "succeeded",
        details: { commandId, operation: job.operation, params: t.params, bulkId: jobId } });
      await c.query("UPDATE fleet_job_targets SET state = 'issued', command_id = $3, detail = NULL, updated_at = now() WHERE job_id = $1 AND cabinet_id = $2",
        [jobId, t.cabinet_id, commandId]);
      issued.push({ cabinet_id: t.cabinet_id, command_id: commandId, params: t.params });
    }
    return issued;
  }).then(async issued =>
    // Every cabinet in this batch was skipped: go on to the next batch rather than ending the job.
    issued.length > 0 || !(await pendingLeft(pool, jobId)) ? issued : issueBatch(pool, jobId, job));
}

const pendingLeft = async (pool: pg.Pool, jobId: string) =>
  !!(await pool.query("SELECT 1 FROM fleet_job_targets WHERE job_id = $1 AND state = 'pending' LIMIT 1", [jobId])).rows[0];

const FAILED_STATUSES = new Set(["failed", "rejected", "expired"]);

/** Waits for a batch's commands, records each result, then verifies the successes from the cabinets' next reports. */
async function followUp(pool: pg.Pool, jobId: string, operation: JobOperation, batch: { cabinet_id: string; command_id: string; params: Record<string, unknown> }[], timing: Timing,
  creator: { userId: string; role: Role }) {
  const waiting = new Map(batch.map(b => [b.command_id, b]));
  const answered: { cabinet_id: string; params: Record<string, unknown>; at: Date }[] = [];
  // A command expires 2 minutes after it was issued; the agent's answer can arrive a little after that.
  const deadline = Date.now() + 150_000;
  while (waiting.size > 0 && Date.now() < deadline) {
    const rows = (await pool.query<{ id: string; status: string; result: { error?: { code: string; message: string } } | null; result_at: Date | null }>(
      "SELECT id, status, result, result_at FROM commands WHERE id = ANY($1::uuid[])", [[...waiting.keys()]])).rows;
    for (const r of rows) {
      const t = waiting.get(r.id)!;
      if (r.status === "succeeded") {
        await setTarget(pool, jobId, t.cabinet_id, "succeeded", "The cabinet made the change; waiting for its next report to verify it.");
        answered.push({ cabinet_id: t.cabinet_id, params: t.params, at: r.result_at ?? new Date() });
        waiting.delete(r.id);
      } else if (FAILED_STATUSES.has(r.status)) {
        const why = r.status === "expired" ? "The cabinet did not answer before the command expired." : r.result?.error ? `${r.result.error.code}: ${r.result.error.message}` : `The command ${r.status}.`;
        await setTarget(pool, jobId, t.cabinet_id, "failed", why);
        waiting.delete(r.id);
      }
    }
    if (waiting.size > 0) await sleep(timing.pollMs);
  }
  for (const t of waiting.values()) await setTarget(pool, jobId, t.cabinet_id, "failed", "No answer from the cabinet in time.");
  // Verification: the cabinet's own report after the change shows the result (its zone, its clock, its firewall).
  const verifyBy = Date.now() + timing.verifyMs;
  let left = answered;
  while (left.length > 0) {
    const still: typeof left = [];
    for (const a of left) {
      if (await verified(pool, operation, a, creator)) await setTarget(pool, jobId, a.cabinet_id, "verified", verifiedText[operation]);
      else still.push(a);
    }
    left = still;
    if (left.length === 0 || Date.now() >= verifyBy) break;
    await sleep(timing.pollMs);
  }
  for (const a of left) await setTarget(pool, jobId, a.cabinet_id, "not_verified", "The cabinet said it made the change, but its next report did not show it in time. Check it.");
}

const verifiedText: Record<JobOperation, string> = {
  "time.setZone": "Verified: the cabinet reports its site's time zone.",
  "time.sync": "Verified: the cabinet's clock is within two minutes of the server's.",
  "firewall.applyPolicy": "Verified: the cabinet's firewall matches its client's policy.",
  "network.setDns": "Verified: read back from the cabinet, its DNS servers are the baseline's.",
  "network.setIp": "Verified: read back from the cabinet, its address settings are as intended.",
  "network.renewLease": "Verified: read back from the cabinet, it has a real address from the DHCP server.",
};

/** Network changes are verified by reading the settings back from the cabinet (as the person who started the job), not from a heartbeat. */
async function networkVerified(pool: pg.Pool, creator: { userId: string; role: Role }, operation: JobOperation, a: { cabinet_id: string; params: Record<string, unknown> }): Promise<boolean> {
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

async function verified(db: pg.Pool, operation: JobOperation, a: { cabinet_id: string; params: Record<string, unknown>; at: Date }, creator: { userId: string; role: Role }): Promise<boolean> {
  if (operation === "network.setDns" || operation === "network.setIp" || operation === "network.renewLease") return networkVerified(db, creator, operation, a);
  const k = (await db.query<{ zone: string | null; skew: number | null; last: Date | null; profiles: Record<string, boolean> | null }>(
    "SELECT time_zone_id AS zone, clock_skew_seconds AS skew, last_heartbeat_at AS last, firewall_profiles AS profiles FROM cabinets WHERE id = $1", [a.cabinet_id])).rows[0];
  // Only a report made after the change counts.
  if (!k?.last || k.last.getTime() < a.at.getTime()) return false;
  if (operation === "time.setZone") return k.zone === a.params.timeZoneId;
  if (operation === "time.sync") return k.skew !== null && Math.abs(k.skew) <= CLOCK_TOLERANCE_SECONDS;
  const want = a.params.profiles as Record<string, boolean>;
  return !!k.profiles && ["domain", "private", "public"].every(p => k.profiles![p] === want[p]);
}

const setTarget = (db: Queryable, jobId: string, cabinetId: string, state: string, detail: string) =>
  db.query("UPDATE fleet_job_targets SET state = $3, detail = $4, updated_at = now() WHERE job_id = $1 AND cabinet_id = $2", [jobId, cabinetId, state, detail.slice(0, 300)]);

/** After a restart: every job still running is picked up again where it stopped. */
export async function resumeJobs(pool: pg.Pool, timing: Timing = DEFAULT_TIMING, log: (m: string) => void = () => {}): Promise<number> {
  const ids = (await pool.query<{ id: string }>("SELECT id FROM fleet_jobs WHERE state = 'running'")).rows.map(r => r.id);
  for (const id of ids) void runJob(pool, id, timing, log);
  return ids.length;
}

/** Stops a job before its next batch (a batch already sent finishes). The person who started it, or an Admin. */
export async function cancelJob(pool: pg.Pool, user: { userId: string; role: Role }, jobId: string): Promise<void> {
  await transaction(pool, async c => {
    const r = await c.query("UPDATE fleet_jobs SET state = 'cancelled', cancelled_by = $2 WHERE id = $1 AND state = 'running' AND (created_by = $2 OR $3)",
      [jobId, user.userId, user.role === "admin"]);
    if (r.rowCount !== 1) {
      const j = (await c.query<{ state: string }>("SELECT state FROM fleet_jobs WHERE id = $1", [jobId])).rows[0];
      if (!j) throw new Refused("not_found", 404, "no such job");
      throw new Refused(j.state === "running" ? "forbidden" : "job_finished", j.state === "running" ? 403 : 409,
        j.state === "running" ? "only the person who started it, or an Admin, can cancel it" : "the job has already finished");
    }
    // Cabinets not yet reached are cancelled now; a batch already sent finishes and is still verified.
    await c.query(`UPDATE fleet_job_targets SET state = 'cancelled', detail = 'The job was cancelled before this cabinet was reached.', updated_at = now()
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
      WHERE t.job_id = $1 ORDER BY t.position`, [jobId])).rows;
  const counts: Record<string, number> = {};
  for (const t of targets) counts[t.state] = (counts[t.state] ?? 0) + 1;
  return { id: j.id, operation: j.operation, state: j.state, startedBy: j.name, startedAt: j.created_at.toISOString(), finishedAt: j.finished_at?.toISOString() ?? null,
    batchSize: j.batch_size, total: j.total, counts,
    cabinets: targets.map(t => ({ id: t.cabinet_id, name: t.name, site: t.site, client: t.client, state: t.state, detail: t.detail, params: t.params,
      commandId: t.command_id, updatedAt: t.updated_at.toISOString() })) };
}

export async function recentJobs(db: Queryable) {
  return (await db.query<{ id: string; operation: string; state: string; created_at: Date; total: number; name: string; verified: string; failed: string }>(
    `SELECT j.id, j.operation, j.state, j.created_at, j.total, u.name,
            (SELECT count(*) FROM fleet_job_targets t WHERE t.job_id = j.id AND t.state = 'verified') AS verified,
            (SELECT count(*) FROM fleet_job_targets t WHERE t.job_id = j.id AND t.state IN ('failed', 'not_verified')) AS failed
       FROM fleet_jobs j JOIN users u ON u.id = j.created_by ORDER BY j.created_at DESC LIMIT 20`)).rows
    .map(r => ({ id: r.id, operation: r.operation, state: r.state, startedAt: r.created_at.toISOString(), total: r.total, startedBy: r.name,
      verified: Number(r.verified), problems: Number(r.failed) }));
}
