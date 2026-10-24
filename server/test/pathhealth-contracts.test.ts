// The sync-path contracts (contracts/schemas/pathhealth/*.schema.json) and the semantic rules behind them:
// what the schemas refuse, what only the code can refuse, and the two rules that must never be traded away for convenience --
// a sample cannot name a destination, and a series with no reply cannot report a round-trip time.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Certainty, Layer, Severity } from "../src/diagnose/network-findings.js";
import { ContractError } from "../src/contracts.js";
import {
  MAX_SAMPLES, MAX_SAMPLES_PER_TARGET, MAX_TARGETS, RETENTION_MS,
  assembleSampleSet, lossPercentOf, parseReport, parseReportedSamples, parseSampleSet, pathHealthContracts,
} from "../src/services/pathhealth-contracts.js";

const repo = (() => {
  // Walk up from this file (the repo layout is server/dist/test/*.js), and fall back to the working directory's parent so the
  // suite also runs from a scoped build outside the tree.
  const marker = (dir: string) => existsSync(resolve(dir, "contracts", "schemas", "pathhealth", "sample-set.schema.json"));
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (marker(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fromCwd = resolve(process.cwd(), "..");
  if (marker(fromCwd)) return fromCwd;
  throw new Error("contracts/schemas/pathhealth is not reachable from this test's path or the working directory");
})();
const schema = (file: "sample-set" | "report") => JSON.parse(readFileSync(resolve(repo, "contracts", "schemas", "pathhealth", `${file}.schema.json`), "utf8")) as Record<string, unknown>;

const NOW = Date.parse("2026-10-23T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const CABINET = "11111111-2222-3333-4444-555555555555";
const SITE = "66666666-7777-8888-9999-aaaaaaaaaaaa";

const healthyIcmp = () => ({ sent: 4, received: 4, lossPercent: 0, minMs: 0.4, avgMs: 0.7, maxMs: 1.1, jitterMs: 0.2 });
const lossyIcmp = () => ({ sent: 4, received: 1, lossPercent: 75, minMs: 3.2, avgMs: 3.4, maxMs: 3.6, jitterMs: 0.3 });
const silentIcmp = () => ({ sent: 4, received: 0, lossPercent: 100, minMs: null, avgMs: null, maxMs: null, jitterMs: null });
const okTcp = () => ({ attempts: 3, connected: 3, refused: 0, timedOut: 0, minMs: 4, avgMs: 5, maxMs: 7 });
const refusedTcp = () => ({ attempts: 3, connected: 0, refused: 3, timedOut: 0, minMs: null, avgMs: null, maxMs: null });
const timeoutTcp = () => ({ attempts: 3, connected: 0, refused: 0, timedOut: 3, minMs: null, avgMs: null, maxMs: null });

/** A stored set as the server writes it: two targets it filled in itself, and samples that point at them by index. */
const sampleSet = (over: Record<string, unknown> = {}) => ({
  cabinetId: CABINET, siteId: SITE, role: "satellite", collectedAt: minutesAgo(1),
  targets: [{ kind: "sync_cabinet", address: "10.21.9.20", port: 8443 }, { kind: "platform_server", address: "203.0.113.9", port: 443 }],
  state: { online: true, minutesSilent: 12 },
  samples: [{ at: minutesAgo(30), targetIndex: 0, result: "reached", icmp: healthyIcmp(), tcp: okTcp() }],
  ...over,
});
const selection = [{ kind: "sync_cabinet" as const, address: "10.21.9.20", port: 8443 }, { kind: "platform_server" as const, address: "203.0.113.9", port: 443 }];
const refusal = (fn: () => unknown): ContractError => {
  try { fn(); } catch (e) { if (e instanceof ContractError) return e; throw e; }
  throw new Error("expected a ContractError, none was thrown");
};

test("the schema bounds and the code's bounds are the same numbers", () => {
  const set = schema("sample-set") as unknown as { properties: { samples: { maxItems: number }; targets: { maxItems: number } }; $defs: { sample: { properties: { targetIndex: { maximum: number } } }; icmpSeries: { properties: { sent: { maximum: number } } }; tcpSeries: { properties: { attempts: { maximum: number } } } } };
  assert.equal(set.properties.samples.maxItems, MAX_SAMPLES, "MAX_SAMPLES drifted from the contract");
  assert.equal(set.properties.targets.maxItems, MAX_TARGETS, "MAX_TARGETS drifted from the contract");
  assert.equal(set.$defs.sample.properties.targetIndex.maximum, MAX_TARGETS - 1, "targetIndex is not bounded by the target count");
  assert.equal(set.$defs.icmpSeries.properties.sent.maximum, 20);
  assert.equal(set.$defs.tcpSeries.properties.attempts.maximum, 20);
});

test("a well-formed set parses, and its targets are the ones the server filled in", () => {
  const set = parseSampleSet(sampleSet(), NOW);
  assert.deepEqual(set.targets.map(t => `${t.kind}:${t.address}:${t.port}`), ["sync_cabinet:10.21.9.20:8443", "platform_server:203.0.113.9:443"]);
  assert.equal(set.samples.length, 1);
  assert.equal(RETENTION_MS, 24 * 60 * 60 * 1000);
});

test("a sample cannot name a destination of its own", () => {
  const hostile = sampleSet({ samples: [{ at: minutesAgo(30), targetIndex: 0, result: "reached", icmp: healthyIcmp(), tcp: okTcp(), address: "10.21.9.99", port: 22 }] });
  const error = refusal(() => parseSampleSet(hostile, NOW));
  assert.equal(error.schema, "pathhealth/sample-set");
  assert.ok(error.issues.some(i => i.rule === "additionalProperties" && i.path.includes("/samples/0")), `expected additionalProperties, got ${JSON.stringify(error.issues)}`);
});

test("a set cannot carry a free-form target next to the server's own", () => {
  const hostile = sampleSet({ target: { host: "evil.example", port: 4444 } });
  const error = refusal(() => parseSampleSet(hostile, NOW));
  assert.ok(error.issues.some(i => i.rule === "additionalProperties" && i.path === "/"));
});

test("a sample pointing at a target that was never selected is refused", () => {
  const error = refusal(() => parseSampleSet(sampleSet({ samples: [{ at: minutesAgo(30), targetIndex: 4, result: "reached", icmp: healthyIcmp(), tcp: okTcp() }] }), NOW));
  assert.ok(error.issues.some(i => i.rule === "targetIndexOutOfRange" || i.rule === "maximum"), JSON.stringify(error.issues));
});

test("ICMP silence must not carry a round-trip time, and a zero is refused as loudly as a negative one", () => {
  for (const minMs of [0, 0.1, -1, 12]) {
    const hostile = sampleSet({ samples: [{ at: minutesAgo(30), targetIndex: 0, result: "timeout", icmp: { ...silentIcmp(), minMs, avgMs: minMs, maxMs: minMs, jitterMs: minMs }, tcp: timeoutTcp() }] });
    assert.throws(() => parseSampleSet(hostile, NOW), ContractError, `a silent series accepted minMs=${minMs}`);
  }
  assert.equal(parseSampleSet(sampleSet({ samples: [{ at: minutesAgo(30), targetIndex: 0, result: "timeout", icmp: silentIcmp(), tcp: timeoutTcp() }] }), NOW).samples[0]!.icmp!.minMs, null);
});

test("a reported series that contradicts itself is refused rather than stored", () => {
  const moreRepliesThanSent = sampleSet({ samples: [{ at: minutesAgo(30), targetIndex: 0, result: "reached", icmp: { ...healthyIcmp(), sent: 2, received: 4, lossPercent: 0 }, tcp: okTcp() }] });
  assert.ok(refusal(() => parseSampleSet(moreRepliesThanSent, NOW)).issues.some(i => i.rule === "receivedExceedsSent"));
  const wrongPercent = sampleSet({ samples: [{ at: minutesAgo(30), targetIndex: 0, result: "timeout", icmp: { ...lossyIcmp(), lossPercent: 3 }, tcp: timeoutTcp() }] });
  assert.ok(refusal(() => parseSampleSet(wrongPercent, NOW)).issues.some(i => i.rule === "lossPercentMismatch"));
  const impossibleSpread = sampleSet({ samples: [{ at: minutesAgo(30), targetIndex: 0, result: "reached", icmp: { ...healthyIcmp(), minMs: 9, avgMs: 2, maxMs: 3 }, tcp: okTcp() }] });
  assert.ok(refusal(() => parseSampleSet(impossibleSpread, NOW)).issues.some(i => i.rule === "roundTripSpread"));
  const tooManyEndings = sampleSet({ samples: [{ at: minutesAgo(30), targetIndex: 0, result: "reached", icmp: healthyIcmp(), tcp: { attempts: 2, connected: 2, refused: 2, timedOut: 2, minMs: 1, avgMs: 2, maxMs: 3 } }] });
  assert.ok(refusal(() => parseSampleSet(tooManyEndings, NOW)).issues.some(i => i.rule === "tcpOutcomesExceedAttempts"));
  const noConnectionWithTimes = sampleSet({ samples: [{ at: minutesAgo(30), targetIndex: 0, result: "refused", icmp: healthyIcmp(), tcp: { ...refusedTcp(), minMs: 1, avgMs: 1, maxMs: 1 } }] });
  assert.throws(() => parseSampleSet(noConnectionWithTimes, NOW), ContractError);
});

test("the attempt's verdict cannot contradict its own series", () => {
  const sample0 = (over: Record<string, unknown>) => ({ at: minutesAgo(30), targetIndex: 0, result: "reached", icmp: healthyIcmp(), tcp: okTcp(), ...over });
  const issuesFor = (over: Record<string, unknown>) => {
    try { parseSampleSet(sampleSet({ samples: [sample0(over)] }), NOW); return []; }
    catch (e) { if (e instanceof ContractError) return [...e.issues]; throw e; }
  };
  const contradiction = (over: Record<string, unknown>) => issuesFor(over).some(i => i.rule === "resultContradictsSeries");
  // A timeout while three connects succeeded is not a timeout.
  assert.equal(contradiction({ result: "timeout", icmp: silentIcmp(), tcp: okTcp() }), true);
  // Silence with a working port is a success, however little the ICMP series liked it.
  assert.deepEqual(issuesFor({ result: "reached", icmp: silentIcmp(), tcp: okTcp() }), []);
  // Reached with nothing answered is not reached, and a refusal with no refusal counted is not a refusal.
  assert.equal(contradiction({ result: "reached", icmp: silentIcmp(), tcp: timeoutTcp() }), true);
  assert.equal(contradiction({ result: "refused", icmp: healthyIcmp(), tcp: okTcp() }), true);
  assert.equal(contradiction({ result: "refused", icmp: healthyIcmp(), tcp: null }), true);
  // A timeout is allowed while the ping series had partial replies: it is the port that was silent, not the whole path.
  assert.deepEqual(issuesFor({ result: "timeout", icmp: lossyIcmp(), tcp: timeoutTcp() }), []);
  assert.deepEqual(issuesFor({ result: "refused", icmp: healthyIcmp(), tcp: refusedTcp() }), []);
  // An unreachable or errored attempt claims nothing about the series, so it is not constrained by it.
  assert.deepEqual(issuesFor({ result: "unreachable", icmp: silentIcmp(), tcp: timeoutTcp() }), []);
});

test("a sample that measured nothing is not a sample", () => {
  const empty = sampleSet({ samples: [{ at: minutesAgo(30), targetIndex: 0, result: "error", icmp: null, tcp: null }] });
  assert.ok(refusal(() => parseSampleSet(empty, NOW)).issues.some(i => i.rule === "not"));
});

test("timestamps: not in the future, not older than the retained buffer, not twice at the same instant", () => {
  const future = sampleSet({ samples: [{ at: new Date(NOW + 30 * 60_000).toISOString(), targetIndex: 0, result: "reached", icmp: healthyIcmp(), tcp: okTcp() }] });
  assert.ok(refusal(() => parseSampleSet(future, NOW)).issues.some(i => i.rule === "timestampInFuture"));
  const old = sampleSet({ samples: [{ at: new Date(NOW - RETENTION_MS - 3 * 60 * 60_000).toISOString(), targetIndex: 0, result: "reached", icmp: healthyIcmp(), tcp: okTcp() }] });
  assert.ok(refusal(() => parseSampleSet(old, NOW)).issues.some(i => i.rule === "timestampTooOld"));
  const twice = { at: minutesAgo(30), targetIndex: 0, result: "reached" as const, icmp: healthyIcmp(), tcp: okTcp() };
  const duplicate = sampleSet({ samples: [twice, { ...twice }] });
  assert.ok(refusal(() => parseSampleSet(duplicate, NOW)).issues.some(i => i.rule === "duplicateSample"));
  // The same instant for two different targets is not a duplicate: two targets are polled in the same second.
  const twoTargets = parseSampleSet(sampleSet({ samples: [twice, { ...twice, targetIndex: 1 }] }), NOW);
  assert.equal(twoTargets.samples.length, 2);
});

test("numbers that are not real numbers never reach the totals", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const hostile = sampleSet({ samples: [{ at: minutesAgo(30), targetIndex: 0, result: "reached", icmp: { ...healthyIcmp(), avgMs: bad }, tcp: okTcp() }] });
    assert.throws(() => parseSampleSet(hostile, NOW), ContractError, `accepted avgMs=${String(bad)}`);
    const loss = sampleSet({ samples: [{ at: minutesAgo(30), targetIndex: 0, result: "reached", icmp: { ...healthyIcmp(), lossPercent: bad }, tcp: okTcp() }] });
    assert.throws(() => parseSampleSet(loss, NOW), ContractError, `accepted lossPercent=${String(bad)}`);
  }
  assert.equal(lossPercentOf(4, 1), 75);
  assert.equal(lossPercentOf(0, 0), 0);
  assert.equal(lossPercentOf(3, 0), 100);
});

test("the reported batch is bounded before it is bound to the server's targets", () => {
  const one = { at: minutesAgo(30), targetIndex: 0, result: "reached", icmp: healthyIcmp(), tcp: okTcp() };
  assert.equal(parseReportedSamples([one], 2, NOW).length, 1);
  assert.throws(() => parseReportedSamples([], 2, NOW), ContractError);
  assert.throws(() => parseReportedSamples("not an array", 2, NOW), ContractError);
  assert.throws(() => parseReportedSamples({ samples: [one] }, 2, NOW), ContractError);
  assert.throws(() => parseReportedSamples(Array.from({ length: MAX_SAMPLES + 1 }, () => one), 2, NOW), ContractError);
  assert.throws(() => parseReportedSamples([{ ...one, port: 22 }], 2, NOW), ContractError);
  assert.throws(() => parseReportedSamples([{ ...one, targetIndex: 9 }], 2, NOW), ContractError);
  // A reported target is ignored, not copied: the stored set carries the selection the server passed in.
  const stored = assembleSampleSet({ selection, state: { online: false, minutesSilent: 95 }, samples: [one], cabinetId: CABINET, siteId: SITE, role: "satellite", collectedAt: minutesAgo(1), now: NOW });
  assert.deepEqual(stored.targets, selection);
  assert.deepEqual(stored.state, { online: false, minutesSilent: 95 });
});

test("the validators are pure: a refusal never echoes what was submitted", () => {
  const secret = "attacker-supplied-host-name.example";
  const hostile = sampleSet({ targets: [{ kind: "sync_cabinet", address: secret, port: 8443 }] });
  const error = refusal(() => parseSampleSet(hostile, NOW));
  assert.ok(!JSON.stringify(error).includes(secret), "the refusal repeated the submitted value");
  const before = sampleSet();
  const snapshot = JSON.stringify(before);
  parseSampleSet(before, NOW);
  assert.equal(JSON.stringify(before), snapshot, "parsing mutated its input");
});

test("a report parses, and a finding with an invented severity or id is refused", () => {
  const finding = { id: "pathhealth-ok", layer: "sync" as Layer, severity: "ok" as Severity, certainty: "possible" as Certainty, title: "Sync path measured clean", evidence: ["sync cabinet 10.21.9.20:8443: 4 sent, 4 replied."], fix: null };
  const report = {
    cabinetId: CABINET, siteId: SITE, window: { from: minutesAgo(30), to: minutesAgo(30), samples: 1, dropped: 0 }, syncFailureWindow: null,
    targets: [{ kind: "sync_cabinet", address: "10.21.9.20", port: 8443, samples: 1, icmp: { sent: 4, received: 4, lossPercent: 0, maxLossPercent: 0, minMs: 0.4, avgMs: 0.7, maxMs: 1.1, jitterMs: 0.2 }, tcp: { attempts: 3, connected: 3, refused: 0, timedOut: 0 }, state: "ok" }],
    correlation: { measured: true, lossDuringWindow: false, timeoutsDuringWindow: false, refusalsDuringWindow: false, icmpFiltered: false, interpretation: "path_clean", confidence: "possible" },
    findings: [finding],
  };
  assert.deepEqual(parseReport(report), report as never);
  assert.throws(() => parseReport({ ...report, findings: [{ ...finding, severity: "critical" }] }), ContractError);
  assert.throws(() => parseReport({ ...report, findings: [{ ...finding, id: "loss-window" }] }), ContractError);
  assert.throws(() => parseReport({ ...report, correlation: { ...report.correlation, interpretation: "packet_loss" } }), ContractError);
  assert.throws(() => parseReport({ ...report, window: { from: minutesAgo(30), to: minutesAgo(30), samples: -1, dropped: 0 } }), ContractError);
  assert.throws(() => parseReport({ ...report, targets: [123] }), ContractError);
});

test("a sample set with no samples is valid: retention can empty a window, and that is not health", () => {
  const empty = parseSampleSet(sampleSet({ samples: [] }), NOW);
  assert.equal(empty.samples.length, 0);
  assert.equal(pathHealthContracts.sampleSet.is(empty), true);
  assert.equal(MAX_SAMPLES_PER_TARGET, 24);
});
