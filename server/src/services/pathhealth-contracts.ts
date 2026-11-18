// The sync-path contracts:
// validation and the semantic rules the JSON Schemas cannot express, in front of every other file here.
//
// Every value that enters from a cabinet or a console passes contracts/schemas/pathhealth/*.schema.json first (CLAUDE.md: validation
// before any other code), and then the consistency checks below, which a schema cannot state: that a loss percentage agrees with the
// replies that came back, that a series with no reply carries no round-trip times, and that a sample points at a target the server itself
// filled in. Nothing here echoes a submitted value: a refusal reports a location and a rule only.
//
// The types are written by hand instead of imported: contracts/scripts/generate-ts.mjs generates only the catalog operations, the
// envelopes, the console bodies and the agent upgrade files, so a new schema directory (pathhealth/) would not appear in
// generated/ts/contracts.d.ts. The schemas stay the source of truth: the tests below check the constants against the schema text.
import { createAjv, ref } from "@mashura/cabinet-contracts/load";
import { ContractError, type ContractIssue } from "../contracts.js";
import type { Certainty, Layer, Severity } from "../diagnose/network-findings.js";

/** New Ajv instance: contracts.ts does not export the one it builds, and a second one compiles only this directory's schemas. */
const ajv = createAjv();

export interface Validator<T> {
  /** Type guard: true when data matches the schema. */
  is(data: unknown): data is T;
  /** Returns the data typed, or throws ContractError. */
  parse(data: unknown): T;
}

function validator<T>(name: string, id: string): Validator<T> {
  const check = ajv.getSchema(id);
  if (!check) throw new Error(`Contract schema not found: ${id} (contracts/schemas/pathhealth)`);
  return {
    is: (data: unknown): data is T => check(data) === true,
    parse(data: unknown): T {
      if (check(data) === true) return data as T;
      throw new ContractError(name, issuesOf(check.errors));
    },
  };
}

/** Locations and failed keywords only; the submitted values are never included (they may be hostile). */
function issuesOf(errors: readonly { instancePath?: string; keyword?: string }[] | null | undefined): ContractIssue[] {
  return (errors ?? []).slice(0, 20).map(e => ({ path: e.instancePath || "/", rule: e.keyword ?? "unknown" }));
}

const sampleSetId = (def?: string) => ref("pathhealth/sample-set.schema.json", def);
const reportId = () => ref("pathhealth/report.schema.json");

// ---- Bounds, mirrored by the schemas (a test asserts they agree) ------------------------------------
/** At most four sync ports plus the platform endpoint. */
export const MAX_TARGETS = 5;
/** At most 24 samples per target, so 24 hourly samples. */
export const MAX_SAMPLES_PER_TARGET = 24;
/** At most 120 samples in one stored set. */
export const MAX_SAMPLES = 120;
/** Sets are a recent buffer: older than this, a sample says nothing about a window that is still of interest. */
export const RETENTION_MS = 24 * 60 * 60 * 1000;
/** An agent's clock may run a little fast; more than this is a claim about the future. */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;

// ---- Types (the shapes the schemas describe) --------------------------------------------------------
export type PathHealthTargetKind = "sync_cabinet" | "platform_server";
export type PathHealthResult = "reached" | "timeout" | "refused" | "unreachable" | "error";
export type PathHealthTargetState = "ok" | "loss" | "loss_and_timeouts" | "timeouts" | "refused" | "filtering" | "not_measured";
export type PathHealthInterpretation = "loss_during_window" | "packet_filtering" | "application_or_listener" | "path_clean" | "not_measured";

/** A destination the server filled in from settings: a private IPv4 address and, at most, a configured service port. */
export interface PathHealthTarget {
  kind: PathHealthTargetKind;
  address: string;
  /** Null for an ICMP-only target; never a caller's choice. */
  port: number | null;
}

export interface PathHealthIcmpSeries {
  sent: number;
  received: number;
  lossPercent: number;
  /** Null when nothing came back: no reply, no round-trip time (never zero). */
  minMs: number | null;
  avgMs: number | null;
  maxMs: number | null;
  jitterMs: number | null;
}

export interface PathHealthTcpSeries {
  attempts: number;
  connected: number;
  refused: number;
  timedOut: number;
  /** Null when no connection was made. */
  minMs: number | null;
  avgMs: number | null;
  maxMs: number | null;
}

export interface PathHealthSample {
  at: string;
  /** Index into the set's targets; there is no other way to name a destination. */
  targetIndex: number;
  result: PathHealthResult;
  icmp: PathHealthIcmpSeries | null;
  tcp: PathHealthTcpSeries | null;
}

/** What the platform knew about the cabinet's heartbeat at collection time (server-filled). */
export interface PathHealthState {
  online: boolean;
  minutesSilent: number | null;
}

export interface PathHealthSampleSet {
  cabinetId: string;
  siteId: string;
  role: "sync" | "satellite" | "standalone";
  collectedAt: string;
  targets: PathHealthTarget[];
  state: PathHealthState | null;
  samples: PathHealthSample[];
}

