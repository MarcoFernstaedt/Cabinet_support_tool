// The USB alert rules on the server: device absent, reconnect flap and dependency detached, with the severity each
// carries, the automatic resolution when the unit returns, quiet hours and the rate limit on repeats
// (docs/spec/18-built-designs.md §5).
//
// Includes hostile input: a report that fails the contract, a unit the cabinet has never seen, an absence with no
// evidence of when it began, a reconnect count the cabinet cannot vouch for, telemetry that went missing, and a report
// that asks for 25 dependency incidents at once.
import test from "node:test";
import assert from "node:assert/strict";
import { parseUsbWatchPolicy, type UsbPolicy, type UsbPolicyLevel } from "../src/services/usb-policy.js";
import {
  USB_DEPENDENCY_INCIDENT_CAP, USB_RESOLUTION_TEXT, checkUsbDeviceReport, evaluateUsbReport, evaluateUsbWatch,
  usbAlertWork, usbIncidentKey, usbQuietHoursState,
  type UsbDeviceReport, type UsbIssueTypeInfo, type UsbOpenIncident, type UsbWorkloadEntry,
} from "../src/services/usb-rules.js";

const NOW = new Date("2026-07-01T21:05:00.000Z");
const CABINET = "6f1d1f9e-3d3a-4a5b-8f0e-1b2c3d4e5f60";

const policy = (over: Record<string, unknown> = {}): UsbPolicy => parseUsbWatchPolicy({
  identityKey: { kind: "device", value: "UNIT-1", confidence: "high" },
  enabled: true,
  absentForMinutes: 5,
  reconnect: { count: 3, windowMinutes: 10 },
  quietHours: null,
  severity: {},
  autoRestart: false,
  ...over,
});

const device = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  unitKey: "UNIT-1",
  portKey: "SLOT-9",
  parentKey: null,
  parentRootCause: "none",
  identity: "serial",
  identityConfidence: "high",
  state: "present",
  portDisplay: "Port_#0002.Hub_#0003",
  firstSeenAt: "2026-07-01T08:00:00.000Z",
  lastSeenAt: "2026-07-01T21:00:00.000Z",
  firstAbsentAt: null,
  reconnectCount: 0,
  reconnectWindowMinutes: 10,
  cyclesAreLowerBound: false,
  healthySamples: 2,
  workload: [],
  workloadProbe: "none",
  ...over,
});

const report = (devices: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  cabinetId: CABINET,
  bootId: "0f1d1f9e-3d3a-4a5b-8f0e-1b2c3d4e5f61",
  reportedAt: "2026-07-01T21:05:00.000Z",
  monitorState: "present",
  settled: true,
  eventHistoryComplete: true,
  sweepSeconds: 60,
  devices,
  ...over,
});

const entry = (over: Partial<UsbWorkloadEntry> = {}): UsbWorkloadEntry => ({ kind: "probe", name: "ScanHost.exe", state: "detached", ...over });

const catalog = (extra: [string, UsbIssueTypeInfo][] = []): Map<string, UsbIssueTypeInfo> => new Map([
  ["usb_missing", { id: "id-missing", name: "Expected USB device not detected", severity: "minor" }],
  ["usb_flap", { id: "id-flap", name: "USB device reconnecting repeatedly", severity: "minor" }],
  ["usb_dependency", { id: "id-dependency", name: "Software that uses this USB device is not running", severity: "major" }],
  ...extra,
]);

const levels = (at: UsbPolicy | null, level: "cabinet" | "site" = "cabinet", version = 1): UsbPolicyLevel[] =>
  [{ level, scopeId: level === "cabinet" ? "cab-1" : "site-1", stored: at === null ? null : JSON.stringify({ version, policy: at }) }];

interface RunOptions {
  at?: UsbPolicy | null;
  level?: "cabinet" | "site";
  incidents?: Map<string, UsbOpenIncident>;
  issueTypes?: Map<string, UsbIssueTypeInfo>;
  over?: Record<string, unknown>;
  now?: Date;
}

