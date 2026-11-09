// Retention and aggregation for sync-path samples (docs/platform/archive/improvement-plan.md §4: "keep 24 hours, aggregate per target").
//
// Two things this file refuses to do:
//   * It never turns a silence into a number. A series with no reply keeps null round-trip figures, so a missing reply can never be
//     read as an impossibly fast one; a target with no measurement is "not_measured", never "ok".
//   * It never counts a silent ICMP series as loss when a TCP connect to the same address succeeded. That combination is packet
//     filtering, and calling it loss sends the technician to the wrong end of the cable.
//
// Thresholds are the diagnosis's own, so a path-health finding means the same thing as a network finding (network-findings.ts treats
// a ping loss of 10% or more as a weak link).
import type { PathHealthIcmpTotal, PathHealthSample, PathHealthSampleSet, PathHealthTarget, PathHealthTargetState, PathHealthTargetSummary, PathHealthTcpTotal } from "./pathhealth-contracts.js";
import { MAX_SAMPLES_PER_TARGET, RETENTION_MS, lossPercentOf, parseSampleSet } from "./pathhealth-contracts.js";

/** The loss at which the platform calls a path lossy: the same 10% network-findings.ts uses for a weak link. */
export const LOSS_THRESHOLD_PERCENT = 10;

const timeOf = (value: string): number => Date.parse(value);
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/**
 * Keeps the last 24 hours and at most 24 samples per target, newest kept. Returns how many were dropped so a report can say that
 * a window is thin because retention cleared it, rather than showing a healthy-looking empty set.
 */
export function retain(set: PathHealthSampleSet, now: number): { set: PathHealthSampleSet; dropped: number } {
  const cutoff = now - RETENTION_MS;
  const fresh = set.samples.filter(s => timeOf(s.at) >= cutoff);
  const perTarget = new Map<number, number>();
  const kept: PathHealthSample[] = [];
  // Newest first while the cap is applied, so it is the newest samples that survive it.
  for (const sample of [...fresh].sort((a, b) => timeOf(b.at) - timeOf(a.at))) {
    const count = perTarget.get(sample.targetIndex) ?? 0;
    if (count >= MAX_SAMPLES_PER_TARGET) continue;
    perTarget.set(sample.targetIndex, count + 1);
    kept.push(sample);
  }
  kept.sort((a, b) => timeOf(a.at) - timeOf(b.at));
  const dropped = set.samples.length - kept.length;
  if (dropped === 0) return { set, dropped: 0 };
  // Re-validated, not merely copied: retention must not be able to produce a stored set that its own schema refuses.
  return { set: parseSampleSet({ ...set, samples: kept }, now), dropped };
}

/** The ICMP series of a target added up over the samples: totals, the worst single series, and the worst spread. */
export function totalIcmp(samples: readonly PathHealthSample[]): PathHealthIcmpTotal | null {
  const series = samples.map(s => s.icmp).filter((s): s is NonNullable<PathHealthSample["icmp"]> => s !== null);
  if (series.length === 0) return null;
  const sent = sum(series.map(s => s.sent));
  const received = sum(series.map(s => s.received));
  if (sent === 0) return null;
  const mins = series.map(s => s.minMs).filter((v): v is number => v !== null);
  const maxes = series.map(s => s.maxMs).filter((v): v is number => v !== null);
  const jitters = series.map(s => s.jitterMs).filter((v): v is number => v !== null);
  // Weighted by replies, so a series that got three replies does not weigh as much as one that got twenty.
  const weighted = series.filter(s => s.avgMs !== null && s.received > 0);
  const replies = sum(weighted.map(s => s.received));
  const avg = replies > 0 ? weighted.reduce((acc, s) => acc + (s.avgMs ?? 0) * s.received, 0) / replies : null;
  return {
    sent,
    received,
    lossPercent: lossPercentOf(sent, received),
    maxLossPercent: Math.max(...series.map(s => s.lossPercent)),
    minMs: mins.length > 0 ? Math.min(...mins) : null,
    avgMs: avg === null ? null : Math.round(avg * 100) / 100,
    maxMs: maxes.length > 0 ? Math.max(...maxes) : null,
    jitterMs: jitters.length > 0 ? Math.max(...jitters) : null,
  };
}

