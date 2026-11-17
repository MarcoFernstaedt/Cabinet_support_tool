// The firewall policy (docs/spec/12-milestones-8-to-12.md, milestone 9; site level: 05-server-spec.md "Site policies"). A policy
// says, for each profile, on or off. The most specific level with one applies: the site's, else the client's, else the fleet
// default, which is all off unless an Admin changes it.
// Cabinets report their profiles with every heartbeat; one that differs gets a minor alert that closes once it
// matches again. A person applies the policy, to one cabinet with a click or to a site or client with the password.
import { randomUUID } from "node:crypto";
import { consumeStepUpToken } from "../auth/stepup.js";
import { catalog } from "../contracts.js";
import { audit, lock, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { queueBulkCommand } from "./commands.js";
import { foldCabinetCondition, type CabinetScope } from "./alerts.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";
import { FIREWALL_PROFILES as PROFILES, firewallDiffersSql, firewallPolicySql } from "./cabinet-conditions.js";
import { Refused } from "./errors.js";
import { ISSUE } from "./rules.js";
import { parseJson, upsertSetting } from "./settings.js";
import { assertUnderWriteLimit, fleetPause, pauseOnWriteLimit } from "./writes.js";

export type Switch = "on" | "off";
export interface FirewallPolicy { domain: Switch; private: Switch; public: Switch }
export interface ProfileSwitches { domain: boolean; private: boolean; public: boolean }

export const DEFAULT_POLICY: FirewallPolicy = { domain: "off", private: "off", public: "off" };
export const BULK_LIMIT = 200;

export const switchesFor = (p: FirewallPolicy): ProfileSwitches => ({ domain: p.domain === "on", private: p.private === "on", public: p.public === "on" });
export const differs = (p: FirewallPolicy, s: ProfileSwitches): boolean => PROFILES.some(k => (p[k] === "on") !== s[k]);

const isPolicy = (v: unknown): v is FirewallPolicy =>
  typeof v === "object" && v !== null && PROFILES.every(k => (v as Record<string, unknown>)[k] === "on" || (v as Record<string, unknown>)[k] === "off");

export async function fleetPolicy(db: Queryable): Promise<FirewallPolicy> {
  const v = (await db.query<{ value: unknown }>("SELECT [value] FROM settings WHERE [key] = 'firewall.policy'")).rows[0]?.value;
  return isPolicy(v) ? v : DEFAULT_POLICY;
}

const asPolicy = (raw: string | null): FirewallPolicy | null => { const v = parseJson<unknown>(raw); return isPolicy(v) ? v : null; };

/** The policy a site's cabinets follow and where it comes from: the site's own, else the client's, else the fleet's. */
export async function sitePolicy(db: Queryable, siteId: string) {
  const r = (await db.query<{ client_id: string; site_policy: string | null; client_policy: string | null }>(
    `SELECT s.client_id, s.firewall_policy AS site_policy, cl.firewall_policy AS client_policy
       FROM sites s JOIN clients cl ON cl.id = s.client_id WHERE s.id = $1 AND s.removed_at IS NULL`, [siteId])).rows[0];
  if (!r) throw new Refused("not_found", 404, "no such site");
  const [own, client, fleet] = [asPolicy(r.site_policy), asPolicy(r.client_policy), await fleetPolicy(db)];
  return { clientId: r.client_id, own, client, fleet, policy: own ?? client ?? fleet, source: own ? "site" as const : client ? "client" as const : "fleet" as const };
}

/** The policy that applies to one cabinet, where it comes from, and the profiles the cabinet last reported. */
export async function cabinetPolicy(db: Queryable, cabinetId: string) {
  const r = (await db.query<{ client_id: string; site_policy: string | null; client_policy: string | null; firewall_profiles: ProfileSwitches | null; read_only: boolean | null }>(
    `SELECT s.client_id, s.firewall_policy AS site_policy, cl.firewall_policy AS client_policy, k.firewall_profiles, k.read_only
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id WHERE k.id = $1`, [cabinetId])).rows[0];
  if (!r) throw new Refused("not_found", 404, "no such cabinet");
  const [site, client] = [asPolicy(r.site_policy), asPolicy(r.client_policy)];
  const policy = site ?? client ?? await fleetPolicy(db);
  return { clientId: r.client_id, policy, source: site ? "site" as const : client ? "client" as const : "fleet" as const, reported: r.firewall_profiles,
    differs: r.firewall_profiles ? differs(policy, r.firewall_profiles) : null, readOnly: r.read_only };
}

// The condition texts live in cabinet-conditions.ts, where alerts.ts reads them too (D107); here $1 is the fleet policy, as before.
const POLICY_SQL = firewallPolicySql(1);
const DIFFERS_SQL = firewallDiffersSql(1);

/**
 * Opens a minor "Firewall differs from client policy" alert for each cabinet in scope that differs, and resolves it
 * for each that matches again. Run on a heartbeat that reports a change, and for every affected cabinet when a policy changes.
 */
export async function evaluateDrift(db: Queryable, scope: CabinetScope): Promise<{ opened: number; resolved: number }> {
  const policy = await fleetPolicy(db);
  const fleet = safeJson(policy);
  // FORCESEEK on alerts here and in the MERGE: a plan compiled while alerts was still nearly empty (a new install, a load test) chose a
  // scan, and a HOLDLOCK scan range-locks the whole table, which serialised every heartbeat of a 10,000-cabinet fleet.
  // One cabinet (a heartbeat): a lock-free read first says whether it differs and whether an alert is open; usually neither, and then
  // no range-locking MERGE runs (it was the costliest statement of a fleet's first heartbeats).
  let [differ, open] = [true, true];
  if (scope !== "all" && "cabinetId" in scope) {
    const r = (await db.query<{ d: boolean; o: boolean }>(
      `SELECT CAST(CASE WHEN k.status = 'active' AND ${DIFFERS_SQL} THEN 1 ELSE 0 END AS bit) AS d,
              CAST(CASE WHEN EXISTS (SELECT 1 FROM alerts WITH (FORCESEEK) WHERE cabinet_id = k.id AND issue_type_id = $3 AND state <> 'resolved') THEN 1 ELSE 0 END AS bit) AS o
         FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id WHERE k.id = $2`, [fleet, scope.cabinetId, ISSUE.firewallPolicy])).rows[0];
    [differ, open] = [!!r?.d, !!r?.o];
    if (!differ && !open) return { opened: 0, resolved: 0 };
  }
  // alerts.ts opens and closes the alert, by name, with the fleet policy as a value (D107).
  return foldCabinetCondition(db, "firewall", scope, { open: differ, close: open }, { fleetPolicy: policy });
}

/** An Admin sets a client's own policy, or removes it (null) so the fleet default applies. Needs a code. */
export async function setClientPolicy(pool: Pool, adminId: string, clientId: string, policy: FirewallPolicy | null, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "client.firewall_policy", clientId);
    const r = await c.query("UPDATE clients SET firewall_policy = $2 WHERE id = $1 AND removed_at IS NULL", [clientId, policy === null ? null : safeJson(policy)]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such client");
    await audit(c, { actorKind: "user", actorId: adminId, action: "client.firewall_policy", targetKind: "client", targetId: clientId, outcome: "succeeded", details: { policy } });
    await evaluateDrift(c, { clientId });
  });
}

