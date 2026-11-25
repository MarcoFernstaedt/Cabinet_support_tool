// Fixtures for the USB policy and rule tests: contract-valid shapes, one fixed clock, no database and no cabinet.
//
// Every value here is the shape docs/spec/18-built-designs.md §5 describes, so a test can change
// one field and leave the rest as a real report would carry it.
import type { UsbPolicy, UsbPolicyLevel, UsbScopeLevel } from "../src/services/usb-policy.js";
import type { UsbDeviceReport, UsbIssueTypeInfo, UsbReportDevice, UsbWatchInput } from "../src/services/usb-rules.js";

export const CABINET_ID = "3f8a5c2e-9b1d-4a7e-8c6f-2d5b9e4a1c7f";
export const SITE_ID = "6d2b8f41-7c3a-4e5b-9f10-8a4c6e2d5b93";
export const CLIENT_ID = "b7e4c9a2-1d6f-4b83-a95c-3e7f0d8b2a64";
export const BOOT_ID = "8c1e4d7a-2f5b-4c9e-a3d6-7b0f2e5c8a1d";

/** 2026-10-23T12:00:00Z, a Friday: quiet-hours tests below read the weekday from here. */
export const NOW = new Date("2026-10-23T12:00:00.000Z");

/** The device key: characters the contract's key pattern allows (a hardware ID with its separators). */
export const UNIT = "USB\\VID_1004&PID_6555\\7&1F2C3D4E&0&1";
/** The slot key: a location path, which is what a port-scoped policy names. */
export const PORT = "PCIROOT(0)#USBROOT(0)#USB(1)";
export const LABEL = "Port_#0002.Hub_#0003";

/** A timestamp `minutes` away from NOW, as a report carries it. */
export const iso = (minutes: number): string => new Date(NOW.getTime() + minutes * 60_000).toISOString();

/** Drops the keys a caller left undefined, so a spread does not set an optional field to undefined. */
const prune = <T extends object>(value: Partial<T>): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

export const SCOPE_ID: Readonly<Record<UsbScopeLevel, string | null>> = {
  cabinet: CABINET_ID,
  site: SITE_ID,
  client: CLIENT_ID,
  fleet: null,
};

export function policy(over: Partial<UsbPolicy> = {}): UsbPolicy {
  const base: UsbPolicy = {
    identityKey: { kind: "device", value: UNIT, confidence: "high" },
    enabled: true,
    absentForMinutes: 5,
    reconnect: { count: 3, windowMinutes: 60 },
    settle: { afterHintSeconds: 15, afterResumeSeconds: 30, maxSettleSeconds: 120 },
    quietHours: null,
    severity: {},
    autoRestart: false,
  };
  return { ...base, ...prune(over) } as UsbPolicy;
}

/** One scope's row with a policy in it, as the data layer hands it over. */
export const level = (l: UsbScopeLevel, p: UsbPolicy | null, version = 1, scopeId: string | null = SCOPE_ID[l]): UsbPolicyLevel => ({
  level: l,
  scopeId,
  stored: p === null ? null : { version, policy: p },
});

/** One scope's row with whatever the settings table actually holds, valid or not. */
export const rawLevel = (l: UsbScopeLevel, stored: unknown, scopeId: string | null = SCOPE_ID[l]): UsbPolicyLevel => ({ level: l, scopeId, stored });

export function device(over: Partial<UsbReportDevice> = {}): UsbReportDevice {
  const base: UsbReportDevice = {
    unitKey: UNIT,
    portKey: PORT,
    parentKey: null,
    parentRootCause: "none",
    identity: "serial",
    identityConfidence: "high",
    state: "present",
    problemCode: null,
    firstSeenAt: iso(-600),
    lastSeenAt: iso(-1),
    firstAbsentAt: null,
    reconnectCount: 0,
    reconnectWindowMinutes: 60,
    cyclesAreLowerBound: false,
    healthySamples: 2,
    portDisplay: LABEL,
    workload: [],
    workloadProbe: "none",
  };
  return { ...base, ...prune(over) } as UsbReportDevice;
}

export function report(over: Partial<UsbDeviceReport> = {}): UsbDeviceReport {
  const base: UsbDeviceReport = {
    cabinetId: CABINET_ID,
    bootId: BOOT_ID,
    reportedAt: NOW.toISOString(),
    monitorState: "present",
    settled: true,
    eventHistoryComplete: true,
    devices: [device()],
  };
  return { ...base, ...prune(over) } as UsbDeviceReport;
}

const issueType = (id: string, name: string, severity: UsbIssueTypeInfo["severity"]): UsbIssueTypeInfo => ({ id, name, severity });

/** The catalog as migrations/0001_baseline.sql seeds it, with the two keys the other rules need. */
export const ISSUE_TYPES: ReadonlyMap<string, UsbIssueTypeInfo> = new Map([
  ["usb_missing", issueType("11111111-1111-4111-8111-111111111111", "Expected USB device not detected", "minor")],
  ["usb_flap", issueType("22222222-2222-4222-8222-222222222222", "USB device reconnecting repeatedly", "minor")],
  ["usb_dependency", issueType("33333333-3333-4333-8333-333333333333", "USB dependency not attached", "minor")],
]);

/** A whole evaluation input: one cabinet, one watched unit, the fleet policy, no open incidents. */
export function watch(over: Partial<UsbWatchInput> = {}): UsbWatchInput {
  const base: UsbWatchInput = {
    cabinetId: CABINET_ID,
    now: NOW,
    report: report(),
    levels: [level("fleet", policy())],
    incidents: new Map(),
    issueTypes: ISSUE_TYPES,
  };
  return { ...base, ...prune(over) } as UsbWatchInput;
}
