// The cabinet diagnosis's checks (diagnose/cabinet-findings.ts): pure functions over the reads' answers. Each check says what is wrong, the
// evidence, how sure it is and the fix; a read that did not answer is "could not check", never healthy; hostile text from a cabinet is
// cleaned; the order is by severity, then certainty, then priority.
import test from "node:test";
import assert from "node:assert/strict";
import { cabinetFindings, clean, rank, safeKey, type CabinetEvidence, type BundleFinding } from "../src/diagnose/cabinet-findings.js";
import { bundleReads } from "../src/diagnose/cabinet.js";
import { classifyTrend } from "../src/services/error-trends.js";
import { triageScore } from "../src/services/triage.js";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const base = (): CabinetEvidence => ({ cabinet: { id: "7d2a0a58-6d2e-4a3b-9c0e-4b7d4f0c2a11", name: "Surgery", role: "satellite" }, siteTimeZone: "Eastern Standard Time", now: NOW });
const ok = <T,>(output: T) => ({ ok: true as const, output });
const fail = (failure: string) => ({ ok: false as const, failure });
const ids = (e: CabinetEvidence, n?: Parameters<typeof cabinetFindings>[1]) => cabinetFindings(e, n).findings.map(f => f.id);
const find = (e: CabinetEvidence, id: string) => cabinetFindings(e).findings.find(f => f.id === id);

test("disk errors in the System log are an event log problem, with the drive issue and the event logs to open; no drive health is read", () => {
  const entry = (source: string, eventId: number, firstLine = "x") => ({ recordId: 1, time: "2026-10-19T10:00:00Z", level: "error" as const, source, eventId, firstLine });
  const e: CabinetEvidence = { ...base(), systemLog: ok({ log: "System", entries: [entry("disk", 7, "bad block"), entry("disk", 153, "retried")], nextBeforeRecordId: null, truncated: false } as never) };
  const r = cabinetFindings(e);
  const disk = r.findings.find(f => f.key === "log-disk-errors")!;
  assert.equal(disk.severity, "problem");
  assert.equal(disk.issueTypeId, "00000000-0000-4000-8000-000000000102");
  assert.deepEqual(disk.action?.kind === "open" ? disk.action.section : null, "events", "the Drive health section is gone (D151)");
  assert.equal(r.areas.find(a => a.area === "logs")!.state, "problem");
  assert.ok(!r.areas.some(a => (a.area as string) === "storage"), "no drive health area");
  assert.ok(!r.findings.some(f => f.key === "drive-health" || f.id.startsWith("drive-")), "nothing from SMART");
  assert.ok(!bundleReads().some(b => b.operation === "disk.smart" || b.operation === "storage.health"), "the diagnosis does not ask for drive health");
});

test("reads that failed are 'could not check', never healthy", () => {
  const e = { ...base(), systemLog: fail("no answer"), performance: fail("timeout"), services: fail("x") };
  const r = cabinetFindings(e);
  assert.ok(r.findings.every(f => f.certainty === "not_checked" && f.severity === "info"));
  for (const a of r.areas) assert.equal(a.state, "unknown", a.area);
});

test("low space, memory, a stopped essential service and a clock that is off each produce a fix the console can offer", () => {
  const e: CabinetEvidence = { ...base(),
    performance: ok({ takenAt: "2026-10-19T12:00:00Z", cpu: { usedPercent: 10, logicalProcessors: 4, queueLength: 0 }, memory: { totalBytes: 8e9, availableBytes: 3e8, committedBytes: null, commitLimitBytes: null, pagesPerSecond: 300 },
      volumes: [{ drive: "C:", label: null, fileSystem: "NTFS", sizeBytes: 250e9, freeBytes: 20e9 }], physicalDisks: [], byCpu: [], byMemory: [{ name: "app.exe", id: 4, cpuPercent: 1, workingSetBytes: 4e9 }] }),
    services: ok({ services: [{ name: "Dnscache", displayName: "DNS Client", state: "stopped" as const, startType: "automatic" as const, account: null, processId: null, executablePath: null, description: null, recovery: null }], watched: [] }),
    time: ok({ timeZoneId: "Pacific Standard Time", timeZoneName: "Pacific", utcOffsetMinutes: -480, daylightSavingNow: true, localTime: "x", utcTime: "2026-10-19T12:10:00Z", timeService: "running" as const, sync: { state: "synced" as const, source: null, lastSuccessfulSync: "2026-10-19T08:00:00Z" }, policyManaged: false }) };
  const r = cabinetFindings(e);
  const by = (k: string) => r.findings.find(f => f.key === k)!;
  assert.equal(by("disk-space").severity, "warning");
  assert.equal(by("disk-space").issueTypeId, "00000000-0000-4000-8000-000000000123");
  assert.equal(by("memory-low").severity, "problem");
  const svc = by("service-stopped");
  assert.deepEqual(svc.action, { kind: "operation", operation: "service.control", params: { name: "Dnscache", action: "start" }, label: "Start DNS Client", cabinetId: e.cabinet.id, cabinetName: "Surgery" });
  const skew = by("time-skew").action;
  assert.equal(skew && skew.kind === "operation" ? skew.operation : null, "time.sync");
  const zone = by("time-zone");
  assert.deepEqual(zone.action && zone.action.kind === "operation" ? zone.action.params : null, { timeZoneId: "Eastern Standard Time" });
});