/** Validates the fixture report the way a route would, then evaluates it: what a heartbeat actually does. */
const run = (devices: unknown[], opts: RunOptions = {}) => {
  const body = report(devices, opts.over ?? {});
  const checked = checkUsbDeviceReport(body);
  assert.equal(checked.ok, true, `the fixture report has to meet the contract: ${checked.ok ? "" : JSON.stringify(checked.issues)}`);
  if (!checked.ok) throw new Error("unreachable");
  return evaluateUsbWatch({
    cabinetId: CABINET,
    now: opts.now ?? NOW,
    report: checked.report,
    levels: levels(opts.at === undefined ? policy() : opts.at, opts.level ?? "cabinet"),
    incidents: opts.incidents ?? new Map(),
    issueTypes: opts.issueTypes ?? catalog(),
  });
};

const openIncident = (over: Partial<UsbOpenIncident> = {}): UsbOpenIncident => ({ severity: "minor", occurrences: 1, lastUpdateAt: null, ...over });

test("a report the contract accepts is read, and one that breaks it is refused field by field", () => {
  assert.equal(checkUsbDeviceReport(report([device()])).ok, true);
  const issues = (body: unknown) => {
    const checked = checkUsbDeviceReport(body);
    assert.equal(checked.ok, false, "expected the contract to refuse this report");
    return checked.ok ? [] : checked.issues;
  };
  assert.deepEqual(issues(report([]))[0], { field: "/devices", rule: "minItems" });
  assert.deepEqual(issues(report([device()], { monitorState: "fine" }))[0], { field: "/monitorState", rule: "enum" });
  assert.deepEqual(issues(report([device()], { settled: "yes" }))[0], { field: "/settled", rule: "type" });
  assert.deepEqual(issues(report([device()], { devices: "all of them" }))[0], { field: "/devices", rule: "type" });
  assert.deepEqual(issues(report([device({ reconnectCount: -1 })]))[0], { field: "/devices/0/reconnectCount", rule: "minimum" });
  assert.deepEqual(issues(report([device({ unitKey: "" })]))[0], { field: "/devices/0/unitKey", rule: "minLength" });
  assert.deepEqual(issues(report([device({ state: "gone" })]))[0], { field: "/devices/0/state", rule: "enum" });
  assert.deepEqual(issues(report([device({ workload: [entry({ name: "Scan\nHost" })] })]))[0], { field: "/devices/0/workload/0/name", rule: "pattern" });
  assert.deepEqual(issues(report([device({ workload: [entry({ kind: "daemon" as never })] })]))[0], { field: "/devices/0/workload/0/kind", rule: "enum" });
  assert.deepEqual(issues(report([device({ mystery: 1 })]))[0], { field: "/devices/0/<unexpected field>", rule: "additionalProperties" });
  assert.deepEqual(issues(report([device()], { sweepSeconds: 5 }))[0], { field: "/sweepSeconds", rule: "minimum" });
  const proto = JSON.parse(`{"__proto__":{"polluted":true},${JSON.stringify(report([device()])).slice(1)}`) as unknown;
  assert.deepEqual(issues(proto)[0], { field: "/<unexpected field>", rule: "additionalProperties" });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const crowd = Array.from({ length: 257 }, () => device());
  assert.deepEqual(issues(report(crowd))[0], { field: "/devices", rule: "maxItems" });
});

test("a unit no scope watches alerts on nothing, and says so", () => {
  const other = policy({ identityKey: { kind: "device", value: "SOMEONE-ELSE", confidence: "high" } });
  const result = run([device({ state: "absent", firstAbsentAt: "2026-07-01T20:00:00.000Z" })], { at: other });
  assert.deepEqual(result.decisions, []);
  assert.deepEqual(result.holds, [{ unitKey: "UNIT-1", ruleId: null, reason: "unwatched" }]);
  assert.equal(result.resolutions[0]?.resolution, null);
});

test("a policy switched off at the scope that wins alerts on nothing, whatever a broader scope says", () => {
  const result = run([device({ state: "absent", firstAbsentAt: "2026-07-01T20:00:00.000Z" })], { at: policy({ enabled: false }) });
  assert.deepEqual(result.decisions, []);
  assert.equal(result.holds[0]?.reason, "disabled");
});

