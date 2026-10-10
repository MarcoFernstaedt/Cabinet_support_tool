// Scenario B, a whole site offline (docs/spec/13-roadmap.md module 40). Checked every minute: a site whose active cabinets
// (two or more) all stopped reporting within the same 10 minutes, in the last 7 days, gets a major alert on each of them.
// A site whose cabinets are crashing in a loop is a crash incident, not an outage, so a site with an open reboot-loop
// alert is left to that. The alerts close as soon as any cabinet at the site is heard from again.
import type { Queryable } from "../db/db.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";
import { ISSUE } from "./rules.js";

export const TOGETHER_MINUTES = 10;

export async function checkSiteOutages(db: Queryable): Promise<{ raised: number; resolved: number }> {
  const issue = (await db.query<{ name: string; severity: string }>("SELECT name, severity FROM issue_types WHERE id = $1", [ISSUE.siteOutage])).rows[0];
  if (!issue) return { raised: 0, resolved: 0 };
  const secs = OFFLINE_AFTER_MS / 1000;
  const raised = await db.query(
    `WITH sites_down AS (
       SELECT k.site_id FROM cabinets k WHERE k.status = 'active'
        GROUP BY k.site_id
       HAVING count(*) >= 2
          AND bool_and(k.last_heartbeat_at IS NOT NULL AND k.last_heartbeat_at < now() - make_interval(secs => $5))
          AND max(k.last_heartbeat_at) > now() - interval '7 days'
          AND max(k.last_heartbeat_at) - min(k.last_heartbeat_at) <= make_interval(mins => $6)
          AND NOT EXISTS (SELECT 1 FROM alerts a JOIN cabinets y ON y.id = a.cabinet_id
                           WHERE y.site_id = k.site_id AND a.issue_type_id = $7 AND a.state <> 'resolved'))
     INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen)
     SELECT k.id, $1, $2, $3, $4, k.last_heartbeat_at, now() FROM cabinets k JOIN sites_down d ON d.site_id = k.site_id WHERE k.status = 'active'
     ON CONFLICT (cabinet_id, signature) WHERE state <> 'resolved' DO UPDATE SET last_seen = now()
     RETURNING (xmax = 0) AS created`,
    [ISSUE.siteOutage, issue.severity, `issue:${ISSUE.siteOutage}`, issue.name, secs, TOGETHER_MINUTES, ISSUE.rebootLoop]);
  const resolved = await db.query(
    `UPDATE alerts a SET state = 'resolved', resolved_at = now(), resolution = 'A cabinet at the site is reporting again.'
       FROM cabinets k WHERE k.id = a.cabinet_id AND a.issue_type_id = $1 AND a.state <> 'resolved'
        AND EXISTS (SELECT 1 FROM cabinets y WHERE y.site_id = k.site_id AND y.status = 'active' AND y.last_heartbeat_at > now() - make_interval(secs => $2))`,
    [ISSUE.siteOutage, secs]);
  return { raised: raised.rows.filter(r => r.created).length, resolved: resolved.rowCount ?? 0 };
}
