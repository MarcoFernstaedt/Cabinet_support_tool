// Step-up: a fresh authenticator code (or, for a bulk change, the password) at the moment of an action produces a
// token bound to that one action on that one target, and to the exact parameters when given, valid 2 minutes,
// used once (docs/spec/02-security-model.md control 8, 12-milestones-8-to-12.md "Confirmation levels").
import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../db/db.js";
import { Refused } from "../services/errors.js";
import { paramsHash } from "./canonical.js";
import { checkRetentionCutoff, inBatches, RETENTION_BATCH, type BatchOptions } from "../db/batches.js";

export const STEP_UP_SECONDS = 120;
const hash = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

export async function issueStepUpToken(db: Queryable, userId: string, action: string, target: string, boundParamsHash?: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  // Confirming no parameters at all binds nothing: the route then receives the bare token (see boundTo).
  if (boundParamsHash === paramsHash({})) boundParamsHash = undefined;
  await db.query(`INSERT INTO step_up_tokens (token_hash, user_id, action, target, params_hash, expires_at) VALUES ($1, $2, $3, $4, $5, DATEADD(second, $6, SYSUTCDATETIME()))`,
    [hash(token), userId, action, target, boundParamsHash ?? null, STEP_UP_SECONDS]);
  return token;
}

/**
 * The token as a route received it, bound to the rest of the request body: the person must have confirmed exactly these
 * parameters (the console sends their canonical hash with the code). A body that is only the token stays unbound, since
 * the action and target already say everything. Tokens are base64url, so the "." cannot come from the request.
 */
export function boundTo(token: string, body: object): string {
  const { stepUpToken: _token, ...params } = body as Record<string, unknown>;
  return Object.keys(params).length === 0 ? token : `${token}.${paramsHash(params)}`;
}

/**
 * Consumes the token inside the caller's transaction, so the action and the token's use commit together. When the
 * action passes its parameters, the token must have been confirmed for exactly those parameters. A token issued for parameters
 * never matches without them: dropping the ".hash" suffix cannot widen what it covers.
 */
export async function consumeStepUpToken(db: Queryable, token: string, userId: string, action: string, target: string, params?: unknown): Promise<void> {
  const dot = token.indexOf(".");
  const boundHash = dot < 0 ? null : token.slice(dot + 1);
  if (dot >= 0) token = token.slice(0, dot);
  const required = params === undefined ? boundHash : paramsHash(params);
  const r = await db.query(`UPDATE step_up_tokens SET used_at = SYSUTCDATETIME()
                              WHERE token_hash = $1 AND user_id = $2 AND action = $3 AND target = $4 AND used_at IS NULL AND expires_at > SYSUTCDATETIME()
                                AND ((params_hash IS NULL AND $5 IS NULL) OR params_hash = $5)`,
    [hash(token), userId, action, target, required]);
  if (r.rowCount !== 1) throw new Refused("step_up_required", 403, "a valid step-up token for this exact action is required");
}

/** Removes step-up tokens that expired before `cutoff`, in batches, each batch audited (retention, decision-log D71). */
export async function pruneExpiredStepUpTokens(db: Queryable, cutoff: Date, o: BatchOptions = RETENTION_BATCH): Promise<number> {
  checkRetentionCutoff(cutoff);
  return inBatches(db, "DELETE TOP ($1) FROM step_up_tokens WHERE expires_at < $2", [cutoff], o, { table: "step_up_tokens", cutoff });
}
