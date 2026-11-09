// Admin screens' data (docs/spec/06-console-spec.md "Admin screens"): clients and sites, cabinet
// roles, issue types, who is online, what each person did, and the searchable audit log.
// Every change needs a step-up token for that action and target, and is audited with it.
import { randomUUID } from "node:crypto";
import { audit, isUniqueViolation, transaction, type Pool, type Queryable } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { Refused } from "./errors.js";
import { linkUnassigned, reportedAddress } from "./sync-cabinets.js";
import { writeStatus } from "./writes.js";
import { addIssueType, editIssueType, type IssueTypeInput } from "./rules.js";

const ONLINE_MINUTES = 5;

// ---- Clients and sites ---------------------------------------------------------------------

export async function listClientsWithSites(db: Queryable) {
  const clients = (await db.query<{ id: string; name: string; write_paused: boolean; write_pause_reason: string | null }>(
    "SELECT id, name, write_paused, write_pause_reason FROM clients WHERE removed_at IS NULL ORDER BY name")).rows;
  const sites = (await db.query<{ id: string; client_id: string; name: string; cabinets: string; pending: string }>(
    `SELECT s.id, s.client_id, s.name, SUM(CASE WHEN k.status = 'active' THEN 1 ELSE 0 END) AS cabinets, SUM(CASE WHEN k.status = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM sites s LEFT JOIN cabinets k ON k.site_id = s.id WHERE s.removed_at IS NULL GROUP BY s.id, s.client_id, s.name ORDER BY s.name`)).rows;
  return clients.map(c => ({
    id: c.id, name: c.name, writePaused: c.write_paused, writePauseReason: c.write_pause_reason,
    sites: sites.filter(s => s.client_id === c.id).map(s => ({ id: s.id, name: s.name, cabinets: Number(s.cabinets) + Number(s.pending) })),
  }));
}

const nameTaken = isUniqueViolation;

export async function createClient(pool: Pool, adminId: string, name: string, stepUpToken: string): Promise<string> {
  const id = randomUUID();
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "client.create", "fleet");
    await c.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [id, name]).catch(e => { throw nameTaken(e) ? new Refused("name_taken", 409, "a client with that name exists") : e; });
    await audit(c, { actorKind: "user", actorId: adminId, action: "client.create", targetKind: "client", targetId: id, outcome: "succeeded", details: { name } });
  });
  return id;
}

export async function renameClient(pool: Pool, adminId: string, id: string, name: string, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "client.rename", id);
    const r = await c.query<{ old_name: string }>("UPDATE clients SET name = $2 OUTPUT deleted.name AS old_name WHERE id = $1 AND removed_at IS NULL", [id, name])
      .catch(e => { throw nameTaken(e) ? new Refused("name_taken", 409, "a client with that name exists") : e; });
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such client");
    await audit(c, { actorKind: "user", actorId: adminId, action: "client.rename", targetKind: "client", targetId: id, outcome: "succeeded", details: { before: r.rows[0]!.old_name, name } });
  });
}

/** Allowed only when no active or pending cabinet is left; the client and its sites are kept, marked removed, with their history. */
export async function removeClient(pool: Pool, adminId: string, id: string, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "client.remove", id);
    const busy = (await c.query(`SELECT TOP (1) 1 AS busy FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE s.client_id = $1 AND k.status IN ('active', 'pending')`, [id])).rows[0];
    if (busy) throw new Refused("has_cabinets", 409, "move or remove its cabinets first");
    const r = await c.query<{ name: string }>("UPDATE clients SET removed_at = SYSUTCDATETIME(), write_paused = 0 OUTPUT inserted.name WHERE id = $1 AND removed_at IS NULL", [id]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such client");
    await c.query("UPDATE sites SET removed_at = SYSUTCDATETIME() WHERE client_id = $1 AND removed_at IS NULL", [id]);
    await audit(c, { actorKind: "user", actorId: adminId, action: "client.remove", targetKind: "client", targetId: id, outcome: "succeeded", details: { name: r.rows[0]!.name } });
  });
}