export interface PathHealthIcmpTotal {
  sent: number;
  received: number;
  lossPercent: number;
  maxLossPercent: number;
  minMs: number | null;
  avgMs: number | null;
  maxMs: number | null;
  jitterMs: number | null;
}

export interface PathHealthTcpTotal {
  attempts: number;
  connected: number;
  refused: number;
  timedOut: number;
}

export interface PathHealthTargetSummary {
  kind: PathHealthTargetKind;
  address: string;
  port: number | null;
  samples: number;
  icmp: PathHealthIcmpTotal | null;
  tcp: PathHealthTcpTotal | null;
  state: PathHealthTargetState;
}

export interface PathHealthFailureWindow {
  from: string;
  /** Null while the failure is still open. */
  to: string | null;
  failedChecks: number;
}

export interface PathHealthCorrelation {
  measured: boolean;
  lossDuringWindow: boolean;
  timeoutsDuringWindow: boolean;
  refusalsDuringWindow: boolean;
  icmpFiltered: boolean;
  interpretation: PathHealthInterpretation;
  confidence: Certainty;
}

export interface PathHealthReportWindow {
  from: string | null;
  to: string | null;
  samples: number;
  dropped: number;
}

/** The same shape the network diagnosis uses, so the console can merge the two lists. */
export interface PathHealthFinding {
  id: string;
  layer: Layer;
  severity: Severity;
  certainty: Certainty;
  title: string;
  evidence: string[];
  fix: string | null;
  /** The id of the network finding that probably explains this one; null or absent when none does. No automatic fix action is proposed. */
  causedBy?: string | null;
}

export interface PathHealthReport {
  cabinetId: string;
  siteId: string;
  window: PathHealthReportWindow;
  syncFailureWindow: PathHealthFailureWindow | null;
  targets: PathHealthTargetSummary[];
  correlation: PathHealthCorrelation;
  findings: PathHealthFinding[];
}

// ---- Validators --------------------------------------------------------------------------------------
export const pathHealthContracts = {
  /** A whole stored set, as the platform keeps it (targets and state filled in by the server). */
  sampleSet: validator<PathHealthSampleSet>("pathhealth/sample-set", sampleSetId()),
  /** One measured sample, the shape a cabinet reports back. */
  sample: validator<PathHealthSample>("pathhealth/sample", sampleSetId("sample")),
  /** The report the platform builds from a set. */
  report: validator<PathHealthReport>("pathhealth/report", reportId()),
} as const;

/** The compiled check for one sample, used where the failed keywords themselves are reported. */
const sampleCheck = ajv.getSchema(sampleSetId("sample"))!;

// ---- Semantic checks ---------------------------------------------------------------------------------
interface JsonObject { [key: string]: unknown }
const asObject = (value: unknown): JsonObject | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Rounds the way the cabinet reports: whole percentages to one decimal place. */
export const lossPercentOf = (sent: number, received: number): number => (sent <= 0 ? 0 : Math.round((100 * (sent - received) / sent) * 10) / 10);

/**
 * The rules a JSON Schema cannot state, applied to one sample.
 * A mismatch means the cabinet's report contradicts itself, so it is refused rather than stored.
 */
export function checkSample(value: unknown, path: string, targetCount: number): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const s = asObject(value);
  if (!s) return issues; // the schema already refused anything that is not an object
  const index = num(s.targetIndex);
  if (index !== null && (index < 0 || index >= targetCount)) issues.push({ path: `${path}/targetIndex`, rule: "targetIndexOutOfRange" });

  const icmp = asObject(s.icmp);
  if (icmp) {
    const sent = num(icmp.sent), received = num(icmp.received), lossPercent = num(icmp.lossPercent);
    if (sent !== null && received !== null && received > sent) issues.push({ path: `${path}/icmp/received`, rule: "receivedExceedsSent" });
    if (sent !== null && received !== null && lossPercent !== null && Math.abs(lossPercent - lossPercentOf(sent, received)) > 0.05)
      issues.push({ path: `${path}/icmp/lossPercent`, rule: "lossPercentMismatch" });
    if (received !== null && received > 0) {
      const min = num(icmp.minMs), avg = num(icmp.avgMs), max = num(icmp.maxMs), jitter = num(icmp.jitterMs);
      if (min === null || avg === null || max === null || jitter === null) issues.push({ path: `${path}/icmp`, rule: "roundTripMissing" });
      else if (!(min <= avg && avg <= max)) issues.push({ path: `${path}/icmp/avgMs`, rule: "roundTripSpread" });
    }
  }

  const tcp = asObject(s.tcp);
  if (tcp) {
    const attempts = num(tcp.attempts), connected = num(tcp.connected), refused = num(tcp.refused), timedOut = num(tcp.timedOut);
    if (attempts !== null && connected !== null && refused !== null && timedOut !== null && connected + refused + timedOut > attempts)
      issues.push({ path: `${path}/tcp`, rule: "tcpOutcomesExceedAttempts" });
    if (connected !== null && connected > 0) {
      const min = num(tcp.minMs), avg = num(tcp.avgMs), max = num(tcp.maxMs);
      if (min === null || avg === null || max === null) issues.push({ path: `${path}/tcp`, rule: "connectTimeMissing" });
      else if (!(min <= avg && avg <= max)) issues.push({ path: `${path}/tcp/avgMs`, rule: "connectTimeSpread" });
    }
  }

  // The attempt's own verdict cannot contradict its series: an impossible combination is a report that cannot be trusted.
  const result = s.result;
  const icmpReplies = icmp ? num(icmp.received) : null;
  const connected = tcp ? num(tcp.connected) : null;
  const refused = tcp ? num(tcp.refused) : null;
  const anySuccess = (icmpReplies ?? 0) > 0 || (connected ?? 0) > 0;
  if (result === "reached" && !anySuccess) issues.push({ path: `${path}/result`, rule: "resultContradictsSeries" });
  // A timeout means the port was not answered; a successful connect in the same sample says it was.
  if (result === "timeout" && (connected ?? 0) > 0) issues.push({ path: `${path}/result`, rule: "resultContradictsSeries" });
  if (result === "refused" && (refused ?? 0) === 0) issues.push({ path: `${path}/result`, rule: "resultContradictsSeries" });
  return issues;
}