test("the agent's own state has the last word: degraded, unsettled and never-seen units decide nothing", () => {
  const absent = device({ state: "absent", firstAbsentAt: "2026-07-01T20:00:00.000Z" });
  const degraded = run([absent], { over: { monitorState: "degraded" } });
  assert.equal(degraded.holds[0]?.reason, "source_unknown");
  assert.deepEqual(degraded.decisions, []);
  const unknownMonitor = run([absent], { over: { monitorState: "unknown" } });
  assert.equal(unknownMonitor.holds[0]?.reason, "source_unknown");
  const settling = run([absent], { over: { settled: false } });
  assert.equal(settling.holds[0]?.reason, "settling");
  assert.deepEqual(settling.decisions, []);
  // An automatic scanner nobody has ever seen is not an absent device, however long it is missing.
  const neverSeen = run([device({ state: "absent", firstSeenAt: null, lastSeenAt: null, firstAbsentAt: "2026-06-01T00:00:00.000Z" })]);
  assert.equal(neverSeen.holds[0]?.reason, "never_seen");
  assert.deepEqual(neverSeen.decisions, []);
});

test("an absent unit opens one incident at the threshold, and waits below it", () => {
  const young = run([device({ state: "absent", firstAbsentAt: "2026-07-01T21:01:00.000Z" })]);
  assert.deepEqual(young.decisions, []);
  assert.equal(young.holds.some(h => h.ruleId === "usb-absent" && h.reason === "waiting"), true);

  const ripe = run([device({ state: "absent", firstAbsentAt: "2026-07-01T20:59:00.000Z" })]);
  assert.equal(ripe.decisions.length, 1);
  const opened = ripe.decisions[0];
  assert.equal(opened?.ruleId, "usb-absent");
  assert.equal(opened?.action, "open");
  assert.equal(opened?.incidentKey, "usb:absent:UNIT-1");
  assert.equal(opened?.issueKey, "usb_missing");
  assert.equal(opened?.issueTypeId, "id-missing");
  assert.equal(opened?.severity, "minor");
  assert.equal(opened?.title, "Expected USB device not detected: Port_#0002.Hub_#0003");
  assert.equal(opened?.absentSince, "2026-07-01T20:59:00.000Z");
  assert.equal(opened?.delivery, "immediate");
  assert.equal(opened?.renotify, true);
  assert.equal(opened?.occurrences, 1);
  assert.equal(opened?.policyScope.level, "cabinet");
  assert.equal(opened?.policyScope.version, 1);
  assert.equal(opened?.restartRequested, false);
});

test("the absence is timed from evidence of it, never from a missing field", () => {
  // No firstAbsentAt, but the unit was last seen present 10 minutes ago: the absence began somewhere after that, so
  // waiting from there can only make the wait longer than the real one.
  const fromLastSeen = run([device({ state: "absent", firstAbsentAt: null, lastSeenAt: "2026-07-01T20:55:00.000Z" })]);
  assert.equal(fromLastSeen.decisions[0]?.action, "open");
  assert.equal(fromLastSeen.decisions[0]?.absentSince, "2026-07-01T20:55:00.000Z");
  // Neither moment of evidence: nothing can be concluded about when it began.
  const noEvidence = run([device({ state: "absent", firstAbsentAt: null, lastSeenAt: null })]);
  assert.deepEqual(noEvidence.decisions, []);
  assert.equal(noEvidence.holds.some(h => h.ruleId === "usb-absent" && h.reason === "uncertain"), true);
});

test("a unit that comes back closes its incident, after two healthy samples and never on missing telemetry", () => {
  const incidents = new Map([["usb:absent:UNIT-1", openIncident({ occurrences: 4, lastUpdateAt: new Date("2026-07-01T20:00:00.000Z") })]]);
  const oneSample = run([device({ healthySamples: 1 })], { incidents });
  assert.deepEqual(oneSample.decisions, []);
  assert.equal(oneSample.holds.some(h => h.ruleId === "usb-absent" && h.reason === "recovery_pending"), true);

  const back = run([device({ healthySamples: 2 })], { incidents });
  assert.equal(back.decisions.length, 1);
  assert.equal(back.decisions[0]?.action, "resolve");
  assert.equal(back.decisions[0]?.occurrences, 4, "a resolution carries the incident it closes");
  assert.equal(back.decisions[0]?.absentSince, null);

  // Still away: the incident stays open and nothing resolves it.
  const stillAway = run([device({ state: "absent", firstAbsentAt: "2026-07-01T21:04:00.000Z" })], { incidents });
  assert.equal(stillAway.decisions.some(d => d.action === "resolve"), false);
  // Neither here nor gone: the unit is coming back, which proves nothing yet.
  const recovering = run([device({ state: "recovering" })], { incidents });
  assert.equal(recovering.decisions.some(d => d.action === "resolve"), false);
  assert.equal(recovering.holds.some(h => h.ruleId === "usb-absent" && h.reason === "indeterminate"), true);
  // A degraded agent cannot close an incident either: missing telemetry is not health.
  const degraded = run([device({ healthySamples: 9 })], { incidents, over: { monitorState: "degraded" } });
  assert.equal(degraded.decisions.some(d => d.action === "resolve"), false);
});

