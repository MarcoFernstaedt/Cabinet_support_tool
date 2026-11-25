// The USB alert rules: what a validated report and a resolved policy add up to.
//
// The three rules, and where each bound comes from (docs/spec/18-built-designs.md §5):
//   * usb-absent: a unit that has been known is gone, continuously, for `absentForMinutes`. The absence is timed from
//     the first evidence of it (firstAbsentAt, or the last time the unit was seen present, which can only make the
//     wait longer, never shorter) — never from a missing field;
//   * usb-flap: `reconnect.count` completed present -> absent -> present cycles inside `reconnect.count`... inside
//     `reconnect.windowMinutes`, and only from a count the cabinet can vouch for: a lower bound is not enough, and a
//     counting window longer than the policy's proves nothing about the policy's window;
//   * usb-dependency: a service or application the unit needs is not attached (a running service is not attachment);
//
// with automatic resolution when the unit returns — two healthy samples, so one reading at a resume is not enough, and
// never because telemetry went missing — severity per rule (falling back to the issue type's own severity), quiet hours
// that defer delivery and nothing else, and a 15-minute rate limit on repeats of one incident.
//
// This module reads no database, holds no threshold of its own (every number comes from the resolved policy or from the
// constants named below) and executes nothing on a cabinet: it takes a validated report, the levels, the open incidents
// and the issue type catalog, and returns decisions.
import {
  USB_ISSUE_KEYS, USB_SCOPE_LEVELS, UsbPolicyMemory, checkUsbContract, reconcileUsbPolicies, usbPolicyAuditEntry,
  type UsbAuditEntry, type UsbPolicy, type UsbPolicyLevel, type UsbPolicyResolution, type UsbPolicySubject, type UsbScopeLevel,
  type UsbSeverity, type UsbValidationIssue, USB_DEVICE_REPORT_SCHEMA,
} from "./usb-policy.js";

export { usbPolicyAuditEntry, type UsbAuditEntry };
export type { UsbPolicy, UsbPolicyLevel, UsbSeverity, UsbScopeLevel };
export { USB_DEVICE_REPORT_SCHEMA, USB_SCOPE_LEVELS };

export type { UsbRuleId } from "./usb-policy.js";
import type { UsbRuleId } from "./usb-policy.js";

/** How often a repeat of one open incident may page an operator. */
export const USB_INCIDENT_RATE_LIMIT_MINUTES = 15;
/** Two healthy samples before an incident is closed: one reading at a resume proves nothing. */
export const USB_HEALTHY_SAMPLES = 2;
/** Dependency incidents one report may open at once; the rest are counted, not dropped silently. */
export const USB_DEPENDENCY_INCIDENT_CAP = 20;

// ---- The report, as the contract validates it ------------------------------------------

export type UsbDeviceState = "present" | "suspectAbsent" | "absent" | "recovering" | "problem" | "queryRemove" | "unknown";
export type UsbMonitorState = "unknown" | "present" | "suspectAbsent" | "absent" | "recovering" | "degraded";
export type UsbWorkloadKind = "service" | "process" | "probe";
export type UsbWorkloadState = "running" | "stopped" | "missing" | "attached" | "detached" | "unknown";

export interface UsbWorkloadEntry {
  kind: UsbWorkloadKind;
  name: string;
  state: UsbWorkloadState;
  isDeviceDriver?: boolean;
  checkedAt?: string | null;
}

export interface UsbReportDevice {
  unitKey: string;
  portKey: string | null;
  parentKey: string | null;
  parentRootCause: "none" | "usb-hub" | "usb-controller" | "dock" | "power";
  identity: "instanceId" | "serial" | "vidPid" | "hardwareId" | "containerId";
  identityConfidence: "high" | "low" | "none";
  state: UsbDeviceState;
  problemCode?: number | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  firstAbsentAt: string | null;
  reconnectCount: number;
  reconnectWindowMinutes: number | null;
  cyclesAreLowerBound: boolean;
  healthySamples: number;
  portDisplay?: string | null;
  workload: readonly UsbWorkloadEntry[];
  workloadProbe: "none" | "service" | "application";
}

/** One report as the cabinet sent it: validated, not yet interpreted. */
export interface UsbDeviceReport {
  cabinetId: string;
  bootId: string;
  reportedAt: string;
  monitorState: UsbMonitorState;
  settled: boolean;
  eventHistoryComplete: boolean;
  sweepSeconds?: number;
  devices: readonly UsbReportDevice[];
}

