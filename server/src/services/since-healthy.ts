// "What changed since it was healthy", answered in one read (F8.R4, decision-log D44): the health (state, last known healthy, when the
// problem was first observed), the drift from the baseline in force, the comparison with the last healthy mark (what differs now, and what
// changed and came back, F8.R3), and the configuration changes recorded since the mark, ranked by how close they are to the moment the
// cabinet stopped being healthy. Closeness is only that: nothing here says a change caused the problem.
import type { Queryable } from "../db/db.js";
import { driftFor } from "./baseline-drift.js";
import { compareWithHealthy, lastKnownHealthy } from "./cabinet-health.js";

export interface RankedChange {
  category: string; key: string; change: string; fields: Record<string, { before: unknown; after: unknown }>;
  /** When it happened, as exactly as is known: the exact time, else the end of the window it is known to have happened in. */
  at: string; notBefore: string | null; exact: boolean; viaPlatform: boolean; violatesBaseline: boolean;
  /** Minutes from the transition: negative before it, positive after; null while there is no transition to measure from. */
  minutesFromProblem: number | null;
}

/** The most changes the ranked list carries; the History view has the rest. */
export const SINCE_HEALTHY_LIMIT = 200;

/**
 * Ranks by closeness to the problem's start: the smallest distance first, and at an equal distance one before the problem ahead of one
 * after it (a cause comes before its effect). With no problem to measure from, the newest first.
 */
export function rankChanges(changes: RankedChange[]): RankedChange[] {
  return [...changes].sort((a, b) => {
    if (a.minutesFromProblem === null || b.minutesFromProblem === null) return a.at < b.at ? 1 : a.at > b.at ? -1 : 0;
    const d = Math.abs(a.minutesFromProblem) - Math.abs(b.minutesFromProblem);
    if (d !== 0) return d;
    return a.minutesFromProblem - b.minutesFromProblem;
  });
}

/**
 * Why there is nothing to compare with (F8.R5, decision-log D45), or null when there is something: the health evaluation's reason when the
 * cabinet was never judged healthy (not evaluated, no configuration, no approved baseline, never healthy); "no_mark" when it was healthy
 * but no mark is kept; "versions_pruned" when a mark is kept but none of its configuration is any more. Never a bare "nothing".
 */
export type NothingToCompare = "not_evaluated" | "no_configuration" | "no_baseline" | "never_healthy" | "no_mark" | "versions_pruned";
export async function nothingToCompare(db: Queryable, cabinetId: string, comparison: Awaited<ReturnType<typeof compareWithHealthy>>): Promise<NothingToCompare | null> {
  if (comparison) {
    const marked = (await db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM healthy_marks m JOIN cabinet_health h ON h.last_mark_id = m.id CROSS APPLY OPENJSON(m.versions) v WHERE h.cabinet_id = $1", [cabinetId])).rows[0];
    const categories = Number(marked?.n ?? 0);
    return categories > 0 && comparison.unavailable.length >= categories ? "versions_pruned" : null;
  }
  const lastHealthy = await lastKnownHealthy(db, cabinetId);
  return lastHealthy.reason ?? "no_mark";
}

export async function sinceHealthy(db: Queryable, cabinetId: string) {
  const h = (await db.query<{ state: string; degraded_since: Date | null }>("SELECT state, degraded_since FROM cabinet_health WHERE cabinet_id = $1", [cabinetId])).rows[0];
  const lastHealthy = await lastKnownHealthy(db, cabinetId);
  const comparison = await compareWithHealthy(db, cabinetId);
  const problem = h?.state !== "healthy" ? h?.degraded_since ?? null : null;
  // The changes since the healthy mark; with no mark, since the last healthy time; with neither, none (there is no "since").
  const from = comparison ? new Date(comparison.markedAt) : lastHealthy.at ? new Date(lastHealthy.at) : null;
  const rows = from ? (await db.query<{ category: string; item_key: string; change: string; fields: RankedChange["fields"]; not_before: Date | null; observed_at: Date; exact_at: Date | null; via_platform: boolean; violates_baseline: boolean }>(
    `SELECT TOP (${SINCE_HEALTHY_LIMIT * 2}) category, item_key, change, fields, not_before, observed_at, exact_at, via_platform, violates_baseline FROM config_changes
      WHERE cabinet_id = $1 AND observed_at > $2 ORDER BY observed_at DESC`, [cabinetId, from])).rows : [];
  const changes = rankChanges(rows.map(r => {
    const at = r.exact_at ?? r.observed_at;
    return { category: r.category, key: r.item_key, change: r.change, fields: r.fields, at: at.toISOString(), notBefore: r.not_before?.toISOString() ?? null, exact: r.exact_at !== null,
      viaPlatform: !!r.via_platform, violatesBaseline: !!r.violates_baseline,
      minutesFromProblem: problem ? Math.round((at.getTime() - problem.getTime()) / 60_000) : null };
  })).slice(0, SINCE_HEALTHY_LIMIT);
  return {
    health: { state: h?.state ?? "unknown", lastHealthy, problemFirstObserved: problem?.toISOString() ?? null },
    drift: await driftFor(db, cabinetId),
    sinceMark: comparison, nothingToCompare: await nothingToCompare(db, cabinetId, comparison),
    changes, changesFrom: from?.toISOString() ?? null,
  };
}