test("the scanner: missing, present with an error code, and fine", () => {
  const out = (over: object) => ({ configured: true, connected: true, name: "Reader", status: "OK", errorCode: null, errorText: null, hardwareIds: ["USB\\VID_1234&PID_5678"], driver: null, locationInfo: null, checks: [], candidates: [], ...over });
  assert.equal(find({ ...base(), peripheral: ok(out({ connected: false, checks: [{ check: "device_present", outcome: "fail", summary: "Nothing on any port." }] }) as never) }, "scanner-missing")!.severity, "problem");
  assert.match(find({ ...base(), peripheral: ok(out({ errorCode: 43, errorText: "x" }) as never) }, "scanner-error")!.title, /code 43/);
  assert.equal(cabinetFindings({ ...base(), peripheral: ok(out({}) as never) }).findings.length, 0);
  assert.equal(cabinetFindings({ ...base(), peripheral: ok(out({ configured: false, connected: false }) as never) }).findings.length, 0);
});

test("event logs: known problems by exact source and event ID, application crashes by name, the rest summarized", () => {
  const entry = (source: string, eventId: number, firstLine = "x", level: "error" | "critical" = "error") => ({ recordId: 1, time: "2026-10-19T10:00:00Z", level, source, eventId, firstLine });
  const e: CabinetEvidence = { ...base(),
    systemLog: ok({ log: "System", entries: [entry("Microsoft-Windows-Kernel-Power", 41, "rebooted", "critical"), entry("Microsoft-Windows-Kernel-Power", 41, "rebooted", "critical"), entry("disk", 7, "bad block"), entry("Weird", 9, "odd")], nextBeforeRecordId: null, truncated: false } as never),
    appLog: ok({ log: "Application", entries: [entry("Application Error", 1000, "Faulting application name: pos.exe, version: 1.0"), entry("Application Error", 1000, "Faulting application name: pos.exe, version: 1.0"), entry("Application Error", 1000, "Faulting application name: pos.exe, version: 1.0")], nextBeforeRecordId: null, truncated: false } as never) };
  const r = cabinetFindings(e);
  assert.equal(r.findings.find(f => f.key === "log-unexpected-shutdown")!.severity, "problem", "twice is a pattern");
  assert.equal(r.findings.find(f => f.key === "log-disk-errors")!.severity, "problem");
  assert.match(r.findings.find(f => f.key === "log-app-crashes")!.title, /^pos\.exe crashed 3 times/);
  assert.match(r.findings.find(f => f.key === "log-other-errors")!.title, /^1 other error/);
  assert.equal(cabinetFindings({ ...base(), systemLog: ok({ log: "System", entries: [], nextBeforeRecordId: null, truncated: false } as never) }).areas[0]!.state, "ok");
});

test("network findings are carried over, ranked with the rest, and a network failure is 'unknown'", () => {
  const nf = [{ id: "dns-all", layer: "dns" as const, severity: "problem" as const, certainty: "confirmed" as const, title: "No DNS server answers", evidence: ["a"], fix: "Fix DNS" },
    { id: "gateway", layer: "gateway" as const, severity: "ok" as const, certainty: "confirmed" as const, title: "fine", evidence: [], fix: null }];
  const r = cabinetFindings(base(), { findings: nf });
  assert.deepEqual(r.findings.map(f => f.id), ["net-dns-all"]);
  assert.equal(r.findings[0]!.key, "dns-all");
  assert.equal(r.findings[0]!.source, "network");
  assert.equal(cabinetFindings(base(), { failure: "timed out" }).areas.find(a => a.area === "network")!.state, "unknown");
});

test("ranking: severity, then a cause before what it explains, then certainty, then priority", () => {
  const f = (id: string, severity: BundleFinding["severity"], certainty: BundleFinding["certainty"], priority: number, causedBy?: string): BundleFinding =>
    ({ id, key: id, area: "system", source: "cabinet", severity, certainty, title: id, evidence: [], fix: null, priority, ...(causedBy ? { causedBy } : {}) });
  const r = rank([f("c", "warning", "confirmed", 90), f("b", "problem", "possible", 99), f("a", "problem", "confirmed", 10), f("d", "problem", "confirmed", 50, "a"), f("e", "problem", "confirmed", 60)]);
  assert.deepEqual(r.map(x => x.id), ["e", "a", "b", "d", "c"]);
});

