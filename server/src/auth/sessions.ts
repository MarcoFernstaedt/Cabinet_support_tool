// Server-side sessions: the cookie holds a random ID, the database holds its hash
// (docs/spec/02-security-model.md control 6).
import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../db/db.js";
import { forgetTrustedDevices } from "./devices.js";

export type Stage = "totp" | "totp_setup" | "password_change" | "complete";
export { SESSION_COOKIE as COOKIE } from "./cookies.js";

export interface SessionPolicy { idleMinutes: number; absoluteHours: number; }
export const DEFAULT_POLICY: SessionPolicy = { idleMinutes: 30, absoluteHours: 12 };

export interface SessionUser {
  sessionHash: Buffer; stage: Stage; userId: string; username: string; name: string; role: "tier1" | "tier2" | "admin";
  totpEnabled: boolean; mustChangePassword: boolean; tourCompleted: boolean; canApproveFixes: boolean;
}

export const hashId = (id: string): Buffer => createHash("sha256").update(id, "utf8").digest();

export async function createSession(db: Queryable, userId: string, stage: Stage, address: string, policy = DEFAULT_POLICY, signInId: number | null = null): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO sessions (id_hash, user_id, stage, expires_at, address, sign_in_id) VALUES ($1, $2, $3, DATEADD(second, $4, SYSUTCDATETIME()), $5, $6)`,
    [hashId(id), userId, stage, Math.round(policy.absoluteHours * 3600), address, signInId]);
  if (stage === "complete") await markSignInCompleted(db, hashId(id));
  return id;
}

/** A sign-in is complete once its session has passed every stage (password, authenticator, any setup). */
const markSignInCompleted = (db: Queryable, sessionHash: Buffer) =>
  db.query("UPDATE sign_ins SET completed = 1 WHERE id = (SELECT sign_in_id FROM sessions WHERE id_hash = $1)", [sessionHash]);

/**
 * The session and its user, if the session is live. A person's own request touches it, extending the idle
 * window; background checks (the live stream's re-check, polling a badge) pass touch = false, so an unattended
 * console still times out and presence shows real activity.
 */
export async function loadSession(db: Queryable, id: string | undefined, policy = DEFAULT_POLICY, touch = true): Promise<SessionUser | null> {
  if (!id || id.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const live = `s.id_hash = $1 AND u.id = s.user_id AND u.status = 'active'
        AND s.expires_at > SYSUTCDATETIME() AND s.last_activity_at > DATEADD(second, -$2, SYSUTCDATETIME())`;
  const columns = (touch ? "inserted.stage" : "s.stage") + ", u.id AS user_id, u.username, u.name, u.role, u.totp_enabled, u.must_change_password, u.tour_completed, u.can_approve_fixes";
  const row = (await db.query<{ stage: Stage; user_id: string; username: string; name: string; role: SessionUser["role"]; totp_enabled: boolean;
    must_change_password: boolean; tour_completed: boolean; can_approve_fixes: boolean }>(
    // The UPDATE reads the user's columns through OUTPUT (sessions has no trigger, so OUTPUT without INTO is allowed).
    touch ? `UPDATE s SET last_activity_at = SYSUTCDATETIME() OUTPUT ${columns} FROM sessions s, users u WHERE ${live}`
          : `SELECT ${columns} FROM sessions s, users u WHERE ${live}`,
    [hashId(id), Math.round(policy.idleMinutes * 60)])).rows[0];
  if (!row) return null;
  return { sessionHash: hashId(id), stage: row.stage, userId: row.user_id, username: row.username, name: row.name, role: row.role,
    totpEnabled: row.totp_enabled, mustChangePassword: row.must_change_password, tourCompleted: row.tour_completed, canApproveFixes: row.role === "admin" || (row.role === "tier2" && row.can_approve_fixes) };
}

export async function setStage(db: Queryable, sessionHash: Buffer, stage: Stage): Promise<void> {
  await db.query("UPDATE sessions SET stage = $2 WHERE id_hash = $1", [sessionHash, stage]);
  if (stage === "complete") await markSignInCompleted(db, sessionHash);
}

export const endSession = (db: Queryable, sessionHash: Buffer) => db.query("DELETE FROM sessions WHERE id_hash = $1", [sessionHash]);

/** Ends every session of a user: after a password or authenticator reset, or disabling the account. */
/** Ends every session of the account and forgets the browsers it was trusted on: each must pass the full sign-in again. */
export const endAllSessions = async (db: Queryable, userId: string) => {
  await forgetTrustedDevices(db, userId);
  return db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
};

/** The next stage a signed-in user must pass before using the console. An Admin setting can require an authenticator for every account. */
/** Every account, of every role, needs an authenticator at sign-in (docs/spec/12-milestones-8-to-12.md). */
export function nextStage(u: { totpEnabled: boolean; role: string; mustChangePassword: boolean }, passedTotp: boolean): Stage {
  if (u.totpEnabled && !passedTotp) return "totp";
  if (!u.totpEnabled) return "totp_setup";
  if (u.mustChangePassword) return "password_change";
  return "complete";
}

export const policyFrom = (s: { sessionIdleMinutes: number; sessionAbsoluteHours: number }): SessionPolicy =>
  ({ idleMinutes: s.sessionIdleMinutes, absoluteHours: s.sessionAbsoluteHours });

// ---- The record of sign-ins (F21.R2, decision-log D70) -------------------------------------------------------------------------------
// Every row of sign_ins is written here: devices.ts works out whether the network and device are new, and records the sign-in through
// this function; setStage marks it complete. What it is given is checked against the table's own rules first.

export interface SignInRow { userId: string; address: string; network: string; deviceLabel: string; newNetwork: boolean; newDevice: boolean }
const USER_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const text = (v: unknown, max: number) => typeof v === "string" && v.length >= 1 && v.length <= max;

/** Records one sign-in that got past the password and returns its id. Each call is one sign-in, so each records a row of its own. */
export async function addSignIn(db: Queryable, r: SignInRow): Promise<number> {
  if (typeof r?.userId !== "string" || !USER_ID.test(r.userId)) throw new Error("a sign-in needs the user's id");
  if (!text(r.address, 64) || !text(r.network, 64) || !text(r.deviceLabel, 120)) throw new Error("a sign-in's address and network are 1 to 64 characters, its device 1 to 120");
  if (typeof r.newNetwork !== "boolean" || typeof r.newDevice !== "boolean") throw new Error("a sign-in says whether its network and device are new");
  const id = (await db.query<{ id: string }>(
    "INSERT INTO sign_ins (user_id, address, network, device_label, new_network, new_device) OUTPUT inserted.id VALUES ($1, $2, $3, $4, $5, $6)",
    [r.userId, r.address, r.network, r.deviceLabel, r.newNetwork, r.newDevice])).rows[0]!.id;
  return Number(id);
}
