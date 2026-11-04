import test from "node:test";
import assert from "node:assert/strict";
import { noLogText, nvmeVerdict, repairBadge, repairText, type CriticalWarnings } from "../src/lib/storage-health.ts";

const none: CriticalWarnings = { spareBelowThreshold: false, temperatureOutOfRange: false, reliabilityDegraded: false, readOnly: false, volatileBackupFailed: false, persistentMemoryReadOnly: false };
const log = (w: Partial<CriticalWarnings> = {}, mediaErrors = 0) => ({ criticalWarnings: { ...none, ...w }, mediaErrors, percentageUsed: 4, temperatureCelsius: 40 });

test("a drive with no warnings and no errors is fine", () => {
  assert.deepEqual(nvmeVerdict(log()), { tone: "ok", lines: [] });
});

test("any warning about the drive's own health is critical, worst first", () => {
  const v = nvmeVerdict(log({ spareBelowThreshold: true, readOnly: true }, 3));
  assert.equal(v.tone, "crit");
  assert.equal(v.lines.length, 3);
  assert.match(v.lines[0]!, /read-only/);
  assert.match(v.lines[2]!, /^3 unrecovered/);
});

test("heat or media errors alone are a warning, not a failing drive", () => {
  assert.equal(nvmeVerdict(log({ temperatureOutOfRange: true })).tone, "warn");
  assert.equal(nvmeVerdict(log({}, 1)).tone, "warn");
  assert.match(nvmeVerdict(log({}, 1)).lines[0]!, /^1 unrecovered data error$/);
});

test("repair states read as the chkdsk they need, and the dirty bit is said", () => {
  assert.equal(repairText("none", false), null);
  assert.equal(repairText("unknown", null), null);
  assert.match(repairText("spot_fix_needed", false)!, /spotfix/);
  assert.match(repairText("full_repair_needed", true)!, /full repair.*next start/);
  assert.equal(repairText("none", true), "Windows will check it at the next start");
});

test("a drive without a log says why", () => {
  assert.match(noLogText("not_nvme"), /Not an NVMe/);
  assert.match(noLogText("not_supported"), /driver/);
  assert.equal(noLogText(null), "Not read");
  assert.equal(noLogText("anything else"), "Not read");
});

test("a volume's badge follows its repair state, and anything unexpected is unknown", () => {
  assert.deepEqual(repairBadge("none"), ["ok", "Healthy"]);
  assert.equal(repairBadge("scan_needed")[0], "warn");
  assert.equal(repairBadge("spot_fix_needed")[0], "warn");
  assert.equal(repairBadge("full_repair_needed")[0], "crit");
  for (const odd of ["unknown", "", "healthy", "<b>x</b>"]) assert.deepEqual(repairBadge(odd), ["off", "Unknown"], odd);
});
