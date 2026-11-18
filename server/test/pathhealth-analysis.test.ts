// Sync-path target selection, retention, aggregation and correlation.
// Pure functions: no database, no network, no clock of their own (the time is passed in, so every expectation below is exact).
//
// The tests that matter most are the negative ones: a name is never a sync target, a resolved address that is not the approved one is
// never used, and ICMP silence next to a working TCP connect is reported as filtering rather than as packet loss.
import test from "node:test";
import assert from "node:assert/strict";
import { ContractError } from "../src/contracts.js";
import type { PathHealthSample, PathHealthSampleSet, PathHealthTarget } from "../src/services/pathhealth-contracts.js";
import { parseSampleSet, parseReport } from "../src/services/pathhealth-contracts.js";
import { selectTargets, validateResolvedDestination, isConfiguredPort, isGlobalIpv4, isIpv4, isPrivateIpv4, type PathHealthSyncSettings } from "../src/services/pathhealth-targets.js";
import { LOSS_THRESHOLD_PERCENT, reportWindow, retain, summariseTargets, targetState, totalIcmp, totalTcp } from "../src/services/pathhealth-analysis.js";
import { buildPathHealthReport, classifySample, correlate, correlationSummary, pathHealthFindings } from "../src/services/pathhealth-correlation.js";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const CABINET = "11111111-2222-3333-4444-555555555555";
const SITE = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const SYNC = "10.21.9.20";
const PLATFORM = "203.0.113.9";

const healthyIcmp = () => ({ sent: 4, received: 4, lossPercent: 0, minMs: 0.4, avgMs: 0.7, maxMs: 1.1, jitterMs: 0.2 });
const lossyIcmp = (received = 1) => ({ sent: 4, received, lossPercent: (100 * (4 - received)) / 4, minMs: 3.2, avgMs: 3.4, maxMs: 3.6, jitterMs: 0.3 });
const silentIcmp = () => ({ sent: 4, received: 0, lossPercent: 100, minMs: null, avgMs: null, maxMs: null, jitterMs: null });
const slowIcmp = () => ({ sent: 4, received: 4, lossPercent: 0, minMs: 180, avgMs: 240, maxMs: 410, jitterMs: 90 });
const okTcp = () => ({ attempts: 3, connected: 3, refused: 0, timedOut: 0, minMs: 4, avgMs: 5, maxMs: 7 });
const refusedTcp = () => ({ attempts: 3, connected: 0, refused: 3, timedOut: 0, minMs: null, avgMs: null, maxMs: null });
const timeoutTcp = () => ({ attempts: 3, connected: 0, refused: 0, timedOut: 3, minMs: null, avgMs: null, maxMs: null });

const sample = (over: Partial<PathHealthSample> = {}): PathHealthSample => ({ at: minutesAgo(30), targetIndex: 0, result: "reached", icmp: healthyIcmp(), tcp: okTcp(), ...over });
const setWith = (samples: PathHealthSample[], targets: PathHealthTarget[] = [{ kind: "sync_cabinet", address: SYNC, port: 8443 }, { kind: "platform_server", address: PLATFORM, port: 443 }]): PathHealthSampleSet =>
  parseSampleSet({ cabinetId: CABINET, siteId: SITE, role: "satellite", collectedAt: minutesAgo(1), targets, state: { online: true, minutesSilent: 8 }, samples }, NOW);
const window = (failedChecks = 3) => ({ from: minutesAgo(40), to: minutesAgo(10), failedChecks });

// ---- Target selection --------------------------------------------------------------------------------
test("a satellite gets its site's sync cabinet ports and the platform endpoint, and nothing else", () => {
  const site: PathHealthSyncSettings = { address: SYNC, effective: [8443, 445] };
  const selection = selectTargets({ role: "satellite", sync: site, platform: { address: PLATFORM, port: 443 } });
  assert.deepEqual(selection.targets, [
    { kind: "platform_server", address: PLATFORM, port: 443 },
    { kind: "sync_cabinet", address: SYNC, port: 8443 },
    { kind: "sync_cabinet", address: SYNC, port: 445 },
  ]);
  assert.deepEqual(selection.skipped, []);
  assert.equal(selection.targets.length <= 5, true);
});