/** A timestamp the platform is willing to correlate: a real date, not in the future, not older than the retained buffer. */
export function checkSampleTime(at: unknown, path: string, now: number): ContractIssue[] {
  if (typeof at !== "string") return []; // the schema's pattern already refused that
  const parsed = Date.parse(at);
  const issues: ContractIssue[] = [];
  if (Number.isNaN(parsed)) issues.push({ path, rule: "notATimestamp" });
  else if (parsed > now + FUTURE_SKEW_MS) issues.push({ path, rule: "timestampInFuture" });
  else if (parsed < now - RETENTION_MS - 60 * 60 * 1000) issues.push({ path, rule: "timestampTooOld" });
  return issues;
}

/**
 * Validates one sample set: the schema first, then the consistency rules, then the duplicates.
 * `now` is passed in so the result never depends on when it is called.
 */
export function parseSampleSet(value: unknown, now: number): PathHealthSampleSet {
  const set = pathHealthContracts.sampleSet.parse(value);
  const issues: ContractIssue[] = checkSampleTime(set.collectedAt, "/collectedAt", now);
  const seen = new Set<string>();
  set.samples.forEach((sample, i) => {
    issues.push(...checkSample(sample, `/samples/${i}`, set.targets.length));
    issues.push(...checkSampleTime(sample.at, `/samples/${i}/at`, now));
    const key = `${sample.targetIndex}@${sample.at}`;
    if (seen.has(key)) issues.push({ path: `/samples/${i}/at`, rule: "duplicateSample" });
    seen.add(key);
  });
  if (issues.length > 0) throw new ContractError("pathhealth/sample-set", issues.slice(0, 20));
  return set;
}

/**
 * Validates the samples a cabinet reported, before the server binds them to the targets it filled in.
 * The array is bounded here because the schema describes one sample, not the batch.
 */
export function parseReportedSamples(value: unknown, targetCount: number, now: number): PathHealthSample[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SAMPLES)
    throw new ContractError("pathhealth/sample", [{ path: "/samples", rule: "sampleCountOutOfRange" }]);
  const samples: PathHealthSample[] = [];
  const issues: ContractIssue[] = [];
  value.forEach((entry, i) => {
    if (!pathHealthContracts.sample.is(entry)) {
      sampleCheck(entry);
      issues.push(...issuesOf(sampleCheck.errors).map(e => ({ path: `/samples/${i}${e.path === "/" ? "" : e.path}`, rule: e.rule })));
      return;
    }
    issues.push(...checkSample(entry, `/samples/${i}`, targetCount));
    issues.push(...checkSampleTime(entry.at, `/samples/${i}/at`, now));
    samples.push(entry);
  });
  if (issues.length > 0) throw new ContractError("pathhealth/sample", issues.slice(0, 20));
  return samples;
}

/**
 * The set the platform stores: the cabinet's reported samples bound to the targets and the state the server filled in itself,
 * then checked once more as a whole. A reported target can never reach storage, because the caller passes the selection
 * (pathhealth-targets.ts) and nothing from the report is copied into it.
 */
export function assembleSampleSet(input: { selection: PathHealthTarget[]; state: PathHealthState | null; samples: unknown; cabinetId: string; siteId: string; role: "sync" | "satellite" | "standalone"; collectedAt: string; now: number }): PathHealthSampleSet {
  const samples = parseReportedSamples(input.samples, input.selection.length, input.now);
  if (input.selection.length === 0 || input.selection.length > MAX_TARGETS)
    throw new ContractError("pathhealth/sample-set", [{ path: "/targets", rule: "targetCountOutOfRange" }]);
  return parseSampleSet({
    cabinetId: input.cabinetId, siteId: input.siteId, role: input.role, collectedAt: input.collectedAt,
    targets: input.selection.map(t => ({ kind: t.kind, address: t.address, port: t.port })),
    state: input.state, samples,
  }, input.now);
}

/** Validates a report before it leaves the server (the console renders it, so it is a contract too). */
export function parseReport(value: unknown): PathHealthReport {
  return pathHealthContracts.report.parse(value);
}
