// Account management (docs/spec/05-server-spec.md "Accounts", docs/spec/06-console-spec.md "Users").
// Every change needs a step-up token for that action on that account and is audited with it.
// Resetting a password or authenticator, disabling, deleting or changing a role ends every one of
// that person's sessions at once. The last active Admin can never be disabled, deleted or demoted,
// and nobody becomes Tier 2 or Admin without an authenticator.
import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { audit, transaction, type Queryable } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { endAllSessions } from "../auth/sessions.js";
import { hashPassword } from "../auth/passwords.js";
import { Refused } from "./errors.js";

export type Role = "tier1" | "tier2" | "admin";
const ONLINE_MINUTES = 5;

/** Accounts, with the deleted ones too when an Admin asks for them (to reactivate one). */
export async function listUsers(db: Queryable, includeDeleted = false) {
  const rows = (await db.query<{ id: string; username: string; name: string; role: Role; status: string; totp_enabled: boolean; write_limit: number; can_approve_fixes: boolean;
    writes_paused: boolean; writes_paused_reason: string | null; last_login_at: Date | null; created_at: Date; locked: boolean; online: boolean }>(
    `SELECT u.id, u.username, u.name, u.role, u.status, u.totp_enabled, u.write_limit, u.can_approve_fixes, u.writes_paused, u.writes_paused_reason, u.last_login_at, u.created_at,
            (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
            EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.stage = 'complete' AND s.expires_at > now()
                      AND s.last_activity_at > now() - make_interval(mins => $1)) AS online
       FROM users u WHERE ($2::boolean OR u.status <> 'deleted') ORDER BY (u.status = 'deleted'), u.name`, [ONLINE_MINUTES, includeDeleted])).rows;
  return rows.map(r => ({
    id: r.id, username: r.username, name: r.name, role: r.role, status: r.status, totpEnabled: r.totp_enabled, writeLimit: r.write_limit, canApproveFixes: r.can_approve_fixes,
    writesPaused: r.writes_paused, writesPausedReason: r.writes_paused_reason, lastLoginAt: r.last_login_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(), locked: r.locked, online: r.online,
  }));
}

const temporaryPassword = () => randomBytes(12).toString("base64url");

interface Target { id: string; username: string; role: Role; status: string; totp_enabled: boolean; }

async function target(c: Queryable, id: string): Promise<Target> {
  await c.query("SELECT pg_advisory_xact_lock(hashtext('cabinet-diagnostics.accounts'))");
  const t = (await c.query<Target>("SELECT id, username, role, status, totp_enabled FROM users WHERE id = $1 AND status <> 'deleted' FOR UPDATE", [id])).rows[0];
  if (!t) throw new Refused("not_found", 404, "no such user");
  return t;
}

/**
 * Refuses a change that would leave no active Admin. Changes to accounts are serialized (adminLock), so two Admins
 * demoting each other at the same moment cannot both see the other as the one remaining.
 */
async function keepAnAdmin(c: Queryable, t: Target, stillAdmin: boolean): Promise<void> {
  if (t.role !== "admin" || t.status !== "active" || stillAdmin) return;
  const others = Number((await c.query<{ n: string }>("SELECT count(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id <> $1", [t.id])).rows[0]!.n);
  if (others === 0) throw new Refused("last_admin", 409, "this is the last active Admin account");
}

export async function createUser(pool: pg.Pool, adminId: string, u: { username: string; name: string; role: Role; writeLimit?: number }, stepUpToken: string) {
  const temporary = temporaryPassword();
  const hash = await hashPassword(temporary);
  const id = randomUUID();
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "user.create", "fleet");
    const taken = (await c.query<{ id: string; status: string }>("SELECT id, status FROM users WHERE username = $1", [u.username])).rows[0];
    // A deleted account keeps its row (its history stays in the audit log), so its username is not free: it can be reactivated instead.
    if (taken?.status === "deleted") throw new Refused("username_deleted", 409, "that username belonged to an account that was deleted; reactivate it instead", { userId: taken.id });
    if (taken) throw new Refused("username_taken", 409, "that username is already used");
    // Tier 2 and Admin accounts set up their authenticator at first sign-in, before anything else (nextStage).
    await c.query("INSERT INTO users (id, username, name, role, password_hash, must_change_password, write_limit) VALUES ($1, $2, $3, $4, $5, true, $6)",
      [id, u.username, u.name, u.role, hash, u.writeLimit ?? 20]);
    await audit(c, { actorKind: "user", actorId: adminId, action: "user.create", targetKind: "user", targetId: id, outcome: "succeeded",
      details: { username: u.username, role: u.role, writeLimit: u.writeLimit ?? 20 } });
  });
  return { id, temporaryPassword: temporary };
}