test("the reconnect rule fires on N cycles inside Y minutes, and only from a count the cabinet vouches for", () => {
  const flapping = run([device({ reconnectCount: 3 })]);
  assert.equal(flapping.decisions.length, 1);
  assert.equal(flapping.decisions[0]?.ruleId, "usb-flap");
  assert.equal(flapping.decisions[0]?.issueKey, "usb_flap");
  assert.equal(flapping.decisions[0]?.incidentKey, "usb:flap:UNIT-1");
  assert.equal(flapping.decisions[0]?.reconnectCount, 3);

  const below = run([device({ reconnectCount: 2 })]);
  assert.deepEqual(below.decisions, []);
  assert.equal(below.holds.some(h => h.ruleId === "usb-flap" && h.reason === "trigger_gone"), true);

  const partialHistory = run([device({ reconnectCount: 9 })], { over: { eventHistoryComplete: false } });
  assert.deepEqual(partialHistory.decisions, []);
  assert.equal(partialHistory.holds.some(h => h.ruleId === "usb-flap" && h.reason === "lower_bound"), true);

  const lowerBound = run([device({ reconnectCount: 9, cyclesAreLowerBound: true })]);
  assert.deepEqual(lowerBound.decisions, []);
  assert.equal(lowerBound.holds.some(h => h.ruleId === "usb-flap" && h.reason === "lower_bound"), true);

  // A count taken over a longer window says nothing about the policy's window.
  const wrongWindow = run([device({ reconnectCount: 9, reconnectWindowMinutes: 30 })]);
  assert.deepEqual(wrongWindow.decisions, []);
  assert.equal(wrongWindow.holds.some(h => h.ruleId === "usb-flap" && h.reason === "window_too_long"), true);

  // The cabinet did not say how it counted: the policy's window is the assumption it is asked for.
  const noWindow = run([device({ reconnectCount: 3, reconnectWindowMinutes: null })]);
  assert.equal(noWindow.decisions[0]?.action, "open");
});

test("a unit that is away is not flapping, and a flapping one that settles closes its incident", () => {
  const incidents = new Map([["usb:flap:UNIT-1", openIncident()]]);
  const away = run([device({ state: "absent", reconnectCount: 9, firstAbsentAt: "2026-07-01T20:00:00.000Z" })], { incidents });
  assert.equal(away.decisions.some(d => d.ruleId === "usb-flap"), false);
  assert.equal(away.holds.some(h => h.ruleId === "usb-flap" && h.reason === "trigger_gone"), true);

  const settled = run([device({ reconnectCount: 1 })], { incidents });
  const resolved = settled.decisions.find(d => d.ruleId === "usb-flap");
  assert.equal(resolved?.action, "resolve");
  assert.equal(resolved?.incidentKey, "usb:flap:UNIT-1");
});

test("an incident is updated while it lasts, and a repeat inside the rate limit pages nobody again", () => {
  const incidents = new Map([["usb:absent:UNIT-1", openIncident({ occurrences: 2, lastUpdateAt: new Date(NOW.getTime() - 60_000) })]]);
  const soon = run([device({ state: "absent", firstAbsentAt: "2026-07-01T20:00:00.000Z" })], { incidents });
  assert.equal(soon.decisions[0]?.action, "update");
  assert.equal(soon.decisions[0]?.occurrences, 3);
  assert.equal(soon.decisions[0]?.renotify, false);
  const later = run([device({ state: "absent", firstAbsentAt: "2026-07-01T20:00:00.000Z" })], {
    incidents: new Map([["usb:absent:UNIT-1", openIncident({ occurrences: 2, lastUpdateAt: new Date(NOW.getTime() - 60 * 60_000) })]]),
  });
  assert.equal(later.decisions[0]?.renotify, true);
  const first = run([device({ state: "absent", firstAbsentAt: "2026-07-01T20:00:00.000Z" })]);
  assert.equal(first.decisions[0]?.renotify, true, "nothing has been said about this incident yet");
});

