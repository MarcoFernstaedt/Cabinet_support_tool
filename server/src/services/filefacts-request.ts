// The read request the platform builds from a cabinet's allowlist, and the budgets it is held to (docs/platform/improvement-plan.md
// section 5). The cabinet is never asked to find a file: the platform resolves the list into a fixed plan of named paths, caps how
// many files, how many bytes and how long the read may take, and rate-limits how often one cabinet may be asked at all.
//
// The three caps are here rather than in the contract on purpose. The JSON Schema carries the envelope's hard ceiling, which is
// twice the platform cap: a file-facts report that took longer than the platform allows is still a well-formed report, so it is
// parsed and refused with a reason ("result_over_cap") instead of being reported as malformed telemetry. A cabinet that did too
// much work is diagnosed, not scolded for its JSON.
import type { Queryable } from "../db/db.js";
import { audit } from "../db/db.js";
import { ROLE_RANK, type Role } from "./console-commands.js";
import { Refused } from "./errors.js";
import { MAX_ELAPSED_MS, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from "./filefacts-path.js";
import { READ_ACTION, normalizeEntry, type AllowlistContent, type AllowlistLevels, type AllowlistEntry, allowlistLevels } from "./filefacts-allowlist.js";

export interface Caps {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxElapsedMs: number;
  /** How many reads one cabinet may be asked for in an hour. */
  maxPerHour: number;
}

export const CAPS: Caps = { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, maxElapsedMs: MAX_ELAPSED_MS, maxPerHour: 12 };
export const RATE_WINDOW_SECONDS = 3600;

export interface PlanEntry {
  key: string;
  root: string;
  name: string;
  includeSha256: boolean;
  /** The most this entry may read: its own limit, never above the platform's per-file cap. */
  maxBytes: number;
}

export type PlanRefusalReason = "over_file_cap" | "over_total_bytes";

export interface Plan {
  allowlistVersion: number;
  entries: PlanEntry[];
  /** Entries the caps kept out, so a console can say why a path it configured was not read. */
  skipped: { key: string; reason: PlanRefusalReason }[];
  truncated: boolean;
  caps: Caps;
}

/**
 * The plan for one list: at most `maxFiles` names, and only as many as fit under the aggregate byte cap once each entry's own
 * limit is counted. Entries are taken in key order, so the same list always yields the same plan and two cabinets with the same
 * list are asked for the same names.
 */
export function buildPlan(content: AllowlistContent, caps: Caps = CAPS): Plan {
  const skipped: { key: string; reason: PlanRefusalReason }[] = [];
  const entries: PlanEntry[] = [];
  let budget = Math.min(caps.maxTotalBytes, caps.maxFiles * caps.maxFileBytes);
  for (const entry of content.entries) {
    if (entries.length >= caps.maxFiles) {
      skipped.push({ key: entry.key, reason: "over_file_cap" });
      continue;
    }
    const maxBytes = Math.min(Math.max(entry.maxBytes, 0), caps.maxFileBytes);
    if (maxBytes > budget) {
      skipped.push({ key: entry.key, reason: "over_total_bytes" });
      continue;
    }
    budget -= maxBytes;
    entries.push({ key: entry.key, root: entry.root, name: entry.name, includeSha256: entry.includeSha256, maxBytes });
  }
  return { allowlistVersion: content.version, entries, skipped, truncated: skipped.length > 0, caps };
}

/** The configured entry a result belongs to, or nothing when the plan never issued that key. */
export const planEntry = (plan: Plan, key: unknown): PlanEntry | undefined =>
  (typeof key === "string" ? plan.entries.find(e => e.key === key) : undefined);

/**
 * What a report claims, against the caps. The platform counts what it admits itself; this is the first, cruder check, and it is
 * what keeps a cabinet that ignored its budget from reaching anything else.
 */
export function overBudget(claimed: { files: number; totalBytes: number; elapsedMs: number }, caps: Caps = CAPS): string | null {
  if (claimed.files > caps.maxFiles) return "file_count_over_cap";
  if (claimed.totalBytes > caps.maxTotalBytes) return "total_bytes_over_cap";
  if (claimed.elapsedMs > caps.maxElapsedMs) return "elapsed_over_cap";
  return null;
}

/** The rate limit: how many reads this cabinet has been asked for in the last hour, and a refusal over it. */
export async function recentReads(db: Queryable, cabinetId: string): Promise<number> {
  const row = (await db.query<{ n: number }>(
    `SELECT COUNT_BIG(*) AS n FROM audit_log
      WHERE action = $2 AND target_kind = 'cabinet' AND target_id = $1 AND [at] > DATEADD(second, -$3, SYSUTCDATETIME())`,
    [cabinetId.toLowerCase(), READ_ACTION, RATE_WINDOW_SECONDS])).rows[0];
  return row ? Number(row.n) : 0;
}

export function withinRateLimit(used: number, caps: Caps = CAPS): void {
  if (used >= caps.maxPerHour) throw new Refused("rate_limited", 429, `a cabinet is asked to read its files at most ${caps.maxPerHour} times an hour`);
}

/**
 * The plan for one cabinet, ready to hand to an agent: a read is a read, so any Tier 1 or Tier 2 account may ask for one; only an
 * owner may decide which paths it covers. The request is audited before it goes out, which is also what the rate limit counts.
 */
export async function planRead(db: Queryable, user: { userId: string; role: string }, cabinetId: string, caps: Caps = CAPS): Promise<{ plan: Plan; levels: AllowlistLevels }> {
  if (ROLE_RANK[user.role as Role] < ROLE_RANK.tier1) throw new Refused("forbidden", 403, "your role cannot read cabinet files");
  const id = cabinetId.trim().toLowerCase();
  withinRateLimit(await recentReads(db, id), caps);
  const levels = await allowlistLevels(db, id);
  if (!levels.effective || levels.effective.entries.length === 0) throw new Refused("no_file_paths", 409, "no named file paths are configured for this cabinet");
  const plan = buildPlan(levels.effective, caps);
  await audit(db, { actorKind: "user", actorId: user.userId, action: READ_ACTION, targetKind: "cabinet", targetId: id, outcome: "succeeded",
    details: { level: levels.source, allowlistVersion: plan.allowlistVersion, entries: plan.entries.length, skipped: plan.skipped.length,
      truncated: plan.truncated, maxElapsedMs: caps.maxElapsedMs, keys: plan.entries.map(e => e.key) } });
  return { plan, levels };
}

/** The keys a list would read, for a console that shows the plan before anything is asked of a cabinet. */
export const plannedKeys = (entries: readonly AllowlistEntry[]): string[] => entries.map(e => e.key);

/**
 * The read request as it is sent to a cabinet, and kept as the command's params: the names, and the caps to obey. The caps travel
 * with the request so the agent can stop itself at the same numbers the server will hold it to.
 */
export interface PlanRequest {
  allowlistVersion: number;
  entries: PlanEntry[];
  caps: Pick<Caps, "maxFiles" | "maxFileBytes" | "maxTotalBytes" | "maxElapsedMs">;
}

export const requestOf = (plan: Plan): PlanRequest =>
  ({ allowlistVersion: plan.allowlistVersion, entries: plan.entries, caps: { maxFiles: plan.caps.maxFiles, maxFileBytes: plan.caps.maxFileBytes, maxTotalBytes: plan.caps.maxTotalBytes, maxElapsedMs: plan.caps.maxElapsedMs } });

/**
 * A stored request read back from the command that went out, or null when it does not describe a plan this platform could have
 * sent. The params of a command are data like any other, so they are canonicalised again rather than trusted: a plan that claims
 * paths the allowlist rules refuse, or caps above the platform's, is not a plan this server issued.
 */
export function parsePlan(raw: unknown, caps: Caps = CAPS): Plan | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.entries) || r.entries.length > caps.maxFiles) return null;
  const version = r.allowlistVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  const asked = r.caps as Record<string, unknown> | undefined;
  if (!asked || typeof asked !== "object") return null;
  const cap = (name: keyof Caps): number => (typeof asked[name] === "number" ? (asked[name] as number) : caps[name]);
  if (cap("maxFiles") > caps.maxFiles || cap("maxFileBytes") > caps.maxFileBytes || cap("maxTotalBytes") > caps.maxTotalBytes || cap("maxElapsedMs") > caps.maxElapsedMs) return null;
  const entries: PlanEntry[] = [];
  let total = 0;
  for (const item of r.entries) {
    const one = normalizeEntry(item);
    if (!one.ok) return null;
    if (one.entry.maxBytes > caps.maxFileBytes) return null;
    total += one.entry.maxBytes;
    entries.push({ key: one.entry.key, root: one.entry.root, name: one.entry.name, includeSha256: one.entry.includeSha256, maxBytes: one.entry.maxBytes });
  }
  if (total > caps.maxTotalBytes) return null;
  return { allowlistVersion: version, entries, skipped: [], truncated: false, caps: { ...caps } };
}