export type UsbReportCheck = { ok: true; report: UsbDeviceReport } | { ok: false; issues: readonly UsbValidationIssue[] };

/**
 * Validates a report against the contract before anything reads it. The cabinet is authenticated when it heartbeats,
 * but its report is still untrusted input: everything below works from a report that passed here, or not at all.
 */
export function checkUsbDeviceReport(value: unknown): UsbReportCheck {
  const issues = checkUsbContract(USB_DEVICE_REPORT_SCHEMA, value);
  if (issues) return { ok: false, issues };
  return { ok: true, report: value as UsbDeviceReport };
}

// ---- Incidents -------------------------------------------------------------------------

export interface UsbIssueTypeInfo {
  id: string;
  name: string;
  severity: UsbSeverity;
}

/** An incident the platform is already carrying, as the data layer reads it back for one cabinet. */
export interface UsbOpenIncident {
  severity: UsbSeverity;
  occurrences: number;
  lastUpdateAt: Date | null;
}

export type UsbDecisionAction = "open" | "update" | "resolve";

/** Why a rule had nothing to say about a unit (or one of its dependencies). */
export type UsbHoldReason =
  | "unwatched" // no level watches this unit
  | "disabled" // the policy that watches it is switched off
  | "source_unknown" // the agent's monitor is degraded or unknown: nothing can be concluded
  | "settling" // boot or resume: a missing unit proves nothing yet
  | "never_seen" // an automatic scanner nobody has ever seen is not an absent device
  | "waiting" // the absence is real but younger than the threshold
  | "uncertain" // not one moment of evidence about when the absence began
  | "indeterminate" // suspectAbsent, recovering, queryRemove: the unit is neither here nor gone
  | "rule_off" // the rule that would fire is switched off in the policy
  | "lower_bound" // the cabinet cannot vouch for the reconnect count
  | "window_too_long" // the count was taken over a longer window than the rule's
  | "recovery_pending" // the unit is back, but not for two samples yet
  | "trigger_gone" // the condition the rule watches for is not present (a unit that is away cannot be flapping)
  | "catalog_missing"; // the rule's issue type is not seeded, so no alert can be raised for it

export interface UsbDecision {
  incidentKey: string;
  ruleId: UsbRuleId;
  issueKey: string;
  issueTypeId: string;
  action: UsbDecisionAction;
  severity: UsbSeverity;
  /** `deferred` during quiet hours for a minor alert: it is still opened and still counted, only the page waits. */
  delivery: "immediate" | "deferred";
  /** False when the incident was updated inside the rate-limit window: the row moves, nobody is paged again. */
  renotify: boolean;
  occurrences: number;
  title: string;
  subject: { unitKey: string; portKey: string | null; label: string | null; matchedBy: "device" | "port" };
  policyScope: { level: UsbScopeLevel; scopeId: string | null; version: number };
  observedAt: Date;
  absentSince: string | null;
  reconnectCount: number | null;
  dependencyName: string | null;
  /** True only when the policy asks for it and the dependency is an application: this layer starts nothing. */
  restartRequested: boolean;
}

export interface UsbHold {
  unitKey: string | null;
  ruleId: UsbRuleId | null;
  reason: UsbHoldReason;
}

export interface UsbWatchInput {
  cabinetId: string;
  now: Date;
  report: UsbDeviceReport;
  /** The four levels as the data layer read them, most specific first is not required: the resolution orders them. */
  levels: readonly UsbPolicyLevel[];
  memory?: UsbPolicyMemory;
  incidents: ReadonlyMap<string, UsbOpenIncident>;
  /** Issue types by their key (usb_missing and whatever else has been seeded). A rule absent from here cannot fire. */
  issueTypes: ReadonlyMap<string, UsbIssueTypeInfo>;
}

export interface UsbWatchResult {
  decisions: readonly UsbDecision[];
  holds: readonly UsbHold[];
  resolutions: readonly { unitKey: string; resolution: UsbPolicyResolution | null; skips: readonly { level: UsbScopeLevel; reason: string }[] }[];
  /** Dependency incidents this report had to leave unpaged because of the fan-out cap. */
  suppressedDependencies: number;
}

const MINUTE_MS = 60_000;
const RATE_LIMIT_MS = USB_INCIDENT_RATE_LIMIT_MINUTES * MINUTE_MS;

/** `usb:absent:<key>` — one incident key per rule and subject, so a recovery inherits it rather than opening a new one. */
export const usbIncidentKey = (ruleId: UsbRuleId, subjectKey: string, dependencyName?: string): string =>
  `usb:${ruleId.slice(4)}:${subjectKey}${dependencyName === undefined ? "" : `:${dependencyName}`}`;

