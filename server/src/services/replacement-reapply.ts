// Re-applying a replaced cabinet's settings on its replacement (docs/spec/05-server-spec.md "Replacing a cabinet"). The owner's
// decision: what affects the client's experience is put back automatically once the new agent reports, with no second confirmation,
// because the Admin confirmed the replacement with an authenticator code when approving it.
//
// The approval queues one re-apply. Once the new cabinet has reported, the server plans the steps:
//   - firewall: the policy that applies to the new cabinet (its site's, else its client's, else the fleet's);
//   - time zone: the zone that applies to its site, else the zone the old cabinet reported;
//   - drawer: the standard drawer address, 172.20.1.0/32, on the new cabinet's drawer adapter, when the old cabinet had a drawer;
//   - DNS and address: the fixed DNS servers and the fixed address, prefix and gateway of the old cabinet's network adapter, when it
//     had them (a cabinet on DHCP stays on DHCP), on the new cabinet's network adapter. The address goes last: it is the change most
//     likely to cut the cabinet off, and the agent's safety net undoes it if the cabinet loses contact.
// Each step is a fixed catalog operation, issued in the approving Admin's name (counted once against their hourly limit, and stopped
// by every pause), answered, and verified from what the cabinet reads back. A step the server cannot plan safely (no single network
// adapter, no drawer adapter, nothing reported) is skipped with the reason, never guessed. Nothing here runs a command of its own kind.
import { operations } from "../contracts.js";
import { audit, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { DRAWER_ADDRESS, isDrawerAddress } from "../diagnose/network-findings.js";
import { issueCommand } from "./commands.js";
import { currentItems } from "./config-ingest.js";
import type { Item } from "./config-canonical.js";
import { issueFromConsole } from "./console-commands.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";
import { cabinetPolicy, switchesFor } from "./firewall-policy.js";
import { verified } from "./fleet-jobs.js";
import { SITE_ZONE_SQL, TIME_ZONES } from "./time.js";
import type { Role } from "./roles.js";
import type { NetworkConfigOutput } from "@mashura/cabinet-contracts/types";

export type StepKind = "firewall" | "time_zone" | "drawer" | "dns" | "address";
export type StepOperation = "firewall.applyPolicy" | "time.setZone" | "network.setIp" | "network.setDns";
export interface PlannedStep { kind: StepKind; operation: StepOperation; params: Record<string, unknown> | null; skip: string | null }

/** One adapter as the old cabinet last reported it in its configuration snapshots. */
export interface OldAdapter {
  type: string | null; connected: boolean; dhcp: boolean | null;
  addresses: { address: string; prefixLength: number }[]; gateways: string[]; dnsServers: string[]; dnsAutomatic: boolean | null;
}
type NewAdapter = NetworkConfigOutput["adapters"][number];

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The adapters in a cabinet's stored network snapshot ("adapter:<name>" items; addresses written "a.b.c.d/prefix"). */
export function oldAdaptersFrom(items: readonly Item[]): OldAdapter[] {
  return items.filter(i => i.key.startsWith("adapter:")).map(i => {
    const v = i.values;
    const addresses = strings(v.addresses).map(a => {
      const slash = a.indexOf("/");
      const prefix = slash < 0 ? NaN : Number(a.slice(slash + 1));
      return { address: slash < 0 ? a : a.slice(0, slash), prefixLength: prefix };
    }).filter(a => Number.isInteger(a.prefixLength) && a.prefixLength >= 1 && a.prefixLength <= 32);
    return { type: typeof v.type === "string" ? v.type : null, connected: v.connected === true, dhcp: typeof v.dhcp === "boolean" ? v.dhcp : null,
      addresses, gateways: strings(v.gateways), dnsServers: strings(v.dnsServers), dnsAutomatic: typeof v.dnsAutomatic === "boolean" ? v.dnsAutomatic : null };
  });
}

const unidentified = (a: NewAdapter) => (a.details?.networkProfile?.name ?? "").trim().toLowerCase() === "unidentified network";
const onDrawer = (addresses: readonly { address: string }[]) => addresses.some(x => isDrawerAddress(x.address));

/** The adapter that is the drawer link on the new cabinet: one already on the drawer network, else the one wired adapter on an unidentified network. */
function newDrawerAdapter(now: readonly NewAdapter[]): NewAdapter | null {
  const wired = now.filter(a => a.type !== "wifi");
  const on = wired.filter(a => onDrawer(a.ipv4.addresses));
  if (on.length === 1) return on[0]!;
  if (on.length > 1) return null;
  const candidates = wired.filter(unidentified);
  return candidates.length === 1 ? candidates[0]! : null;
}

/** The network adapter (not the drawer link): the one connected adapter with a gateway. None, or several, gives null: nothing is guessed. */
function networkAdapter<T extends { connected: boolean; gateways: string[]; addresses: readonly { address: string }[] }>(all: readonly T[]): T | null {
  const found = all.filter(a => a.connected && a.gateways.length > 0 && !onDrawer(a.addresses));
  return found.length === 1 ? found[0]! : null;
}

/**
 * The network steps, in the order they run: the drawer address, then DNS, then the address. `old` is what the replaced cabinet last
 * reported; `now` is the new cabinet's network as read just now. Every step's parameters are checked against the operation's schema.
 */
export function planNetwork(old: readonly OldAdapter[], now: readonly NewAdapter[]): PlannedStep[] {
  const steps: PlannedStep[] = [];
  const step = (kind: StepKind, operation: StepOperation, params: Record<string, unknown> | null, skip: string | null) => {
    if (params && !operations[operation].params.is(params)) { params = null; skip = "The settings the old cabinet reported are not valid for this change."; }
    steps.push({ kind, operation, params: skip ? null : params, skip });
  };

  // The drawer: the old cabinet's drawer address, exactly as it had it (its prefix too).
  const oldDrawer = old.filter(a => a.type !== "wifi").flatMap(a => a.addresses).filter(x => isDrawerAddress(x.address));
  const drawer = newDrawerAdapter(now);
  if (oldDrawer.length !== 1) step("drawer", "network.setIp", null, oldDrawer.length === 0 ? "The old cabinet reported no drawer address." : "The old cabinet reported more than one drawer address.");
  else if (!drawer) step("drawer", "network.setIp", null, "No single drawer adapter on the new cabinet (an Ethernet adapter on an unidentified network).");
  // The drawer address is the standard one on every cabinet, whatever the old cabinet had: its drawer only says there is one.
  else if (drawer.ipv4.addresses.some(x => x.address === DRAWER_ADDRESS.address && x.prefixLength === DRAWER_ADDRESS.prefixLength) && drawer.ipv4.gateways.length === 0)
    step("drawer", "network.setIp", null, `Already set: ${DRAWER_ADDRESS.address}/${DRAWER_ADDRESS.prefixLength}.`);
  else step("drawer", "network.setIp", { interfaceIndex: drawer.interfaceIndex, mode: "static", address: DRAWER_ADDRESS.address, prefixLength: DRAWER_ADDRESS.prefixLength }, null);

  // DNS and the address of the network adapter: only what the old cabinet had fixed.
  const was = networkAdapter(old);
  const is = networkAdapter(now.map(a => ({ ...a, gateways: a.ipv4.gateways, addresses: a.ipv4.addresses })));
  const noOld = "The old cabinet did not report a single network adapter with a gateway.";
  const noNew = "No single connected network adapter with a gateway on the new cabinet.";
  if (!was) step("dns", "network.setDns", null, noOld);
  else if (was.dnsAutomatic !== false || was.dnsServers.length === 0) step("dns", "network.setDns", null, "The old cabinet took its DNS servers automatically.");
  else if (!is) step("dns", "network.setDns", null, noNew);
  else if (!is.dns.automatic && is.dns.servers.join(",") === was.dnsServers.join(",")) step("dns", "network.setDns", null, `Already set: ${was.dnsServers.join(", ")}.`);
  else step("dns", "network.setDns", { interfaceIndex: is.interfaceIndex, mode: "static", servers: was.dnsServers.slice(0, 4) }, null);

  const fixed = was?.addresses.find(x => !isDrawerAddress(x.address));
  if (!was) step("address", "network.setIp", null, noOld);
  else if (was.dhcp !== false || !fixed) step("address", "network.setIp", null, "The old cabinet took its address from DHCP.");
  else if (!is) step("address", "network.setIp", null, noNew);
  else if (!is.ipv4.dhcp && is.ipv4.addresses.some(x => x.address === fixed.address && x.prefixLength === fixed.prefixLength) && is.ipv4.gateways[0] === was.gateways[0])
    step("address", "network.setIp", null, `Already set: ${fixed.address}/${fixed.prefixLength}.`);
  else step("address", "network.setIp", { interfaceIndex: is.interfaceIndex, mode: "static", address: fixed.address, prefixLength: fixed.prefixLength, gateway: was.gateways[0] }, null);
  return steps;
}

// ---- Queuing, planning and running --------------------------------------------------------------------------------------------------

/** Queued in the approval's transaction; runs once the new cabinet has reported. */
export async function queueReapply(c: Queryable, newId: string, oldId: string, userId: string): Promise<void> {
  await c.query("INSERT INTO replacement_reapply (cabinet_id, replaces_cabinet_id, approved_by) VALUES ($1, $2, $3)", [newId, oldId, userId]);
}

export interface ReapplyTiming { pollMs: number; answerMs: number; verifyMs: number }
export const DEFAULT_REAPPLY_TIMING: ReapplyTiming = { pollMs: 1000, answerMs: 150_000, verifyMs: 150_000 };

const running = new Set<string>();
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const FAILED = new Set(["failed", "rejected", "expired"]);

interface Reapply { cabinetId: string; replaces: string; approvedBy: string; role: Role; userActive: boolean }

/** Starts every re-apply whose new cabinet has reported, and resumes any that was running when the server stopped. */
export async function startDueReapplies(pool: Pool, timing: ReapplyTiming = DEFAULT_REAPPLY_TIMING, log: (m: string) => void = () => {}): Promise<number> {
  const due = (await pool.query<{ cabinet_id: string }>(
    `SELECT r.cabinet_id FROM replacement_reapply r JOIN cabinets k ON k.id = r.cabinet_id
      WHERE r.state = 'running' OR (r.state = 'waiting' AND k.status = 'active' AND k.last_heartbeat_at > DATEADD(second, -$1, SYSUTCDATETIME()))`,
    [OFFLINE_AFTER_MS / 1000])).rows;
  for (const d of due) void runReapply(pool, d.cabinet_id, timing, log);
  return due.length;
}

/** Plans and runs one cabinet's re-apply to its end. Safe to call twice: it runs once per process. */
export async function runReapply(pool: Pool, cabinetId: string, timing: ReapplyTiming = DEFAULT_REAPPLY_TIMING, log: (m: string) => void = () => {}): Promise<void> {
  if (running.has(cabinetId)) return;
  running.add(cabinetId);
  try {
    const r = (await pool.query<{ replaces_cabinet_id: string; approved_by: string; state: string; role: Role | null; status: string | null }>(
      `SELECT r.replaces_cabinet_id, r.approved_by, r.state, u.role, u.status FROM replacement_reapply r LEFT JOIN users u ON u.id = r.approved_by WHERE r.cabinet_id = $1`,
      [cabinetId])).rows[0];
    if (!r || (r.state !== "waiting" && r.state !== "running")) return;
    const job: Reapply = { cabinetId, replaces: r.replaces_cabinet_id, approvedBy: r.approved_by, role: r.role ?? "tier1", userActive: r.status === "active" };
    if (!job.userActive) return finish(pool, job, "stopped", "The Admin who approved the replacement can no longer make changes; nothing was re-applied.");
    if (r.state === "waiting") {
      // Whether it accepts changes is known from its first report; until then it waits.
      const ro = (await pool.query<{ read_only: boolean | null }>("SELECT read_only FROM cabinets WHERE id = $1", [cabinetId])).rows[0];
      if (!ro || ro.read_only === null) return;
      const planned = await planSteps(pool, job, timing);
      if (typeof planned === "string") return finish(pool, job, "stopped", planned);
      const claimed = await transaction(pool, async c => {
        const claim = await c.query("UPDATE replacement_reapply SET state = 'running', started_at = SYSUTCDATETIME() WHERE cabinet_id = $1 AND state = 'waiting'", [cabinetId]);
        if (claim.rowCount !== 1) return false;
        if (planned.length > 0)
          await c.query(`INSERT INTO replacement_reapply_steps (cabinet_id, [position], kind, operation, params, state, detail)
                         SELECT $1, j.position, j.kind, j.operation, j.params, j.state, j.detail
                           FROM OPENJSON($2) WITH (position int '$.i', kind nvarchar(16) '$.k', operation nvarchar(64) '$.o', params nvarchar(max) '$.p', state nvarchar(16) '$.s', detail nvarchar(300) '$.d') j`,
            [cabinetId, JSON.stringify(planned.map((s, i) => ({ i, k: s.kind, o: s.operation, p: s.params ? safeJson(s.params) : null, s: s.skip ? "skipped" : "pending", d: s.skip })))]);
        await audit(c, { actorKind: "system", actorId: "replacement", action: "replacement.reapply.plan", targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded",
          details: { replaces: job.replaces, approvedBy: job.approvedBy, steps: planned.map(s => ({ kind: s.kind, operation: s.operation, params: s.params, skip: s.skip })) } });
        return true;
      });
      // Someone else started it (or it was stopped) between the read and the claim.
      if (!claimed) return;
    }
    await runSteps(pool, job, timing);
    const counts = (await pool.query<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM replacement_reapply_steps WHERE cabinet_id = $1 GROUP BY state", [cabinetId])).rows;
    const n = (s: string) => Number(counts.find(c => c.state === s)?.n ?? 0);
    const problems = n("failed") + n("not_verified");
    await finish(pool, job, "done", problems > 0 ? `${n("verified")} re-applied and verified; ${problems} need a look.` : `${n("verified")} re-applied and verified; ${n("skipped")} not needed.`);
  } catch (e) {
    log(`re-apply for ${cabinetId} stopped: ${(e as Error).message}`);
  } finally {
    running.delete(cabinetId);
  }
}

/** The steps for this cabinet, or why none can be planned. Reads the new cabinet's network as the approving Admin. */
async function planSteps(pool: Pool, job: Reapply, timing: ReapplyTiming): Promise<PlannedStep[] | string> {
  const k = (await pool.query<{ read_only: boolean | null; zone: string | null; site_zone: string | null; old_zone: string | null }>(
    `SELECT k.read_only, k.time_zone_id AS zone, ${SITE_ZONE_SQL} AS site_zone, o.time_zone_id AS old_zone
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id LEFT JOIN cabinets o ON o.id = $2 WHERE k.id = $1`,
    [job.cabinetId, job.replaces])).rows[0];
  if (!k) return "The cabinet no longer exists.";
  if (k.read_only !== false) return "The new cabinet was installed read-only: it accepts no changes.";
  const steps: PlannedStep[] = [];
  const policy = await cabinetPolicy(pool, job.cabinetId);
  steps.push(policy.differs === false ? { kind: "firewall", operation: "firewall.applyPolicy", params: null, skip: "Already matches its firewall policy." }
    : { kind: "firewall", operation: "firewall.applyPolicy", params: { profiles: switchesFor(policy.policy) }, skip: null });
  const zone = k.site_zone ?? ((TIME_ZONES as readonly string[]).includes(k.old_zone ?? "") ? k.old_zone : null);
  steps.push(!zone ? { kind: "time_zone", operation: "time.setZone", params: null, skip: "No time zone applies to its site, and the old cabinet reported none." }
    : zone === k.zone ? { kind: "time_zone", operation: "time.setZone", params: null, skip: `Already in ${zone}.` }
    : { kind: "time_zone", operation: "time.setZone", params: { timeZoneId: zone }, skip: null });
  const old = (await currentItems(pool, job.replaces, ["network"])).get("network");
  const now = await readNetwork(pool, job, timing);
  if (!old) for (const kind of ["drawer", "dns", "address"] as const)
    steps.push({ kind, operation: kind === "dns" ? "network.setDns" : "network.setIp", params: null, skip: "The old cabinet never reported its network settings." });
  else if (!now) for (const kind of ["drawer", "dns", "address"] as const)
    steps.push({ kind, operation: kind === "dns" ? "network.setDns" : "network.setIp", params: null, skip: "The new cabinet's network could not be read." });
  else steps.push(...planNetwork(oldAdaptersFrom(old.items), now.adapters));
  return steps;
}

async function readNetwork(pool: Pool, job: Reapply, timing: ReapplyTiming): Promise<NetworkConfigOutput | null> {
  try {
    const issued = await issueFromConsole(pool, { userId: job.approvedBy, role: job.role }, job.cabinetId, "network.config", {});
    const r = await answer(pool, issued.commandId, timing);
    return r.status === "succeeded" ? (r.result?.output as NetworkConfigOutput | undefined) ?? null : null;
  } catch { return null; }
}

async function answer(pool: Pool, commandId: string, timing: ReapplyTiming) {
  for (const end = Date.now() + timing.answerMs; ; await sleep(timing.pollMs)) {
    const r = (await pool.query<{ status: string; result: { output?: unknown; error?: { code: string; message: string } } | null; result_at: Date | null }>(
      "SELECT status, result, result_at FROM commands WHERE id = $1", [commandId])).rows[0];
    if (r && (r.status === "succeeded" || FAILED.has(r.status))) return r;
    if (Date.now() >= end) return { status: "unanswered", result: null, result_at: null };
  }
}

/** Issues the pending steps one at a time; each is answered and verified before the next, and a failure stops the ones after it. */
async function runSteps(pool: Pool, job: Reapply, timing: ReapplyTiming): Promise<void> {
  const bulkId = job.cabinetId;
  for (;;) {
    const s = (await pool.query<{ position: number; operation: StepOperation; params: Record<string, unknown>; state: string; command_id: string | null }>(
      "SELECT TOP (1) [position], operation, params, state, command_id FROM replacement_reapply_steps WHERE cabinet_id = $1 AND state IN ('pending', 'issued') ORDER BY [position]",
      [job.cabinetId])).rows[0];
    if (!s) return;
    let commandId = s.command_id;
    if (s.state === "pending") {
      try {
        commandId = (await issueCommand(pool, job.approvedBy, job.cabinetId, s.operation, s.params, "command.issue", { viaReplacement: { replaces: job.replaces, bulkId } })).commandId;
      } catch (e) {
        await setStep(pool, job.cabinetId, s.position, "failed", `Not sent: ${(e as Error).message}.`);
        await stopAfter(pool, job.cabinetId, s.position);
        return;
      }
      await pool.query("UPDATE replacement_reapply_steps SET state = 'issued', command_id = $3, updated_at = SYSUTCDATETIME() WHERE cabinet_id = $1 AND [position] = $2",
        [job.cabinetId, s.position, commandId]);
    }
    const r = await answer(pool, commandId!, timing);
    if (r.status !== "succeeded") {
      const why = r.status === "unanswered" ? "No answer from the cabinet in time." : r.status === "expired" ? "The cabinet did not answer before the command expired."
        : r.result?.error ? `${r.result.error.code}: ${r.result.error.message}` : `The command ${r.status}.`;
      await setStep(pool, job.cabinetId, s.position, "failed", why);
      await stopAfter(pool, job.cabinetId, s.position);
      return;
    }
    const at = r.result_at ?? new Date();
    let ok = false;
    for (const end = Date.now() + timing.verifyMs; !ok && Date.now() < end; ) {
      ok = await verified(pool, s.operation, { cabinet_id: job.cabinetId, params: s.params, at }, { userId: job.approvedBy, role: job.role });
      if (!ok) await sleep(timing.pollMs);
    }
    await setStep(pool, job.cabinetId, s.position, ok ? "verified" : "not_verified",
      ok ? "Re-applied, and verified from what the cabinet reports." : "The cabinet said it made the change, but its reports did not show it in time. Check it.");
  }
}

/** A step that failed stops the ones after it: the address must never change after a step before it went wrong. */
const stopAfter = (pool: Pool, cabinetId: string, position: number) =>
  pool.query("UPDATE replacement_reapply_steps SET state = 'skipped', detail = 'Not sent: a step before it did not succeed.', updated_at = SYSUTCDATETIME() WHERE cabinet_id = $1 AND [position] > $2 AND state = 'pending'",
    [cabinetId, position]);

const setStep = (db: Queryable, cabinetId: string, position: number, state: string, detail: string) =>
  db.query("UPDATE replacement_reapply_steps SET state = $3, detail = $4, updated_at = SYSUTCDATETIME() WHERE cabinet_id = $1 AND [position] = $2",
    [cabinetId, position, state, detail.slice(0, 300)]);

async function finish(pool: Pool, job: Reapply, state: "done" | "stopped", detail: string): Promise<void> {
  await transaction(pool, async c => {
    const r = await c.query("UPDATE replacement_reapply SET state = $2, detail = $3, finished_at = SYSUTCDATETIME() WHERE cabinet_id = $1 AND state IN ('waiting', 'running')",
      [job.cabinetId, state, detail.slice(0, 300)]);
    if (r.rowCount === 1)
      await audit(c, { actorKind: "system", actorId: "replacement", action: "replacement.reapply.finish", targetKind: "cabinet", targetId: job.cabinetId, outcome: "succeeded",
        details: { replaces: job.replaces, state, detail } });
  });
}

/** What the cabinet page shows: the re-apply's state and each step with its result. Null when the cabinet replaced none. */
export async function reapplyStatus(db: Queryable, cabinetId: string) {
  const r = (await db.query<{ state: string; detail: string | null; created_at: Date; finished_at: Date | null }>(
    "SELECT state, detail, created_at, finished_at FROM replacement_reapply WHERE cabinet_id = $1", [cabinetId])).rows[0];
  if (!r) return null;
  const steps = (await db.query<{ kind: StepKind; operation: string; params: unknown; state: string; detail: string | null; updated_at: Date }>(
    "SELECT kind, operation, params, state, detail, updated_at FROM replacement_reapply_steps WHERE cabinet_id = $1 ORDER BY [position]", [cabinetId])).rows;
  return { state: r.state, detail: r.detail, queuedAt: r.created_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null,
    steps: steps.map(s => ({ kind: s.kind, operation: s.operation, params: s.params, state: s.state, detail: s.detail, updatedAt: s.updated_at.toISOString() })) };
}
