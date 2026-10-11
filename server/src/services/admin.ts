// Admin screens' data (docs/spec/06-console-spec.md "Admin screens"): clients and sites, cabinet
// roles, issue types, who is online, what each person did, and the searchable audit log.
// Every change needs a step-up token for that action and target, and is audited with it.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { audit, transaction, type Queryable } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { Refused } from "./errors.js";
import { writeStatus } from "./writes.js";

const ONLINE_MINUTES = 5;

// ---- Clients and sites ---------------------------------------------------------------------

export async function listClientsWithSites(db: Queryable) {
  const clients = (await db.query<{ id: string; name: string; write_paused: boolean; write_pause_reason: string | null }>(
    "SELECT id, name, write_paused, write_pause_reason FROM clients WHERE removed_at IS NULL ORDER BY name")).rows;
  const sites = (await db.query<{ id: string; client_id: string; name: string; cabinets: string; pending: string }>(
    `SELECT s.id, s.client_id, s.name, count(k.id) FILTER (WHERE k.status = 'active') AS cabinets, count(k.id) FILTER (WHERE k.status = 'pending') AS pending
       FROM sites s LEFT JOIN cabinets k ON k.site_id = s.id WHERE s.removed_at IS NULL GROUP BY s.id ORDER BY s.name`)).rows;
  return clients.map(c => ({
    id: c.id, name: c.name, writePaused: c.write_paused, writePauseReason: c.write_pause_reason,
    sites: sites.filter(s => s.client_id === c.id).map(s => ({ id: s.id, name: s.name, cabinets: Number(s.cabinets) + Number(s.pending) })),
  }));
}

const nameTaken = (e: unknown) => (e as { code?: string }).code === "23505";

export async function createClient(pool: pg.Pool, adminId: string, name: string, stepUpToken: string): Promise<string> {
  const id = randomUUID();
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "client.create", "fleet");
    await c.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [id, name]).catch(e => { throw nameTaken(e) ? new Refused("name_taken", 409, "a client with that name exists") : e; });
    await audit(c, { actorKind: "user", actorId: adminId, action: "client.create", targetKind: "client", targetId: id, outcome: "succeeded", details: { name } });
  });
  return id;
}

export async function renameClient(pool: pg.Pool, adminId: string, id: string, name: string, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "client.rename", id);
    const r = await c.query<{ before: string }>("UPDATE clients n SET name = $2 FROM clients o WHERE n.id = $1 AND o.id = n.id AND n.removed_at IS NULL RETURNING o.name AS before", [id, name])
      .catch(e => { throw nameTaken(e) ? new Refused("name_taken", 409, "a client with that name exists") : e; });
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such client");
    await audit(c, { actorKind: "user", actorId: adminId, action: "client.rename", targetKind: "client", targetId: id, outcome: "succeeded", details: { before: r.rows[0]!.before, name } });
  });
}

/** Allowed only when no active or pending cabinet is left; the client and its sites are kept, marked removed, with their history. */
export async function removeClient(pool: pg.Pool, adminId: string, id: string, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "client.remove", id);
    const busy = (await c.query(`SELECT 1 FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE s.client_id = $1 AND k.status IN ('active', 'pending') LIMIT 1`, [id])).rows[0];
    if (busy) throw new Refused("has_cabinets", 409, "move or remove its cabinets first");
    const r = await c.query<{ name: string }>("UPDATE clients SET removed_at = now(), write_paused = false WHERE id = $1 AND removed_at IS NULL RETURNING name", [id]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such client");
    await c.query("UPDATE sites SET removed_at = now() WHERE client_id = $1 AND removed_at IS NULL", [id]);
    await audit(c, { actorKind: "user", actorId: adminId, action: "client.remove", targetKind: "client", targetId: id, outcome: "succeeded", details: { name: r.rows[0]!.name } });
  });
}

