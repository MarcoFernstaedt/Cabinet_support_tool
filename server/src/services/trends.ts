// Trend arithmetic: pure functions over numbers, no database and no pattern matching, so each can be tested with plain values. The
// free-space forecast (disk-forecast.ts) uses them.

const DAY = 86_400_000;

export interface Point { t: number; v: number }

/** Least-squares slope in units per day, or null when there are too few points or they cover too little time to mean anything. */
export function slopePerDay(points: readonly Point[], minPoints = 4, minSpanDays = 2): number | null {
  if (points.length < minPoints) return null;
  const first = Math.min(...points.map(p => p.t)), last = Math.max(...points.map(p => p.t));
  if ((last - first) / DAY < minSpanDays) return null;
  const n = points.length, mt = points.reduce((s, p) => s + p.t, 0) / n, mv = points.reduce((s, p) => s + p.v, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.t - mt) * (p.v - mv); den += (p.t - mt) ** 2; }
  return den === 0 ? null : (num / den) * DAY;
}

/** Days until a rising value reaches a limit at its current slope; null when it is not rising, or is already there (0). */
export function daysUntil(limit: number, current: number, slope: number | null): number | null {
  if (current >= limit) return 0;
  if (slope === null || slope <= 0) return null;
  return (limit - current) / slope;
}

/** Days until a falling value (free space) reaches zero; null when it is not falling. */
export function daysUntilEmpty(current: number, slope: number | null): number | null {
  if (current <= 0) return 0;
  if (slope === null || slope >= 0) return null;
  return current / -slope;
}