/** The subject an incident key is built on: the unit's key, or the slot's when the policy watches the slot. */
export const usbSubjectKey = (matchedBy: "device" | "port", subject: UsbPolicySubject): string =>
  matchedBy === "device" ? subject.unitKey : `port:${subject.portKey ?? subject.unitKey}`;

const isPresent = (state: UsbDeviceState): boolean => state === "present" || state === "problem";
const isAbsent = (state: UsbDeviceState): boolean => state === "absent";

// ---- Quiet hours -----------------------------------------------------------------------

const WEEKDAY_NUMBER: Readonly<Record<string, number>> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export interface UsbQuietHoursState {
  active: boolean;
  /** Why: `none` (no window), `outside`, `inside`, `zone_unknown` or `no_day`. A zone the server cannot read is never quiet. */
  reason: "none" | "outside" | "inside" | "zone_unknown" | "no_day";
}

/**
 * Whether the quiet-hours window is in force at `now`.
 *
 * The window is read against the site's local wall clock, so it keeps its local times across a daylight-saving change,
 * and a window whose start is after its end runs over midnight. A time zone the server cannot read is reported as
 * `zone_unknown` and is NOT quiet: a notification is never held back by a window the server could not work out.
 */
export function usbQuietHoursState(window: UsbPolicy["quietHours"], now: Date): UsbQuietHoursState {
  if (!window) return { active: false, reason: "none" };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: window.timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  } catch {
    return { active: false, reason: "zone_unknown" };
  }
  const get = (type: string) => parts.find(p => p.type === type)?.value;
  const weekday = WEEKDAY_NUMBER[get("weekday") ?? ""];
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  if (weekday === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)) return { active: false, reason: "zone_unknown" };
  if (!window.weekdays.includes(weekday)) return { active: false, reason: "no_day" };
  const at = hour * 60 + minute;
  const inside = window.startMinute <= window.endMinute
    ? at >= window.startMinute && at < window.endMinute
    : at >= window.startMinute || at < window.endMinute; // over midnight
  return { active: inside, reason: inside ? "inside" : "outside" };
}

// ---- The rules -------------------------------------------------------------------------

interface RuleContext {
  input: UsbWatchInput;
  unit: UsbReportDevice;
  policy: UsbPolicy;
  resolution: UsbPolicyResolution;
  subjectKey: string;
  subject: UsbPolicySubject;
  label: string | null;
  quiet: UsbQuietHoursState;
}

/**
 * The key a rule's severity setting has in a policy. It is not the rule id with its prefix cut: the policy names the
 * reconnect rule's severity `reconnect`, because that is what the rule watches, not `flap`.
 */
const SEVERITY_KEY: Readonly<Record<UsbRuleId, keyof UsbPolicy["severity"]>> = {
  "usb-absent": "absent",
  "usb-flap": "reconnect",
  "usb-dependency": "dependency",
};

/** The severity of a rule: the policy's own choice, else the issue type's (the platform keeps one severity per issue type). */
function severityOf(policy: UsbPolicy, ruleId: UsbRuleId, issueType: UsbIssueTypeInfo): UsbSeverity {
  return policy.severity[SEVERITY_KEY[ruleId]] ?? issueType.severity;
}

/**
 * Builds a decision for one incident, folding in what the platform already carries for it: the action becomes an update
 * when the incident is open, the occurrence count carries on, and a repeat inside the rate-limit window moves the row
 * without paging anyone again.
 */
