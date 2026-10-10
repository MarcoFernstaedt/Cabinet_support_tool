// Issue types and symptom rules (docs/spec/05-server-spec.md "Issue types and symptom rules").
// A rule matches on structured fields only, plus a plain phrase compared as a case-insensitive
// substring. There are no regular expressions anywhere in matching, so no rule can freeze the server.
import type pg from "pg";
import type { Event, SymptomMatch } from "../contracts.js";
import { commonDefs } from "../contracts.js";
import { audit, safeJson, transaction, type Queryable } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { Refused } from "./errors.js";

export const ISSUE = {
  scanner: "00000000-0000-4000-8000-000000000101",
  drive: "00000000-0000-4000-8000-000000000102",
  firewall: "00000000-0000-4000-8000-000000000105",
  offline: "00000000-0000-4000-8000-000000000108",
  firewallPolicy: "00000000-0000-4000-8000-000000000113",
  serviceRestarted: "00000000-0000-4000-8000-000000000114",
  serviceFailing: "00000000-0000-4000-8000-000000000115",
  serviceWatch: "00000000-0000-4000-8000-000000000116",
  crash: "00000000-0000-4000-8000-000000000109",
  shutdown: "00000000-0000-4000-8000-000000000110",
  hardware: "00000000-0000-4000-8000-000000000111",
  rebootLoop: "00000000-0000-4000-8000-000000000117",
} as const;

/** What the engine knows about an event when it matches: the event as the agent sent it. */
export type MatchableEvent = Pick<Event, "kind" | "source" | "detail" | "device">;

export interface LiveRule {
  id: string; kind: "map" | "suppress"; issueTypeId: string | null; match: SymptomMatch; builtIn: boolean; createdAt: Date; severity: "major" | "minor" | null;
}

const lower = (s: string) => s.toLocaleLowerCase("en-US");

/** Whether one event satisfies every field of a match. */
export function matches(m: SymptomMatch, e: MatchableEvent): boolean {
  if (m.kind !== undefined && e.kind !== m.kind) return false;
  const s = e.source;
  if (m.log !== undefined && s?.log !== m.log) return false;
  if (m.source !== undefined && (s === undefined || lower(s.source) !== lower(m.source))) return false;
  if (m.eventId !== undefined && s?.eventId !== m.eventId) return false;
  if (m.level !== undefined && s?.level !== m.level) return false;
  if (m.hardwareId !== undefined) {
    const want = lower(m.hardwareId);
    const ids = [...(s?.hardwareId ? [s.hardwareId] : []), ...(e.device?.hardwareIds ?? [])];
    if (!ids.some(id => lower(id) === want)) return false;
  }
  if (m.phrase !== undefined && !lower(e.detail?.message ?? "").includes(lower(m.phrase.trim()))) return false;
  return true;
}

/** How narrow a match is; the most specific matching rule wins. */
export const specificity = (m: SymptomMatch): number => Object.keys(m).length;