test("the dependency rule fires on anything the unit needs that is not attached", () => {
  const detached = run([device({ workload: [entry({ state: "detached" })] })]);
  assert.equal(detached.decisions.length, 1);
  assert.equal(detached.decisions[0]?.ruleId, "usb-dependency");
  assert.equal(detached.decisions[0]?.dependencyName, "ScanHost.exe");
  assert.equal(detached.decisions[0]?.incidentKey, "usb:dependency:UNIT-1:ScanHost.exe");
  assert.equal(detached.decisions[0]?.title, "Software that uses this USB device is not running: Port_#0002.Hub_#0003: ScanHost.exe");
  assert.equal(detached.decisions[0]?.restartRequested, false, "nothing is restarted unless the policy says so");

  const stoppedService = run([device({ workload: [entry({ kind: "service", name: "ScanSvc", state: "stopped" })] })]);
  assert.equal(stoppedService.decisions[0]?.action, "open");
  const missingProcess = run([device({ workload: [entry({ kind: "process", name: "helper.exe", state: "missing" })] })]);
  assert.equal(missingProcess.decisions[0]?.action, "open");
});

test("auto-restart is recorded for an application and asked for by nobody else", () => {
  const asked = run([device({ workload: [entry({ kind: "probe", state: "detached" })] })], { at: policy({ autoRestart: true }) });
  assert.equal(asked.decisions[0]?.restartRequested, true);
  const service = run([device({ workload: [entry({ kind: "service", name: "ScanSvc", state: "stopped" })] })], { at: policy({ autoRestart: true }) });
  assert.equal(service.decisions[0]?.restartRequested, false, "a service that is down is not an application to restart");
});

test("a dependency that is attached again closes its incident, and a running process is not attachment", () => {
  const incidents = new Map([["usb:dependency:UNIT-1:ScanHost.exe", openIncident({ severity: "major" })]]);
  const attached = run([device({ workload: [entry({ state: "attached" })] })], { incidents });
  assert.equal(attached.decisions[0]?.action, "resolve");

  const serviceRunning = run([device({ workload: [entry({ kind: "service", name: "ScanHost.exe", state: "running" })] })], { incidents });
  assert.equal(serviceRunning.decisions[0]?.action, "resolve", "the service state is the best evidence a service entry can give");

  const probeRunning = run([device({ workload: [entry({ kind: "probe", state: "running" })] })], { incidents });
  assert.deepEqual(probeRunning.decisions, []);
  assert.equal(probeRunning.holds.some(h => h.ruleId === "usb-dependency" && h.reason === "trigger_gone"), true);

  // Missing telemetry is neither health nor a detached dependency.
  const unknown = run([device({ workload: [entry({ state: "unknown" })] })], { incidents });
  assert.deepEqual(unknown.decisions, []);
  assert.equal(unknown.holds.some(h => h.ruleId === "usb-dependency"), false);
});

test("a dependency of a unit that is away waits for the unit to come back", () => {
  const incidents = new Map([["usb:dependency:UNIT-1:ScanHost.exe", openIncident()]]);
  const away = run([device({ state: "absent", firstAbsentAt: "2026-07-01T20:00:00.000Z", workload: [entry({ state: "detached" })] })], { incidents });
  assert.equal(away.decisions.some(d => d.ruleId === "usb-dependency"), false);
  assert.equal(away.holds.some(h => h.ruleId === "usb-dependency" && h.reason === "trigger_gone"), true);
});

test("one report cannot open an unbounded number of dependency incidents", () => {
  const crowd = Array.from({ length: 25 }, (_, i) => entry({ name: `helper${i}.exe`, state: "detached" }));
  const result = run([device({ workload: crowd })]);
  assert.equal(result.decisions.length, USB_DEPENDENCY_INCIDENT_CAP);
  assert.equal(result.suppressedDependencies, 5);
});