function decisionFor(ctx: RuleContext, ruleId: UsbRuleId, issueType: UsbIssueTypeInfo, extra: {
  incidentKey: string;
  severity: UsbSeverity;
  title: string;
  absentSince: string | null;
  reconnectCount: number | null;
  dependencyName: string | null;
  restartRequested: boolean;
  action: UsbDecisionAction;
}): UsbDecision {
  const open = ctx.input.incidents.get(extra.incidentKey) ?? null;
  const action: UsbDecisionAction = extra.action === "resolve" ? "resolve" : open ? "update" : "open";
  const occurrences = action === "resolve" ? open?.occurrences ?? 1 : (open?.occurrences ?? 0) + 1;
  const renotify = action === "resolve"
    ? true
    : open === null || open.lastUpdateAt === null || ctx.input.now.getTime() - open.lastUpdateAt.getTime() >= RATE_LIMIT_MS;
  const delivery: UsbDecision["delivery"] = action !== "resolve" && extra.severity === "minor" && ctx.quiet.active ? "deferred" : "immediate";
  return {
    incidentKey: extra.incidentKey,
    ruleId,
    issueKey: USB_ISSUE_KEYS[ruleId],
    issueTypeId: issueType.id,
    action,
    severity: extra.severity,
    delivery,
    renotify,
    occurrences,
    title: extra.title,
    subject: { unitKey: ctx.unit.unitKey, portKey: ctx.unit.portKey, label: ctx.label, matchedBy: ctx.resolution.matchedBy },
    policyScope: { level: ctx.resolution.level, scopeId: ctx.resolution.scopeId, version: ctx.resolution.version },
    observedAt: ctx.input.now,
    absentSince: extra.absentSince,
    reconnectCount: extra.reconnectCount,
    dependencyName: extra.dependencyName,
    restartRequested: extra.restartRequested,
  };
}

const title = (issueType: UsbIssueTypeInfo, label: string | null, key: string, suffix?: string): string =>
  `${issueType.name}: ${label ?? key}${suffix === undefined ? "" : `: ${suffix}`}`;

/** The absence rule: gone, continuously, for `absentForMinutes`; closed when the unit is back for two healthy samples. */
function absentDecisions(ctx: RuleContext, out: UsbDecision[], holds: UsbHold[]): void {
  const ruleId: UsbRuleId = "usb-absent";
  const issueType = ctx.input.issueTypes.get(USB_ISSUE_KEYS[ruleId]);
  if (!issueType) { holds.push({ unitKey: ctx.unit.unitKey, ruleId, reason: "catalog_missing" }); return; }
  const incidentKey = usbIncidentKey(ruleId, ctx.subjectKey);
  const open = ctx.input.incidents.get(incidentKey) ?? null;
  if (ctx.policy.absentForMinutes === null) { holds.push({ unitKey: ctx.unit.unitKey, ruleId, reason: "rule_off" }); return; }
  if (!isAbsent(ctx.unit.state)) {
    if (!isPresent(ctx.unit.state)) { holds.push({ unitKey: ctx.unit.unitKey, ruleId, reason: "indeterminate" }); return; }
    if (!open) { holds.push({ unitKey: ctx.unit.unitKey, ruleId, reason: "trigger_gone" }); return; }
    if (ctx.unit.healthySamples < USB_HEALTHY_SAMPLES) { holds.push({ unitKey: ctx.unit.unitKey, ruleId, reason: "recovery_pending" }); return; }
    out.push(decisionFor(ctx, ruleId, issueType, { incidentKey, severity: severityOf(ctx.policy, ruleId, issueType), title: title(issueType, ctx.label, ctx.unit.unitKey),
      absentSince: null, reconnectCount: null, dependencyName: null, restartRequested: false, action: "resolve" }));
    return;
  }
  // The absence began somewhere after the last time the unit was seen present, so timing it from there can only make
  // the wait longer than the real one, never shorter.
  const since = ctx.unit.firstAbsentAt ?? ctx.unit.lastSeenAt;
  if (since === null) { holds.push({ unitKey: ctx.unit.unitKey, ruleId, reason: "uncertain" }); return; }
  const elapsedMs = ctx.input.now.getTime() - Date.parse(since);
  if (!Number.isFinite(elapsedMs) || elapsedMs < ctx.policy.absentForMinutes * MINUTE_MS) { holds.push({ unitKey: ctx.unit.unitKey, ruleId, reason: "waiting" }); return; }
  out.push(decisionFor(ctx, ruleId, issueType, { incidentKey, severity: severityOf(ctx.policy, ruleId, issueType), title: title(issueType, ctx.label, ctx.unit.unitKey),
    absentSince: since, reconnectCount: null, dependencyName: null, restartRequested: false, action: "open" }));
}

