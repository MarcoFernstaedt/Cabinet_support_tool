// The USB watch policy on the server: what a scope watches, which level wins, and how a change is validated, versioned
// and audited (docs/spec/18-built-designs.md §5).
//
// Includes hostile input: a prototype key, an oversized identity key, numbers and types outside the contract, a wall of
// unknown fields, and stored documents that have gone wrong (truncated JSON, missing version, an envelope a future
// server wrote). Every refusal has to name the field and the rule, and never quote a value back.
import test from "node:test";
import assert from "node:assert/strict";
import {
  USB_POLICY_SETTING_KEY, USB_RULE_IDS, USB_SETTLE_DEFAULTS, UsbPolicyError, UsbPolicyMemory, checkStoredUsbPolicy,
  checkUsbWatchPolicy, issuesText, nextUsbPolicyVersion, parseUsbWatchPolicy, reconcileUsbPolicies, usbPolicyAuditEntry,
  usbPolicyMatch, usbPolicySettingKey, usbStepUpAction,
  type UsbPolicy, type UsbPolicyLevel, type UsbValidationIssue,
} from "../src/services/usb-policy.js";

const KEY = "USB\\VID_04B8&PID_0202\\SER0001";

const policy = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  identityKey: { kind: "device", value: KEY, confidence: "high" },
  enabled: true,
  absentForMinutes: 5,
  reconnect: { count: 3, windowMinutes: 10 },
  quietHours: { timeZone: "Europe/London", startMinute: 22 * 60, endMinute: 6 * 60, weekdays: [1, 2, 3, 4, 5] },
  severity: { absent: "minor" },
  autoRestart: false,
  ...over,
});

const refusal = (value: unknown): readonly UsbValidationIssue[] => {
  const checked = checkUsbWatchPolicy(value);
  assert.equal(checked.ok, false, "expected the contract to refuse this");
  return checked.ok ? [] : checked.issues;
};

const level = (l: UsbPolicyLevel["level"], scopeId: string | null, stored: unknown): UsbPolicyLevel => ({ level: l, scopeId, stored });
const storedPolicy = (p: UsbPolicy, version = 1): string => JSON.stringify({ version, policy: p });
const asPolicy = (over: Record<string, unknown> = {}): UsbPolicy => parseUsbWatchPolicy(policy(over));

/** A policy that watches the unit the resolution tests resolve for. */
const watchesUnit = (over: Record<string, unknown> = {}): UsbPolicy =>
  asPolicy({ identityKey: { kind: "device", value: "UNIT-1", confidence: "high" }, ...over });

test("a policy the contract accepts parses, with the documented settle timings filled in", () => {
  const parsed = parseUsbWatchPolicy(policy());
  assert.deepEqual(parsed.settle, USB_SETTLE_DEFAULTS);
  assert.equal(parsed.autoRestart, false);
  assert.deepEqual(parsed.severity, { absent: "minor" });
  assert.equal(parsed.identityKey.value, KEY);
});

test("auto-restart is a required field, so there is no way to ask for it by leaving it out", () => {
  const withoutAutoRestart = policy();
  delete withoutAutoRestart.autoRestart;
  const issues = refusal(withoutAutoRestart);
  assert.deepEqual(issues[0], { field: "/autoRestart", rule: "required" });
  assert.equal(parseUsbWatchPolicy(policy({ autoRestart: true })).autoRestart, true);
});

test("a missing top-level field is named by the field and the rule", () => {
  const without = policy();
  delete without.enabled;
  assert.deepEqual(refusal(without)[0], { field: "/enabled", rule: "required" });
});

test("an unknown field is refused without ever echoing the caller's key", () => {
  const issues = refusal(policy({ snoozeUntil: "tomorrow" }));
  assert.deepEqual(issues[0], { field: "/<unexpected field>", rule: "additionalProperties" });
  assert.equal(issuesText(issues).includes("snoozeUntil"), false);
  const nested = refusal(policy({ identityKey: { kind: "device", value: KEY, confidence: "high", secret: 1 } }));
  assert.deepEqual(nested[0], { field: "/identityKey/<unexpected field>", rule: "additionalProperties" });
  assert.equal(issuesText(nested).includes("secret"), false);
});