/** The TCP connect series of a target added up: how the attempts ended. A refusal is not an IP measurement, so it stays its own count. */
export function totalTcp(samples: readonly PathHealthSample[]): PathHealthTcpTotal | null {
  const series = samples.map(s => s.tcp).filter((s): s is NonNullable<PathHealthSample["tcp"]> => s !== null);
  if (series.length === 0) return null;
  return {
    attempts: sum(series.map(s => s.attempts)),
    connected: sum(series.map(s => s.connected)),
    refused: sum(series.map(s => s.refused)),
    timedOut: sum(series.map(s => s.timedOut)),
  };
}

/** True when ICMP was entirely silent. Silence is not loss on its own: it needs the TCP result to tell the two apart. */
export const icmpSilent = (t: PathHealthIcmpTotal | null): boolean => t !== null && t.sent > 0 && t.received === 0;
/** True when part of the ICMP series came back and part did not: that is loss, whether or not the port answers. */
export const icmpPartiallyLost = (t: PathHealthIcmpTotal | null): boolean => t !== null && t.received > 0 && t.received < t.sent && t.lossPercent >= LOSS_THRESHOLD_PERCENT;

/**
 * How one target looks over the window, from measurements only.
 * An ICMP silence next to a successful TCP connect is filtering; an ICMP silence with no TCP success is an unanswered destination,
 * which is loss until something shows otherwise. A refusal is the port, not the path.
 */
export function targetState(icmp: PathHealthIcmpTotal | null, tcp: PathHealthTcpTotal | null): PathHealthTargetState {
  if (icmp === null && tcp === null) return "not_measured";
  const timedOut = tcp !== null && tcp.timedOut > 0;
  const refused = tcp !== null && tcp.refused > 0;
  const tcpWorking = tcp !== null && tcp.connected > 0;
  const lost = icmpPartiallyLost(icmp) || (icmpSilent(icmp) && !tcpWorking);
  if (lost && timedOut) return "loss_and_timeouts";
  if (lost) return "loss";
  if (timedOut) return "timeouts";
  if (refused) return "refused";
  if (icmpSilent(icmp) && tcpWorking) return "filtering";
  return "ok";
}

/** One summary per target, in the order the server selected them. A selected target with no samples is "not_measured", not "ok". */
export function summariseTargets(set: PathHealthSampleSet): PathHealthTargetSummary[] {
  const indexes = new Map<number, PathHealthSample[]>();
  for (const sample of set.samples) {
    const list = indexes.get(sample.targetIndex) ?? [];
    list.push(sample);
    indexes.set(sample.targetIndex, list);
  }
  // Only reachable if the contract check was bypassed: the schema bounds targetIndex to the targets the server filled in.
  const stray = [...indexes.keys()].filter(index => index < 0 || index >= set.targets.length);
  if (stray.length > 0) throw new Error(`pathhealth: samples reference targets that were not selected (${stray.join(", ")})`);
  return set.targets.map((target, index) => {
    const samples = indexes.get(index) ?? [];
    const icmp = totalIcmp(samples);
    const tcp = totalTcp(samples);
    return { kind: target.kind, address: target.address, port: target.port, samples: samples.length, icmp, tcp, state: targetState(icmp, tcp) };
  });
}

/** The bounds of the samples a report covers: oldest, newest, how many, and how many retention dropped. */
export function reportWindow(set: PathHealthSampleSet, dropped: number): { from: string | null; to: string | null; samples: number; dropped: number } {
  if (set.samples.length === 0) return { from: null, to: null, samples: 0, dropped };
  const ordered = set.samples.map(s => s.at).sort((a, b) => timeOf(a) - timeOf(b));
  return { from: ordered[0]!, to: ordered[ordered.length - 1]!, samples: set.samples.length, dropped };
}