test("a sync cabinet is not given a sync target, and a site without a sync address gets none", () => {
  const site: PathHealthSyncSettings = { address: SYNC, effective: [8443] };
  const self = selectTargets({ role: "sync", sync: site, platform: { address: PLATFORM, port: 443 } });
  assert.deepEqual(self.targets.map(t => t.kind), ["platform_server"]);
  assert.equal(self.skipped[0]?.reason, "this cabinet is the site's sync cabinet");
  const none = selectTargets({ role: "satellite", sync: { address: null, effective: [8443] }, platform: { address: PLATFORM, port: 443 } });
  assert.deepEqual(none.targets.map(t => t.kind), ["platform_server"]);
  assert.equal(none.skipped[0]?.kind, "sync_cabinet");
});

test("a sync target is only ever a private IPv4 address: a name, a public address and a hostname:port are all refused", () => {
  const noAddress = "the sync cabinet's address is not an IPv4 address";
  const notPrivate = "the sync cabinet's address is not a private address on the site's own network";
  for (const [address, expected] of [["sync-cabinet.lan", noAddress], ["8.8.8.8", notPrivate], ["203.0.113.9", notPrivate], ["169.254.10.4", notPrivate], ["127.0.0.1", notPrivate], ["", noAddress], ["10.21.9.20:8443", noAddress]] as [string, string][]) {
    const selection = selectTargets({ role: "satellite", sync: { address, effective: [8443] }, platform: { address: PLATFORM, port: 443 } });
    assert.deepEqual(selection.targets.filter(t => t.kind === "sync_cabinet"), [], `selected a sync target for ${address}`);
    assert.equal(selection.skipped.find(s => s.kind === "sync_cabinet")?.reason, expected);
  }
});

test("sync ports come from the settings only: junk is dropped, duplicates collapse, and five ports become four", () => {
  const selection = selectTargets({ role: "satellite", sync: { address: SYNC, effective: [8443, 8443, 0, 70000, Number.NaN, 445, 445, 139, 8080] as number[] }, platform: { address: PLATFORM, port: 443 } });
  assert.deepEqual(selection.targets.filter(t => t.kind === "sync_cabinet").map(t => t.port), [8443, 445, 139, 8080]);
  // No usable port at all is not an excuse to invent one: the target is sampled over ICMP only.
  const icmpOnly = selectTargets({ role: "satellite", sync: { address: SYNC, effective: [] }, platform: { address: PLATFORM, port: 443 } });
  assert.deepEqual(icmpOnly.targets.find(t => t.kind === "sync_cabinet"), { kind: "sync_cabinet", address: SYNC, port: null });
});

test("the platform endpoint must be an address by the time targets are selected, and its port must be a service port", () => {
  const named = selectTargets({ role: "satellite", sync: null, platform: { address: "platform.example.com", port: 443 } });
  assert.deepEqual(named.targets, []);
  assert.equal(named.skipped[0]?.kind, "platform_server");
  const badPort = selectTargets({ role: "satellite", sync: null, platform: { address: PLATFORM, port: 0 } });
  assert.deepEqual(badPort.targets, []);
});

test("only a port the server selected is a configured port: 22 on the sync cabinet is not", () => {
  const selection = selectTargets({ role: "satellite", sync: { address: SYNC, effective: [8443] }, platform: { address: PLATFORM, port: 443 } }).targets;
  assert.equal(isConfiguredPort(selection, SYNC, 8443), true);
  assert.equal(isConfiguredPort(selection, SYNC, 22), false);
  assert.equal(isConfiguredPort(selection, "10.21.9.99", 8443), false);
  assert.equal(isConfiguredPort(selection, PLATFORM, 443), true);
});

test("a resolved destination is re-validated before it is used: a name cannot move a test", () => {
  const sync: PathHealthTarget = { kind: "sync_cabinet", address: SYNC, port: 8443 };
  const platform: PathHealthTarget = { kind: "platform_server", address: PLATFORM, port: 443 };
  // The name answers with the approved address and something else: only the approved one is used.
  assert.deepEqual(validateResolvedDestination(sync, ["10.21.9.21", SYNC]), { approved: SYNC, addresses: [SYNC], reason: null });
  // The name answers somewhere else (a stale hosts entry, a hostile DNS answer): nothing is used.
  const moved = validateResolvedDestination(sync, ["10.21.9.99", "8.8.8.8"]);
  assert.equal(moved.approved, null);
  assert.equal(moved.addresses.length, 0);
  assert.match(String(moved.reason), /not the approved sync cabinet address/);
  // An approved address that is not private is refused even when it matches.
  const publicApproved = validateResolvedDestination({ kind: "sync_cabinet", address: "8.8.8.8", port: 8443 }, ["8.8.8.8"]);
  assert.equal(publicApproved.approved, null);
  assert.match(String(publicApproved.reason), /not a private IPv4 address/);
  // The platform endpoint is reached over the Internet: a private or loopback answer is a redirection, not a destination.
  const rebound = validateResolvedDestination(platform, ["127.0.0.1", "10.0.0.5", "169.254.1.1"]);
  assert.equal(rebound.approved, null);
  assert.match(String(rebound.reason), /private or non-routable/);
  assert.deepEqual(validateResolvedDestination(platform, ["10.0.0.5", "93.184.216.34"]).approved, "93.184.216.34");
  const nothing = validateResolvedDestination(platform, ["::1", "", 123 as never, null as never]);
  assert.equal(nothing.approved, null);
  assert.match(String(nothing.reason), /resolved to no IPv4 address/);
});

