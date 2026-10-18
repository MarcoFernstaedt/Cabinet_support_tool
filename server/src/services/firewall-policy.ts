// The client firewall policy (docs/spec/12-milestones-8-to-12.md, milestone 9). Each client's policy says, for each
// profile, on or off; a client without its own uses the fleet default, which is all off unless an Admin changes it.
// Cabinets report their profiles with every heartbeat; one that differs gets a minor alert that closes once it
// matches again. A person applies the policy, to one cabinet with a click or to a site or client with the password.
import { randomUUID } from "node:crypto";
import { consumeStepUpToken } from "../auth/stepup.js";
import { catalog } from "../contracts.js";
import { audit, lock, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";
import { Refused } from "./errors.js";
import { ISSUE } from "./rules.js";
import { parseJson, upsertSetting } from "./settings.js";
import { fleetPause, WRITE_OPERATIONS, WriteLimitReached } from "./writes.js";

export type Switch = "on" | "off";
export interface FirewallPolicy { domain: Switch; private: Switch; public: Switch }
export interface ProfileSwitches { domain: boolean; private: boolean; public: boolean }

export const DEFAULT_POLICY: FirewallPolicy = { domain: "off", private: "off", public: "off" };
export const BULK_LIMIT = 200;
const PROFILES = ["domain", "private", "public"] as const;

export const switchesFor = (p: FirewallPolicy): ProfileSwitches => ({ domain: p.domain === "on", private: p.private === "on", public: p.public === "on" });
export const differs = (p: FirewallPolicy, s: ProfileSwitches): boolean => PROFILES.some(k => (p[k] === "on") !== s[k]);

const isPolicy = (v: unknown): v is FirewallPolicy =>
  typeof v === "object" && v !== null && PROFILES.every(k => (v as Record<string, unknown>)[k] === "on" || (v as Record<string, unknown>)[k] === "off");

export async function fleetPolicy(db: Queryable): Promise<FirewallPolicy> {
  const v = (await db.query<{ value: unknown }>("SELECT [value] FROM settings WHERE [key] = 'firewall.policy'")).rows[0]?.value;
  return isPolicy(v) ? v : DEFAULT_POLICY;
}

/** The policy that applies to one cabinet, where it comes from, and the profiles the cabinet last reported. */
export async function cabinetPolicy(db: Queryable, cabinetId: string) {
  const r = (await db.query<{ client_id: string; client_policy: string | null; firewall_profiles: ProfileSwitches | null; read_only: boolean | null }>(
    `SELECT s.client_id, cl.firewall_policy AS client_policy, k.firewall_profiles, k.read_only
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id WHERE k.id = $1`, [cabinetId])).rows[0];
  if (!r) throw new Refused("not_found", 404, "no such cabinet");
  const clientPolicy = parseJson<unknown>(r.client_policy);
  const own = isPolicy(clientPolicy) ? clientPolicy : null;
  const policy = own ?? await fleetPolicy(db);
  return { clientId: r.client_id, policy, source: own ? "client" as const : "fleet" as const, reported: r.firewall_profiles,
    differs: r.firewall_profiles ? differs(policy, r.firewall_profiles) : null, readOnly: r.read_only };
}

/**
 * The SQL that says whether cabinet k (joined to its client cl) differs from its policy; $1 is the fleet policy (JSON text).
 * A profile the cabinet did not report as true or false counts as different, as PostgreSQL's IS DISTINCT FROM did. Only the three fixed profile names go into the text.
 */
const differsOn = (profile: (typeof PROFILES)[number]) =>
  `(CASE WHEN JSON_VALUE(COALESCE(cl.firewall_policy, $1), '$.${profile}') = 'on' THEN 1 ELSE 0 END)
     <> ISNULL(CASE JSON_VALUE(k.firewall_profiles, '$.${profile}') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END, 2)`;
const DIFFERS_SQL = `k.firewall_profiles IS NOT NULL AND (${PROFILES.map(differsOn).join("\n  OR ")})`;

/**
 * Opens a minor "Firewall differs from client policy" alert for each cabinet in scope that differs, and resolves it
 * for each that matches again. Run on a heartbeat that reports a change, and for every affected cabinet when a policy changes.
 */
export async function evaluateDrift(db: Queryable, scope: { cabinetId: string } | { clientId: string } | "all"): Promise<{ opened: number; resolved: number }> {
  const fleet = safeJson(await fleetPolicy(db));
  const [where, arg] = scope === "all" ? ["1 = 1", null] : "cabinetId" in scope ? ["k.id = $2", scope.cabinetId] : ["cl.id = $2", scope.clientId];
  const params = arg === null ? [fleet] : [fleet, arg];
  // One cabinet (a heartbeat): a lock-free read first says whether it differs and whether an alert is open; usually neither, and then
  // no range-locking MERGE runs (it was the costliest statement of a fleet's first heartbeats).
  let [differ, open] = [true, true];
  if (scope !== "all" && "cabinetId" in scope) {
    const r = (await db.query<{ d: boolean; o: boolean }>(
      `SELECT CAST(CASE WHEN k.status = 'active' AND ${DIFFERS_SQL} THEN 1 ELSE 0 END AS bit) AS d,
              CAST(CASE WHEN EXISTS (SELECT 1 FROM alerts WHERE cabinet_id = k.id AND issue_type_id = $3 AND state <> 'resolved') THEN 1 ELSE 0 END AS bit) AS o
         FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id WHERE k.id = $2`, [fleet, scope.cabinetId, ISSUE.firewallPolicy])).rows[0];
    [differ, open] = [!!r?.d, !!r?.o];
    if (!differ && !open) return { opened: 0, resolved: 0 };
  }
  const issue = (await db.query<{ name: string; severity: string }>("SELECT name, severity FROM issue_types WHERE id = $1", [ISSUE.firewallPolicy])).rows[0];
  if (!issue) return { opened: 0, resolved: 0 };
  const n = params.length;
  // alerts has triggers (they announce new alerts), so what the MERGE did is read through a table variable.
  const opened = !differ ? { rows: [] as { act: string }[] } : await db.query<{ act: string }>(
    `DECLARE @o TABLE (act nvarchar(10));
     MERGE alerts WITH (HOLDLOCK) AS t
     USING (SELECT k.id AS cabinet_id
              FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id
             WHERE k.status = 'active' AND ${where} AND ${DIFFERS_SQL}) AS src
        ON t.cabinet_id = src.cabinet_id AND t.signature = $${n + 3} AND t.state <> 'resolved'
      WHEN MATCHED THEN UPDATE SET last_seen = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen)
           VALUES (src.cabinet_id, CAST($${n + 1} AS uniqueidentifier), $${n + 2}, $${n + 3}, $${n + 4}, SYSUTCDATETIME(), SYSUTCDATETIME())
      OUTPUT $action INTO @o (act);
     SELECT act FROM @o;`,
    [...params, ISSUE.firewallPolicy, issue.severity, `issue:${ISSUE.firewallPolicy}`, issue.name]);
  const resolved = !open ? { rowCount: 0 } : await db.query(
    `UPDATE a SET state = 'resolved', resolved_at = SYSUTCDATETIME(), resolution = 'The firewall matches the client policy again.'
       FROM alerts a JOIN cabinets k ON a.cabinet_id = k.id JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id
      WHERE a.issue_type_id = CAST($${n + 1} AS uniqueidentifier) AND a.state <> 'resolved' AND ${where}
        AND (k.status <> 'active' OR NOT (${DIFFERS_SQL}))`,
    [...params, ISSUE.firewallPolicy]);
  return { opened: opened.rows.filter(r => r.act === "INSERT").length, resolved: resolved.rowCount ?? 0 };
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
    `SELECT k.id, k.name, COALESCE(cl.firewall_policy, $1) AS firewall_policy
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id
      WHERE k.status = 'active' AND ${scope === "site" ? "s.id" : "cl.id"} = $2 AND k.read_only = 0 AND cl.write_paused = 0
        AND k.last_heartbeat_at > DATEADD(second, -$3, SYSUTCDATETIME()) AND ${DIFFERS_SQL}
      ORDER BY k.name`, [fleet, id, Math.round(OFFLINE_AFTER_MS / 1000)])).rows.map(r => ({ id: r.id, name: r.name, policy: r.firewall_policy }));
}