test("a settle block, once given, has to be whole: half of it is a refusal naming both halves", () => {
  const issues = refusal(policy({ settle: { afterHintSeconds: 15 } }));
  assert.deepEqual(issues.map(i => i.field).sort(), ["/settle/afterResumeSeconds", "/settle/maxSettleSeconds"]);
  assert.deepEqual([...new Set(issues.map(i => i.rule))], ["required"]);
  assert.equal(parseUsbWatchPolicy(policy({ settle: { afterHintSeconds: 15, afterResumeSeconds: 30, maxSettleSeconds: 120 } })).settle.maxSettleSeconds, 120);
});

test("numbers outside the contract are refused with the field and the rule they broke", () => {
  assert.deepEqual(refusal(policy({ absentForMinutes: 0 }))[0], { field: "/absentForMinutes", rule: "minimum" });
  assert.deepEqual(refusal(policy({ absentForMinutes: 1441 }))[0], { field: "/absentForMinutes", rule: "maximum" });
  assert.deepEqual(refusal(policy({ reconnect: { count: 1, windowMinutes: 10 } }))[0], { field: "/reconnect/count", rule: "minimum" });
  assert.deepEqual(refusal(policy({ reconnect: { count: 3, windowMinutes: 4 } }))[0], { field: "/reconnect/windowMinutes", rule: "minimum" });
  assert.deepEqual(refusal(policy({ quietHours: { timeZone: "Europe/London", startMinute: 1440, endMinute: 60, weekdays: [1] } }))[0], { field: "/quietHours/startMinute", rule: "maximum" });
});

test("an empty or repeated weekday list is refused", () => {
  const empty = refusal(policy({ quietHours: { timeZone: "Europe/London", startMinute: 0, endMinute: 60, weekdays: [] } }));
  assert.deepEqual(empty[0], { field: "/quietHours/weekdays", rule: "minItems" });
  const repeated = refusal(policy({ quietHours: { timeZone: "Europe/London", startMinute: 0, endMinute: 60, weekdays: [1, 1] } }));
  assert.deepEqual(repeated[0], { field: "/quietHours/weekdays", rule: "uniqueItems" });
});

test("a type the contract did not ask for is refused", () => {
  assert.deepEqual(refusal(policy({ autoRestart: "false" }))[0], { field: "/autoRestart", rule: "type" });
  assert.deepEqual(refusal(policy({ identityKey: { kind: "device", value: 12, confidence: "high" } }))[0], { field: "/identityKey/value", rule: "type" });
  assert.deepEqual(refusal(policy({ identityKey: { kind: "cable", value: KEY, confidence: "high" } }))[0], { field: "/identityKey/kind", rule: "enum" });
  assert.deepEqual(refusal(policy({ severity: { absent: "critical" } }))[0], { field: "/severity/absent", rule: "enum" });
  assert.deepEqual(refusal(null)[0], { field: "/", rule: "type" });
  assert.deepEqual(refusal("a policy, honestly")[0], { field: "/", rule: "type" });
  assert.deepEqual(refusal([])[0], { field: "/", rule: "type" });
});

test("an identity key outside the character set, or longer than the platform stores, is refused", () => {
  assert.deepEqual(refusal(policy({ identityKey: { kind: "port", value: "PCIROOT(0)\n#USBROOT(0)", confidence: "low" } }))[0], { field: "/identityKey/value", rule: "pattern" });
  assert.deepEqual(refusal(policy({ identityKey: { kind: "device", value: "A".repeat(401), confidence: "high" } }))[0], { field: "/identityKey/value", rule: "maxLength" });
  // The charset the cabinet prints for a location path is inside the contract.
  assert.equal(parseUsbWatchPolicy(policy({ identityKey: { kind: "port", value: "PCIROOT(0)#USBROOT(0)#USB(1)", confidence: "high" } })).identityKey.kind, "port");
});