test("severity comes from the policy when it names one, and from the issue type otherwise", () => {
  const away = run([device({ state: "absent", firstAbsentAt: "2026-07-01T20:00:00.000Z" })]);
  assert.equal(away.decisions.find(d => d.ruleId === "usb-absent")?.severity, "minor");
  const detached = run([device({ workload: [entry({ state: "detached" })] })]);
  assert.equal(detached.decisions.find(d => d.ruleId === "usb-dependency")?.severity, "major", "the dependency issue type is major");
  const byPolicy = run([device({ state: "absent", firstAbsentAt: "2026-07-01T20:00:00.000Z" })], {
    at: policy({ severity: { absent: "major" } }),
  });
  assert.equal(byPolicy.decisions.find(d => d.ruleId === "usb-absent")?.severity, "major");
  const dependency = run([device({ workload: [entry({ state: "detached" })] })], { at: policy({ severity: { dependency: "minor" } }) });
  assert.equal(dependency.decisions.find(d => d.ruleId === "usb-dependency")?.severity, "minor");
  const reconnect = run([device({ reconnectCount: 4 })], { at: policy({ severity: { reconnect: "major" } }) });
  assert.equal(reconnect.decisions.find(d => d.ruleId === "usb-flap")?.severity, "major");
});

test("a rule whose issue type is not seeded cannot fire, whatever the cabinet reports", () => {
  const seeded = catalog();
  seeded.delete("usb_flap");
  const result = run([device({ reconnectCount: 9 })], { issueTypes: seeded });
  assert.deepEqual(result.decisions, []);
  assert.equal(result.holds.some(h => h.ruleId === "usb-flap" && h.reason === "catalog_missing"), true);
});

test("quiet hours read the site's wall clock, and a window the server cannot read is never quiet", () => {
  const window = { timeZone: "Europe/London", startMinute: 22 * 60, endMinute: 6 * 60, weekdays: [1, 2, 3, 4, 5, 6, 7] };
  const inside = usbQuietHoursState(window, new Date("2026-07-01T21:30:00.000Z")); // 22:30 in London
  assert.deepEqual(inside, { active: true, reason: "inside" });
  const outside = usbQuietHoursState(window, new Date("2026-07-01T12:00:00.000Z")); // 13:00 in London
  assert.deepEqual(outside, { active: false, reason: "outside" });
  const smallHours = usbQuietHoursState(window, new Date("2026-07-02T02:00:00.000Z")); // 03:00, past midnight
  assert.equal(smallHours.active, true);
  assert.equal(usbQuietHoursState({ ...window, weekdays: [7] }, new Date("2026-07-01T21:30:00.000Z")).reason, "no_day");
  assert.deepEqual(usbQuietHoursState({ ...window, timeZone: "Mars/Olympus" }, new Date("2026-07-01T21:30:00.000Z")), { active: false, reason: "zone_unknown" });
  assert.deepEqual(usbQuietHoursState(null, new Date("2026-07-01T21:30:00.000Z")), { active: false, reason: "none" });
});

test("quiet hours defer a minor page, never a major one and never a resolution", () => {
  const quiet = { timeZone: "Europe/London", startMinute: 22 * 60, endMinute: 6 * 60, weekdays: [1, 2, 3, 4, 5, 6, 7] };
  const absent = device({ state: "absent", firstAbsentAt: "2026-07-01T20:00:00.000Z" });
  const minor = run([absent], { at: policy({ quietHours: quiet }) });
  assert.equal(minor.decisions[0]?.severity, "minor");
  assert.equal(minor.decisions[0]?.delivery, "deferred");
  assert.equal(minor.decisions[0]?.action, "open", "a deferred page is still opened and still counted");

  const major = run([absent], { at: policy({ quietHours: quiet, severity: { absent: "major" } }) });
  assert.equal(major.decisions[0]?.delivery, "immediate");

  const incidents = new Map([["usb:absent:UNIT-1", openIncident()]]);
  const resolved = run([device({ healthySamples: 2 })], { at: policy({ quietHours: quiet }), incidents });
  assert.equal(resolved.decisions[0]?.action, "resolve");
  assert.equal(resolved.decisions[0]?.delivery, "immediate", "closing an incident is not a page");
});

test("incident keys are one per rule and subject, and follow a slot policy's slot", () => {
  assert.equal(usbIncidentKey("usb-absent", "UNIT-1"), "usb:absent:UNIT-1");
  assert.equal(usbIncidentKey("usb-flap", "UNIT-1"), "usb:flap:UNIT-1");
  assert.equal(usbIncidentKey("usb-dependency", "UNIT-1", "ScanHost.exe"), "usb:dependency:UNIT-1:ScanHost.exe");
  const bySlot = run([device({ state: "absent", firstAbsentAt: "2026-07-01T20:00:00.000Z" })], {
    at: policy({ identityKey: { kind: "port", value: "SLOT-9", confidence: "low" } }),
  });
  assert.equal(bySlot.decisions[0]?.incidentKey, "usb:absent:port:SLOT-9");
  assert.equal(bySlot.decisions[0]?.subject.matchedBy, "port");
});

