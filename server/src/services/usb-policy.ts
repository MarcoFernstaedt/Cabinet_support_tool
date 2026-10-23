// The USB watch policy layer: what a scope watches, which scope wins, and how a change is validated, versioned and audited.
//
// One policy per scope, most specific wins (cabinet, then site, then client, then the fleet default), the pattern
// device-settings.ts already uses for the scanner's hardware IDs. A policy names ONE identity (a unit's key, or the
// slot's key) and the three rules' settings for it, so several scopes can watch different things at once and the most
// specific scope that watches a given unit or slot is the one that applies to it.
//
// Storage is the settings table, keyed `usb.policy` for the fleet and `usb.policy.<level>.<id>` for the rest, with the
// value `{ version, policy }`. The settings table is already a key/value store with a JSON check on the value, so a new
// level or a new field needs no migration; the version is the server's, not the console's, and it only ever goes up.
//
// The contract is contracts/schemas/usb/usb-watch-policy.schema.json and it is checked before any other code here runs
// (docs/spec/STANDING-INSTRUCTIONS.md). The field-by-field design and its bounds are in
// docs/platform/research/2026-10/usb-design-research.md.
//
// Nothing here touches the database or the SQL driver: the data layer (usb-store.ts) reads the rows and calls in, so
// every rule below is exercised by test/usb-policy.test.ts without a live server.
import { createAjv, ref, type CompiledValidator } from "@mashura/cabinet-contracts/load";

export type UsbScopeLevel = "cabinet" | "site" | "client" | "fleet";

/** Most specific first: the order the levels are resolved in. */
export const USB_SCOPE_LEVELS: readonly UsbScopeLevel[] = ["cabinet", "site", "client", "fleet"];

/** The platform's alert severities (alerts.severity, migrations/0001_baseline.sql). */
export type UsbSeverity = "major" | "minor";

export type UsbRuleId = "usb-absent" | "usb-flap" | "usb-dependency";

export const USB_RULE_IDS: readonly UsbRuleId[] = ["usb-absent", "usb-flap", "usb-dependency"];

/**
 * The issue type each rule raises. usb_missing is seeded already (migrations/0001_baseline.sql, "Expected USB device not
 * detected", minor, cabinet); a rule whose key is not in issue_types cannot open an alert — the rules say so rather
 * than inventing an id.
 */
export const USB_ISSUE_KEYS: Readonly<Record<UsbRuleId, string>> = {
  "usb-absent": "usb_missing",
  "usb-flap": "usb_flap",
  "usb-dependency": "usb_dependency",
};

export interface UsbIdentityKey {
  /** `device`: the unit wherever it is plugged in. `port`: the slot, whatever is in it. */
  kind: "device" | "port";
  /** The cabinet's normalized key: the same text a report carries as unitKey (kind device) or portKey (kind port). */
  value: string;
  confidence: "high" | "low" | "unknown";
}

export interface UsbReconnectRule {
  /** N: cycles in the window that count as flapping. */
  count: number;
  /** Y: the window, in minutes. */
  windowMinutes: number;
}

export interface UsbSettleRule {
  afterHintSeconds: number;
  afterResumeSeconds: number;
  maxSettleSeconds: number;
}

export interface UsbQuietHours {
  timeZone: string;
  startMinute: number;
  endMinute: number;
  weekdays: readonly number[];
}

export interface UsbPolicy {
  identityKey: UsbIdentityKey;
  enabled: boolean;
  /** Minutes a known unit must be continuously absent before the absence rule opens; null turns that rule off. */
  absentForMinutes: number | null;
  reconnect: UsbReconnectRule;
  settle: UsbSettleRule;
  quietHours: UsbQuietHours | null;
  /** Severity per rule; a rule left out uses its issue type's severity. */
  severity: { absent?: UsbSeverity; reconnect?: UsbSeverity; dependency?: UsbSeverity };
  /** Whether the platform may start a stopped application again. Off unless set; this layer only records the wish. */
  autoRestart: boolean;
}

/** The settle timings the contract proposes when a policy leaves them out (research, section 4). */
export const USB_SETTLE_DEFAULTS: UsbSettleRule = { afterHintSeconds: 15, afterResumeSeconds: 30, maxSettleSeconds: 120 };

/** What the settings table keeps for one scope. */
export interface UsbStoredPolicy {
  version: number;
  policy: UsbPolicy;
}

/** A scope's row as read from the database: `stored` is the settings value, JSON text, or null when nothing is set. */
export interface UsbPolicyLevel {
  level: UsbScopeLevel;
  /** null for the fleet. */
  scopeId: string | null;
  stored: unknown;
}

/** The unit or slot a policy is being resolved for, from a report's device record. */
export interface UsbPolicySubject {
  unitKey: string;
  portKey: string | null;
}