/** The reconnect rule: N cycles inside Y minutes, from a count the cabinet can vouch for. */
function flapDecisions(ctx: RuleContext, out: UsbDecision[], holds: UsbHold[]): void {
  const ruleId: UsbRuleId = "usb-flap";
  const issueType = ctx.input.issueTypes.get(USB_ISSUE_KEYS[ruleId]);
  if (!issueType) { holds.push({ unitKey: ctx.unit.unitKey, ruleId, reason: "catalog_missing" }); return; }
  const incidentKey = usbIncidentKey(ruleId, ctx.subjectKey);
  const open = ctx.input.incidents.get(incidentKey) ?? null;
  if (!isPresent(ctx.unit.state)) { holds.push({ unitKey: ctx.unit.unitKey, ruleId, reason: isAbsent(ctx.unit.state) ? "trigger_gone" : "indeterminate" }); return; }
  if (!ctx.input.report.eventHistoryComplete || ctx.unit.cyclesAreLowerBound) { holds.push({ unitKey: ctx.unit.unitKey, ruleId, reason: "lower_bound" }); return; }
  const windowMinutes = ctx.unit.reconnectWindowMinutes ?? ctx.policy.reconnect.windowMinutes;
  if (windowMinutes > ctx.policy.reconnect.windowMinutes) { holds.push({ unitKey: ctx.unit.unitKey, ruleId, reason: "window_too_long" }); return; }
  const severity = severityOf(ctx.policy, ruleId, issueType);
  if (ctx.unit.reconnectCount >= ctx.policy.reconnect.count) {
    out.push(decisionFor(ctx, ruleId, issueType, { incidentKey, severity, title: title(issueType, ctx.label, ctx.unit.unitKey),
      absentSince: null, reconnectCount: ctx.unit.reconnectCount, dependencyName: null, restartRequested: false, action: "open" }));
    return;
  }
  if (!open) { holds.push({ unitKey: ctx.unit.unitKey, ruleId, reason: "trigger_gone" }); return; }
  out.push(decisionFor(ctx, ruleId, issueType, { incidentKey, severity, title: title(issueType, ctx.label, ctx.unit.unitKey),
    absentSince: null, reconnectCount: ctx.unit.reconnectCount, dependencyName: null, restartRequested: false, action: "resolve" }));
}

const DETACHED: readonly UsbWorkloadState[] = ["detached", "stopped", "missing"];

/** True when this entry is evidence that the dependency is working again. */
const isAttachedAgain = (entry: UsbWorkloadEntry): boolean => entry.state === "attached" || (entry.kind === "service" && entry.state === "running");

/** The dependency rule: something the unit needs is not attached. A running service is not attachment. */
function dependencyDecisions(ctx: RuleContext, out: UsbDecision[], holds: UsbHold[], state: { suppressed: number }): void {
  const ruleId: UsbRuleId = "usb-dependency";
  const issueType = ctx.input.issueTypes.get(USB_ISSUE_KEYS[ruleId]);
  if (!issueType) { holds.push({ unitKey: ctx.unit.unitKey, ruleId, reason: "catalog_missing" }); return; }
  if (!isPresent(ctx.unit.state)) { holds.push({ unitKey: ctx.unit.unitKey, ruleId, reason: isAbsent(ctx.unit.state) ? "trigger_gone" : "indeterminate" }); return; }
  const severity = severityOf(ctx.policy, ruleId, issueType);
  for (const entry of ctx.unit.workload) {
    const incidentKey = usbIncidentKey(ruleId, ctx.subjectKey, entry.name);
    const open = ctx.input.incidents.get(incidentKey) ?? null;
    if (entry.state === "unknown") continue; // missing telemetry is not health, and it is not a detached dependency either
    if (DETACHED.includes(entry.state)) {
      if (out.filter(d => d.ruleId === ruleId).length >= USB_DEPENDENCY_INCIDENT_CAP) { state.suppressed += 1; continue; }
      out.push(decisionFor(ctx, ruleId, issueType, { incidentKey, severity, title: title(issueType, ctx.label, ctx.unit.unitKey, entry.name),
        absentSince: null, reconnectCount: null, dependencyName: entry.name,
        restartRequested: ctx.policy.autoRestart && entry.kind === "probe", action: "open" }));
      continue;
    }
    if (!open) continue;
    if (!isAttachedAgain(entry)) { holds.push({ unitKey: ctx.unit.unitKey, ruleId, reason: "trigger_gone" }); continue; }
    out.push(decisionFor(ctx, ruleId, issueType, { incidentKey, severity, title: title(issueType, ctx.label, ctx.unit.unitKey, entry.name),
      absentSince: null, reconnectCount: null, dependencyName: entry.name, restartRequested: false, action: "resolve" }));
  }
}

// ---- The evaluation --------------------------------------------------------------------

/**
 * Every decision one report produces: for each unit, the policy that watches it, then the three rules, each of which
 * either decides or says why it does not. `levels` are the four scope rows as the data layer read them; the memory, when
 * given, keeps a level's last valid policy in force through a document that has gone wrong (last valid wins).
 */
