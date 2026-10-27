// What comes back from a file-facts read, and what the platform does with it (docs/platform/improvement-plan.md section 5).
//
// A read is an ordinary command: the platform issues it with the plan as its params, the cabinet answers through the same result
// path every other operation uses, and the report is the answer's output (commands.result, '$.output'). What comes back is
// telemetry from a cabinet, so it is treated as hostile input in three steps and in this order: it must match its JSON Schema
// (filefacts-report.schema.json) before any other code looks at it; it must then survive the plan the cabinet was actually asked
// for — read back from the command's params and canonicalised again — meaning a key the plan never issued is dropped, a handle that
// is not exactly the configured root plus the configured file name is refused, a handle that went through a reparse point is
// refused, a file bigger than its own entry's limit is refused, a SHA-256 nobody asked for is dropped, and every string that
// survives is cleaned and bounded; and only then is anything diffed or alerted on. No field here is ever file content, and no
// value is ever echoed back into an error.
//
// The version a file reports is compared with the site's baseline through the same machinery configuration drift already uses:
// the observed versions become `app:<name>` items in the applications category, the baseline's resolved expectations are computed
// from them, and one alert per cabinet is raised while a tracked version differs and closed when it matches again (the shape
// diagnose/network.ts uses for the network baseline).
import { createAjv, ref } from "@mashura/cabinet-contracts/load";
import { type Queryable } from "../db/db.js";
import { clean } from "../diagnose/cabinet-findings.js";
import { upsertAlert } from "./alerts.js";
import { computeDrift, type DriftRow } from "./baseline-drift.js";
import { resolveForCabinet, type ResolvedItem } from "./baselines.js";
import type { Item } from "./config-canonical.js";
import { Refused } from "./errors.js";
import { looksLikeVersion, matchesEntry } from "./filefacts-path.js";
import { CAPS, overBudget, parsePlan, planEntry, type Caps, type Plan } from "./filefacts-request.js";
import { parseJson } from "./settings.js";

/** The operation a file-facts read is asked for as, named the way the platform names its other reads. */
export const FACTS_OPERATION = "files.facts";
/** The issue type a tracked version that differs from its baseline raises. Registered by migration 0010_missing_objects.sql. */
export const APP_VERSION_ISSUE = "00000000-0000-4000-8000-000000000124";
export const REPORT_SCHEMA_ID = "filefacts/filefacts-report.schema.json";

export type FactStatus = "ok" | "missing" | "access_denied" | "too_large" | "timeout" | "refused" | "reparse_point" | "outside_root" | "invalid_path" | "error";

export interface ReportFile {
  key: string;
  status: FactStatus;
  signatureStatus: string;
  openedPath?: string | null;
  reparsePoint: boolean;
  observedAt: string;
  productVersion?: string | null;
  fileVersion?: string | null;
  companyName?: string | null;
  description?: string | null;
  sizeBytes?: number | null;
  modifiedAt?: string | null;
  createdAt?: string | null;
  sha256?: string | null;
  detail?: string | null;
}

export interface FactsReport {
  takenAt: string;
  allowlistVersion: number;
  files: ReportFile[];
  fileCount: number;
  totalBytes: number;
  elapsedMs: number;
  truncated: boolean;
}

/** The version values that belong to one named file once the platform has decided they may be kept. */
export interface FactValues {
  productVersion: string | null;
  fileVersion: string | null;
  companyName: string | null;
  description: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  createdAt: string | null;
  signatureStatus: string;
  sha256: string | null;
}

export interface Admitted {
  key: string;
  status: FactStatus;
  /** The version a person would quote: the product version, or the file version when the file has no product version. */
  version: string | null;
  facts: FactValues | null;
  detail: string;
}

export interface Admission {
  allowed: Admitted[];
  dropped: { key: string; reason: string }[];
  /** Counted by the platform from what it admitted, never taken from the cabinet's own totals. */
  files: number;
  bytes: number;
  truncated: boolean;
  takenAt: string;
}

let validator: ((data: unknown) => boolean) | null = null;
const reportValidator = (): ((data: unknown) => boolean) => {
  if (!validator) {
    const check = createAjv().getSchema(ref(REPORT_SCHEMA_ID));
    if (!check) throw new Error(`Contract schema not found: ${REPORT_SCHEMA_ID}`);
    validator = (data: unknown): boolean => check(data) === true;
  }
  return validator;
};

/** The report, typed, or a refusal. The schema runs first and its errors report locations and keywords only, never values. */
export function parseReport(raw: unknown): FactsReport {
  const check = reportValidator();
  if (check(raw)) return raw as FactsReport;
  const get = createAjv().getSchema(ref(REPORT_SCHEMA_ID))!;
  get(raw);
  const issues = (get.errors ?? []).slice(0, 20).map(e => `${e.instancePath || "/"}:${e.keyword}`);
  throw new Refused("invalid_result", 400, `the file-facts report did not match its contract (${issues.join(", ")})`);
}