export async function createSite(pool: Pool, adminId: string, clientId: string, name: string, stepUpToken: string): Promise<string> {
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

export async function renameSite(pool: Pool, adminId: string, id: string, name: string, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "site.rename", id);
    const r = await c.query<{ old_name: string }>("UPDATE sites SET name = $2 OUTPUT deleted.name AS old_name WHERE id = $1 AND removed_at IS NULL", [id, name])
      .catch(e => { throw nameTaken(e) ? new Refused("name_taken", 409, "that client already has a site with that name") : e; });
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such site");
    await audit(c, { actorKind: "user", actorId: adminId, action: "site.rename", targetKind: "site", targetId: id, outcome: "succeeded", details: { before: r.rows[0]!.old_name, name } });
  });
}

export async function removeSite(pool: Pool, adminId: string, id: string, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "site.remove", id);
    const busy = (await c.query("SELECT TOP (1) 1 AS busy FROM cabinets WHERE site_id = $1 AND status IN ('active', 'pending')", [id])).rows[0];
    if (busy) throw new Refused("has_cabinets", 409, "move or remove its cabinets first");
    const r = await c.query<{ name: string }>("UPDATE sites SET removed_at = SYSUTCDATETIME() OUTPUT inserted.name WHERE id = $1 AND removed_at IS NULL", [id]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such site");
    await audit(c, { actorKind: "user", actorId: adminId, action: "site.remove", targetKind: "site", targetId: id, outcome: "succeeded", details: { name: r.rows[0]!.name } });
  });
}

/**
 * Changes a cabinet's role. The site's sync arrangement follows in the same transaction: a cabinet that stops being a satellite drops its
 * link; one that stops being a sync cabinet drops its address, and its satellites read as incomplete unless the site now has exactly one
 * sync cabinet, which takes them in. A new sync cabinet starts from the address it last reported.
 */
export async function setCabinetRole(pool: Pool, adminId: string, id: string, role: string, stepUpToken: string): Promise<void> {
  const reported = role === "sync" ? await reportedAddress(pool, id) : null;
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "cabinet.role", id);
    const r = await c.query<{ old_role: string; site_id: string }>(
      `UPDATE cabinets SET role = $2,
              sync_cabinet_id = CASE WHEN $2 = 'satellite' THEN sync_cabinet_id ELSE NULL END,
              sync_address = CASE WHEN $2 = 'sync' AND role = 'sync' THEN sync_address WHEN $2 = 'sync' THEN $3 ELSE NULL END,
              sync_address_source = CASE WHEN $2 = 'sync' AND role = 'sync' THEN sync_address_source WHEN $2 = 'sync' AND $3 IS NOT NULL THEN 'reported' ELSE NULL END
       OUTPUT deleted.role AS old_role, inserted.site_id WHERE id = $1 AND status = 'active'`, [id, role, reported]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such active cabinet");
    const linked = await linkUnassigned(c, r.rows[0]!.site_id);
    await audit(c, { actorKind: "user", actorId: adminId, action: "cabinet.role", targetKind: "cabinet", targetId: id, outcome: "succeeded",
      details: { before: r.rows[0]!.old_role, role, satellitesLinked: linked } });
  });
}

// ---- Issue types ---------------------------------------------------------------------------

/** The input of an issue type, as rules.ts (its owner) checks and writes it. */
export type { IssueTypeInput } from "./rules.js";

export async function createIssueType(pool: Pool, adminId: string, t: IssueTypeInput, stepUpToken: string): Promise<string> {
  return transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "issue_type.create", "fleet");
    return addIssueType(c, adminId, t);
  });
}

/** Built-in issue types can be renamed and re-described, and their severity changed; the engine still finds them by their fixed key. */
export async function updateIssueType(pool: Pool, adminId: string, id: string, t: IssueTypeInput, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "issue_type.update", id);
    await editIssueType(c, adminId, id, t);
  });
}

// ---- Presence, activity and the audit log --------------------------------------------------