export async function createSite(pool: pg.Pool, adminId: string, clientId: string, name: string, stepUpToken: string): Promise<string> {
  const id = randomUUID();
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "site.create", clientId);
    const client = (await c.query<{ demo: boolean }>("SELECT demo FROM clients WHERE id = $1 AND removed_at IS NULL", [clientId])).rows[0];
    if (client?.demo) throw new Refused("demo_client", 409, "simulated demo clients cannot be changed");
    if (!client) throw new Refused("not_found", 404, "no such client");
    await c.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [id, clientId, name])
      .catch(e => { throw nameTaken(e) ? new Refused("name_taken", 409, "that client already has a site with that name") : e; });
    await audit(c, { actorKind: "user", actorId: adminId, action: "site.create", targetKind: "site", targetId: id, outcome: "succeeded", details: { clientId, name } });
  });
  return id;
}

export async function renameSite(pool: pg.Pool, adminId: string, id: string, name: string, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "site.rename", id);
    const r = await c.query<{ before: string }>("UPDATE sites n SET name = $2 FROM sites o WHERE n.id = $1 AND o.id = n.id AND n.removed_at IS NULL RETURNING o.name AS before", [id, name])
      .catch(e => { throw nameTaken(e) ? new Refused("name_taken", 409, "that client already has a site with that name") : e; });
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such site");
    await audit(c, { actorKind: "user", actorId: adminId, action: "site.rename", targetKind: "site", targetId: id, outcome: "succeeded", details: { before: r.rows[0]!.before, name } });
  });
}

export async function removeSite(pool: pg.Pool, adminId: string, id: string, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "site.remove", id);
    const busy = (await c.query("SELECT 1 FROM cabinets WHERE site_id = $1 AND status IN ('active', 'pending') LIMIT 1", [id])).rows[0];
    if (busy) throw new Refused("has_cabinets", 409, "move or remove its cabinets first");
    const r = await c.query<{ name: string }>("UPDATE sites SET removed_at = now() WHERE id = $1 AND removed_at IS NULL RETURNING name", [id]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such site");
    await audit(c, { actorKind: "user", actorId: adminId, action: "site.remove", targetKind: "site", targetId: id, outcome: "succeeded", details: { name: r.rows[0]!.name } });
  });
}

export async function setCabinetRole(pool: pg.Pool, adminId: string, id: string, role: string, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "cabinet.role", id);
    const r = await c.query<{ before: string }>(
      "UPDATE cabinets n SET role = $2 FROM cabinets o WHERE n.id = $1 AND o.id = n.id AND n.status = 'active' RETURNING o.role AS before", [id, role]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such active cabinet");
    await audit(c, { actorKind: "user", actorId: adminId, action: "cabinet.role", targetKind: "cabinet", targetId: id, outcome: "succeeded", details: { before: r.rows[0]!.before, role } });
  });
}

// ---- Issue types ---------------------------------------------------------------------------

export interface IssueTypeInput { name: string; severity: "major" | "minor"; description: string; }

export async function createIssueType(pool: pg.Pool, adminId: string, t: IssueTypeInput, stepUpToken: string): Promise<string> {
  return transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "issue_type.create", "fleet");
    const r = await c.query<{ id: string }>("INSERT INTO issue_types (name, severity, description, created_by) VALUES ($1, $2, $3, $4) RETURNING id",
      [t.name, t.severity, t.description, adminId]).catch(e => { throw nameTaken(e) ? new Refused("name_taken", 409, "an issue type with that name exists") : e; });
    const id = r.rows[0]!.id;
    await audit(c, { actorKind: "user", actorId: adminId, action: "issue_type.create", targetKind: "issue_type", targetId: id, outcome: "succeeded", details: { ...t } });
    return id;
  });
}