/** One string as it may be kept: cleaned of control characters, trimmed, bounded, empty becomes nothing. */
const text = (value: unknown, max: number): string | null => {
  const out = clean(value, max);
  return out.length === 0 ? null : out;
};

/** A version string, or nothing: a version is short, single-line text and is never parsed into anything. */
const version = (value: unknown): string | null => (looksLikeVersion(value) ? (clean(value, 64) || null) : null);

/**
 * What the platform will keep from a report, pure and without a database. The plan decides what a result is allowed to say; the
 * caps decide whether the cabinet worked within its budget at all, which is refused outright rather than trimmed.
 */
export function admitReport(plan: Plan, report: FactsReport, caps: Caps = CAPS): Admission {
  const over = overBudget({ files: report.fileCount, totalBytes: report.totalBytes, elapsedMs: report.elapsedMs }, caps);
  if (over) throw new Refused("result_over_cap", 409, `the file-facts report exceeded its budget: ${over}`);
  const allowed: Admitted[] = [];
  const dropped: { key: string; reason: string }[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const file of report.files) {
    const entry = planEntry(plan, file.key);
    if (!entry) {
      dropped.push({ key: clean(file.key, 128) || "?", reason: "unknown_path" });
      continue;
    }
    if (seen.has(entry.key)) {
      dropped.push({ key: entry.key, reason: "duplicate_key" });
      continue;
    }
    seen.add(entry.key);
    const detail = text(file.detail, 200) ?? "";
    if (file.status !== "ok") {
      allowed.push({ key: entry.key, status: file.status, version: null, facts: null, detail });
      continue;
    }
    // The handle, not the path the platform asked for, is what was opened: it must be the configured file, exactly.
    if (file.reparsePoint) {
      allowed.push({ key: entry.key, status: "reparse_point", version: null, facts: null, detail });
      continue;
    }
    if (!matchesEntry(entry, file.openedPath)) {
      allowed.push({ key: entry.key, status: "outside_root", version: null, facts: null, detail });
      continue;
    }
    const size = typeof file.sizeBytes === "number" && Number.isInteger(file.sizeBytes) && file.sizeBytes >= 0 ? file.sizeBytes : null;
    if (size !== null && size > entry.maxBytes) {
      allowed.push({ key: entry.key, status: "too_large", version: null, facts: null, detail });
      continue;
    }
    const product = version(file.productVersion);
    const fileVersion = version(file.fileVersion);
    const facts: FactValues = {
      productVersion: product,
      fileVersion,
      companyName: text(file.companyName, 128),
      description: text(file.description, 200),
      sizeBytes: size,
      modifiedAt: text(file.modifiedAt, 40),
      createdAt: text(file.createdAt, 40),
      signatureStatus: clean(file.signatureStatus, 16) || "unknown",
      // A SHA-256 the plan did not ask for is not kept: the platform reads what it asked for and nothing else.
      sha256: entry.includeSha256 ? (clean(file.sha256, 64).toLowerCase() || null) : null,
    };
    if (facts.sha256 !== null && !/^[0-9a-f]{64}$/.test(facts.sha256)) facts.sha256 = null;
    bytes += size ?? 0;
    allowed.push({ key: entry.key, status: "ok", version: product ?? fileVersion, facts, detail });
  }
  return { allowed, dropped, files: allowed.filter(a => a.status === "ok").length, bytes, truncated: report.truncated || dropped.length > 0, takenAt: report.takenAt };
}