test("the address helpers agree with what the agent's own validator accepts", () => {
  assert.equal(isIpv4("10.21.9.20"), true);
  for (const bad of ["010.21.9.20", "10.21.9", "10.21.9.256", "10.21.9.20 ", "::1", ""]) assert.equal(isIpv4(bad), false, bad);
  assert.equal(isPrivateIpv4("10.0.0.1"), true);
  assert.equal(isPrivateIpv4("172.16.0.1"), true);
  assert.equal(isPrivateIpv4("172.32.0.1"), false);
  assert.equal(isPrivateIpv4("192.168.1.1"), true);
  assert.equal(isPrivateIpv4("8.8.8.8"), false);
  assert.equal(isGlobalIpv4("93.184.216.34"), true);
  for (const bad of ["127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.1.1", "198.51.100.4", "224.0.0.1", "255.255.255.255", "0.0.0.0"]) assert.equal(isGlobalIpv4(bad), false, bad);
});

// ---- Retention and aggregation ------------------------------------------------------------------------
test("retention keeps the last 24 hours and the newest 24 samples per target, and says how many it dropped", () => {
  const samples = Array.from({ length: 30 }, (_, i) => sample({ at: minutesAgo(5 * (30 - i)) }));
  const old = sample({ at: minutesAgo(25 * 60) });
  const before = setWith([old, ...samples]);
  const { set, dropped } = retain(before, NOW);
  const kept = set.samples;
  assert.equal(dropped, 7, "expected the 25-hour-old sample and 6 over the per-target cap to be dropped");
  assert.equal(kept.length, 24);
  assert.equal(kept.some(s => s.at === old.at), false);
  assert.equal(kept[kept.length - 1]!.at, samples[samples.length - 1]!.at);
  assert.deepEqual(summariseTargets(set).map(s => s.samples), [24, 0]);
  assert.equal(retain(set, NOW).dropped, 0);
});

test("a sample that is within the window is never starved by another target's samples", () => {
  const busy = Array.from({ length: 30 }, (_, i) => sample({ at: minutesAgo(i + 1) }));
  const quiet = sample({ at: minutesAgo(90), targetIndex: 1, tcp: null });
  const { set, dropped } = retain(setWith([...busy, quiet]), NOW);
  assert.equal(dropped, 6);
  assert.deepEqual(summariseTargets(set).map(s => s.samples), [24, 1]);
});

test("totals: replies weight the average, the worst series is kept, and nothing is invented", () => {
  const samples = [sample({ icmp: slowIcmp(), tcp: okTcp() }), sample({ at: minutesAgo(20), icmp: lossyIcmp(), tcp: { attempts: 3, connected: 2, refused: 0, timedOut: 1, minMs: 8, avgMs: 9, maxMs: 10 } }), sample({ at: minutesAgo(10), icmp: silentIcmp(), tcp: timeoutTcp(), result: "timeout" })];
  const icmp = totalIcmp(samples)!;
  assert.equal(icmp.sent, 12);
  assert.equal(icmp.received, 5);
  assert.equal(icmp.lossPercent, 58.3);
  assert.equal(icmp.maxLossPercent, 100);
  assert.equal(icmp.minMs, 3.2);
  assert.equal(icmp.maxMs, 410);
  assert.equal(icmp.jitterMs, 90);
  const weighted = ((240 * 4) + (3.4 * 1)) / 5;
  assert.equal(icmp.avgMs, Math.round(weighted * 100) / 100);
  const tcp = totalTcp(samples)!;
  assert.deepEqual(tcp, { attempts: 9, connected: 5, refused: 0, timedOut: 4 });
  assert.equal(totalIcmp([sample({ icmp: null, tcp: okTcp() })]), null);
  assert.equal(totalTcp([sample({ icmp: healthyIcmp(), tcp: null })]), null);
  assert.equal(totalIcmp([]), null);
});

