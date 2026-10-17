// Trend arithmetic and the rules that turn a drive's history into a level of concern. Pure functions over numbers: no database, no
// pattern matching, so every rule can be tested with plain values. The levels: ok, watch (look at it), act (plan a replacement), urgent
// (back up and replace now).

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

export interface DriveSample {
  at: number;
  health: "healthy" | "warning" | "failing" | "unknown";
  predictFailure: boolean | null;
  temperature: number | null;
  reallocated: number | null;
  pending: number | null;
  uncorrectable: number | null;
  wear: number | null;
}
export type Level = "ok" | "watch" | "act" | "urgent";
export interface Reason { code: string; level: Level; text: string }
export interface Assessment { level: Level; reasons: Reason[]; projection: { wearFullInDays: number | null; reallocatedPer30Days: number | null; temperatureRise30Days: number | null } }

const RANK: Record<Level, number> = { ok: 0, watch: 1, act: 2, urgent: 3 };
export const higher = (a: Level, b: Level): boolean => RANK[a] > RANK[b];
const worst = (rs: Reason[]): Level => rs.reduce<Level>((l, r) => (higher(r.level, l) ? r.level : l), "ok");

/** The value `days` before the newest sample, from the newest sample at or before that time; the oldest sample if the history is shorter. */
function before(samples: DriveSample[], days: number, pick: (s: DriveSample) => number | null): number | null {
  const newest = samples[samples.length - 1]!.at, target = newest - days * DAY;
  let found: number | null = null;
  for (const s of samples) { const v = pick(s); if (v === null) continue; if (s.at <= target) found = v; else if (found === null) found = v; }
  return found;
}

/** What one drive's history says. `samples` are oldest first. */
export function assessDrive(samples: readonly DriveSample[]): Assessment {
  const s = [...samples].sort((a, b) => a.at - b.at);
  const none: Assessment = { level: "ok", reasons: [], projection: { wearFullInDays: null, reallocatedPer30Days: null, temperatureRise30Days: null } };
  if (s.length === 0) return none;
  const now = s[s.length - 1]!;
  const reasons: Reason[] = [];
  const add = (code: string, level: Level, text: string) => reasons.push({ code, level, text });

  if (now.predictFailure === true) add("predicts_failure", "urgent", "The drive's own self-monitoring predicts it will fail.");
  if (now.health === "failing") add("health_failing", "urgent", "Windows reports the drive as failing.");
  else if (now.health === "warning") add("health_warning", "watch", "Windows reports a warning for the drive.");

  const grew = (pick: (x: DriveSample) => number | null, days: number) => { const was = before(s, days, pick), is = pick(now); return was !== null && is !== null ? is - was : 0; };
  for (const [code, label, pick] of [["uncorrectable", "uncorrectable errors", (x: DriveSample) => x.uncorrectable], ["pending", "sectors waiting to be reallocated", (x: DriveSample) => x.pending]] as const) {
    const value = pick(now) ?? 0;
    if (value > 0) add(code, grew(pick, 30) > 0 ? "urgent" : "act", `${value.toLocaleString("en-US")} ${label}${grew(pick, 30) > 0 ? ", and the number is rising" : ""}.`);
  }

  const reallocated = now.reallocated ?? 0;
  const g30 = grew(x => x.reallocated, 30), g7 = grew(x => x.reallocated, 7);
  if (reallocated > 0) {
    if (g30 >= 8) add("reallocated_rising", "urgent", `${reallocated.toLocaleString("en-US")} reallocated sectors, ${g30} more in the last 30 days.`);
    else if (g7 >= 1) add("reallocated_rising", "act", `${reallocated.toLocaleString("en-US")} reallocated sectors, ${g7} more in the last 7 days.`);
    else add("reallocated", "watch", `${reallocated.toLocaleString("en-US")} reallocated sectors, steady.`);
  }

  let wearFullInDays: number | null = null;
  if (now.wear !== null) {
    wearFullInDays = daysUntil(100, now.wear, slopePerDay(s.filter(x => x.wear !== null).map(x => ({ t: x.at, v: x.wear! })), 4, 14));
    if (now.wear >= 95) add("wear", "urgent", `${now.wear}% of the drive's rated life is used.`);
    else if (now.wear >= 90) add("wear", "act", `${now.wear}% of the drive's rated life is used.`);
    else if (now.wear >= 80) add("wear", "watch", `${now.wear}% of the drive's rated life is used.`);
    if (wearFullInDays !== null && now.wear < 95) {
      const days = Math.round(wearFullInDays);
      if (wearFullInDays <= 60) add("wear_projection", "urgent", `At its recent rate the drive reaches its rated life in about ${days} days.`);
      else if (wearFullInDays <= 180) add("wear_projection", "act", `At its recent rate the drive reaches its rated life in about ${days} days.`);
    }
  }

  const rise = (() => { const was = before(s, 30, x => x.temperature), is = now.temperature; return was !== null && is !== null ? is - was : null; })();
  if (now.temperature !== null && now.temperature >= 70) add("temperature", "act", `The drive is at ${now.temperature} °C.`);
  else if (now.temperature !== null && now.temperature >= 60) add("temperature", "watch", `The drive is at ${now.temperature} °C.`);
  else if (rise !== null && rise >= 10) add("temperature_rise", "watch", `The drive is ${rise} °C hotter than 30 days ago.`);

  return { level: worst(reasons), reasons, projection: { wearFullInDays: wearFullInDays === null ? null : Math.round(wearFullInDays), reallocatedPer30Days: reallocated > 0 ? g30 : null, temperatureRise30Days: rise } };
}
