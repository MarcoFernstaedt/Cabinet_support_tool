// Sign-in, authenticator setup, password change, sign-out and step-up
// (docs/spec/02-security-model.md controls 6 and 8, docs/spec/06-console-spec.md "Sign-in").
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { audit, transaction } from "../db/db.js";
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from "../auth/passwords.js";
import { createSession, endSession, nextStage, setStage, type SessionUser } from "../auth/sessions.js";
import { raiseSecurityAlertNow } from "../services/security.js";
import { ownSignIns, sessionSignIn } from "../services/sign-ins.js";
import { DEVICE_MAX_AGE_SECONDS, recordSignIn } from "../auth/devices.js";
import { DEVICE_COOKIE, readCookie, setCookie } from "../auth/cookies.js";
import { issueStepUpToken } from "../auth/stepup.js";
import * as totp from "../auth/totp.js";
import { Refused } from "../services/errors.js";
import { clearSessionCookie, setSessionCookie, type ConsoleApiOptions, type Guards } from "./server.js";

export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 15;
const ADDRESS_FAILURES_PER_15_MIN = 30;

export async function authRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  const now = o.now ?? Date.now;
  const addressFailures = new Map<string, number[]>();

  const recentAddressFailures = (ip: string): number[] => (addressFailures.get(ip) ?? []).filter(t => now() - t < 15 * 60_000);
  const noteAddressFailure = (ip: string): void => {
    const r = recentAddressFailures(ip); r.push(now()); addressFailures.set(ip, r);
    // Kept bounded: addresses with no failure in the last 15 minutes are dropped once the map grows.
    if (addressFailures.size > 10_000) for (const [k] of addressFailures) if (recentAddressFailures(k).length === 0) addressFailures.delete(k);
  };

  /**
   * Counts a failed password or code against the account; enough of them lock it for a while, and the failure that
   * locks it raises a security alert to Admins. Once a lock has run out the count starts again, so a later run of
   * failures locks (and alerts) again instead of re-locking on the first one, silently.
   */
  const recordFailure = async (userId: string, kind: "failed_logins" | "failed_step_ups", source: string): Promise<void> => {
    const r = (await o.pool.query<{ failed_logins: number; username: string }>(
      `UPDATE users SET failed_logins = CASE WHEN locked_until IS NOT NULL AND locked_until <= SYSUTCDATETIME() THEN 1 ELSE failed_logins + 1 END,
                        locked_until = CASE WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= SYSUTCDATETIME() THEN 1 ELSE failed_logins + 1 END) >= $2
                                            THEN DATEADD(minute, $3, SYSUTCDATETIME())
                                            WHEN locked_until IS NOT NULL AND locked_until <= SYSUTCDATETIME() THEN NULL ELSE locked_until END
        OUTPUT inserted.failed_logins, inserted.username
        WHERE id = $1`, [userId, MAX_FAILURES, LOCK_MINUTES])).rows[0];
    if (r && r.failed_logins === MAX_FAILURES)
      await raiseSecurityAlertNow(o.pool, { kind, signature: `${kind}|${userId}`, userId,
        title: kind === "failed_logins" ? `Repeated failed sign-ins on ${r.username}; the account is locked for ${LOCK_MINUTES} minutes`
                                        : `Repeated failed step-up codes on ${r.username}; the account is locked for ${LOCK_MINUTES} minutes`,
        detail: { failures: r.failed_logins, source } });
  };

  const describe = (u: SessionUser) => ({
    user: { id: u.userId, username: u.username, name: u.name, role: u.role, totpEnabled: u.totpEnabled, tourCompleted: u.tourCompleted, canApproveFixes: u.canApproveFixes },
    stage: u.stage,
  });

  app.post("/api/auth/login", async (request, reply) => {
    if (recentAddressFailures(request.ip).length >= ADDRESS_FAILURES_PER_15_MIN) return reply.code(429).send({ error: "too_many_attempts" });
    const body = consoleBodies.login.parse(request.body);
    const user = (await o.pool.query<{ id: string; password_hash: string | null; role: string; totp_enabled: boolean; must_change_password: boolean; locked: boolean }>(
      `SELECT TOP (1) id, password_hash, role, totp_enabled, must_change_password, CAST(CASE WHEN locked_until IS NOT NULL AND locked_until > SYSUTCDATETIME() THEN 1 ELSE 0 END AS bit) AS locked
         FROM users WHERE username COLLATE Latin1_General_100_BIN2 = $1 AND status = 'active'`, [body.username])).rows[0];
    const ok = await verifyPassword(user?.password_hash ?? null, body.password);
    // A lock is shown only to someone who knows the password: a wrong password gets the same answer for every account.
    if (user?.locked && ok) return reply.code(429).send({ error: "account_locked" });
    if (!user || !ok) {
      noteAddressFailure(request.ip);
      if (user && !user.locked) await recordFailure(user.id, "failed_logins", request.ip);
      await transaction(o.pool, c => audit(c, { actorKind: user ? "user" : "system", actorId: user?.id ?? "console", action: "auth.login", outcome: "refused",
        details: { username: body.username, source: request.ip } }));
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const policy = await o.guards.policy();
    const stage = nextStage({ totpEnabled: user.totp_enabled, role: user.role, mustChangePassword: user.must_change_password }, false);
    const id = await transaction(o.pool, async c => {
      // The failure count is cleared only when sign-in needs no authenticator code. Otherwise it is cleared by a correct
      // code: a correct password must not reset the count, or someone holding it could guess codes without ever locking.
      if (stage !== "totp") await c.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [user.id]);
      const signIn = await recordSignIn(c, { userId: user.id, username: body.username, address: request.ip, userAgent: request.headers["user-agent"],
        deviceCookie: readCookie(request, DEVICE_COOKIE) });
      if (stage === "complete") await c.query("UPDATE users SET last_login_at = SYSUTCDATETIME() WHERE id = $1", [user.id]);
      await audit(c, { actorKind: "user", actorId: user.id, action: "auth.login", outcome: "succeeded",
        details: { stage, source: request.ip, newNetwork: signIn.newNetwork, newDevice: signIn.newDevice } });
      return { session: await createSession(c, user.id, stage, request.ip, policy, signIn.signInId), device: signIn.deviceValue };
    });
    setSessionCookie(reply, id.session, policy.absoluteHours * 3600);
    setCookie(reply, DEVICE_COOKIE, id.device, DEVICE_MAX_AGE_SECONDS);
    return { stage };
  });

  app.get("/api/auth/me", async request => {
    const u = await o.guards.session(request);
    return { ...describe(u), signIn: u.stage === "complete" ? await sessionSignIn(o.pool, u.sessionHash) : null };
  });

  /** The signed-in person's own recent sign-ins, with any from a network or device they had not used before marked. */
  app.get("/api/auth/sign-ins", async request => {
    const u = await o.guards.session(request);
    return { signIns: await ownSignIns(o.pool, u.userId) };
  });

  app.post("/api/auth/totp", async (request, reply) => {
    if (recentAddressFailures(request.ip).length >= ADDRESS_FAILURES_PER_15_MIN) return reply.code(429).send({ error: "too_many_attempts" });
    const u = await o.guards.session(request);
    if (u.stage !== "totp") throw new Refused("wrong_stage", 409, "no authenticator code is expected now");
    const { code } = consoleBodies.code.parse(request.body);
    const row = (await o.pool.query<{ totp_secret_enc: Buffer; totp_last_step: string | null; locked: boolean }>(
      "SELECT totp_secret_enc, totp_last_step, CAST(CASE WHEN locked_until IS NOT NULL AND locked_until > SYSUTCDATETIME() THEN 1 ELSE 0 END AS bit) AS locked FROM users WHERE id = $1", [u.userId])).rows[0]!;
    if (row.locked) return reply.code(429).send({ error: "account_locked" });
    const step = totp.verify(o.secrets.open(row.totp_secret_enc), code, now(), row.totp_last_step === null ? null : Number(row.totp_last_step));
    if (step === null) {
      noteAddressFailure(request.ip);
      await recordFailure(u.userId, "failed_logins", request.ip);
      await transaction(o.pool, c => audit(c, { actorKind: "user", actorId: u.userId, action: "auth.totp", outcome: "refused", details: { source: request.ip } }));
      return reply.code(401).send({ error: "invalid_code" });
    }
    const stage = nextStage({ totpEnabled: true, role: u.role, mustChangePassword: u.mustChangePassword }, true);
    await transaction(o.pool, async c => {
      // Claimed with a conditional update, so two requests racing with the same code cannot both pass.
      const claimed = await c.query("UPDATE users SET totp_last_step = $2, failed_logins = 0, last_login_at = CASE WHEN $3 = 1 THEN SYSUTCDATETIME() ELSE last_login_at END WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)",
        [u.userId, step, stage === "complete"]);
      if (claimed.rowCount !== 1) throw new Refused("invalid_code", 401, "that code was already used");
      await setStage(c, u.sessionHash, stage);
      await audit(c, { actorKind: "user", actorId: u.userId, action: "auth.totp", outcome: "succeeded", details: { source: request.ip } });
    });
    return { stage };
  });

  /** Starts authenticator setup: required at first sign-in for Tier 2 and Admin, optional for Tier 1. */
  app.get("/api/auth/totp/setup", async request => {
    const u = await o.guards.session(request);
    if (!(u.stage === "totp_setup" || (u.stage === "complete" && !u.totpEnabled))) throw new Refused("wrong_stage", 409, "authenticator setup is not available now");
    // A GET changes nothing a person could lose: the pending secret is created once and shown again on every later
    // request until setup completes (an Admin's reset clears it), so no link or request can swap it under them.
    const row = (await o.pool.query<{ totp_secret_enc: Buffer | null }>(
      "UPDATE users SET totp_secret_enc = COALESCE(totp_secret_enc, $2) OUTPUT inserted.totp_secret_enc WHERE id = $1 AND totp_enabled = 0",
      [u.userId, o.secrets.seal(totp.newSecret())])).rows[0];
    if (!row?.totp_secret_enc) throw new Refused("wrong_stage", 409, "authenticator setup is not available now");
    const secret = o.secrets.open(row.totp_secret_enc);
    return { secret: totp.base32(secret), otpauthUri: totp.otpauthUri(secret, u.username) };
  });

  app.post("/api/auth/totp/setup", async (request, reply) => {
    const u = await o.guards.session(request);
    if (!(u.stage === "totp_setup" || (u.stage === "complete" && !u.totpEnabled))) throw new Refused("wrong_stage", 409, "authenticator setup is not available now");
    const { code } = consoleBodies.code.parse(request.body);
    const row = (await o.pool.query<{ totp_secret_enc: Buffer | null }>("SELECT totp_secret_enc FROM users WHERE id = $1", [u.userId])).rows[0]!;
    if (!row.totp_secret_enc) throw new Refused("setup_not_started", 409, "start authenticator setup first");
    const step = totp.verify(o.secrets.open(row.totp_secret_enc), code, now(), null);
    if (step === null) return reply.code(401).send({ error: "invalid_code" });
    const stage = u.stage === "complete" ? "complete" : nextStage({ totpEnabled: true, role: u.role, mustChangePassword: u.mustChangePassword }, true);
    await transaction(o.pool, async c => {
      await c.query("UPDATE users SET totp_enabled = 1, totp_last_step = $2 WHERE id = $1", [u.userId, step]);
      await setStage(c, u.sessionHash, stage);
      await audit(c, { actorKind: "user", actorId: u.userId, action: "auth.totp.enable", targetKind: "user", targetId: u.userId, outcome: "succeeded" });
    });
    return { stage };
  });

  app.post("/api/auth/password", async (request, reply) => {
    const u = await o.guards.session(request);
    if (!(u.stage === "password_change" || u.stage === "complete")) throw new Refused("wrong_stage", 409, "finish the earlier sign-in steps first");
    const body = consoleBodies.passwordChange.parse(request.body);
    // The same limits as sign-in: a stolen session must not become a way to guess the password without locking.
    if (recentAddressFailures(request.ip).length >= ADDRESS_FAILURES_PER_15_MIN) return reply.code(429).send({ error: "too_many_attempts" });
    const row = (await o.pool.query<{ password_hash: string; locked: boolean }>(
      "SELECT password_hash, CAST(CASE WHEN locked_until IS NOT NULL AND locked_until > SYSUTCDATETIME() THEN 1 ELSE 0 END AS bit) AS locked FROM users WHERE id = $1", [u.userId])).rows[0]!;
    if (row.locked) return reply.code(429).send({ error: "account_locked" });
    if (!(await verifyPassword(row.password_hash, body.currentPassword))) {
      noteAddressFailure(request.ip);
      await recordFailure(u.userId, "failed_logins", request.ip);
      await transaction(o.pool, c => audit(c, { actorKind: "user", actorId: u.userId, action: "auth.password.change", targetKind: "user", targetId: u.userId,
        outcome: "refused", details: { source: request.ip } }));
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    if (body.newPassword.length < MIN_PASSWORD_LENGTH || body.newPassword === body.currentPassword || body.newPassword.toLowerCase().includes(u.username))
      throw new Refused("weak_password", 400, "choose a different, longer password");
    const hash = await hashPassword(body.newPassword);
    await transaction(o.pool, async c => {
      await c.query("UPDATE users SET password_hash = $2, must_change_password = 0 WHERE id = $1", [u.userId, hash]);
      // Every other session of this user ends; this one continues.
      await c.query("DELETE FROM sessions WHERE user_id = $1 AND id_hash <> $2", [u.userId, u.sessionHash]);
      if (u.stage === "password_change") await setStage(c, u.sessionHash, "complete");
      await audit(c, { actorKind: "user", actorId: u.userId, action: "auth.password.change", targetKind: "user", targetId: u.userId, outcome: "succeeded" });
    });
    return { stage: "complete" };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    try {
      const u = await o.guards.session(request);
      await transaction(o.pool, async c => {
        await endSession(c, u.sessionHash);
        await audit(c, { actorKind: "user", actorId: u.userId, action: "auth.logout", outcome: "succeeded" });
      });
    } catch (e) { if (!(e instanceof Refused)) throw e; }
    clearSessionCookie(reply);
    return { stage: "signed_out" };
  });

  app.post("/api/auth/tour-complete", async request => {
    const u = await o.guards.role(request, "tier1");
    await o.pool.query("UPDATE users SET tour_completed = 1 WHERE id = $1", [u.userId]);
    return { ok: true };
  });

  /** A fresh code for one action on one target produces a single-use token valid 2 minutes. */
  app.post("/api/auth/step-up", async (request, reply) => {
    const u = await o.guards.role(request, "tier1");
    const body = consoleBodies.stepUp.parse(request.body);
    const row = (await o.pool.query<{ totp_enabled: boolean; totp_secret_enc: Buffer | null; totp_last_step: string | null; locked: boolean }>(
      "SELECT totp_enabled, totp_secret_enc, totp_last_step, CAST(CASE WHEN locked_until IS NOT NULL AND locked_until > SYSUTCDATETIME() THEN 1 ELSE 0 END AS bit) AS locked FROM users WHERE id = $1", [u.userId])).rows[0]!;
    if (!row.totp_enabled || !row.totp_secret_enc) throw new Refused("totp_required", 403, "set up your authenticator first");
    if (row.locked) return reply.code(429).send({ error: "account_locked" });
    const step = totp.verify(o.secrets.open(row.totp_secret_enc), body.code, now(), row.totp_last_step === null ? null : Number(row.totp_last_step));
    if (step === null) {
      await recordFailure(u.userId, "failed_step_ups", request.ip);
      await transaction(o.pool, c => audit(c, { actorKind: "user", actorId: u.userId, action: "auth.step_up", outcome: "refused", details: { action: body.action, target: body.target } }));
      return reply.code(401).send({ error: "invalid_code" });
    }
    const token = await transaction(o.pool, async c => {
      const claimed = await c.query("UPDATE users SET totp_last_step = $2, failed_logins = 0 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)", [u.userId, step]);
      if (claimed.rowCount !== 1) throw new Refused("invalid_code", 401, "that code was already used");
      await audit(c, { actorKind: "user", actorId: u.userId, action: "auth.step_up", outcome: "succeeded",
        details: { action: body.action, target: body.target, ...(body.paramsHash ? { paramsHash: body.paramsHash } : {}) } });
      return issueStepUpToken(c, u.userId, body.action, body.target, body.paramsHash);
    });
    return { token };
  });


  /**
   * A change to more than one cabinet is confirmed with the password again (docs/spec/12-milestones-8-to-12.md). The token
   * is bound to the bulk action, the site or client, and the exact parameters. Wrong passwords count toward the lock.
   */
  app.post("/api/auth/confirm-password", async (request, reply) => {
    if (recentAddressFailures(request.ip).length >= ADDRESS_FAILURES_PER_15_MIN) return reply.code(429).send({ error: "too_many_attempts" });
    const u = await o.guards.role(request, "tier1");
    const body = consoleBodies.confirmPassword.parse(request.body);
    const row = (await o.pool.query<{ password_hash: string | null; locked: boolean }>(
      "SELECT password_hash, CAST(CASE WHEN locked_until IS NOT NULL AND locked_until > SYSUTCDATETIME() THEN 1 ELSE 0 END AS bit) AS locked FROM users WHERE id = $1", [u.userId])).rows[0]!;
    if (row.locked) return reply.code(429).send({ error: "account_locked" });
    if (!(await verifyPassword(row.password_hash, body.password))) {
      noteAddressFailure(request.ip);
      await recordFailure(u.userId, "failed_step_ups", request.ip);
      await transaction(o.pool, c => audit(c, { actorKind: "user", actorId: u.userId, action: "auth.confirm_password", outcome: "refused",
        details: { action: body.action, target: body.target } }));
      return reply.code(401).send({ error: "invalid_password" });
    }
    const token = await transaction(o.pool, async c => {
      await c.query("UPDATE users SET failed_logins = 0 WHERE id = $1", [u.userId]);
      await audit(c, { actorKind: "user", actorId: u.userId, action: "auth.confirm_password", outcome: "succeeded",
        details: { action: body.action, target: body.target, paramsHash: body.paramsHash } });
      return issueStepUpToken(c, u.userId, body.action, body.target, body.paramsHash);
    });
    return { token };
  });
}
