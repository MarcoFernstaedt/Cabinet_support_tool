// Scenario B, a whole site offline (docs/spec/13-roadmap.md module 40). Checked every minute: a site whose active cabinets
// (two or more) all stopped reporting within the same 10 minutes, in the last 7 days, gets a major alert on each of them.
// A site whose cabinets are crashing in a loop is a crash incident, not an outage, so a site with an open reboot-loop
// alert is left to that (the NOT EXISTS on ISSUE.rebootLoop below is that rule, not a typo for siteOutage: an open outage alert is simply
// kept up to date by the fold). The alerts close as soon as any cabinet at the site is heard from again. While the fleet's contact is in
// doubt (alerts.ts FleetContact: the server or database was away, or contact fell fleet-wide) no new outage is raised, except at sites
// whose cabinets are all simulated demo cabinets.
import { auditMany, type Queryable } from "../db/db.js";
import { fleetContact, foldAlert, inTransaction, readFleetContact, type FleetContact } from "./alerts.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";
import { ISSUE } from "./rules.js";

export const TOGETHER_MINUTES = 10;

/** The note an automatic closure carries; the audit entry names the same text. */
export const RESOLUTION = "A cabinet at the site is reporting again.";

export async function checkSiteOutages(db: Queryable, guard: FleetContact = fleetContact): Promise<{ raised: number; resolved: number }> {
  const issue = (await db.query<{ name: string; severity: string }>("SELECT name, severity FROM issue_types WHERE id = $1", [ISSUE.siteOutage])).rows[0];
  if (!issue) return { raised: 0, resolved: 0 };
  const secs = OFFLINE_AFTER_MS / 1000;
  return inTransaction(db, async tx => {
    const judge = guard.judge(await readFleetContact(tx));
    const down = (await tx.query<{ id: string; last_heartbeat_at: Date }>(
      `WITH sites_down AS (
         SELECT k.site_id FROM cabinets k WHERE k.status = 'active'
          GROUP BY k.site_id
         HAVING COUNT(*) >= 2
            AND MIN(CASE WHEN k.last_heartbeat_at IS NOT NULL AND k.last_heartbeat_at < DATEADD(second, -$1, SYSUTCDATETIME()) THEN 1 ELSE 0 END) = 1
            AND MAX(k.last_heartbeat_at) > DATEADD(day, -7, SYSUTCDATETIME())
            AND DATEDIFF_BIG(millisecond, MIN(k.last_heartbeat_at), MAX(k.last_heartbeat_at)) <= $2 * 60000
            AND ($4 = 1 OR MIN(CASE WHEN k.demo_scenario IS NOT NULL THEN 1 ELSE 0 END) = 1)
            AND NOT EXISTS (SELECT 1 FROM alerts a JOIN cabinets y ON y.id = a.cabinet_id
                             WHERE y.site_id = k.site_id AND a.issue_type_id = $3 AND a.state <> 'resolved'))
       SELECT k.id, k.last_heartbeat_at FROM cabinets k JOIN sites_down d ON d.site_id = k.site_id WHERE k.status = 'active'`,
      [secs, TOGETHER_MINUTES, ISSUE.rebootLoop, judge])).rows;
    const now = new Date();
    let raised = 0;
    for (const k of down) {
      const a = await foldAlert(tx, { cabinetId: k.id, issueTypeId: ISSUE.siteOutage, severity: issue.severity, signature: `issue:${ISSUE.siteOutage}`, title: issue.name,
        firstSeen: k.last_heartbeat_at, lastSeen: now, ruleId: null, eventId: null, occurrences: 1 }, "seen");
      if (a.created) raised++;
    }
    // Pick the alerts to close first (a snapshot read under RCSI, no locks on cabinets), then close them by id: the old single UPDATE joined
    // cabinets while heartbeats were writing them, and lost deadlocks against them during a backlog drain.
    const closing = (await tx.query<{ id: string }>(
      `SELECT a.id FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id WHERE a.issue_type_id = $1 AND a.state <> 'resolved'
          AND EXISTS (SELECT 1 FROM cabinets y WHERE y.site_id = k.site_id AND y.status = 'active' AND y.last_heartbeat_at > DATEADD(second, -$2, SYSUTCDATETIME()))`,
      [ISSUE.siteOutage, secs])).rows;
    let resolved = 0;
    for (let i = 0; i < closing.length; i += 500) {
      const ids = closing.slice(i, i + 500).map(r => r.id);
      // The cabinet's liveness is checked again here, in the update itself: between the snapshot read above and this statement a heartbeat
      // can have arrived (or gone stale), and closing an alert that is no longer about a live site is exactly what must not happen.
      // The rows it changed come back, so every closure this automatic step makes leaves its own audit entry, in the same transaction.
      // alerts carries the alert_notify trigger, and SQL Server refuses OUTPUT without INTO on a table that has an enabled trigger: the
      // changed ids are collected into a table variable and read back, as the alert fold and the alert insert do.
      const changed = (await tx.query<{ id: string }>(
        `DECLARE @o TABLE (id uniqueidentifier);
         UPDATE a SET a.state = 'resolved', a.resolved_at = SYSUTCDATETIME(), a.resolution = $${ids.length + 2}
          OUTPUT inserted.id INTO @o (id)
           FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id
          WHERE a.state <> 'resolved' AND a.id IN (${ids.map((_, n) => `$${n + 1}`).join(", ")})
            AND EXISTS (SELECT 1 FROM cabinets y WHERE y.site_id = k.site_id AND y.status = 'active' AND y.last_heartbeat_at > DATEADD(second, -$${ids.length + 1}, SYSUTCDATETIME()));
         SELECT id FROM @o;`,
        [...ids, secs, RESOLUTION])).rows;
      resolved += changed.length;
      if (changed.length > 0)
        await auditMany(tx, changed.map(r => ({ actorKind: "system", actorId: "site-outage", action: "alert.resolve", targetKind: "alert", targetId: r.id,
          outcome: "succeeded", details: { issueTypeId: ISSUE.siteOutage, resolution: RESOLUTION, automatic: true } })));
    }
    return { raised, resolved };
  });
}
