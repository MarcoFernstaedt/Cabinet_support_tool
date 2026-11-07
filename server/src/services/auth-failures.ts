// A failed sign-in or step-up code counts toward the account's lock, whichever door it came through (the console or the operator command
// line, F3): five in a row lock the account for 15 minutes and raise a security alert.
import type { Pool } from "../db/db.js";
import { raiseSecurityAlertNow } from "./security.js";

export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 15;

export async function recordAuthFailure(pool: Pool, userId: string, kind: "failed_logins" | "failed_step_ups", source: string): Promise<void> {
  const r = (await pool.query<{ failed_logins: number; username: string }>(
    `UPDATE users SET failed_logins = CASE WHEN locked_until IS NOT NULL AND locked_until <= SYSUTCDATETIME() THEN 1 ELSE failed_logins + 1 END,
                      locked_until = CASE WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= SYSUTCDATETIME() THEN 1 ELSE failed_logins + 1 END) >= $2
                                          THEN DATEADD(minute, $3, SYSUTCDATETIME())
                                          WHEN locked_until IS NOT NULL AND locked_until <= SYSUTCDATETIME() THEN NULL ELSE locked_until END
      OUTPUT inserted.failed_logins, inserted.username
      WHERE id = $1`, [userId, MAX_FAILURES, LOCK_MINUTES])).rows[0];
  if (r && r.failed_logins === MAX_FAILURES)
    await raiseSecurityAlertNow(pool, { kind, signature: `${kind}|${userId}`, userId,
      title: kind === "failed_logins" ? `Repeated failed sign-ins on ${r.username}; the account is locked for ${LOCK_MINUTES} minutes`
                                      : `Repeated failed step-up codes on ${r.username}; the account is locked for ${LOCK_MINUTES} minutes`,
      detail: { failures: r.failed_logins, source } });
}