/** Who is signed in now: an active session with activity in the last 5 minutes (docs/spec/05-server-spec.md "Presence"). */
export async function onlineUsers(db: Queryable) {
  const rows = (await db.query<{ id: string; name: string; username: string; role: string; last_activity: Date; address: string | null;
    cabinet_id: string | null; cabinet_name: string | null }>(
    `SELECT id, name, username, role, last_activity, address, cabinet_id, cabinet_name FROM (
       SELECT u.id, u.name, u.username, u.role, s.last_activity_at AS last_activity, s.address, k.id AS cabinet_id, k.name AS cabinet_name,
              ROW_NUMBER() OVER (PARTITION BY u.id ORDER BY s.last_activity_at DESC) AS rn
         FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN cabinets k ON k.id = s.current_cabinet
        WHERE s.stage = 'complete' AND s.expires_at > SYSUTCDATETIME() AND u.status = 'active' AND s.last_activity_at > DATEADD(minute, -$1, SYSUTCDATETIME())) x
      WHERE rn = 1`, [ONLINE_MINUTES])).rows;
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
  const limit = Math.min(Math.max(Math.trunc(Number(f.limit ?? 100)), 1), 500);
  const before = f.before ? Number(f.before) : null;
  if (!Number.isFinite(limit) || (before !== null && !Number.isSafeInteger(before))) throw new Refused("invalid_request", 400, "not a number");
  const action = f.action ?? null;
  const rows = (await db.query<{ seq: string; at: Date; actor_kind: string; actor_id: string; actor_name: string | null; actor_username: string | null; action: string;
    target_kind: string | null; target_id: string | null; target_name: string | null; outcome: string; details: Record<string, unknown> }>(
    // Ids in the log are text (an actor can also be "console" or an agent's name), so the joins convert the log's text to a GUID, which is NULL when it is none.
    `SELECT TOP ($7) a.seq, a.[at], a.actor_kind, a.actor_id, u.name AS actor_name, u.username AS actor_username, a.action, a.target_kind, a.target_id,
            COALESCE(k.name, tu.name, s.name, cl.name) AS target_name, a.outcome, a.details
       FROM audit_log a
       LEFT JOIN users u ON a.actor_kind = 'user' AND u.id = TRY_CAST(a.actor_id AS uniqueidentifier)
       LEFT JOIN cabinets k ON a.target_kind = 'cabinet' AND k.id = TRY_CAST(a.target_id AS uniqueidentifier)
       LEFT JOIN users tu ON a.target_kind = 'user' AND tu.id = TRY_CAST(a.target_id AS uniqueidentifier)
       LEFT JOIN sites s ON a.target_kind = 'site' AND s.id = TRY_CAST(a.target_id AS uniqueidentifier)
       LEFT JOIN clients cl ON a.target_kind = 'client' AND cl.id = TRY_CAST(a.target_id AS uniqueidentifier)
      WHERE ($1 IS NULL OR a.actor_id = $1)
        AND ($2 IS NULL OR a.target_id = $2 OR (a.actor_kind = 'agent' AND a.actor_id = $2))
        AND ($3 IS NULL OR a.action = $3 OR (RIGHT($3, 1) = '.' AND LEFT(a.action, LEN($3)) = $3))
        AND ($4 IS NULL OR a.[at] >= $4) AND ($5 IS NULL OR a.[at] <= $5)
        AND ($6 IS NULL OR a.seq < $6)
      ORDER BY a.seq DESC`,
    [f.user ?? null, f.cabinet ?? null, action, from, to, before, limit])).rows;
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
    `SELECT TOP (200) k.id, k.name, COUNT(*) AS views, MAX(a.[at]) AS last_viewed
       FROM audit_log a JOIN cabinets k ON k.id = TRY_CAST(a.target_id AS uniqueidentifier)
      WHERE a.actor_kind = 'user' AND a.actor_id = $1 AND a.action = 'cabinet.view'
        AND ($2 IS NULL OR a.[at] >= $2) AND ($3 IS NULL OR a.[at] <= $3)
      GROUP BY k.id, k.name ORDER BY MAX(a.[at]) DESC`, [userId, from, to])).rows;
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
    "SELECT id, name, username, writes_paused_reason AS reason, write_limit FROM users WHERE writes_paused = 1 AND status = 'active' ORDER BY name")).rows;
  return {
    fleet: status.fleet,
    clients: clients.map(c => ({ id: c.id, name: c.name, paused: c.write_paused, reason: c.write_pause_reason })),
    pausedUsers: users.map(u => ({ id: u.id, name: u.name, username: u.username, reason: u.reason, writeLimit: u.write_limit })),
  };
}
