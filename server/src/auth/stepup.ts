// Step-up: a fresh authenticator code (or, for a bulk change, the password) at the moment of an action produces a
// token bound to that one action on that one target, and to the exact parameters when given, valid 2 minutes,
// used once (docs/spec/02-security-model.md control 8, 12-milestones-8-to-12.md "Confirmation levels").
import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../db/db.js";
import { Refused } from "../services/errors.js";
import { paramsHash } from "./canonical.js";

export const STEP_UP_SECONDS = 120;
const hash = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

export async function issueStepUpToken(db: Queryable, userId: string, action: string, target: string, boundParamsHash?: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO step_up_tokens (token_hash, user_id, action, target, params_hash, expires_at) VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
    [hash(token), userId, action, target, boundParamsHash ?? null, STEP_UP_SECONDS]);
  return token;
}

/**
 * Consumes the token inside the caller's transaction, so the action and the token's use commit together. When the
 * action passes its parameters, the token must have been confirmed for exactly those parameters.
 */
export async function consumeStepUpToken(db: Queryable, token: string, userId: string, action: string, target: string, params?: unknown): Promise<void> {
  const r = await db.query(`UPDATE step_up_tokens SET used_at = now()
                              WHERE token_hash = $1 AND user_id = $2 AND action = $3 AND target = $4 AND used_at IS NULL AND expires_at > now()
                                AND ($5::text IS NULL OR params_hash = $5)`,
    [hash(token), userId, action, target, params === undefined ? null : paramsHash(params)]);
  if (r.rowCount !== 1) throw new Refused("step_up_required", 403, "a valid step-up token for this exact action is required");
}