/** Built-in issue types can be renamed and re-described, and their severity changed; the engine still finds them by their fixed key. */
export async function updateIssueType(pool: pg.Pool, adminId: string, id: string, t: IssueTypeInput, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "issue_type.update", id);
    const before = (await c.query<IssueTypeInput>("SELECT name, severity, description FROM issue_types WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!before) throw new Refused("not_found", 404, "no such issue type");
    await c.query("UPDATE issue_types SET name = $2, severity = $3, description = $4 WHERE id = $1", [id, t.name, t.severity, t.description])
      .catch(e => { throw nameTaken(e) ? new Refused("name_taken", 409, "an issue type with that name exists") : e; });
    await audit(c, { actorKind: "user", actorId: adminId, action: "issue_type.update", targetKind: "issue_type", targetId: id, outcome: "succeeded", details: { before, after: t } });
  });
}

// ---- Presence, activity and the audit log --------------------------------------------------

/** Who is signed in now: an active session with activity in the last 5 minutes (docs/spec/05-server-spec.md "Presence"). */
export async function onlineUsers(db: Queryable) {
  const rows = (await db.query<{ id: string; name: string; username: string; role: string; last_activity: Date; address: string | null;
    cabinet_id: string | null; cabinet_name: string | null }>(
    `SELECT DISTINCT ON (u.id) u.id, u.name, u.username, u.role, s.last_activity_at AS last_activity, s.address, k.id AS cabinet_id, k.name AS cabinet_name
       FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN cabinets k ON k.id = s.current_cabinet
      WHERE s.stage = 'complete' AND s.expires_at > now() AND u.status = 'active' AND s.last_activity_at > now() - make_interval(mins => $1)
      ORDER BY u.id, s.last_activity_at DESC`, [ONLINE_MINUTES])).rows;
  return rows.sort((a, b) => b.last_activity.getTime() - a.last_activity.getTime()).map(r => ({
    id: r.id, name: r.name, username: r.username, role: r.role, lastActivityAt: r.last_activity.toISOString(), address: r.address,
    cabinet: r.cabinet_id ? { id: r.cabinet_id, name: r.cabinet_name } : null,
  }));
}

export interface AuditFilter { user?: string; cabinet?: string; action?: string; from?: string; to?: string; before?: string; limit?: string; }

/** Turns the query string's dates into times: a bare date means the whole of that UTC day. */
function range(from?: string, to?: string): [Date | null, Date | null] {
  const day = (d: string, end: boolean) => d.length === 10 ? new Date(`${d}T${end ? "23:59:59.999" : "00:00:00.000"}Z`) : new Date(d);
  const f = from ? day(from, false) : null;
  const t = to ? day(to, true) : null;
  if ((f && Number.isNaN(f.getTime())) || (t && Number.isNaN(t.getTime()))) throw new Refused("invalid_request", 400, "not a date");
  return [f, t];
}

/**
 * The audit log, newest first, by person, cabinet (as the target, or named in the details of a command),
 * action and date range, with names resolved. An action ending in "." matches every action under it.
 */