test("ICMP silence next to a successful TCP connect is filtering, never loss", () => {
  assert.equal(targetState(totalIcmp([sample({ result: "reached", icmp: silentIcmp(), tcp: okTcp() })]), totalTcp([sample({ icmp: silentIcmp(), tcp: okTcp() })])), "filtering");
  // The same silence with nothing answering is loss: nothing came back at all.
  assert.equal(targetState(totalIcmp([sample({ result: "timeout", icmp: silentIcmp(), tcp: timeoutTcp() })]), totalTcp([sample({ icmp: silentIcmp(), tcp: timeoutTcp() })])), "loss_and_timeouts");
  // Partial loss with a working port is still loss: some of the path is dropping packets.
  assert.equal(targetState(totalIcmp([sample({ icmp: lossyIcmp() })]), totalTcp([sample({ icmp: lossyIcmp(), tcp: okTcp() })])), "loss");
  assert.equal(targetState(totalIcmp([sample({ icmp: healthyIcmp() })]), totalTcp([sample({ icmp: healthyIcmp(), tcp: refusedTcp(), result: "refused" })])), "refused");
  assert.equal(targetState(totalIcmp([sample({ icmp: healthyIcmp() })]), totalTcp([sample({ icmp: healthyIcmp(), tcp: timeoutTcp(), result: "timeout" })])), "timeouts");
  assert.equal(targetState(null, null), "not_measured");
  assert.equal(targetState(totalIcmp([sample()]), totalTcp([sample()])), "ok");
  // Just below the threshold is not called loss, so the threshold is a real one and not decoration.
  const light = { sent: 20, received: 19, lossPercent: 5, minMs: 1, avgMs: 2, maxMs: 3, jitterMs: 1 };
  assert.equal(targetState(totalIcmp([sample({ icmp: light })]), totalTcp([sample({ icmp: light })])), "ok");
  assert.equal(LOSS_THRESHOLD_PERCENT, 10);
});

test("a target the server never selected cannot be summarised", () => {
  const set = setWith([sample()], [{ kind: "sync_cabinet", address: SYNC, port: 8443 }]);
  const bypassed = { ...set, samples: [{ ...sample(), targetIndex: 1 }] } as PathHealthSampleSet;
  assert.throws(() => summariseTargets(bypassed), /not selected/);
});

test("the report window follows the samples, and an empty set has no window at all", () => {
  const set = setWith([sample({ at: minutesAgo(50) }), sample({ at: minutesAgo(20), targetIndex: 1 })]);
  assert.deepEqual(reportWindow(set, 3), { from: minutesAgo(50), to: minutesAgo(20), samples: 2, dropped: 3 });
  assert.deepEqual(reportWindow(setWith([]), 1), { from: null, to: null, samples: 0, dropped: 1 });
});

// ---- Correlation and findings --------------------------------------------------------------------------
test("a sample is classified by what came back, and a silence yields to the TCP evidence", () => {
  assert.deepEqual(classifySample(sample({ result: "reached", icmp: silentIcmp(), tcp: okTcp() })), { loss: false, timeout: false, refused: false, filtered: true });
  assert.equal(classifySample(sample({ result: "timeout", icmp: silentIcmp(), tcp: timeoutTcp() })).loss, true);
  assert.equal(classifySample(sample({ icmp: lossyIcmp(), tcp: okTcp() })).loss, true);
  assert.equal(classifySample(sample({ result: "refused", icmp: healthyIcmp(), tcp: refusedTcp() })).refused, true);
  assert.equal(classifySample(sample({ icmp: healthyIcmp(), tcp: null })).loss, false);
  // The verdict from the export and the series it is derived from agree, or the contract would have refused the sample.
  assert.equal(classifySample(sample({ result: "timeout", icmp: lossyIcmp(), tcp: timeoutTcp() })).timeout, true);
});

test("a window with no samples in it answers \"not measured\", never \"fine\"", () => {
  const outside = setWith([sample({ at: minutesAgo(90) }), sample({ at: minutesAgo(60) })]);
  const correlation = correlate(outside, window(), NOW);
  assert.deepEqual(correlation, { measured: false, lossDuringWindow: false, timeoutsDuringWindow: false, refusalsDuringWindow: false, icmpFiltered: false, interpretation: "not_measured", confidence: "not_checked" });
  assert.equal(correlationSummary(correlation), "not measured");
  // A window that ends before it starts is empty rather than an error.
  assert.equal(correlate(setWith([sample()]), { from: minutesAgo(10), to: minutesAgo(40), failedChecks: 1 }, NOW).measured, false);
  // An open window (to = null) runs to now.
  assert.equal(correlate(setWith([sample({ at: minutesAgo(5) })]), { from: minutesAgo(30), to: null, failedChecks: 2 }, NOW).measured, true);
});