// ---- Validation ------------------------------------------------------------------------

/** One thing wrong with a request: the field it is in and the schema rule it broke. Never a value from the request. */
export interface UsbValidationIssue {
  field: string;
  rule: string;
}

/** A request (or a stored document) that the contract refuses. */
export class UsbPolicyError extends Error {
  constructor(readonly issues: readonly UsbValidationIssue[]) {
    super(issuesText(issues));
    this.name = "UsbPolicyError";
  }
}

/** A request never gets a wall of errors (contracts.ts caps its own validators the same way). */
const MAX_ISSUES = 20;

export const USB_WATCH_POLICY_SCHEMA = "usb/usb-watch-policy.schema.json";
export const USB_DEVICE_REPORT_SCHEMA = "usb/usb-device-report.schema.json";

let ajv: ReturnType<typeof createAjv> | null = null;
const compiled = new Map<string, CompiledValidator>();

/**
 * The shared schema set (contracts/load.mjs), compiled once. The loader refuses to build it at all if any schema is
 * malformed, so a failure here is a broken deployment rather than a bad request.
 */
function check(schemaFile: string): CompiledValidator {
  const cached = compiled.get(schemaFile);
  if (cached) return cached;
  ajv ??= createAjv();
  const validator = ajv.getSchema(ref(schemaFile));
  if (!validator) throw new Error(`contract ${schemaFile} is not in the schema set`);
  compiled.set(schemaFile, validator);
  return validator;
}

const at = (path: string, name: string) => (path === "/" ? `/${name}` : `${path}/${name}`);

/**
 * The field and the rule of every failure, in the order Ajv reports them.
 *
 * Only locations and keywords are reported, never a value out of the request: a rejected policy can carry anything the
 * caller chose, including something that should not be logged (contracts.ts reports its own failures the same way). A
 * missing property's name comes from the schema and is named; an unexpected property's name comes from the caller, so
 * it is shown as `<unexpected field>` under the object it was found in.
 */
export function usbIssues(errors: CompiledValidator["errors"]): UsbValidationIssue[] {
  const issues = (errors ?? []).slice(0, MAX_ISSUES).map(e => {
    const path = e.instancePath || "/";
    const params = e.params as { missingProperty?: unknown };
    if (e.keyword === "required" && typeof params.missingProperty === "string") return { field: at(path, params.missingProperty), rule: e.keyword };
    if (e.keyword === "additionalProperties") return { field: `${path === "/" ? "" : path}/<unexpected field>`, rule: e.keyword };
    return { field: path, rule: e.keyword };
  });
  return issues.length > 0 ? issues : [{ field: "/", rule: "invalid" }];
}

/** `usb-watch-policy /absentForMinutes: maximum` — the field and the rule, for a log line or an API error. */
export const issuesText = (issues: readonly UsbValidationIssue[]): string => issues.map(i => `${i.field}: ${i.rule}`).join(", ");

/** Checks any of the two USB contracts and returns the field and rule of every failure. */
export function checkUsbContract(schemaFile: string, value: unknown): UsbValidationIssue[] | null {
  const validator = check(schemaFile);
  return validator(value) ? null : usbIssues(validator.errors);
}

export type UsbPolicyCheck = { ok: true; policy: UsbPolicy } | { ok: false; issues: UsbValidationIssue[] };

/**
 * Validates a policy against the contract, then fills the fields the contract lets a scope leave out. Validation comes
 * first and on its own, so nothing below ever reads an unchecked request.
 */
export function checkUsbWatchPolicy(value: unknown): UsbPolicyCheck {
  const issues = checkUsbContract(USB_WATCH_POLICY_SCHEMA, value);
  if (issues) return { ok: false, issues };
  return { ok: true, policy: withUsbDefaults(value as UsbPolicy) };
}

/** A validated policy, or a UsbPolicyError naming the field and rule that failed. */
export function parseUsbWatchPolicy(value: unknown): UsbPolicy {
  const checked = checkUsbWatchPolicy(value);
  if (!checked.ok) throw new UsbPolicyError(checked.issues);
  return checked.policy;
}

/** The policy with the omitted settle timings filled from the documented defaults (the JSON Schema carries no defaults). */
export function withUsbDefaults(policy: UsbPolicy): UsbPolicy {
  return { ...policy, settle: policy.settle ?? USB_SETTLE_DEFAULTS, severity: policy.severity ?? {} };
}

// ---- Stored documents ------------------------------------------------------------------

export type UsbStoreRejection = "empty" | "not_json" | "not_an_object" | "no_version" | "bad_version" | "unknown_field" | "policy_invalid";