test("hostile input: a prototype key is refused and pollutes nothing", () => {
  const hostile = JSON.parse(`{"__proto__":{"polluted":true},${JSON.stringify(policy()).slice(1)}`) as Record<string, unknown>;
  assert.equal(Object.keys(hostile).includes("__proto__"), true);
  assert.deepEqual(refusal(hostile)[0], { field: "/<unexpected field>", rule: "additionalProperties" });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const constructor = JSON.parse(`{"constructor":{"prototype":{"evil":1}},${JSON.stringify(policy()).slice(1)}`) as Record<string, unknown>;
  assert.equal(checkUsbWatchPolicy(constructor).ok, false);
  assert.equal(({} as Record<string, unknown>).evil, undefined);
});

test("a wall of unknown fields is capped, like every other refusal in the platform", () => {
  const noise: Record<string, unknown> = policy();
  for (let i = 0; i < 40; i += 1) noise[`field${i}`] = i;
  const issues = refusal(noise);
  assert.equal(issues.length, 20);
  assert.deepEqual([...new Set(issues.map(i => i.rule))], ["additionalProperties"]);
});

test("a number JSON cannot hold (1e400) is refused, not silently taken as a huge number", () => {
  const huge = JSON.parse(JSON.stringify(policy()).replace("\"absentForMinutes\":5", "\"absentForMinutes\":1e400")) as Record<string, unknown>;
  const issues = refusal(huge);
  assert.equal(issues[0]?.field, "/absentForMinutes");
  assert.equal(issues[0]?.rule === "maximum" || issues[0]?.rule === "type", true, `a number the JSON Schema cannot hold is refused as such: ${JSON.stringify(issues)}`);
});

test("a stored document is read as its version and its policy, from text or from an already parsed value", () => {
  const fromText = checkStoredUsbPolicy(storedPolicy(asPolicy(), 7));
  assert.equal(fromText.ok, true);
  assert.equal(fromText.ok ? fromText.stored.version : 0, 7);
  assert.equal(fromText.ok ? fromText.stored.policy.settle.afterResumeSeconds : 0, USB_SETTLE_DEFAULTS.afterResumeSeconds);
  const fromValue = checkStoredUsbPolicy({ version: 2, policy: JSON.parse(JSON.stringify(policy())) });
  assert.equal(fromValue.ok, true);
  assert.equal(fromValue.ok ? fromValue.stored.version : 0, 2);
});

test("a stored document that has gone wrong says exactly how it went wrong", () => {
  const reason = (raw: unknown): string => {
    const checked = checkStoredUsbPolicy(raw);
    assert.equal(checked.ok, false);
    return checked.ok ? "" : checked.reason;
  };
  assert.equal(reason(null), "empty");
  assert.equal(reason(""), "not_json");
  assert.equal(reason("{\"version\":1,"), "not_json");
  assert.equal(reason("null"), "empty");
  assert.equal(reason("[1,2]"), "not_an_object");
  assert.equal(reason("a policy"), "not_json");
  assert.equal(reason(JSON.stringify({ policy: policy() })), "no_version");
  assert.equal(reason(JSON.stringify({ version: 0, policy: policy() })), "bad_version");
  assert.equal(reason(JSON.stringify({ version: "1", policy: policy() })), "bad_version");
  assert.equal(reason(JSON.stringify({ version: 1.5, policy: policy() })), "bad_version");
  assert.equal(reason(JSON.stringify({ version: 1, policy: policy(), note: "written by a newer server" })), "unknown_field");
  const invalidPolicy = checkStoredUsbPolicy(JSON.stringify({ version: 1, policy: { enabled: true } }));
  assert.equal(invalidPolicy.ok, false);
  assert.equal(invalidPolicy.ok ? "" : invalidPolicy.reason, "policy_invalid");
  assert.equal(invalidPolicy.ok ? 0 : invalidPolicy.issues?.[0]?.rule, "required");
});

