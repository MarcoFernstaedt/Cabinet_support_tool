// Resolution notes (docs/spec/12-milestones-8-to-12.md "Resolution notes"): resolving an alert records what was wrong (the cause) and what fixed it
// (one of the issue type's known fixes, or typed). Counting those per issue type is what puts "usually fixed by..." first on the next alert of
// that type. Matching is exact: a known fix by its ID, a typed fix by its words, never by pattern.
import type { Queryable } from "../db/db.js";

const WINDOW_DAYS = 365;

export interface UsualFix { fix: string; count: number; lastAt: string; fixId: string | null; solution: string | null }
export interface LastResolution { alertId: string; cabinet: { id: string; name: string }; resolvedBy: string | null; resolvedAt: string; cause: string | null; fix: string | null }
export interface IssueResolutions { issueTypeId: string; resolved: number; withFix: number; fixes: UsualFix[]; recent: LastResolution[] }

/** The three fixes that most often resolved this issue type's alerts in the last year, and the last five resolutions with their causes. */
export async function issueResolutions(db: Queryable, issueTypeId: string): Promise<IssueResolutions> {
  const counts = (await db.query<{ resolved: number; with_fix: number }>(
    `SELECT COUNT(*) AS resolved, SUM(CASE WHEN resolution_fix IS NOT NULL THEN 1 ELSE 0 END) AS with_fix FROM alerts
      WHERE issue_type_id = $1 AND state = 'resolved' AND resolved_by IS NOT NULL AND resolved_at > DATEADD(day, -${WINDOW_DAYS}, SYSUTCDATETIME())`, [issueTypeId])).rows[0]!;
  const fixes = (await db.query<{ fix: string; n: number; last_at: Date; fix_id: string | null; solution: string | null }>(
    `SELECT TOP (3) g.fix, g.n, g.last_at, g.fix_id, k.solution FROM (
        SELECT resolution_fix AS fix, COUNT(*) AS n, MAX(resolved_at) AS last_at, CAST(MAX(CAST(resolution_fix_id AS char(36))) AS uniqueidentifier) AS fix_id
          FROM alerts WHERE issue_type_id = $1 AND resolution_fix IS NOT NULL AND resolved_at > DATEADD(day, -${WINDOW_DAYS}, SYSUTCDATETIME()) GROUP BY resolution_fix) g
       LEFT JOIN known_fixes k ON k.id = g.fix_id AND k.removed_at IS NULL AND k.status = 'approved'
      ORDER BY g.n DESC, g.last_at DESC`, [issueTypeId])).rows;
  const recent = (await db.query<{ id: string; cabinet_id: string; cabinet: string; by: string | null; resolved_at: Date; cause: string | null; fix: string | null }>(
    `SELECT TOP (5) a.id, a.cabinet_id, k.name AS cabinet, u.name AS [by], a.resolved_at, a.resolution_cause AS cause, a.resolution_fix AS fix
       FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id LEFT JOIN users u ON u.id = a.resolved_by
      WHERE a.issue_type_id = $1 AND a.state = 'resolved' AND (a.resolution_cause IS NOT NULL OR a.resolution_fix IS NOT NULL) ORDER BY a.resolved_at DESC`, [issueTypeId])).rows;
  return { issueTypeId, resolved: Number(counts.resolved ?? 0), withFix: Number(counts.with_fix ?? 0),
    fixes: fixes.map(f => ({ fix: f.fix, count: Number(f.n), lastAt: f.last_at.toISOString(), fixId: f.fix_id, solution: f.solution })),
    recent: recent.map(r => ({ alertId: r.id, cabinet: { id: r.cabinet_id, name: r.cabinet }, resolvedBy: r.by, resolvedAt: r.resolved_at.toISOString(), cause: r.cause, fix: r.fix })) };
}

/** The composed text of the case note a resolution writes: who fixed what, how, in one place on the cabinet. */
export function resolutionNoteText(r: { cause?: string | undefined; fix?: string | undefined; note?: string | undefined; title: string }): string {
  const parts = [`Resolved: ${r.title}.`];
  if (r.cause) parts.push(`Cause: ${r.cause}`);
  if (r.fix) parts.push(`Fix: ${r.fix}`);
  if (r.note) parts.push(`Note: ${r.note}`);
  return parts.join(" ").slice(0, 2000);
}
