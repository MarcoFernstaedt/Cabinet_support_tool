// Crash signatures (decision-log D26) without React: how a kind of blue screen is trending.

/** Whether a kind of blue screen is growing: crashes in the last 24 hours against the 24 before. Counts that are not whole and non-negative read as unknown. */
export function trendText(r: { lastDay: number; dayBefore: number }): string {
  const ok = (n: number) => Number.isInteger(n) && n >= 0;
  if (!ok(r.lastDay) || !ok(r.dayBefore)) return "unknown";
  if (r.lastDay === 0) return r.dayBefore === 0 ? "none in the last two days" : `none in the last day, down from ${r.dayBefore}`;
  if (r.dayBefore === 0) return `${r.lastDay} in the last day, none the day before`;
  if (r.lastDay === r.dayBefore) return `${r.lastDay} in the last day, the same as the day before`;
  return `${r.lastDay} in the last day, ${r.lastDay > r.dayBefore ? "up" : "down"} from ${r.dayBefore}`;
}