/** An Admin sets a site's own policy, or removes it (null) so the client's, else the fleet's, applies. Needs a code. */
export async function setSitePolicy(pool: Pool, adminId: string, siteId: string, policy: FirewallPolicy | null, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "site.firewall_policy", siteId);
    await writeSitePolicy(c, adminId, siteId, policy);
  });
}

/** Writes a site's own policy in the caller's transaction (the caller checked the role and the code), audits it and re-checks the site. */
export async function writeSitePolicy(c: Queryable, userId: string, siteId: string, policy: FirewallPolicy | null): Promise<void> {
  const r = await c.query("UPDATE sites SET firewall_policy = $2 WHERE id = $1 AND removed_at IS NULL", [siteId, policy === null ? null : safeJson(policy)]);
  if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such site");
  await audit(c, { actorKind: "user", actorId: userId, action: "site.firewall_policy", targetKind: "site", targetId: siteId, outcome: "succeeded", details: { policy } });
  await evaluateDrift(c, { siteId });
}

/** An Admin sets the fleet default policy (null restores all off). Needs a code. */
export async function setFleetPolicy(pool: Pool, adminId: string, policy: FirewallPolicy | null, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "fleet.firewall_policy", "fleet");
    if (policy === null) await c.query("DELETE FROM settings WHERE [key] = 'firewall.policy'");
    else await upsertSetting(c, "firewall.policy", policy, adminId);
    await audit(c, { actorKind: "user", actorId: adminId, action: "fleet.firewall_policy", outcome: "succeeded", details: { policy } });
    await evaluateDrift(c, "all");
  });
}

