// The named file paths of the file-facts read (docs/platform/archive/improvement-plan.md section 5, design requirements in
// docs/platform/research/2026-10/audit-server.md "Proposed bounded file-version read"). This file holds every rule that decides
// whether a path an owner configured may be read at all. It is pure: no filesystem call, no clock, no database.
//
// A version resource is read from a file the owner named, so the allowlist is an exact list: a path is either written exactly as
// configured and canonical, or it is refused. Nothing here repairs a path ("close enough" is how a traversal gets through): a
// device path, a UNC path, an alternate data stream, a relative or rooted segment, a wildcard, a trailing dot or space, a
// forward slash and a control character are all refusals, never a normalisation.
//
// What this file cannot do is what only the cabinet can: it cannot know whether the handle it opened traversed a reparse point.
// The read therefore also reports the path of the opened handle and whether it went through one, and the ingest side
// (filefacts-ingest.ts) refuses the entry unless both agree with the configured root and file name. Lexical containment on its
// own is not a security check; it is one of two.
import { Refused } from "./errors.js";

/** The platform's own caps. Contracts carry the same numbers: the report schema refuses anything larger. */
export const MAX_FILES = 32;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_ELAPSED_MS = 30_000;
export const MAX_PATH_LENGTH = 260;
export const MAX_ROOT_LENGTH = 200;
export const MAX_NAME_LENGTH = 128;
export const MAX_KEY_LENGTH = 128;

/** Why a path, a name or an entry was refused. A caller never sees the path back, only this. */
export type PathRefusalReason =
  | "not_text"
  | "empty"
  | "too_long"
  | "control_character"
  | "unc"
  | "device"
  | "not_absolute"
  | "wrong_separator"
  | "alternate_stream"
  | "traversal"
  | "empty_segment"
  | "trailing_dot_or_space"
  | "reserved_character"
  | "wildcard"
  | "not_a_name";

export type Canonical = { ok: true; path: string } | { ok: false; reason: PathRefusalReason };
const accepts = (path: string): Canonical => ({ ok: true, path });
const refuses = (reason: PathRefusalReason): Canonical => ({ ok: false, reason });

/** Characters Windows reserves in a name, plus the two separators and the alternate-stream colon. */
const FORBIDDEN = new Set([...'<>:"/|?*']);
const isControl = (code: number): boolean => code < 0x20 || code === 0x7f;

/** A directory or file name rule shared by every segment of a path and by a single file name. */
function segmentProblem(segment: string): PathRefusalReason | null {
  if (segment.length === 0) return "empty_segment";
  for (const ch of segment) {
    const code = ch.codePointAt(0)!;
    if (isControl(code)) return "control_character";
    if (FORBIDDEN.has(ch)) {
      if (ch === ":") return "alternate_stream"; // "file.exe:stream" is another file's data, not this file
      if (ch === "?" || ch === "*") return "wildcard";
      return "reserved_character";
    }
  }
  if (segment === "." || segment === "..") return "traversal";
  // Windows quietly drops a trailing dot or space, so "App." IS "App": refusing it keeps one path from meaning two files.
  if (segment.endsWith(".") || segment.endsWith(" ")) return "trailing_dot_or_space";
  return null;
}

/**
 * The one canonical form of an absolute local path: `C:\Program Files\Dispenser\Dispenser.App.exe`. The drive letter is
 * upper-cased; everything else is kept exactly as given. A trailing separator is not a canonical form, so the root of a whole
 * drive (`C:\`) is refused with everything else that is not a named path.
 */
function canonical(raw: string, max: number): Canonical {
  if (raw.length > max) return refuses("too_long");
  // A device path ("\\?\C:\...", "\\.\C:\...", "\??\C:\...") names the device namespace and a UNC path
  // ("\\server\share\...") names a share on another machine: neither is a file on this cabinet.
  if (raw.startsWith("\\")) {
    if (raw.startsWith("\\\\?\\") || raw.startsWith("\\\\.\\") || raw.startsWith("\\??\\")) return refuses("device");
    return raw.startsWith("\\\\") ? refuses("unc") : refuses("not_absolute");
  }
  if (raw.includes("/")) return refuses("wrong_separator");
  const head = /^([A-Za-z]):\\/.exec(raw);
  if (!head) return refuses("not_absolute");
  const body = raw.slice(3);
  if (body.length === 0) return refuses("empty_segment");
  let out = `${head[1]!.toUpperCase()}:`;
  for (const segment of body.split("\\")) {
    const problem = segmentProblem(segment);
    if (problem) return refuses(problem);
    out += `\\${segment}`;
  }
  return accepts(out);
}