test("the next version is one more than what is in force, and the first one is 1", () => {
  assert.equal(nextUsbPolicyVersion(null), 1);
  assert.equal(nextUsbPolicyVersion("{\"version\":4,\"policy\":{}}"), 1, "an unusable document does not raise the version it claims");
  assert.equal(nextUsbPolicyVersion(storedPolicy(asPolicy(), 4)), 5);
  assert.equal(nextUsbPolicyVersion(storedPolicy(asPolicy(), 41)), 42);
});

test("a device key matches the unit wherever it is plugged in; a port key matches the slot", () => {
  const device = asPolicy({ identityKey: { kind: "device", value: "UNIT-1", confidence: "high" } });
  const port = asPolicy({ identityKey: { kind: "port", value: "SLOT-9", confidence: "low" } });
  assert.equal(usbPolicyMatch(device, { unitKey: "UNIT-1", portKey: "SLOT-9" }), "device");
  assert.equal(usbPolicyMatch(device, { unitKey: "UNIT-1", portKey: "SLOT-2" }), "device", "the unit is watched on another port too");
  assert.equal(usbPolicyMatch(device, { unitKey: "UNIT-2", portKey: "SLOT-9" }), null);
  assert.equal(usbPolicyMatch(port, { unitKey: "UNIT-1", portKey: "SLOT-9" }), "port");
  assert.equal(usbPolicyMatch(port, { unitKey: "UNIT-2", portKey: "SLOT-9" }), "port", "the slot is watched whatever is in it");
  assert.equal(usbPolicyMatch(port, { unitKey: "UNIT-1", portKey: null }), null, "a unit with no slot named is not watched by a slot policy");
});

test("the most specific scope that watches the unit wins", () => {
  const unit = { unitKey: "UNIT-1", portKey: "SLOT-9" };
  const levels = [
    level("cabinet", "cab-1", storedPolicy(watchesUnit({ absentForMinutes: 5 }), 3)),
    level("site", "site-1", storedPolicy(watchesUnit({ absentForMinutes: 30 }), 9)),
    level("client", "client-1", storedPolicy(watchesUnit({ absentForMinutes: 60 }), 1)),
    level("fleet", null, storedPolicy(watchesUnit({ absentForMinutes: 120 }), 99)),
  ];
  const result = reconcileUsbPolicies({ levels, subject: unit });
  assert.equal(result.resolution?.level, "cabinet");
  assert.equal(result.resolution?.policy.absentForMinutes, 5);
  assert.equal(result.resolution?.version, 3);
  assert.equal(result.resolution?.matchedBy, "device");
  assert.deepEqual(result.skips, []);
  assert.equal(result.fromMemory, false);
});

test("a level that watches another unit is skipped, and the next level up decides", () => {
  const levels = [
    level("cabinet", "cab-1", storedPolicy(asPolicy({ identityKey: { kind: "device", value: "SOMEONE-ELSE", confidence: "high" }, absentForMinutes: 5 }))),
    level("site", "site-1", storedPolicy(watchesUnit({ absentForMinutes: 30 }))),
  ];
  const result = reconcileUsbPolicies({ levels, subject: { unitKey: "UNIT-1", portKey: null } });
  assert.equal(result.resolution?.level, "site");
  assert.equal(result.skips[0]?.reason, "other_identity");
  assert.deepEqual(result.skips[0] && [result.skips[0].level, result.skips[0].scopeId], ["cabinet", "cab-1"]);
});