export function evaluateUsbWatch(input: UsbWatchInput): UsbWatchResult {
  const decisions: UsbDecision[] = [];
  const holds: UsbHold[] = [];
  const resolutions: { unitKey: string; resolution: UsbPolicyResolution | null; skips: readonly { level: UsbScopeLevel; reason: string }[] }[] = [];
  const fanout = { suppressed: 0 };

  for (const unit of input.report.devices) {
    const subject: UsbPolicySubject = { unitKey: unit.unitKey, portKey: unit.portKey };
    const { resolution, skips } = reconcileUsbPolicies({ levels: input.levels, subject, ...(input.memory ? { memory: input.memory } : {}) });
    resolutions.push({ unitKey: unit.unitKey, resolution, skips: skips.map(s => ({ level: s.level, reason: s.reason })) });
    if (!resolution) { holds.push({ unitKey: unit.unitKey, ruleId: null, reason: "unwatched" }); continue; }
    if (!resolution.policy.enabled) { holds.push({ unitKey: unit.unitKey, ruleId: null, reason: "disabled" }); continue; }
    if (input.report.monitorState === "unknown" || input.report.monitorState === "degraded") { holds.push({ unitKey: unit.unitKey, ruleId: null, reason: "source_unknown" }); continue; }
    if (!input.report.settled) { holds.push({ unitKey: unit.unitKey, ruleId: null, reason: "settling" }); continue; }
    if (unit.firstSeenAt === null) { holds.push({ unitKey: unit.unitKey, ruleId: null, reason: "never_seen" }); continue; }
    const ctx: RuleContext = {
      input, unit, policy: resolution.policy, resolution,
      subjectKey: usbSubjectKey(resolution.matchedBy, subject), subject,
      label: unit.portDisplay ?? null,
      quiet: usbQuietHoursState(resolution.policy.quietHours, input.now),
    };
    absentDecisions(ctx, decisions, holds);
    flapDecisions(ctx, decisions, holds);
    dependencyDecisions(ctx, decisions, holds, fanout);
  }
  return { decisions, holds, resolutions, suppressedDependencies: fanout.suppressed };
}

/** Convenience: validate a report and evaluate it, for a caller that has the raw body in hand. */
export function evaluateUsbReport(input: Omit<UsbWatchInput, "report"> & { report: unknown }): UsbWatchResult | { issues: readonly UsbValidationIssue[] } {
  const checked = checkUsbDeviceReport(input.report);
  if (!checked.ok) return { issues: checked.issues };
  return evaluateUsbWatch({ ...input, report: checked.report });
}

// ---- What the platform writes ----------------------------------------------------------

/** Exactly the shape alerts.upsertAlert takes; the store passes it straight through. */
export interface UsbAlertWrite {
  cabinetId: string;
  issueTypeId: string;
  severity: UsbSeverity;
  signature: string;
  title: string;
  seenAt: Date;
  ruleId: null;
  eventId: null;
}

export function usbAlertWrite(cabinetId: string, decision: UsbDecision): UsbAlertWrite {
  return { cabinetId, issueTypeId: decision.issueTypeId, severity: decision.severity, signature: decision.incidentKey, title: decision.title, seenAt: decision.observedAt, ruleId: null, eventId: null };
}

/** The wording an automatic resolution carries. Fixed per rule: nothing a cabinet sent reaches it. */
export const USB_RESOLUTION_TEXT: Readonly<Record<UsbRuleId, string>> = {
  "usb-absent": "The device is back.",
  "usb-flap": "The device is no longer reconnecting.",
  "usb-dependency": "The dependency is attached again.",
};

export interface UsbAlertWork {
  writes: readonly UsbAlertWrite[];
  resolutions: readonly { signature: string; resolution: string }[];
  /** Incidents an operator already saw inside the rate-limit window: the row moves, no new page. */
  silent: readonly string[];
}

/** Splits decisions into the alert writes and the automatic resolutions the data layer has to make. */
export function usbAlertWork(cabinetId: string, decisions: readonly UsbDecision[]): UsbAlertWork {
  const writes: UsbAlertWrite[] = [];
  const resolutions: { signature: string; resolution: string }[] = [];
  const silent: string[] = [];
  for (const d of decisions) {
    if (d.action === "resolve") { resolutions.push({ signature: d.incidentKey, resolution: USB_RESOLUTION_TEXT[d.ruleId] }); continue; }
    writes.push(usbAlertWrite(cabinetId, d));
    if (!d.renotify) silent.push(d.incidentKey);
  }
  return { writes, resolutions, silent };
}