export async function updateUser(pool: pg.Pool, adminId: string, id: string, change: { role?: Role; writeLimit?: number; status?: "active" | "disabled"; canApproveFixes?: boolean },
  stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "user.update", id);
    const t = await target(c, id);
    if (id === adminId && (change.status === "disabled" || (change.role && change.role !== t.role)))
      throw new Refused("not_yourself", 409, "ask another Admin to change your own role or disable your account");
    if (change.role && change.role !== "tier1" && !t.totp_enabled)
      throw new Refused("totp_required", 409, "this person must set up an authenticator before becoming Tier 2 or Admin");
    await keepAnAdmin(c, t, (change.role ?? t.role) === "admin" && (change.status ?? t.status) === "active");
    await c.query(`UPDATE users SET role = coalesce($2, role), write_limit = coalesce($3, write_limit), status = coalesce($4, status), can_approve_fixes = coalesce($5, can_approve_fixes) WHERE id = $1`,
      [id, change.role ?? null, change.writeLimit ?? null, change.status ?? null, change.canApproveFixes ?? null]);
    // A new role or a disabled account takes effect at once: their sessions end.
    if ((change.role && change.role !== t.role) || (change.status && change.status !== t.status)) await endAllSessions(c, id);
    await audit(c, { actorKind: "user", actorId: adminId, action: "user.update", targetKind: "user", targetId: id, outcome: "succeeded",
      details: { username: t.username, before: { role: t.role, status: t.status }, change } });
  });
}

export async function deleteUser(pool: pg.Pool, adminId: string, id: string, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "user.delete", id);
    const t = await target(c, id);
    if (id === adminId) throw new Refused("not_yourself", 409, "ask another Admin to delete your account");
    await keepAnAdmin(c, t, false);
    // The account's history stays (commands, audit entries); it can never sign in again.
    await c.query(`UPDATE users SET status = 'deleted', password_hash = NULL, totp_secret_enc = NULL, totp_enabled = false WHERE id = $1`, [id]);
    await endAllSessions(c, id);
    await audit(c, { actorKind: "user", actorId: adminId, action: "user.delete", targetKind: "user", targetId: id, outcome: "succeeded", details: { username: t.username } });
  });
}

/**
 * Brings a deleted account back: active again with a new temporary password, no authenticator (set up fresh at the first
 * sign-in), no old sessions. Needs a written reason, which goes into the audit log with who it was and what it was before.
 */
export async function reactivateUser(pool: pg.Pool, adminId: string, id: string, reason: string, stepUpToken: string): Promise<{ temporaryPassword: string }> {
  const temporary = temporaryPassword();
  const hash = await hashPassword(temporary);
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "user.reactivate", id);
    await c.query("SELECT pg_advisory_xact_lock(hashtext('cabinet-diagnostics.accounts'))");
    const t = (await c.query<Target>("SELECT id, username, role, status, totp_enabled FROM users WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!t) throw new Refused("not_found", 404, "no such user");
    if (t.status !== "deleted") throw new Refused("not_deleted", 409, "only a deleted account can be reactivated");
    await c.query(`UPDATE users SET status = 'active', password_hash = $2, must_change_password = true, totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL,
                          failed_logins = 0, locked_until = NULL, writes_paused = false, writes_paused_reason = NULL WHERE id = $1`, [id, hash]);
    await endAllSessions(c, id);
    await audit(c, { actorKind: "user", actorId: adminId, action: "user.reactivate", targetKind: "user", targetId: id, outcome: "succeeded",
      details: { username: t.username, role: t.role, reason } });
  });
  return { temporaryPassword: temporary };
}

export async function resetPassword(pool: pg.Pool, adminId: string, id: string, stepUpToken: string): Promise<{ temporaryPassword: string }> {
  const temporary = temporaryPassword();
  const hash = await hashPassword(temporary);
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "user.password.reset", id);
    const t = await target(c, id);
    await c.query("UPDATE users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL WHERE id = $1", [id, hash]);
    await endAllSessions(c, id);
    await audit(c, { actorKind: "user", actorId: adminId, action: "user.password.reset", targetKind: "user", targetId: id, outcome: "succeeded", details: { username: t.username } });
  });
  return { temporaryPassword: temporary };
}

/** Removes the person's authenticator; they set up a new one at their next sign-in (required for Tier 2 and Admin). */
export async function resetTotp(pool: pg.Pool, adminId: string, id: string, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "user.totp.reset", id);
    const t = await target(c, id);
    await c.query("UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL, failed_logins = 0, locked_until = NULL WHERE id = $1", [id]);
    await endAllSessions(c, id);
    await audit(c, { actorKind: "user", actorId: adminId, action: "user.totp.reset", targetKind: "user", targetId: id, outcome: "succeeded", details: { username: t.username } });
  });
}

export async function resumeUserWrites(pool: pg.Pool, adminId: string, id: string, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "user.resume_writes", id);
    const t = await target(c, id);
    const r = await c.query("UPDATE users SET writes_paused = false, writes_paused_reason = NULL WHERE id = $1 AND writes_paused", [id]);
    if (r.rowCount !== 1) throw new Refused("not_paused", 409, "this person's writes are not paused");
    await audit(c, { actorKind: "user", actorId: adminId, action: "writes.user_resumed", targetKind: "user", targetId: id, outcome: "succeeded", details: { username: t.username } });
  });
}