test("hostile text from a cabinet is cleaned, cut and never trusted as a key", () => {
  assert.equal(clean("a\u0000b\u001b[31mc d"), "a b [31mc d");
  assert.equal(clean("x".repeat(10_000), 50).length, 50);
  assert.equal(clean({ not: "a string" }), "");
  assert.equal(safeKey("../../etc/passwd"), "etc-passwd");
  assert.equal(safeKey("9lives"), "lives");
  assert.equal(safeKey("\u0000\u0001"), "finding");
  const nasty = "<img src=x onerror=alert(1)>\u0007".repeat(400);
  const e: CabinetEvidence = { ...base(), devices: ok({ devices: Array.from({ length: 300 }, (_, i) => ({ instanceId: `i${i}`, class: nasty, name: nasty, status: "Error", errorCode: 43, errorText: nasty, hardwareIds: [], driver: null })), truncated: true }),
    info: ok({ hostname: nasty, osVersion: nasty, osBuild: "1", uptimeSeconds: Number.NaN, agentVersion: "1", readOnlyMode: false, cabinetRole: null, serialNumber: null }) };
  const r = cabinetFindings(e);
  for (const f of r.findings) {
    assert.ok(f.evidence.length <= 8 && f.evidence.every(x => x.length <= 301 && !x.includes("\u0007")), f.id);
    assert.ok(f.title.length <= 201 && /^[a-z][a-z0-9-]{0,47}$/.test(f.key));
  }
});

test("garbage shapes do not throw", () => {
  const junk = { drives: null, services: null, devices: null, entries: null, volumes: null, installed: null, pending: null, byCpu: null, checks: null } as never;
  const e: CabinetEvidence = { ...base(), services: ok(junk), devices: ok(junk), systemLog: ok(junk), performance: ok({ cpu: {}, memory: {}, ...(junk as object) } as never), updates: ok(junk), peripheral: ok({ configured: true, connected: true, checks: null, hardwareIds: [] } as never), usb: ok(junk) };
  assert.doesNotThrow(() => cabinetFindings(e));
});

test("trend marks: new, rising, steady and too small to matter", () => {
  const z = (n: number) => Array(n).fill(0) as number[];
  assert.equal(classifyTrend([...z(29), 4], 10).mark, "new");
  assert.equal(classifyTrend([...z(29), 4], 1).mark, null, "nothing to be new against on the first day");
  assert.equal(classifyTrend([...z(16), ...Array(7).fill(2), ...Array(7).fill(6)], 30).mark, "rising");
  assert.equal(classifyTrend([...Array(30).fill(3)], 30).mark, null);
  assert.equal(classifyTrend([...Array(23).fill(1), ...Array(7).fill(0.5)], 30).mark, null);
  assert.equal(classifyTrend([...z(10), 1, 0, 0, 0, 0, 0, 1, ...z(13)], 30).mark, null, "a handful of events is noise");
  assert.equal(classifyTrend([], 30).mark, null);
  assert.equal(classifyTrend([Number.NaN, -5, Infinity] as number[], 30).mark, null);
});

test("the triage score explains itself and ranks major and widespread first", () => {
  const major = triageScore({ severity: "major", cabinets: 12, unclaimed: 5, mark: "rising", sitePatternAlerts: 1, oldestUnclaimedHours: 10, unrecognized: false });
  const minor = triageScore({ severity: "minor", cabinets: 1, unclaimed: 1, mark: null, sitePatternAlerts: 0, oldestUnclaimedHours: 0, unrecognized: false });
  assert.ok(major.score > minor.score);
  assert.ok(major.why.some(w => w.includes("12 cabinets")) && major.why.some(w => w.includes("rising")));
  const odd = triageScore({ severity: "minor", cabinets: -5, unclaimed: Number.NaN, mark: null, sitePatternAlerts: 0, oldestUnclaimedHours: -1, unrecognized: true });
  assert.ok(Number.isFinite(odd.score) && odd.score >= 0);
});

test("a client that uses no fingerprint scanner: the scanner area says so, with no finding", () => {
  const r = cabinetFindings({ ...base(), scannerUsed: false });
  const area = r.areas.find(a => a.area === "scanner");
  assert.deepEqual(area && { state: area.state, summary: area.summary }, { state: "ok", summary: "Not used by this client" });
  assert.equal(r.findings.filter(f => f.area === "scanner").length, 0);
});
