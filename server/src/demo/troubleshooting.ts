// What the simulated fleet shows of the troubleshooting workflow (docs/platform/demo.md): 30 days of error trends for the errors the simulated
// cabinets log (one steady, one rising, one new), and a few alerts resolved in the past with their cause and fix, so "usually fixed by" and
// the cabinet's case notes have something to show on the first day. Only simulated clients and cabinets are touched; turning demo mode off
// removes it all (demo.ts disableDemo).
import { randomUUID } from "node:crypto";
import type { Pool } from "../db/db.js";
import { ISSUE } from "../services/rules.js";

const DAY = 86_400_000;

/** Daily event counts, oldest first, for the three shapes the trends page marks: steady, rising and new. */
export function demoSeries(shape: "steady" | "rising" | "new", base: number, days = 30): number[] {
  return Array.from({ length: days }, (_, i) => {
    const ago = days - 1 - i;
    if (shape === "steady") return base + (i % 3 === 0 ? 1 : 0);
    if (shape === "rising") return ago >= 14 ? Math.max(1, Math.round(base / 3)) : ago >= 7 ? base : base * 3;
    return ago === 0 ? base * 2 : 0;
  });
}

export async function seedDemoTroubleshooting(pool: Pool, ownerId: string): Promise<void> {
  const state = (await pool.query<{ through: Date | null }>("SELECT computed_through AS through FROM trend_state WHERE id = 1")).rows[0];
  const today = Math.floor(Date.now() / DAY) * DAY;
  const groups = (await pool.query<{ client_id: string; lg: string; src: string; eid: number; cabinets: number; issue: string | null }>(
    `SELECT s.client_id, JSON_VALUE(e.source, '$.log') AS lg, JSON_VALUE(e.source, '$.source') AS src, TRY_CAST(JSON_VALUE(e.source, '$.eventId') AS int) AS eid,
            COUNT(DISTINCT e.cabinet_id) AS cabinets, CAST(MAX(CAST(r.issue_type_id AS char(36))) AS uniqueidentifier) AS issue
       FROM events e JOIN cabinets k ON k.id = e.cabinet_id JOIN sites s ON s.id = k.site_id LEFT JOIN symptom_rules r ON r.id = e.matched_rule
      WHERE k.demo_scenario IS NOT NULL AND e.kind = 'error' AND e.source IS NOT NULL AND JSON_VALUE(e.source, '$.level') IN ('error', 'critical')
      GROUP BY s.client_id, JSON_VALUE(e.source, '$.log'), JSON_VALUE(e.source, '$.source'), TRY_CAST(JSON_VALUE(e.source, '$.eventId') AS int) ORDER BY COUNT(DISTINCT e.cabinet_id) DESC`)).rows
    .filter(g => g.lg && g.src && g.eid !== null).slice(0, 12);
  if (!state?.through && groups.length > 0) {
    const rows: unknown[][] = [];
    groups.forEach((g, i) => {
      const shape = g.issue === null ? (i % 3 === 0 ? "rising" : i % 3 === 1 ? "new" : "steady") : (i % 2 === 0 ? "steady" : "rising");
      const base = Math.max(1, Number(g.cabinets));
      demoSeries(shape, base).forEach((events, d) => {
        if (events > 0) rows.push([new Date(today - (30 - d) * DAY), g.client_id, g.lg, g.src, g.eid, g.issue, Math.min(base, events), events]);
      });
    });
    for (let i = 0; i < rows.length; i += 200)
      await pool.query(`INSERT INTO error_daily ([day], client_id, [log], [source], [event_id], issue_type_id, cabinets, [events])
                        SELECT CAST(JSON_VALUE(v.value, '$[0]') AS date), JSON_VALUE(v.value, '$[1]'), JSON_VALUE(v.value, '$[2]'), JSON_VALUE(v.value, '$[3]'), JSON_VALUE(v.value, '$[4]'),
                               JSON_VALUE(v.value, '$[5]'), JSON_VALUE(v.value, '$[6]'), JSON_VALUE(v.value, '$[7]') FROM OPENJSON($1) v`, [JSON.stringify(rows.slice(i, i + 200))]);
    await pool.query("UPDATE trend_state SET computed_through = CAST($1 AS date), computed_at = SYSUTCDATETIME() WHERE id = 1", [new Date(today - DAY)]);
  }

  // Alerts resolved in the past, with what was wrong and what fixed them.
  const past: { issue: string; scenario: string; cause: string; fix: string; title: string }[] = [
    { issue: ISSUE.scanner, scenario: "scanner_disconnected", cause: "The cable had worked loose from the rear USB port.", fix: "Reseated the cable on a rear port and turned off USB power saving.", title: "Fingerprint scanner problem" },
    { issue: ISSUE.scanner, scenario: "usb_missing", cause: "A damaged cable.", fix: "Reseated the cable on a rear port and turned off USB power saving.", title: "Fingerprint scanner problem" },
    { issue: ISSUE.scanner, scenario: "scanner_flapping", cause: "A driver update the night before.", fix: "Rolled the reader's driver back to the previous version.", title: "Fingerprint scanner problem" },
    { issue: ISSUE.firewallPolicy, scenario: "firewall_drift", cause: "A Windows feature update turned the profiles back on.", fix: "Applied the client's firewall policy.", title: "Firewall differs from client policy" },
  ];
  for (const [i, p] of past.entries()) {
    const k = (await pool.query<{ id: string }>("SELECT TOP (1) id FROM cabinets WHERE demo_scenario = $1 ORDER BY name", [p.scenario])).rows[0];
    if (!k) continue;
    const id = randomUUID(), at = new Date(Date.now() - (3 + i * 2) * DAY);
    await pool.query(
      `INSERT INTO alerts (id, cabinet_id, issue_type_id, severity, signature, title, state, occurrences, first_seen, last_seen, resolved_by, resolved_at, resolution, resolution_cause, resolution_fix)
       VALUES ($1, $2, $3, 'minor', $4, $5, 'resolved', 1, $6, $6, $7, $6, $8, $9, $8)`, [id, k.id, p.issue, `issue:${p.issue}:past${i}`, p.title, at, ownerId, p.fix, p.cause]);
    await pool.query("INSERT INTO case_notes (id, cabinet_id, alert_id, author_id, kind, body, created_at) VALUES ($1, $2, $3, $4, 'resolution', $5, $6)",
      [randomUUID(), k.id, id, ownerId, `Resolved: ${p.title}. Cause: ${p.cause} Fix: ${p.fix}`, at]);
  }
}
