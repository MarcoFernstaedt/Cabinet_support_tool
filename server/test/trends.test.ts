// The trend arithmetic and the drive rules, with plain numbers: what is flagged, at what level, and what is not.
import test from "node:test";
import assert from "node:assert/strict";
import { assessDrive, daysUntil, daysUntilEmpty, DEFAULT_DRIVE_THRESHOLDS, riskClass, slopePerDay, thresholdProblem, type DriveSample } from "../src/services/trends.js";

const DAY = 86_400_000, T0 = Date.UTC(2026, 0, 1);
const sample = (day: number, o: Partial<DriveSample> = {}): DriveSample => ({ at: T0 + day * DAY, health: "healthy", predictFailure: false, temperature: 38, reallocated: 0, pending: 0, uncorrectable: 0, wear: 10, ...o });
const series = (days: number, f: (day: number) => Partial<DriveSample>) => Array.from({ length: days + 1 }, (_, d) => sample(d, f(d)));

test("slope is per day, needs enough points over enough time, and ignores nothing silently", () => {
  const rising = Array.from({ length: 10 }, (_, d) => ({ t: T0 + d * DAY, v: 5 + 2 * d }));
  assert.ok(Math.abs(slopePerDay(rising)! - 2) < 1e-9);
  assert.equal(slopePerDay(rising.slice(0, 3)), null, "three points are not a trend");
  assert.equal(slopePerDay(Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * 60_000, v: i }))), null, "ten minutes is not a trend");
  assert.equal(slopePerDay([{ t: T0, v: 1 }, { t: T0, v: 2 }, { t: T0, v: 3 }, { t: T0, v: 4 }]), null, "no time at all");
  assert.ok(Math.abs(slopePerDay(rising.map(p => ({ ...p, v: 100 - p.v })))! + 2) < 1e-9);
});

test("days until a limit or until empty", () => {
  assert.equal(daysUntil(100, 90, 2), 5);
  assert.equal(daysUntil(100, 90, 0), null);
  assert.equal(daysUntil(100, 90, -1), null);
  assert.equal(daysUntil(100, 100, null), 0);
  assert.equal(daysUntilEmpty(30, -3), 10);
  assert.equal(daysUntilEmpty(30, 3), null);
  assert.equal(daysUntilEmpty(0, null), 0);
});

test("a healthy, steady drive raises nothing", () => {
  const a = assessDrive(series(60, () => ({})));
  assert.equal(a.level, "ok"); assert.deepEqual(a.reasons, []);
  assert.equal(assessDrive([]).level, "ok");
});

test("the drive's own prediction or a failing health is urgent at once, from a single sample", () => {
  assert.equal(assessDrive([sample(0, { predictFailure: true })]).level, "urgent");
  assert.equal(assessDrive([sample(0, { health: "failing" })]).level, "urgent");
  assert.equal(assessDrive([sample(0, { health: "warning" })]).level, "watch");
});

test("reallocated sectors: steady is a watch, new ones this week are act, a run of them this month is urgent", () => {
  assert.equal(assessDrive(series(40, d => ({ reallocated: 4 }))).level, "watch");
  assert.equal(assessDrive(series(40, d => ({ reallocated: d < 36 ? 4 : 5 }))).level, "act");
  const run = assessDrive(series(40, d => ({ reallocated: d < 20 ? 0 : (d - 19) * 2 })));
  assert.equal(run.level, "urgent");
  assert.ok(run.projection.reallocatedPer30Days! >= 8);
});

test("pending and uncorrectable sectors are never ignored, and rising ones are urgent", () => {
  assert.equal(assessDrive(series(40, () => ({ pending: 2 }))).level, "act");
  assert.equal(assessDrive(series(40, d => ({ uncorrectable: d > 30 ? 3 : 0 }))).level, "urgent");
});