/** A reason a level's row was not used, in words, for a log line. */
export const rejectionText = (reason: UsbStoreRejection): string => ({
  empty: "nothing is set at this level",
  not_json: "the stored value is not JSON",
  not_an_object: "the stored value is not an object",
  no_version: "the stored value carries no version",
  bad_version: "the stored version is not a whole number of at least 1",
  unknown_field: "the stored value carries a field this version does not know",
  policy_invalid: "the stored policy does not meet the contract",
})[reason];

export type UsbStoredCheck = { ok: true; stored: UsbStoredPolicy } | { ok: false; reason: UsbStoreRejection; issues?: UsbValidationIssue[] };

/**
 * What the settings table holds for one scope, checked the strict way a request is checked: an envelope without a
 * version, with a version that is not a whole number of at least 1, or with a field this version does not know, is not
 * used at all (the last policy that did validate stays in force instead — see reconcileUsbPolicies).
 */
export function checkStoredUsbPolicy(raw: unknown): UsbStoredCheck {
  if (raw === null || raw === undefined) return { ok: false, reason: "empty" };
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, reason: "not_json" };
    }
  }
  if (value === null || value === undefined) return { ok: false, reason: "empty" };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "not_an_object" };
  const envelope = value as Record<string, unknown>;
  if (!("version" in envelope)) return { ok: false, reason: "no_version" };
  const version = envelope["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return { ok: false, reason: "bad_version" };
  if (Object.keys(envelope).some(k => k !== "version" && k !== "policy")) return { ok: false, reason: "unknown_field" };
  const policy = checkUsbWatchPolicy(envelope["policy"]);
  if (!policy.ok) return { ok: false, reason: "policy_invalid", issues: policy.issues };
  return { ok: true, stored: { version, policy: policy.policy } };
}

// ---- Where a scope's policy lives ------------------------------------------------------

export const USB_POLICY_SETTING_KEY = "usb.policy";

/**
 * The settings key for a scope. Ids are lowercased here and lowered in the read query too
 * (`LOWER(CONVERT(nvarchar(64), k.id))`), so the mixed-case uuid a URL or a body carries still finds its row.
 */
export function usbPolicySettingKey(level: UsbScopeLevel, scopeId: string | null): string {
  if (level === "fleet") return USB_POLICY_SETTING_KEY;
  if (!scopeId) throw new Error(`a ${level} policy needs the ${level}'s id`);
  return `${USB_POLICY_SETTING_KEY}.${level}.${scopeId.toLowerCase()}`;
}

/** The step-up action a change to this level needs, and the action its audit entry carries (the house pattern: the two are the same name). */
export const usbStepUpAction = (level: UsbScopeLevel): string => (level === "fleet" ? "settings.usb-policy" : `${level}.usb-policy`);

// ---- Resolution ------------------------------------------------------------------------

export type UsbAuditTargetKind = "cabinet" | "site" | "client";

/** The audit entry the data layer appends for a change (db.ts AuditEntry, without importing the driver). */
export interface UsbAuditEntry {
  actorKind: "user";
  actorId: string;
  action: string;
  targetKind?: UsbAuditTargetKind;
  targetId?: string;
  outcome: "succeeded" | "failed" | "refused";
  details?: Record<string, unknown>;
}

/**
 * One entry per change: what the scope held before, what it holds now, and the version it was saved as. The fleet level
 * has no target of its own (setFleetScanner does the same); every other level names the client, site or cabinet it
 * belongs to.
 */
export function usbPolicyAuditEntry(input: { level: UsbScopeLevel; scopeId: string | null; userId: string; version: number | null; before: UsbPolicy | null; after: UsbPolicy | null }): UsbAuditEntry {
  const target = input.level === "fleet" ? {} : { targetKind: input.level as UsbAuditTargetKind, targetId: input.scopeId ?? undefined };
  return {
    actorKind: "user",
    actorId: input.userId,
    action: usbStepUpAction(input.level),
    ...(target.targetKind === undefined ? {} : { targetKind: target.targetKind, targetId: target.targetId as string }),
    outcome: "succeeded",
    details: { level: input.level, scopeId: input.scopeId, version: input.version, before: input.before, after: input.after },
  };
}

/** Which key of a policy this subject matches, or null when the policy is watching something else. */
export function usbPolicyMatch(policy: UsbPolicy, subject: UsbPolicySubject): "device" | "port" | null {
  const key = policy.identityKey;
  if (key.kind === "device") return key.value === subject.unitKey ? "device" : null;
  return subject.portKey !== null && key.value === subject.portKey ? "port" : null;
}

/**
 * The last policy that validated at each level, kept in the server's memory between reads.
 *
 * This is what makes a scope's last valid policy win while a cabinet is unreachable, or while what it holds has gone
 * wrong: a document that no longer meets the contract, that lost its version, or that is older than what the server
 * already validated (a restore, or two writers racing) never displaces the policy that was in force. The memory is per
 * process, so a restart falls back to the next broader scope — the fleet's own policy — rather than to no policy.
 */