test("loss measured inside the failed-sync window is correlated and raised as a finding", () => {
  const set = setWith([sample({ at: minutesAgo(30), icmp: lossyIcmp(), tcp: timeoutTcp(), result: "timeout" }), sample({ at: minutesAgo(20), targetIndex: 1 })]);
  const correlation = correlate(set, window(), NOW);
  assert.equal(correlation.lossDuringWindow, true);
  assert.equal(correlation.interpretation, "loss_during_window");
  assert.equal(correlation.confidence, "probable");
  const findings = pathHealthFindings({ set, summaries: summariseTargets(set), correlation, window: window() });
  const loss = findings.find(f => f.id === "pathhealth-loss-window");
  assert.ok(loss, `expected a loss finding, got ${findings.map(f => f.id).join(", ")}`);
  assert.equal(loss.severity, "problem");
  assert.equal(loss.layer, "sync");
  assert.ok(loss.evidence.some(e => e.includes("Failed sync window")), JSON.stringify(loss.evidence));
  assert.ok(loss.evidence.some(e => e.includes("75% loss")));
  assert.equal(typeof loss.fix, "string");
});

test("ICMP silence with a working port is filtering in the window too, and never a loss finding", () => {
  const set = setWith([sample({ at: minutesAgo(30), result: "reached", icmp: silentIcmp(), tcp: okTcp() }), sample({ at: minutesAgo(20), targetIndex: 1 })]);
  const correlation = correlate(set, window(), NOW);
  assert.equal(correlation.lossDuringWindow, false, "a silent ICMP series was counted as loss while TCP connected");
  assert.equal(correlation.timeoutsDuringWindow, false);
  assert.equal(correlation.icmpFiltered, true);
  assert.equal(correlation.interpretation, "packet_filtering");
  assert.equal(correlation.confidence, "confirmed");
  const findings = pathHealthFindings({ set, summaries: summariseTargets(set), correlation, window: window() });
  assert.equal(findings.some(f => f.id === "pathhealth-loss-window"), false, "filtering was reported as loss");
  assert.equal(findings.some(f => f.severity === "problem"), false, JSON.stringify(findings));
  const filtered = findings.find(f => f.id === "pathhealth-icmp-filtered");
  assert.ok(filtered);
  assert.equal(filtered.severity, "info");
  assert.equal(filtered.certainty, "confirmed");
  assert.equal(filtered.layer, "firewall");
  assert.match(filtered.title, /filtering/);
  assert.ok(filtered.evidence.some(e => e.includes("not evidence of loss")));
  assert.deepEqual(summariseTargets(set).map(s => s.state), ["filtering", "ok"]);
});

test("a refused sync port is the listener, not the path", () => {
  const set = setWith([sample({ at: minutesAgo(30), result: "refused", icmp: healthyIcmp(), tcp: refusedTcp() })]);
  const correlation = correlate(set, window(), NOW);
  assert.equal(correlation.refusalsDuringWindow, true);
  assert.equal(correlation.lossDuringWindow, false);
  assert.equal(correlation.interpretation, "application_or_listener");
  const findings = pathHealthFindings({ set, summaries: summariseTargets(set), correlation, window: window() });
  const refused = findings.find(f => f.id === "pathhealth-refused");
  assert.ok(refused);
  assert.equal(refused.severity, "problem");
  assert.ok(refused.evidence.some(e => e.includes("A refusal means the address answered")));
  assert.equal(findings.some(f => f.id === "pathhealth-loss-window"), false);
  assert.equal(summariseTargets(set)[0]!.state, "refused");
});

test("a clean path during a failed sync is reported as such, with the confidence it deserves", () => {
  const set = setWith([sample({ at: minutesAgo(30) }), sample({ at: minutesAgo(20), targetIndex: 0, icmp: slowIcmp() })]);
  const correlation = correlate(set, window(), NOW);
  assert.equal(correlation.interpretation, "path_clean");
  assert.equal(correlation.confidence, "probable", "a measured window should not claim more than the samples show, nor less");
  const findings = pathHealthFindings({ set, summaries: summariseTargets(set), correlation, window: window() });
  const clean = findings.find(f => f.id === "pathhealth-clean-path");
  assert.ok(clean);
  assert.equal(clean.severity, "warning");
  assert.match(clean.title, /clean/);
  assert.equal(findings.some(f => f.id === "pathhealth-ok"), false, "a failed window is not an all-clear");
});