test("an unusable document at a level falls through to the level above it, and the reason is reported", () => {
  const levels = [
    level("cabinet", "cab-1", "{\"version\":2,\"policy\":{\"enabled\":true}"),
    level("site", "site-1", storedPolicy(watchesUnit({ absentForMinutes: 30 }))),
  ];
  const result = reconcileUsbPolicies({ levels, subject: { unitKey: "UNIT-1", portKey: null } });
  assert.equal(result.resolution?.level, "site");
  assert.deepEqual(result.skips.map(s => s.reason), ["not_json"]);
  assert.equal(result.fromMemory, false);
});

test("last valid wins: an unusable document does not lose the level's policy while the cabinet is unreachable", () => {
  const cabinet = watchesUnit({ absentForMinutes: 5 });
  const memory = new UsbPolicyMemory();
  const levels: UsbPolicyLevel[] = [level("cabinet", "cab-1", storedPolicy(cabinet, 3)), level("site", "site-1", storedPolicy(watchesUnit({ absentForMinutes: 30 })))];
  const first = reconcileUsbPolicies({ levels, subject: { unitKey: "UNIT-1", portKey: null }, memory });
  assert.equal(first.resolution?.level, "cabinet");
  assert.equal(first.fromMemory, false);
  // The row is written by a newer server, or truncated: the level's last valid policy stays in force.
  const damaged = [level("cabinet", "cab-1", "{\"version\":4,\"policy\":{\"enabled\":true}}"), ...levels.slice(1)];
  const second = reconcileUsbPolicies({ levels: damaged, subject: { unitKey: "UNIT-1", portKey: null }, memory });
  assert.equal(second.resolution?.level, "cabinet");
  assert.equal(second.resolution?.version, 3);
  assert.equal(second.fromMemory, true);
  assert.deepEqual(second.skips.map(s => s.reason), ["policy_invalid"]);
  // A row that has been taken away, though, is not resurrected from the memory: the scope no longer watches the unit,
  // so the next scope up decides (clearing a policy is not the same thing as the row being unreadable).
  const missing = [level("cabinet", "cab-1", null), ...levels.slice(1)];
  const third = reconcileUsbPolicies({ levels: missing, subject: { unitKey: "UNIT-1", portKey: null }, memory });
  assert.equal(third.resolution?.level, "site");
  assert.equal(third.fromMemory, false);
  assert.equal(third.skips.some(s => s.level === "cabinet"), false, "an empty row is skipped without a note");
});

test("a version older than the one already validated never moves a scope backwards", () => {
  const memory = new UsbPolicyMemory();
  const newer = watchesUnit({ absentForMinutes: 5 });
  reconcileUsbPolicies({ levels: [level("cabinet", "cab-1", storedPolicy(newer, 7))], subject: { unitKey: "UNIT-1", portKey: null }, memory });
  const older = watchesUnit({ absentForMinutes: 600 });
  const result = reconcileUsbPolicies({ levels: [level("cabinet", "cab-1", storedPolicy(older, 2))], subject: { unitKey: "UNIT-1", portKey: null }, memory });
  assert.equal(result.resolution?.policy.absentForMinutes, 5);
  assert.equal(result.fromMemory, true);
  assert.deepEqual(result.skips.map(s => s.reason), ["version_out_of_order"]);
});

test("a memory only remembers forward, and only its own level and scope", () => {
  const memory = new UsbPolicyMemory();
  assert.equal(memory.note("cabinet", "cab-1", { version: 4, policy: asPolicy() }), true);
  assert.equal(memory.note("cabinet", "cab-1", { version: 4, policy: asPolicy() }), false);
  assert.equal(memory.note("cabinet", "cab-1", { version: 3, policy: asPolicy() }), false);
  assert.equal(memory.note("cabinet", "cab-2", { version: 1, policy: asPolicy() }), true);
  assert.equal(memory.note("site", "cab-1", { version: 1, policy: asPolicy() }), true);
  assert.equal(memory.last("site", "cab-1")?.version, 1);
  assert.equal(memory.last("cabinet", "cab-3"), null);
  assert.equal(memory.size, 3);
  memory.clear();
  assert.equal(memory.size, 0);
});