test("decisions become alert writes and automatic resolutions, and a folded repeat is not paged again", () => {
  const absent = device({ state: "absent", firstAbsentAt: "2026-07-01T20:00:00.000Z" });
  const incidents = new Map([["usb:absent:UNIT-1", openIncident({ occurrences: 1, lastUpdateAt: new Date(NOW.getTime() - 60_000) })]]);
  const result = run([absent], { incidents });
  const work = usbAlertWork(CABINET, result.decisions);
  assert.equal(work.writes.length, 1);
  assert.deepEqual(work.writes[0], {
    cabinetId: CABINET,
    issueTypeId: "id-missing",
    severity: "minor",
    signature: "usb:absent:UNIT-1",
    title: "Expected USB device not detected: Port_#0002.Hub_#0003",
    seenAt: NOW,
    ruleId: null,
    eventId: null,
  });
  assert.deepEqual(work.silent, ["usb:absent:UNIT-1"]);
  assert.deepEqual(work.resolutions, []);

  const back = run([device({ healthySamples: 2 })], { incidents });
  const closing = usbAlertWork(CABINET, back.decisions);
  assert.deepEqual(closing.writes, []);
  assert.deepEqual(closing.resolutions, [{ signature: "usb:absent:UNIT-1", resolution: USB_RESOLUTION_TEXT["usb-absent"] }]);
});

test("a unit that is present and healthy is not an incident, and the rules say why they are quiet", () => {
  const result = run([device()]);
  assert.deepEqual(result.decisions, []);
  assert.deepEqual(result.holds.map(h => h.reason).sort(), ["trigger_gone", "trigger_gone"]);
  assert.equal(result.resolutions.length, 1);
  assert.equal(result.resolutions[0]?.resolution?.level, "cabinet");
});

test("a report is validated before it is evaluated, and evaluation refuses nothing by throwing", () => {
  const hostile = evaluateUsbReport({ cabinetId: CABINET, now: NOW, levels: levels(policy()), incidents: new Map(), issueTypes: catalog(), report: report([device({ state: "gone" })]) });
  assert.equal("issues" in hostile, true);
  assert.deepEqual("issues" in hostile ? hostile.issues[0] : null, { field: "/devices/0/state", rule: "enum" });
  const good = evaluateUsbReport({ cabinetId: CABINET, now: NOW, levels: levels(policy()), incidents: new Map(), issueTypes: catalog(), report: report([device({ state: "absent", firstAbsentAt: "2026-07-01T20:00:00.000Z" })]) });
  assert.equal("decisions" in good ? good.decisions.length : -1, 1);
});

test("a policy with the reconnect rule switched off entirely still watches, and cannot fire", () => {
  const noAbsence = run([device({ state: "absent", firstAbsentAt: "2026-07-01T20:00:00.000Z" })], { at: policy({ absentForMinutes: null }) });
  assert.deepEqual(noAbsence.decisions, []);
  assert.equal(noAbsence.holds.some(h => h.ruleId === "usb-absent" && h.reason === "rule_off"), true);
  const flapping = run([device({ reconnectCount: 9 })], { at: policy({ reconnect: { count: 20, windowMinutes: 1440 } }) });
  assert.deepEqual(flapping.decisions, []);
  assert.equal(flapping.holds.some(h => h.ruleId === "usb-flap" && h.reason === "trigger_gone"), true);
  const atTheLimit = run([device({ reconnectCount: 20 })], { at: policy({ reconnect: { count: 20, windowMinutes: 1440 } }) });
  assert.equal(atTheLimit.decisions[0]?.action, "open");
});

test("the report the rules read is the report the contract validated, not the body", () => {
  const body = report([device()]);
  const checked = checkUsbDeviceReport(body);
  assert.equal(checked.ok, true);
  const device0 = checked.ok ? (checked.report.devices[0] as UsbDeviceReport["devices"][number]) : null;
  assert.equal(device0?.unitKey, "UNIT-1");
  assert.equal(device0?.workload.length, 0);
  assert.equal(checked.ok ? checked.report.cabinetId : "", CABINET);
  assert.equal(checked.ok ? checked.report.devices.length : 0, 1);
});