/** The cabinets of a site or client that a bulk apply would change: online, writable, reporting, and differing. */
export async function bulkCandidates(db: Queryable, scope: "site" | "client", id: string) {
  const fleet = safeJson(await fleetPolicy(db));
  // The policy column is read under the name the data layer parses (firewall_policy), then renamed.
  return (await db.query<{ id: string; name: string; firewall_policy: FirewallPolicy }>(
    `SELECT k.id, k.name, ${POLICY_SQL} AS firewall_policy
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id
      WHERE k.status = 'active' AND ${scope === "site" ? "s.id" : "cl.id"} = $2 AND k.read_only = 0 AND cl.write_paused = 0
        AND k.last_heartbeat_at > DATEADD(second, -$3, SYSUTCDATETIME()) AND ${DIFFERS_SQL}
      ORDER BY k.name`, [fleet, id, Math.round(OFFLINE_AFTER_MS / 1000)])).rows.map(r => ({ id: r.id, name: r.name, policy: r.firewall_policy }));
}

/**
 * Applies each cabinet's policy to every cabinet of a site or client that differs from it (Tier 1 and up). Confirmed with
 * the password: the token is bound to bulk.firewall_policy on that site or client and to {scope, id}. At most 200
 * cabinets; the write pause, the person's own pause and limit apply, and the whole bulk counts as one write.
 */
export async function bulkApply(pool: Pool, userId: string, scope: "site" | "client", id: string, stepUpToken: string) {
  return pauseOnWriteLimit(pool, userId, () => transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, userId, "bulk.firewall_policy", id, { scope, id });
    await lock(c, `writes:${userId}`);
    if ((await fleetPause(c)).paused) throw new Refused("writes_paused", 409, "writes are paused fleet-wide");
    await assertUnderWriteLimit(c, userId);
    const targets = await bulkCandidates(c, scope, id);
    if (targets.length > BULK_LIMIT) throw new Refused("too_many_cabinets", 409, `${targets.length} cabinets differ; a bulk change covers at most ${BULK_LIMIT}`);
    const bulkId = randomUUID();
    const entry = catalog.get("firewall.applyPolicy")!;
    const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const expiresAt = new Date(issuedAt.getTime() + entry.expirySeconds * 1000);
    const commands: { commandId: string; cabinetId: string; cabinet: string }[] = [];
    for (const t of targets) {
      const commandId = randomUUID();
      const params = { profiles: switchesFor(t.policy) };
      await queueBulkCommand(c, { commandId, cabinetId: t.id, operation: "firewall.applyPolicy", params, issuedBy: userId, issuedAt, expiresAt, bulkId });
      await audit(c, { actorKind: "user", actorId: userId, action: "command.write", targetKind: "cabinet", targetId: t.id, outcome: "succeeded",
        details: { commandId, operation: "firewall.applyPolicy", params, bulkId } });
      commands.push({ commandId, cabinetId: t.id, cabinet: t.name });
    }
    await audit(c, { actorKind: "user", actorId: userId, action: "bulk.firewall_policy", targetKind: scope, targetId: id, outcome: "succeeded",
      details: { bulkId, cabinets: commands.length, commandIds: commands.map(x => x.commandId) } });
    return { bulkId, expiresAt: expiresAt.toISOString(), issuedAt: issuedAt.toISOString(), commands };
  }));
}