/** The same match as SQL over the events table (alias e), with its parameters, for the fleet preview and regrouping. */
export function matchSql(m: SymptomMatch, firstParam: number): { where: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${firstParam + params.length - 1}`; };
  if (m.kind !== undefined) parts.push(`e.kind = ${p(m.kind)}`);
  if (m.log !== undefined) parts.push(`e.source->>'log' = ${p(m.log)}`);
  if (m.source !== undefined) parts.push(`lower(e.source->>'source') = lower(${p(m.source)})`);
  if (m.eventId !== undefined) parts.push(`e.source->>'eventId' = ${p(String(m.eventId))}`);
  if (m.level !== undefined) parts.push(`e.source->>'level' = ${p(m.level)}`);
  if (m.hardwareId !== undefined) {
    const h = p(m.hardwareId);
    parts.push(`(lower(e.source->>'hardwareId') = lower(${h}) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(e.device->'hardwareIds', '[]'::jsonb)) AS id WHERE lower(id) = lower(${h})))`);
  }
  if (m.phrase !== undefined) parts.push(`strpos(lower(COALESCE(e.detail->>'message', '')), lower(${p(m.phrase.trim())})) > 0`);
  return { where: parts.length ? parts.join(" AND ") : "true", params };
}

/**
 * A rule people write must name something specific: a source, an event ID, a hardware ID or a
 * phrase. A rule on only a log or a level would swallow every unrecognized error in it.
 */
export function checkUserMatch(m: SymptomMatch): void {
  if (!commonDefs.symptomMatch.is(m)) throw new Refused("invalid_request", 400, "match does not fit its contract");
  if (m.source === undefined && m.eventId === undefined && m.hardwareId === undefined && m.phrase === undefined)
    throw new Refused("rule_too_broad", 400, "a rule must name a source, event ID, hardware ID or phrase");
  if ((m.log !== undefined || m.source !== undefined || m.eventId !== undefined || m.level !== undefined) && m.kind !== undefined && m.kind !== "error")
    throw new Refused("rule_impossible", 400, "log fields only exist on error events");
}

export async function liveRules(db: Queryable): Promise<LiveRule[]> {
  const rows = (await db.query<{ id: string; kind: "map" | "suppress"; issue_type_id: string | null; match: SymptomMatch; built_in: boolean; created_at: Date;
    severity: "major" | "minor" | null }>(
    `SELECT id, kind, issue_type_id, match, built_in, created_at, severity FROM symptom_rules
      WHERE state = 'live' AND (expires_at IS NULL OR expires_at > now())`)).rows;
  // A stored match is checked again before use: the table is never trusted to hold only valid rules.
  return rows.filter(r => commonDefs.symptomMatch.is(r.match))
    .map(r => ({ id: r.id, kind: r.kind, issueTypeId: r.issue_type_id, match: r.match, builtIn: r.built_in, createdAt: r.created_at, severity: r.severity }));
}

/** The rule that decides an event: a suppression first, else the most specific map rule (the oldest on a tie). */
export function decide(rules: readonly LiveRule[], e: MatchableEvent): LiveRule | null {
  const hits = rules.filter(r => matches(r.match, e));
  const suppress = hits.find(r => r.kind === "suppress");
  if (suppress) return suppress;
  return hits.filter(r => r.kind === "map")
    .sort((a, b) => specificity(b.match) - specificity(a.match) || a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null;
}

// ---- Issue types --------------------------------------------------------------------

export async function issueTypes(db: Queryable) {
  const rows = (await db.query<{ id: string; name: string; severity: string; description: string; built_in: boolean; open_alerts: string; live_rules: string }>(
    `SELECT t.id, t.name, t.severity, t.description, t.built_in,
            (SELECT count(*) FROM alerts a WHERE a.issue_type_id = t.id AND a.state <> 'resolved') AS open_alerts,
            (SELECT count(*) FROM symptom_rules r WHERE r.issue_type_id = t.id AND r.state = 'live') AS live_rules
       FROM issue_types t ORDER BY t.name`)).rows;
  return rows.map(r => ({ id: r.id, name: r.name, severity: r.severity, description: r.description, builtIn: r.built_in,
    openAlerts: Number(r.open_alerts), liveRules: Number(r.live_rules) }));
}

// ---- Rules ---------------------------------------------------------------------------

interface RuleRow {
  id: string; issue_type_id: string | null; issue_name: string | null; kind: string; state: string; version: number; match: SymptomMatch;
  regroup: boolean; built_in: boolean; proposed_by: string | null; proposed_by_name: string | null; approved_by: string | null; approved_by_name: string | null;
  reason: string | null; expires_at: Date | null; created_at: Date; updated_at: Date; matched_count: string; severity: "major" | "minor" | null;
}

const RULE_SELECT = `SELECT r.*, t.name AS issue_name, p.name AS proposed_by_name, a.name AS approved_by_name
  FROM symptom_rules r LEFT JOIN issue_types t ON t.id = r.issue_type_id
  LEFT JOIN users p ON p.id = r.proposed_by LEFT JOIN users a ON a.id = r.approved_by`;

const ruleView = (r: RuleRow) => ({
  id: r.id, issueType: r.issue_type_id ? { id: r.issue_type_id, name: r.issue_name } : null, kind: r.kind, state: r.state, version: r.version,
  match: r.match, severity: r.severity, regroup: r.regroup, builtIn: r.built_in, proposedBy: r.proposed_by ? { id: r.proposed_by, name: r.proposed_by_name } : null,
  approvedBy: r.approved_by ? { id: r.approved_by, name: r.approved_by_name } : null, reason: r.reason,
  expiresAt: r.expires_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), matchedCount: Number(r.matched_count),
});

export async function listRules(db: Queryable, filter: { state?: string; issueTypeId?: string }) {
  const rows = (await db.query<RuleRow>(`${RULE_SELECT}
     WHERE ($1::text IS NULL OR r.state = $1) AND ($2::uuid IS NULL OR r.issue_type_id = $2)
     ORDER BY r.updated_at DESC LIMIT 500`, [filter.state ?? null, filter.issueTypeId ?? null])).rows;
  return rows.map(ruleView);
}

export async function ruleHistory(db: Queryable, ruleId: string) {
  const rows = (await db.query<{ version: number; change: string; state: string; issue_type_id: string | null; match: SymptomMatch; changed_by: string | null; name: string | null; changed_at: Date }>(
    `SELECT h.version, h.change, h.state, h.issue_type_id, h.match, h.changed_by, u.name, h.changed_at
       FROM symptom_rule_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.rule_id = $1 ORDER BY h.id`, [ruleId])).rows;
  return rows.map(h => ({ version: h.version, change: h.change, state: h.state, issueTypeId: h.issue_type_id, match: h.match,
    changedBy: h.changed_by ? { id: h.changed_by, name: h.name } : null, changedAt: h.changed_at.toISOString() }));
}

/** How many events across the fleet in the last 30 days the match would have caught, and on how many cabinets. */
export async function preview(db: Queryable, m: SymptomMatch) {
  const { where, params } = matchSql(m, 1);
  const r = (await db.query<{ events: string; cabinets: string; unrecognized: string }>(
    `SELECT count(*) AS events, count(DISTINCT e.cabinet_id) AS cabinets,
            count(DISTINCT e.alert_id) FILTER (WHERE a.issue_type_id IS NULL AND a.state <> 'resolved') AS unrecognized
       FROM events e LEFT JOIN alerts a ON a.id = e.alert_id
      WHERE e.occurred_at > now() - interval '30 days' AND ${where}`, params)).rows[0]!;
  return { events: Number(r.events), cabinets: Number(r.cabinets), openUnrecognizedAlerts: Number(r.unrecognized), days: 30 };
}

type Role = "tier1" | "tier2" | "admin";
interface Actor { userId: string; role: Role; }

async function history(c: pg.PoolClient, ruleId: string, change: string, by: string | null): Promise<void> {
  await c.query(`INSERT INTO symptom_rule_history (rule_id, version, change, state, issue_type_id, match, severity, changed_by)
                 SELECT id, version, $2, state, issue_type_id, match, severity, $3 FROM symptom_rules WHERE id = $1`, [ruleId, change, by]);
}

/**
 * Map to issue. A Tier 2 user's rule waits as a proposal; an Admin's goes live at once.
 * Both need step-up. Going live may regroup matching open unrecognized alerts.
 */
export interface NewIssueType { name: string; severity: "major" | "minor"; description: string; }

/**
 * Map to issue, for an existing issue type or (Admins only) a new one created in the same step, with one step-up
 * token (target "fleet" for a new type). The rule may set its own severity, overriding the issue type's.
 */
export async function proposeRule(pool: pg.Pool, u: Actor, issue: string | NewIssueType, m: SymptomMatch, regroup: boolean, stepUpToken: string,
  severity: "major" | "minor" | null = null) {
  if (u.role !== "tier2" && u.role !== "admin") throw new Refused("forbidden", 403, "Tier 2 or Admin only");
  if (typeof issue !== "string" && u.role !== "admin") throw new Refused("forbidden", 403, "only Admins create issue types");
  checkUserMatch(m);
  return transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, u.userId, "rule.propose", typeof issue === "string" ? issue : "fleet");
    let issueTypeId: string;
    if (typeof issue === "string") {
      const type = (await c.query("SELECT id FROM issue_types WHERE id = $1", [issue])).rows[0];
      if (!type) throw new Refused("not_found", 404, "no such issue type");
      issueTypeId = issue;
    } else {
      const created = await c.query<{ id: string }>("INSERT INTO issue_types (name, severity, description, created_by) VALUES ($1, $2, $3, $4) RETURNING id",
        [issue.name, issue.severity, issue.description, u.userId])
        .catch((e: { code?: string }) => { throw e.code === "23505" ? new Refused("name_taken", 409, "an issue type with that name exists") : e; });
      issueTypeId = created.rows[0]!.id;
      await audit(c, { actorKind: "user", actorId: u.userId, action: "issue_type.create", targetKind: "issue_type", targetId: issueTypeId, outcome: "succeeded",
        details: { ...issue, from: "map_to_issue" } });
    }
    const live = u.role === "admin";
    const r = (await c.query<{ id: string }>(
      `INSERT INTO symptom_rules (issue_type_id, kind, state, match, regroup, proposed_by, approved_by, severity)
       VALUES ($1, 'map', $2, $3, $4, $5, $6, $7) RETURNING id`,
      [issueTypeId, live ? "live" : "proposed", safeJson(m), regroup, u.userId, live ? u.userId : null, severity])).rows[0]!;
    await history(c, r.id, live ? "approved" : "proposed", u.userId);
    const regrouped = live && regroup ? await regroupOpen(c, r.id, issueTypeId, m) : 0;
    await audit(c, { actorKind: "user", actorId: u.userId, action: live ? "rule.create" : "rule.propose", targetKind: "rule", targetId: r.id,
      outcome: "succeeded", details: { issueTypeId, match: m, severity, regroup, regrouped } });
    return { ruleId: r.id, issueTypeId, state: live ? "live" : "proposed", regrouped };
  });
}

export async function decideRule(pool: pg.Pool, adminId: string, ruleId: string, approve: boolean, stepUpToken: string) {
  return transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, approve ? "rule.approve" : "rule.reject", ruleId);
    const r = (await c.query<{ issue_type_id: string; match: SymptomMatch; regroup: boolean; proposed_by: string }>(
      `UPDATE symptom_rules SET state = $2, approved_by = $3, updated_at = now() WHERE id = $1 AND state = 'proposed'
       RETURNING issue_type_id, match, regroup, proposed_by`, [ruleId, approve ? "live" : "rejected", adminId])).rows[0];
    if (!r) throw new Refused("not_pending", 409, "the rule is not waiting for approval");
    await history(c, ruleId, approve ? "approved" : "rejected", adminId);
    const regrouped = approve && r.regroup ? await regroupOpen(c, ruleId, r.issue_type_id, r.match) : 0;
    await audit(c, { actorKind: "user", actorId: adminId, action: approve ? "rule.approve" : "rule.reject", targetKind: "rule", targetId: ruleId,
      outcome: "succeeded", details: { proposedBy: r.proposed_by, regrouped } });
    return { ruleId, state: approve ? "live" : "rejected", regrouped };
  });
}

export async function disableRule(pool: pg.Pool, adminId: string, ruleId: string, stepUpToken: string) {
  return transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "rule.disable", ruleId);
    const r = await c.query("UPDATE symptom_rules SET state = 'disabled', updated_at = now() WHERE id = $1 AND state = 'live'", [ruleId]);
    if (r.rowCount !== 1) throw new Refused("not_live", 409, "the rule is not live");
    await history(c, ruleId, "disabled", adminId);
    await audit(c, { actorKind: "user", actorId: adminId, action: "rule.disable", targetKind: "rule", targetId: ruleId, outcome: "succeeded" });
  });
}

/** Puts back an earlier version's issue type and match, live, as a new version (history is never rewritten). */
export async function rollbackRule(pool: pg.Pool, adminId: string, ruleId: string, version: number, stepUpToken: string) {
  return transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "rule.rollback", ruleId);
    const old = (await c.query<{ issue_type_id: string | null; match: SymptomMatch }>(
      `SELECT issue_type_id, match FROM symptom_rule_history WHERE rule_id = $1 AND version = $2 ORDER BY id DESC LIMIT 1`, [ruleId, version])).rows[0];
    if (!old) throw new Refused("not_found", 404, "no such version");
    if (!commonDefs.symptomMatch.is(old.match)) throw new Refused("invalid_request", 400, "that version's match no longer fits its contract");
    // Only a rule an Admin already approved can be rolled back: never a proposal or a rejected one.
    const r = await c.query(`UPDATE symptom_rules SET version = version + 1, issue_type_id = $2, match = $3, state = 'live', updated_at = now()
                              WHERE id = $1 AND kind = 'map' AND state IN ('live', 'disabled') AND approved_by IS NOT NULL`, [ruleId, old.issue_type_id, safeJson(old.match)]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "only live or disabled rules can be rolled back");
    await history(c, ruleId, "rolled_back", adminId);
    await audit(c, { actorKind: "user", actorId: adminId, action: "rule.rollback", targetKind: "rule", targetId: ruleId, outcome: "succeeded", details: { toVersion: version } });
  });
}

/**
 * Regrouping: open unrecognized alerts whose latest event matches the new rule are folded into
 * the issue's alert on that cabinet, and closed as regrouped. Their events move with them.
 */
async function regroupOpen(c: pg.PoolClient, ruleId: string, issueTypeId: string, m: SymptomMatch): Promise<number> {
  const { where, params } = matchSql(m, 2);
  const found = (await c.query<{ id: string; cabinet_id: string; occurrences: number; first_seen: Date; last_seen: Date; last_event_id: string | null }>(
    `SELECT a.id, a.cabinet_id, a.occurrences, a.first_seen, a.last_seen, a.last_event_id FROM alerts a
       JOIN events e ON e.event_id = a.last_event_id
      WHERE a.issue_type_id IS NULL AND a.state <> 'resolved' AND a.last_seen > now() - make_interval(days => $1) AND ${where}
      ORDER BY a.last_seen LIMIT 1000`, [365, ...params])).rows;
  const issue = (await c.query<{ name: string; severity: string }>("SELECT name, severity FROM issue_types WHERE id = $1", [issueTypeId])).rows[0]!;
  for (const a of found) {
    const target = (await c.query<{ id: string }>(
      `INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, occurrences, first_seen, last_seen, rule_id, last_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (cabinet_id, signature) WHERE state <> 'resolved' DO UPDATE
         SET occurrences = alerts.occurrences + EXCLUDED.occurrences, first_seen = LEAST(alerts.first_seen, EXCLUDED.first_seen),
             last_seen = GREATEST(alerts.last_seen, EXCLUDED.last_seen)
       RETURNING id`,
      [a.cabinet_id, issueTypeId, issue.severity, `issue:${issueTypeId}`, issue.name, a.occurrences, a.first_seen, a.last_seen, ruleId, a.last_event_id])).rows[0]!;
    await c.query("UPDATE events SET alert_id = $2, matched_rule = $3 WHERE alert_id = $1", [a.id, target.id, ruleId]);
    await c.query(`UPDATE alerts SET state = 'resolved', resolved_at = now(), resolution = $2 WHERE id = $1`, [a.id, `Regrouped under ${issue.name}.`]);
  }
  return found.length;
}

// ---- Suppressions (docs/spec/05-server-spec.md "Protecting the rules") ---------------------

export const SUPPRESSION_DAYS = 90;

/** Admin only, with a written reason; live at once and expiring after 90 days unless renewed. */
export async function createSuppression(pool: pg.Pool, u: Actor, m: SymptomMatch, reason: string, stepUpToken: string) {
  if (u.role !== "admin") throw new Refused("forbidden", 403, "suppressions are Admin only");
  checkUserMatch(m);
  return transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, u.userId, "rule.suppress", "fleet");
    const r = (await c.query<{ id: string; expires_at: Date }>(
      `INSERT INTO symptom_rules (kind, state, match, proposed_by, approved_by, reason, expires_at)
       VALUES ('suppress', 'live', $1, $2, $2, $3, now() + make_interval(days => $4)) RETURNING id, expires_at`,
      [safeJson(m), u.userId, reason, SUPPRESSION_DAYS])).rows[0]!;
    await history(c, r.id, "created", u.userId);
    await audit(c, { actorKind: "user", actorId: u.userId, action: "rule.suppress", targetKind: "rule", targetId: r.id, outcome: "succeeded",
      details: { match: m, reason, expiresAt: r.expires_at.toISOString() } });
    return { ruleId: r.id, expiresAt: r.expires_at.toISOString() };
  });
}

export async function renewSuppression(pool: pg.Pool, adminId: string, ruleId: string, stepUpToken: string) {
  return transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "rule.renew", ruleId);
    const r = (await c.query<{ expires_at: Date }>(
      `UPDATE symptom_rules SET expires_at = now() + make_interval(days => $2), updated_at = now()
        WHERE id = $1 AND kind = 'suppress' AND state = 'live' RETURNING expires_at`, [ruleId, SUPPRESSION_DAYS])).rows[0];
    if (!r) throw new Refused("not_live", 409, "that suppression is not live");
    await history(c, ruleId, "renewed", adminId);
    await audit(c, { actorKind: "user", actorId: adminId, action: "rule.renew", targetKind: "rule", targetId: ruleId, outcome: "succeeded",
      details: { expiresAt: r.expires_at.toISOString() } });
    return { ruleId, expiresAt: r.expires_at.toISOString() };
  });
}

/** Marks live rules past their expiry as expired, with history and audit. The engine already ignores them from that moment. */
export async function expireRules(pool: pg.Pool): Promise<number> {
  return transaction(pool, async c => {
    const ids = (await c.query<{ id: string }>(
      "UPDATE symptom_rules SET state = 'expired', updated_at = now() WHERE state = 'live' AND expires_at IS NOT NULL AND expires_at <= now() RETURNING id")).rows;
    for (const { id } of ids) {
      await history(c, id, "expired", null);
      await audit(c, { actorKind: "system", actorId: "rule-expiry", action: "rule.expire", targetKind: "rule", targetId: id, outcome: "succeeded" });
    }
    return ids.length;
  });
}

/** Every live suppression, soonest to expire first, for the Admin screen. */
export async function listSuppressions(db: Queryable) {
  const rows = (await db.query<RuleRow>(`${RULE_SELECT} WHERE r.kind = 'suppress' AND r.state = 'live' ORDER BY r.expires_at NULLS LAST LIMIT 500`)).rows;
  return rows.map(ruleView);
}