/** A canonical directory root, as the allowlist stores it. */
export function canonicalRoot(raw: unknown): Canonical {
  if (typeof raw !== "string") return refuses("not_text");
  if (raw.length === 0) return refuses("empty");
  return canonical(raw, MAX_ROOT_LENGTH);
}

/** A canonical absolute file path, as a cabinet reports the handle it opened. */
export function canonicalPath(raw: unknown): Canonical {
  if (typeof raw !== "string") return refuses("not_text");
  if (raw.length === 0) return refuses("empty");
  return canonical(raw, MAX_PATH_LENGTH);
}

/** True when two parts of a path name the same thing: a directory on Windows is found whatever the case. */
const samePart = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The full path of one allowlist entry: the canonical root plus one file name taken exactly as configured. The name is a single
 * segment — no separator, so no recursion and no path the owner did not write — and it is compared as an exact name, not as a
 * search: `APP.EXE` is not `app.exe`.
 */
export function joinWithinRoot(rootRaw: unknown, nameRaw: unknown): Canonical {
  const root = canonicalRoot(rootRaw);
  if (!root.ok) return root;
  if (typeof nameRaw !== "string") return refuses("not_text");
  if (nameRaw.length === 0) return refuses("empty");
  if (nameRaw.length > MAX_NAME_LENGTH) return refuses("too_long");
  if (nameRaw.includes("\\") || nameRaw.includes("/")) return refuses("not_a_name");
  const problem = segmentProblem(nameRaw);
  if (problem) return refuses(problem);
  const path = `${root.path}\\${nameRaw}`;
  if (path.length > MAX_PATH_LENGTH) return refuses("too_long");
  return accepts(path);
}

/**
 * True when `candidate` is a file directly inside `root`: the root's own parts compared as Windows compares a directory name,
 * and exactly one more separator with something after it. This is a cross-check on the path a cabinet reports having opened —
 * never the only check, and never used to build a path.
 */
export function insideRoot(rootRaw: unknown, candidateRaw: unknown): boolean {
  const root = canonicalRoot(rootRaw);
  const candidate = canonicalPath(candidateRaw);
  if (!root.ok || !candidate.ok) return false;
  const prefix = `${root.path}\\`;
  if (!samePart(candidate.path.slice(0, prefix.length), prefix)) return false;
  const rest = candidate.path.slice(prefix.length);
  return rest.length > 0 && !rest.includes("\\");
}

/** True when the opened handle is exactly the configured root plus the configured file name. */
export function matchesEntry(entry: { root: string; name: string }, candidateRaw: unknown): boolean {
  if (!insideRoot(entry.root, candidateRaw)) return false;
  const candidate = canonicalPath(candidateRaw);
  const root = canonicalRoot(entry.root);
  if (!candidate.ok || !root.ok) return false;
  return candidate.path.slice(root.path.length + 1) === entry.name;
}

/** An `app:<name>` key, the name a file stands for in the applications category. */
export function keyProblem(raw: unknown): PathRefusalReason | null {
  if (typeof raw !== "string") return "not_text";
  if (raw.length === 0) return "empty";
  if (raw.length > MAX_KEY_LENGTH) return "too_long";
  if (!raw.startsWith("app:") || raw.length === 4) return "not_a_name";
  return segmentProblem(raw.slice(4)) ?? (raw.slice(4).includes("\\") ? "not_a_name" : null);
}

/** True when the text could be a version string: short, single line, no control character. Reported values are never parsed. */
export function looksLikeVersion(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && ![...value].some(ch => isControl(ch.codePointAt(0)!));
}

/** The refusal a route or a service raises for a reason found here; the path itself is never echoed. */
export function refusePath(action: string, reason: PathRefusalReason): Refused {
  return new Refused("invalid_params", 400, `${action}: ${reason}`);
}
