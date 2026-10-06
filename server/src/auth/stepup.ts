// Step-up: a fresh authenticator code at the moment of an action produces a
// token bound to that one action on that one target, valid 2 minutes, used once
// (docs/spec/02-security-model.md control 8).
import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../db/db.js";
import { Refused } from "../services/errors.js";

export const STEP_UP_SECONDS = 120;
const hash = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

export async function issueStepUpToken(db: Queryable, userId: string, action: string, target: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO step_up_tokens (token_hash, user_id, action, target, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
    [hash(token), userId, action, target, STEP_UP_SECONDS]);
  return token;
}

/** Consumes the token inside the caller's transaction, so the action and the token's use commit together. */
export async function consumeStepUpToken(db: Queryable, token: string, userId: string, action: string, target: string): Promise<void> {
  const r = await db.query(`UPDATE step_up_tokens SET used_at = now()
                              WHERE token_hash = $1 AND user_id = $2 AND action = $3 AND target = $4 AND used_at IS NULL AND expires_at > now()`,
    [hash(token), userId, action, target]);
  if (r.rowCount !== 1) throw new Refused("step_up_required", 403, "a valid step-up token for this exact action is required");
}