/** The observed versions as items in the applications category, the shape the baseline comparison expects. */
export function observedItems(allowed: readonly Admitted[]): Item[] {
  const out: Item[] = [];
  for (const one of allowed) {
    if (one.status !== "ok" || !one.facts) continue;
    out.push({ key: one.key, values: { version: one.version, fileVersion: one.facts.fileVersion, productVersion: one.facts.productVersion } });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The version differences that are worth alerting on: the tracked keys the plan covers, compared with the baselines in force. A
 * difference in a field the file read cannot witness (a publisher, an installer version) is not raised by this rule, and a key no
 * baseline mentions produces nothing at all — "no expectation" is not drift.
 */
export function versionDrift(items: readonly ResolvedItem[], allowed: readonly Admitted[], plan: Plan): DriftRow[] {
  const tracked = new Map([...plan.entries.map(e => [e.key, e] as const)]);
  const relevant = items.filter(i => i.category === "applications" && tracked.has(i.key));
  if (relevant.length === 0) return [];
  const current = new Map<string, readonly Item[]>([["applications", observedItems(allowed)]]);
  return computeDrift(relevant, current).filter(row => row.field === "version" || row.mode === "present" || row.mode === "absent");
}

/** The one line a difference is reported with; the values are cleaned and clipped before they can reach a title. */
export function versionTitle(rows: readonly DriftRow[]): string {
  const parts = rows.slice(0, 2).map(r => {
    const want = clean(r.expected === null || r.expected === undefined ? "nothing" : String(r.expected), 40);
    const have = clean(r.actual === null || r.actual === undefined ? (r.mode === "match" ? "not read" : "not seen") : String(r.actual), 40);
    return `${clean(r.itemKey, 128)} is ${have}, the baseline says ${want}`;
  });
  return parts.join("; ");
}

/** Raises the one alert that a tracked version differs, or closes it when every tracked version matches again. */
export async function reconcileVersionAlert(db: Queryable, cabinetId: string, rows: readonly DriftRow[]): Promise<"raised" | "cleared"> {
  if (rows.length > 0) {
    const issue = (await db.query<{ name: string; severity: string }>("SELECT name, severity FROM issue_types WHERE id = $1", [APP_VERSION_ISSUE])).rows[0];
    if (issue) {
      await upsertAlert(db, { cabinetId, issueTypeId: APP_VERSION_ISSUE, severity: issue.severity, signature: `issue:${APP_VERSION_ISSUE}`,
        title: `${issue.name}: ${versionTitle(rows)}`.slice(0, 250), seenAt: new Date(), ruleId: null, eventId: null });
      return "raised";
    }
    return "cleared"; // the issue type is not registered: nothing to raise, and no alert is invented for it
  }
  await db.query(`UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME(), resolution = 'The versions read from the configured file paths match the baseline.'
                   WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved'`, [cabinetId, APP_VERSION_ISSUE]);
  return "cleared";
}

/** Why a cabinet's last read could not move anything, or that it did. */
export type IngestStatus = "no_read" | "unusable_request" | "malformed_report" | "nothing_read" | "done";

/** The last successful read of a cabinet's named paths: the request that was sent, and the report that came back. */
export interface StoredRead {
  at: string;
  /** The plan the cabinet was actually asked for, re-canonicalised; null when the stored params are not a plan this server issued. */
  plan: Plan | null;
  report: unknown;
}

/**
 * The one stored read the platform replays and reports on: the command's params are the request that went out, and its result's
 * output is the report. Nothing here asks a cabinet anything — this is the latest answer already stored, the same projection
 * readings.ts uses for every other read.
 */
export async function storedRead(db: Queryable, cabinetId: string, caps: Caps = CAPS): Promise<StoredRead | null> {
  const row = (await db.query<{ params: unknown; output: unknown; at: Date }>(
    `SELECT TOP (1) params, JSON_QUERY(result, '$.output') AS output, result_at AS [at] FROM commands
      WHERE cabinet_id = $1 AND operation = $2 AND status = 'succeeded' AND result IS NOT NULL AND result_at IS NOT NULL
      ORDER BY result_at DESC`, [cabinetId.trim().toLowerCase(), FACTS_OPERATION])).rows[0];
  if (!row || row.output === null || row.output === undefined) return null;
  return { at: row.at instanceof Date ? row.at.toISOString() : String(row.at), plan: parsePlan(parseJson<unknown>(row.params), caps), report: parseJson<unknown>(row.output) };
}

/**
 * The whole ingest of the latest read: the request that went out is canonicalised again, the report is checked against the contract
 * and then admitted against exactly the paths that were asked for, and the versions that came back are compared with the baseline.
 * The cabinet is the cabinet the plan was built for, so a report can only ever describe the cabinet it came from, and only a read
 * that came back under a plan this server issued can raise or close an alert.
 */
export async function ingestFacts(db: Queryable, cabinetId: string, caps: Caps = CAPS): Promise<{ status: IngestStatus; admission: Admission | null; differences: DriftRow[]; alert: "raised" | "cleared" | "none" }> {
  const id = cabinetId.trim().toLowerCase();
  const stored = await storedRead(db, id, caps);
  if (!stored) return { status: "no_read", admission: null, differences: [], alert: "none" };
  if (!stored.plan) return { status: "unusable_request", admission: null, differences: [], alert: "none" };
  let admission: Admission;
  try {
    admission = admitReport(stored.plan, parseReport(stored.report), caps);
  } catch (e) {
    if (e instanceof Refused) return { status: "malformed_report", admission: null, differences: [], alert: "none" };
    throw e;
  }
  if (!admission.allowed.some(one => one.status === "ok")) return { status: "nothing_read", admission, differences: [], alert: "none" };
  const resolved = await resolveForCabinet(db, id);
  const differences = versionDrift(resolved.items, admission.allowed, stored.plan);
  const alert = await reconcileVersionAlert(db, id, differences);
  return { status: "done", admission, differences, alert };
}