test("with nothing failing, an all-clear is raised, and a thin window is not", () => {
  const set = setWith([sample({ at: minutesAgo(30) }), sample({ at: minutesAgo(20), targetIndex: 1 })]);
  const correlation = correlate(set, null, NOW);
  assert.equal(correlation.interpretation, "path_clean");
  assert.equal(correlation.confidence, "possible");
  const findings = pathHealthFindings({ set, summaries: summariseTargets(set), correlation, window: null });
  assert.deepEqual(findings.map(f => f.id), ["pathhealth-ok"]);
  assert.equal(findings[0]!.severity, "ok");
  assert.equal(findings[0]!.fix, null);
  const thin = setWith([sample({ at: minutesAgo(30), targetIndex: 0 }), sample({ at: minutesAgo(20), targetIndex: 1, icmp: null, tcp: refusedTcp(), result: "refused" })]);
  const refusedOnly = pathHealthFindings({ set: thin, summaries: summariseTargets(thin), correlation: correlate(thin, null, NOW), window: null });
  assert.equal(refusedOnly.some(f => f.id === "pathhealth-ok"), false, "a refused port is not an all-clear");
});

test("loss confined to the sync cabinet while the platform endpoint is clean is called out", () => {
  const set = setWith([sample({ at: minutesAgo(30), icmp: lossyIcmp(), tcp: timeoutTcp(), result: "timeout" }), sample({ at: minutesAgo(20), targetIndex: 1 })]);
  const findings = pathHealthFindings({ set, summaries: summariseTargets(set), correlation: correlate(set, window(), NOW), window: window() });
  const asymmetric = findings.find(f => f.id === "pathhealth-asymmetric");
  assert.ok(asymmetric, `expected an asymmetric finding, got ${findings.map(f => f.id).join(", ")}`);
  assert.ok(asymmetric.evidence.some(e => e.includes("same-site hop")));
});

// ---- The report as a contract --------------------------------------------------------------------------
test("the report the server builds satisfies the report contract, window and all", () => {
  const set = setWith([sample({ at: minutesAgo(30), icmp: lossyIcmp(), tcp: timeoutTcp(), result: "timeout" }), sample({ at: minutesAgo(20), targetIndex: 1 })]);
  const report = buildPathHealthReport({ set, now: NOW, window: window(), dropped: 6 });
  assert.deepEqual(parseReport(report), report);
  assert.equal(report.cabinetId, CABINET);
  assert.deepEqual(report.window, { from: minutesAgo(30), to: minutesAgo(20), samples: 2, dropped: 6 });
  assert.equal(report.syncFailureWindow?.failedChecks, 3);
  assert.equal(report.targets.length, 2);
  assert.equal(report.correlation.interpretation, "loss_during_window");
  assert.ok(report.findings.length > 0 && report.findings.length <= 12);
  for (const finding of report.findings) assert.ok(finding.id.startsWith("pathhealth-"), finding.id);
});

test("a report over an empty window says nothing was measured, and still passes the contract", () => {
  const report = buildPathHealthReport({ set: setWith([]), now: NOW, window: window(2), dropped: 120 });
  assert.deepEqual(parseReport(report), report);
  assert.equal(report.window.samples, 0);
  assert.equal(report.window.from, null);
  assert.equal(report.correlation.measured, false);
  assert.deepEqual(report.findings.map(f => f.id), ["pathhealth-not-measured"]);
  assert.deepEqual(report.targets.map(t => t.state), ["not_measured", "not_measured"]);
  assert.equal(report.targets[0]!.icmp, null);
  assert.equal(report.targets[0]!.tcp, null);
});

test("a report that our own builder got wrong is refused rather than sent", () => {
  const set = setWith([sample({ icmp: healthyIcmp(), tcp: okTcp() })]);
  // An address that is not an address can only get this far if the contract check was bypassed: the report gate then refuses it.
  const hostile = { ...set, targets: [{ kind: "sync_cabinet", address: "999.1.1.1", port: 22 }] } as PathHealthSampleSet;
  assert.throws(() => buildPathHealthReport({ set: hostile, now: NOW, window: null, dropped: 0 }), ContractError);
});