export class UsbPolicyMemory {
  private readonly byLevel = new Map<string, UsbStoredPolicy>();

  private static id(level: UsbScopeLevel, scopeId: string | null): string {
    return `${level}:${scopeId === null ? "" : scopeId.toLowerCase()}`;
  }

  /** Keeps a newer version; an older or equal one is refused. Returns whether it was kept. */
  note(level: UsbScopeLevel, scopeId: string | null, stored: UsbStoredPolicy): boolean {
    const id = UsbPolicyMemory.id(level, scopeId);
    const current = this.byLevel.get(id);
    if (current && current.version >= stored.version) return false;
    this.byLevel.set(id, stored);
    return true;
  }

  last(level: UsbScopeLevel, scopeId: string | null): UsbStoredPolicy | null {
    return this.byLevel.get(UsbPolicyMemory.id(level, scopeId)) ?? null;
  }

  get size(): number {
    return this.byLevel.size;
  }

  clear(): void {
    this.byLevel.clear();
  }
}

export interface UsbPolicyResolution {
  policy: UsbPolicy;
  level: UsbScopeLevel;
  scopeId: string | null;
  version: number;
  /** Which of the policy's keys matched. */
  matchedBy: "device" | "port";
  /** True when the policy came from the memory instead of from what the level now holds. */
  fromMemory: boolean;
}

/** Why a level did not supply the policy: nothing set, a document the contract refuses, an older version, or another identity. */
export type UsbLevelSkipReason = UsbStoreRejection | "version_out_of_order" | "other_identity";

export interface UsbLevelSkip {
  level: UsbScopeLevel;
  scopeId: string | null;
  reason: UsbLevelSkipReason;
  issues?: readonly UsbValidationIssue[];
}

export interface UsbPolicyResolutionResult {
  /** Null when no scope watches this unit or slot: an unpinned unit is watched by nobody and alerts on nothing. */
  resolution: UsbPolicyResolution | null;
  /** Every level that was read and did not supply the policy, most specific first. */
  skips: readonly UsbLevelSkip[];
  /** True when the winning policy came from the memory (the level's stored document was unusable or older). */
  fromMemory: boolean;
}

/**
 * The policy that applies to one unit or slot: the most specific scope that watches it.
 *
 * Levels are walked most specific first, so a level that holds a valid policy for another identity never shadows the
 * broader scope that does watch this one. A level whose document is unusable keeps the last policy that validated for
 * it (when the caller passes a memory), and a version that has gone backwards is refused in favour of what was already
 * validated. A level with nothing set is simply skipped, without a skip note.
 */
export function reconcileUsbPolicies(input: { levels: readonly UsbPolicyLevel[]; subject: UsbPolicySubject; memory?: UsbPolicyMemory }): UsbPolicyResolutionResult {
  const skips: UsbLevelSkip[] = [];
  const byLevel = new Map(input.levels.map(l => [l.level, l]));
  for (const level of USB_SCOPE_LEVELS) {
    const entry = byLevel.get(level);
    if (!entry) continue;
    if (entry.stored === null || entry.stored === undefined) continue;
    const checked = checkStoredUsbPolicy(entry.stored);
    let stored: UsbStoredPolicy | null = null;
    let fromMemory = false;
    if (checked.ok) {
      const retained = input.memory?.last(level, entry.scopeId) ?? null;
      if (retained && retained.version > checked.stored.version) {
        skips.push({ level, scopeId: entry.scopeId, reason: "version_out_of_order" });
        stored = retained;
        fromMemory = true;
      } else {
        input.memory?.note(level, entry.scopeId, checked.stored);
        stored = checked.stored;
      }
    } else {
      skips.push({ level, scopeId: entry.scopeId, reason: checked.reason, ...(checked.issues ? { issues: checked.issues } : {}) });
      stored = input.memory?.last(level, entry.scopeId) ?? null;
      fromMemory = stored !== null;
    }
    if (!stored) continue;
    const matchedBy = usbPolicyMatch(stored.policy, input.subject);
    if (!matchedBy) {
      skips.push({ level, scopeId: entry.scopeId, reason: "other_identity" });
      continue;
    }
    return { resolution: { policy: stored.policy, level, scopeId: entry.scopeId, version: stored.version, matchedBy, fromMemory }, skips, fromMemory };
  }
  return { resolution: null, skips, fromMemory: false };
}

/**
 * The version a change is saved as: one more than the version in force at that level, or 1 when the level holds nothing
 * usable. A stored document the contract refuses is never allowed to push the number backwards, so the version in the
 * table only ever goes up.
 */
export function nextUsbPolicyVersion(current: unknown): number {
  const checked = checkStoredUsbPolicy(current);
  return checked.ok ? checked.stored.version + 1 : 1;
}