/**
 * Applies the client's policy to every cabinet of a site or client that differs from it (Tier 1 and up). Confirmed with
 * the password: the token is bound to bulk.firewall_policy on that site or client and to {scope, id}. At most 200
 * cabinets; the write pause, the person's own pause and limit apply, and the whole bulk counts as one write.
 */
export async function bulkApply(pool: Pool, userId: string, scope: "site" | "client", id: string, stepUpToken: string) {
  return transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, userId, "bulk.firewall_policy", id, { scope, id });
    await lock(c, `writes:${userId}`);
    if ((await fleetPause(c)).paused) throw new Refused("writes_paused", 409, "writes are paused fleet-wide");
    const u = (await c.query<{ writes_paused: boolean; write_limit: number }>("SELECT writes_paused, write_limit FROM users WHERE id = $1 AND status = 'active'", [userId])).rows[0];
    if (!u) throw new Refused("forbidden", 403, "unknown or disabled user");
    if (u.writes_paused) throw new Refused("writes_paused_for_you", 409, "your writes are paused until an Admin resumes them");
    const used = Number((await c.query<{ n: string }>(
      "SELECT COUNT(DISTINCT COALESCE(m.bulk_id, m.id)) AS n FROM commands m JOIN cabinets t ON t.id = m.cabinet_id WHERE m.issued_by = $1 AND m.issued_at > DATEADD(hour, -1, SYSUTCDATETIME()) AND m.operation IN (SELECT [value] FROM OPENJSON($2)) AND t.demo_scenario IS NULL",
      [userId, WRITE_OPERATIONS])).rows[0]!.n);
    if (used >= u.write_limit) throw new WriteLimitReached();
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
      await c.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, bulk_id)
                     VALUES ($1, $2, 'firewall.applyPolicy', $3, $4, $5, $6, 'queued', $7)`, [commandId, t.id, safeJson(params), userId, issuedAt, expiresAt, bulkId]);
      await audit(c, { actorKind: "user", actorId: userId, action: "command.write", targetKind: "cabinet", targetId: t.id, outcome: "succeeded",
        details: { commandId, operation: "firewall.applyPolicy", params, bulkId } });
      commands.push({ commandId, cabinetId: t.id, cabinet: t.name });
    }
    await audit(c, { actorKind: "user", actorId: userId, action: "bulk.firewall_policy", targetKind: scope, targetId: id, outcome: "succeeded",
      details: { bulkId, cabinets: commands.length, commandIds: commands.map(x => x.commandId) } });
    return { bulkId, expiresAt: expiresAt.toISOString(), issuedAt: issuedAt.toISOString(), commands };
  });
}