test("a scope that has switched the policy off does not fall through to a broader one that has not", () => {
  const levels = [
    level("cabinet", "cab-1", storedPolicy(watchesUnit({ enabled: false }))),
    level("site", "site-1", storedPolicy(watchesUnit({ absentForMinutes: 30 }))),
  ];
  const result = reconcileUsbPolicies({ levels, subject: { unitKey: "UNIT-1", portKey: null } });
  assert.equal(result.resolution?.level, "cabinet");
  assert.equal(result.resolution?.policy.enabled, false);
});

test("a unit no level watches is resolved to nothing", () => {
  const levels = [level("site", "site-1", storedPolicy(asPolicy({ identityKey: { kind: "device", value: "OTHER", confidence: "high" } })))];
  const result = reconcileUsbPolicies({ levels, subject: { unitKey: "UNIT-1", portKey: null } });
  assert.equal(result.resolution, null);
  assert.equal(result.fromMemory, false);
  assert.deepEqual(reconcileUsbPolicies({ levels: [], subject: { unitKey: "UNIT-1", portKey: null } }).resolution, null);
});

test("settings keys are the level and the id, and step-up names match the platform's own", () => {
  assert.equal(USB_POLICY_SETTING_KEY, "usb.policy");
  assert.equal(usbPolicySettingKey("fleet", null), "usb.policy");
  assert.equal(usbPolicySettingKey("cabinet", "AB-CD"), "usb.policy.cabinet.ab-cd");
  assert.equal(usbPolicySettingKey("client", "Client-1"), "usb.policy.client.client-1");
  assert.throws(() => usbPolicySettingKey("site", null), /needs the site's id/);
  assert.equal(usbStepUpAction("fleet"), "settings.usb-policy");
  assert.equal(usbStepUpAction("site"), "site.usb-policy");
  assert.equal(USB_RULE_IDS.length, 3);
});

test("every policy change carries an audit entry, with the scope it changed and what it was before", () => {
  const before = asPolicy({ absentForMinutes: 30 });
  const after = asPolicy({ absentForMinutes: 5 });
  const cabinet = usbPolicyAuditEntry({ level: "cabinet", scopeId: "cab-1", userId: "user-1", version: 4, before, after });
  assert.equal(cabinet.actorKind, "user");
  assert.equal(cabinet.actorId, "user-1");
  assert.equal(cabinet.action, "cabinet.usb-policy");
  assert.equal(cabinet.targetKind, "cabinet");
  assert.equal(cabinet.targetId, "cab-1");
  assert.equal(cabinet.outcome, "succeeded");
  assert.equal((cabinet.details?.version as number), 4);
  assert.equal((cabinet.details?.before as UsbPolicy).absentForMinutes, 30);
  assert.equal((cabinet.details?.after as UsbPolicy).absentForMinutes, 5);
  const fleet = usbPolicyAuditEntry({ level: "fleet", scopeId: null, userId: "user-1", version: 1, before: null, after });
  assert.equal(fleet.action, "settings.usb-policy");
  assert.equal("targetKind" in fleet, false, "a fleet setting has no target row to name");
  const cleared = usbPolicyAuditEntry({ level: "site", scopeId: "site-1", userId: "user-1", version: null, before, after: null });
  assert.equal(cleared.details?.version, null);
  assert.equal(cleared.details?.after, null);
});

test("a policy that is not the contract's is refused by the parser, naming the field and the rule", () => {
  try {
    parseUsbWatchPolicy({ identityKey: { kind: "device", value: KEY, confidence: "high" } });
    assert.fail("expected a refusal");
  } catch (e) {
    assert.equal(e instanceof UsbPolicyError, true);
    const issues = e instanceof UsbPolicyError ? e.issues : [];
    assert.equal(issues.length > 0, true);
    assert.equal(issues[0]?.field, "/enabled");
    assert.equal(e instanceof UsbPolicyError ? e.message : "", issuesText(issues));
  }
});
