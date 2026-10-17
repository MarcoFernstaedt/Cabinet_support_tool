// Daily jobs (docs/spec/05-server-spec.md "Audit log" and "Retention"): verify the audit chain,
// raising a security alert if it is broken, and remove what is past its retention period.
import { audit, transaction, verifyAuditChain, type ChainCheck, type Pool, type Queryable } from "../db/db.js";
import { platformSettings } from "./settings.js";
import { raiseSecurityAlert } from "./security.js";

/** Checks the whole chain. A break raises a security alert; the check itself is audited either way. */
export async function verifyChainAndAlert(pool: Pool, by: { userId: string } | "daily"): Promise<ChainCheck> {
  const check = await verifyAuditChain(pool);
  await transaction(pool, async c => {
    if (!check.ok)
      await raiseSecurityAlert(c, { kind: "audit_chain", signature: `audit_chain|${check.firstBadSeq}`,
        title: `The audit log's hash chain is broken at entry ${check.firstBadSeq}`, detail: { firstBadSeq: check.firstBadSeq, entries: check.entries } });
    await audit(c, { actorKind: by === "daily" ? "system" : "user", actorId: by === "daily" ? "daily-check" : by.userId, action: "audit.verify",
      outcome: check.ok ? "succeeded" : "failed", details: { entries: check.entries, firstBadSeq: check.firstBadSeq ?? null } });
  });
  return check;
}

/** Notifications only wake other server processes (each reads them within a second), so one older than an hour is of no use. */
export async function pruneNotifications(db: Queryable): Promise<number> {
  return (await db.query("DELETE FROM notifications WHERE [at] < DATEADD(hour, -1, SYSUTCDATETIME())")).rowCount;
}

export interface RetentionRun { events: number; commandResults: number; alerts: number; firewallChanges: number; sessions: number; stepUpTokens: number;
  diagnoses: number; boots: number; jobs: number; }

/**
 * Removes events, resolved alerts, firewall history, diagnoses, boot records and finished fleet jobs past their retention, and clears old command results
 * (the command itself, who sent it and when, stays in the history). The audit log is never pruned.
 */
export async function runRetention(pool: Pool): Promise<RetentionRun> {
  return transaction(pool, async c => {
    const r = (await platformSettings(c)).retention;
    const days = (n: number) => [n];
    const events = (await c.query("DELETE FROM events WHERE received_at < DATEADD(day, -$1, SYSUTCDATETIME())", days(r.eventsDays))).rowCount ?? 0;
    const commandResults = (await c.query("UPDATE commands SET result = NULL WHERE result IS NOT NULL AND result_at < DATEADD(day, -$1, SYSUTCDATETIME())",
      days(r.commandsDays))).rowCount ?? 0;
    // Events kept longer than their alert would point at nothing; they keep the event and lose the link.
    await c.query(`UPDATE events SET alert_id = NULL WHERE alert_id IN
                     (SELECT id FROM alerts WHERE state = 'resolved' AND last_seen < DATEADD(day, -$1, SYSUTCDATETIME()))`, days(r.alertsDays));
    const alerts = (await c.query("DELETE FROM alerts WHERE state = 'resolved' AND last_seen < DATEADD(day, -$1, SYSUTCDATETIME())", days(r.alertsDays))).rowCount ?? 0;
    const firewallChanges = (await c.query("DELETE FROM firewall_changes WHERE occurred_at < DATEADD(day, -$1, SYSUTCDATETIME())", days(r.firewallDays))).rowCount ?? 0;
    const sessions = (await c.query("DELETE FROM sessions WHERE expires_at < DATEADD(day, -1, SYSUTCDATETIME())")).rowCount ?? 0;
    const stepUpTokens = (await c.query("DELETE FROM step_up_tokens WHERE expires_at < DATEADD(day, -1, SYSUTCDATETIME())")).rowCount ?? 0;
    const diagnoses = (await c.query("DELETE FROM diagnoses WHERE started_at < DATEADD(day, -$1, SYSUTCDATETIME())", days(r.diagnosesDays))).rowCount ?? 0;
    // Load samples are for trend charts only, so two weeks is all they are kept.
    await c.query("DELETE FROM health_samples WHERE [at] < DATEADD(day, -14, SYSUTCDATETIME())");
    // A drive's history is kept for 400 days: long enough to see a year of wear.
    await c.query("DELETE FROM drive_samples WHERE [at] < DATEADD(day, -400, SYSUTCDATETIME())");
    await pruneNotifications(c);
    const boots = (await c.query("DELETE FROM cabinet_boots WHERE booted_at < DATEADD(day, -$1, SYSUTCDATETIME())", days(r.bootsDays))).rowCount ?? 0;
    // A finished job and its per-cabinet results; the commands it sent and the audit log stay.
    await c.query(`DELETE FROM fleet_job_targets WHERE job_id IN
                     (SELECT id FROM fleet_jobs WHERE state <> 'running' AND created_at < DATEADD(day, -$1, SYSUTCDATETIME()))`, days(r.jobsDays));
    const jobs = (await c.query("DELETE FROM fleet_jobs WHERE state <> 'running' AND created_at < DATEADD(day, -$1, SYSUTCDATETIME())", days(r.jobsDays))).rowCount ?? 0;
    const run = { events, commandResults, alerts, firewallChanges, sessions, stepUpTokens, diagnoses, boots, jobs };
    await audit(c, { actorKind: "system", actorId: "retention", action: "retention.run", outcome: "succeeded", details: { ...run, retention: r } });
    return run;
  });
}

/** Runs both jobs a few minutes after start and then every 24 hours; the notifications table is trimmed every hour. */
export function scheduleDailyJobs(pool: Pool, log: (message: string) => void): () => void {
  const run = () => {
    verifyChainAndAlert(pool, "daily").then(c => { if (!c.ok) log(`Audit chain broken at entry ${c.firstBadSeq}.`); }, () => log("Audit chain check failed to run."));
    runRetention(pool).catch(() => log("Retention failed to run."));
  };
  const first = setTimeout(run, 5 * 60_000);
  const daily = setInterval(run, 24 * 3_600_000);
  const hourly = setInterval(() => { pruneNotifications(pool).catch(() => log("Pruning notifications failed to run.")); }, 3_600_000);
  return () => { clearTimeout(first); clearInterval(daily); clearInterval(hourly); };
}