export async function searchAudit(db: Queryable, f: AuditFilter) {
  const [from, to] = range(f.from, f.to);
  const limit = Math.min(Number(f.limit ?? 100), 500);
  const action = f.action ?? null;
  const rows = (await db.query<{ seq: string; at: Date; actor_kind: string; actor_id: string; actor_name: string | null; actor_username: string | null; action: string;
    target_kind: string | null; target_id: string | null; target_name: string | null; outcome: string; details: Record<string, unknown> }>(
    `SELECT a.seq, a.at, a.actor_kind, a.actor_id, u.name AS actor_name, u.username AS actor_username, a.action, a.target_kind, a.target_id,
            coalesce(k.name, tu.name, s.name, cl.name) AS target_name, a.outcome, a.details
       FROM audit_log a
       LEFT JOIN users u ON a.actor_kind = 'user' AND u.id::text = a.actor_id
       LEFT JOIN cabinets k ON a.target_kind = 'cabinet' AND k.id::text = a.target_id
       LEFT JOIN users tu ON a.target_kind = 'user' AND tu.id::text = a.target_id
       LEFT JOIN sites s ON a.target_kind = 'site' AND s.id::text = a.target_id
       LEFT JOIN clients cl ON a.target_kind = 'client' AND cl.id::text = a.target_id
      WHERE ($1::text IS NULL OR a.actor_id = $1)
        AND ($2::text IS NULL OR a.target_id = $2 OR (a.actor_kind = 'agent' AND a.actor_id = $2))
        AND ($3::text IS NULL OR a.action = $3 OR (right($3, 1) = '.' AND starts_with(a.action, $3)))
        AND ($4::timestamptz IS NULL OR a.at >= $4) AND ($5::timestamptz IS NULL OR a.at <= $5)
        AND ($6::bigint IS NULL OR a.seq < $6)
      ORDER BY a.seq DESC LIMIT $7`,
    [f.user ?? null, f.cabinet ?? null, action, from, to, f.before ? Number(f.before) : null, limit])).rows;
  return rows.map(r => ({
    seq: Number(r.seq), at: r.at.toISOString(), actor: { kind: r.actor_kind, id: r.actor_id, name: r.actor_name ?? (r.actor_kind === "user" ? null : r.actor_id), username: r.actor_username },
    action: r.action, target: r.target_kind ? { kind: r.target_kind, id: r.target_id, name: r.target_name } : null, outcome: r.outcome, details: r.details,
  }));
}

/** One person's activity: the cabinets they opened (most recent first, with how often) and everything they did. */
export async function userActivity(db: Queryable, userId: string, f: AuditFilter) {
  const user = (await db.query<{ id: string; name: string; username: string; role: string; status: string; last_login_at: Date | null }>(
    "SELECT id, name, username, role, status, last_login_at FROM users WHERE id = $1", [userId])).rows[0];
  if (!user) throw new Refused("not_found", 404, "no such user");
  const [from, to] = range(f.from, f.to);
  const cabinets = (await db.query<{ id: string; name: string; views: string; last_viewed: Date }>(
    `SELECT k.id, k.name, count(*) AS views, max(a.at) AS last_viewed
       FROM audit_log a JOIN cabinets k ON k.id::text = a.target_id
      WHERE a.actor_kind = 'user' AND a.actor_id = $1 AND a.action = 'cabinet.view'
        AND ($2::timestamptz IS NULL OR a.at >= $2) AND ($3::timestamptz IS NULL OR a.at <= $3)
      GROUP BY k.id, k.name ORDER BY max(a.at) DESC LIMIT 200`, [userId, from, to])).rows;
  return {
    user: { id: user.id, name: user.name, username: user.username, role: user.role, status: user.status, lastLoginAt: user.last_login_at?.toISOString() ?? null },
    cabinetsViewed: cabinets.map(k => ({ id: k.id, name: k.name, views: Number(k.views), lastViewedAt: k.last_viewed.toISOString() })),
    actions: await searchAudit(db, { ...f, user: userId }),
  };
}

// ---- Fleet safety --------------------------------------------------------------------------

/** The fleet and client write pauses, every client (to pause one), and the people whose writes their limit paused. */
export async function fleetSafety(db: Queryable) {
  const status = await writeStatus(db);
  const clients = (await db.query<{ id: string; name: string; write_paused: boolean; write_pause_reason: string | null }>(
    "SELECT id, name, write_paused, write_pause_reason FROM clients WHERE removed_at IS NULL ORDER BY name")).rows;
  const users = (await db.query<{ id: string; name: string; username: string; reason: string | null; write_limit: number }>(
    "SELECT id, name, username, writes_paused_reason AS reason, write_limit FROM users WHERE writes_paused AND status = 'active' ORDER BY name")).rows;
  return {
    fleet: status.fleet,
    clients: clients.map(c => ({ id: c.id, name: c.name, paused: c.write_paused, reason: c.write_pause_reason })),
    pausedUsers: users.map(u => ({ id: u.id, name: u.name, username: u.username, reason: u.reason, writeLimit: u.write_limit })),
  };
}