test("wear: the level, and the projection from the rate it is rising at", () => {
  assert.equal(assessDrive(series(60, () => ({ wear: 82 }))).level, "watch");
  assert.equal(assessDrive(series(60, () => ({ wear: 91 }))).level, "act");
  assert.equal(assessDrive(series(60, () => ({ wear: 96 }))).level, "urgent");
  // 40% to 70% over 60 days is 0.5% a day: 60 days to go from 70 is 60 days.
  const fast = assessDrive(series(60, d => ({ wear: 40 + d * 0.5 })));
  assert.equal(fast.level, "urgent"); assert.equal(fast.projection.wearFullInDays, 60);
  const slow = assessDrive(series(60, d => ({ wear: 20 + d * 0.1 })));
  assert.equal(slow.level, "ok", "a drive wearing slowly is fine");
  assert.ok(assessDrive(series(60, d => ({ wear: 40 + d * 0.3 }))).reasons.some(r => r.code === "wear_projection" && r.level === "act"));
  assert.equal(assessDrive(series(5, d => ({ wear: 40 + d * 5 }))).projection.wearFullInDays, null, "five days is too little history to project");
});

test("temperature: hot is a watch, very hot is act, and a steady climb is noticed", () => {
  assert.equal(assessDrive(series(10, () => ({ temperature: 62 }))).level, "watch");
  assert.equal(assessDrive(series(10, () => ({ temperature: 72 }))).level, "act");
  assert.equal(assessDrive(series(40, d => ({ temperature: d < 20 ? 35 : 47 }))).reasons[0]!.code, "temperature_rise");
});

test("missing values (a drive that reports little) are neither a problem nor a crash", () => {
  const blank = series(20, () => ({ temperature: null, reallocated: null, pending: null, uncorrectable: null, wear: null }));
  const a = assessDrive(blank);
  assert.equal(a.level, "ok"); assert.equal(a.projection.wearFullInDays, null);
});

test("samples may arrive in any order", () => {
  const s = series(40, d => ({ reallocated: d < 20 ? 0 : (d - 19) * 2 }));
  assert.equal(assessDrive([...s].reverse()).level, assessDrive(s).level);
});

test("the named risk classes: Healthy, Attention, High risk, Critical, and Unknown for a drive with no report", () => {
  assert.equal(riskClass("ok"), "healthy");
  assert.equal(riskClass("watch"), "attention");
  assert.equal(riskClass("act"), "high_risk");
  assert.equal(riskClass("urgent"), "critical");
  for (const none of [null, undefined, "bogus" as never]) assert.equal(riskClass(none), "unknown", String(none));
});

test("an Admin's thresholds move the line: the same drive changes class with them, and the defaults are today's", () => {
  const t = { ...DEFAULT_DRIVE_THRESHOLDS };
  assert.equal(assessDrive(series(10, () => ({ wear: 85 }))).level, "watch");
  assert.equal(assessDrive(series(10, () => ({ wear: 85 })), { ...t, wearAttentionPct: 86 }).level, "ok", "85% is fine when Attention starts at 86%");
  assert.equal(assessDrive(series(10, () => ({ temperature: 66 }))).level, "watch");
  assert.equal(assessDrive(series(10, () => ({ temperature: 66 })), { ...t, temperatureHighRiskC: 65 }).level, "act", "a cabinet that must run cooler");
  // One new reallocated sector this week is High risk by default; an Admin can ask for more before it is.
  const oneNew = series(30, d => ({ reallocated: d < 28 ? 4 : 5 }));
  assert.equal(assessDrive(oneNew).level, "act");
  assert.equal(assessDrive(oneNew, { ...t, reallocatedHighRiskPer7Days: 3 }).level, "watch");
});

test("a set of thresholds whose steps do not rise is refused", () => {
  assert.equal(thresholdProblem(DEFAULT_DRIVE_THRESHOLDS), null);
  const t = { ...DEFAULT_DRIVE_THRESHOLDS };
  for (const bad of [{ wearHighRiskPct: 80 }, { wearCriticalPct: 90 }, { wearDaysCritical: 180 }, { temperatureAttentionC: 70 }, { reallocatedCriticalPer30Days: 0 }])
    assert.notEqual(thresholdProblem({ ...t, ...bad }), null, JSON.stringify(bad));
});
