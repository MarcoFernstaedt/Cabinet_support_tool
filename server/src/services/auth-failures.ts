// A failed sign-in or step-up code counts toward the account's lock, whichever door it came through (the console or the operator command
// line, F3): five in a row lock the account for 15 minutes and raise a security alert.
import type { Pool } from "../db/db.js";
import { raiseSecurityAlertNow } from "./security.js";
import { countAuthFailure } from "./users.js";

export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 15;

export async function recordAuthFailure(pool: Pool, userId: string, kind: "failed_logins" | "failed_step_ups", source: string): Promise<void> {
  // The count is the account's, written by users.ts (D113); the policy and the alert stay here.
  const r = await countAuthFailure(pool, userId, MAX_FAILURES, LOCK_MINUTES);
  if (r && r.failures === MAX_FAILURES)
    await raiseSecurityAlertNow(pool, { kind, signature: `${kind}|${userId}`, userId,
      title: kind === "failed_logins" ? `Repeated failed sign-ins on ${r.username}; the account is locked for ${LOCK_MINUTES} minutes`
                                      : `Repeated failed step-up codes on ${r.username}; the account is locked for ${LOCK_MINUTES} minutes`,
      detail: { failures: r.failures, source } });
}
