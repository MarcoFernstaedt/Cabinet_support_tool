// Crash signatures (roadmap Phase 2, "a crash signature groups crashes across the fleet"): what kind of blue screen each crash was, finer than
// its stop code, so the same failure on many cabinets reads as one thing. The faulting driver is not part of it yet: a small dump's header does
// not hold it, and the driver list after the header is read only once a real sample confirms its layout (09-open-decisions, D26).
//
// A signature is the stop code and, for the stop codes whose first parameter Microsoft's bug-check reference documents as the kind of failure
// (an exception code or a subtype), that parameter too. Every other parameter is an address or a count that differs from crash to crash, so it
// would split one failure into many. Parsed without regular expressions, from the BugCheck 1001 message:
// "The computer has rebooted from a bugcheck.  The bugcheck was: 0x0000003b (0x00000000c0000005, 0xfffff80123456789, 0x…, 0x0). A dump was saved in: …"
import type { Queryable } from "../db/db.js";
import { BUG_CHECK_PAIR_MS, compareChanges, describeStopCode, stopCodeOf, stopCodeText, type ChangeComparison } from "./crashes.js";

/** Stop codes whose first parameter is an exception code: the low 32 bits are the code (64-bit Windows may sign-extend it). */
const EXCEPTION_FIRST = new Set([0x1E, 0x3B, 0x7E, 0x8E, 0x1000007E, 0x1000008E]);
/** Stop codes whose first parameter is a subtype naming the kind of failure. */
const SUBTYPE_FIRST = new Set([0x1A, 0x9F, 0xC2, 0x124, 0x133, 0x139]);

/** Exception codes common in blue screens, named in plain words. Others are shown as their number. */
const EXCEPTIONS: Record<number, string> = {
  0xC0000005: "access violation (memory that was not the code's to touch)",
  0xC000001D: "illegal instruction",
  0xC0000006: "in-page error (reading from disk failed)",
  0xC0000094: "integer divide by zero",
  0xC00000FD: "stack overflow",
  0x80000003: "breakpoint",
  0x80000004: "single step",
  0xC0000409: "stack buffer overrun",
  0xC0000420: "assertion failure",
};
/** Subtypes named in plain words where the bug-check reference states them clearly; others are shown as their number. */
const SUBTYPES: Record<number, Record<number, string>> = {
  0x9F: { 0x3: "a device did not finish a power request in time", 0x4: "a power change timed out waiting for Plug and Play" },
  0x133: { 0x0: "one deferred procedure ran too long", 0x1: "deferred procedures ran too long in total" },
  0x124: { 0x0: "machine check from the processor" },
  0x139: { 0x3: "a linked list was corrupted", 0x2: "a stack-based buffer overrun" },
};

const isHex = (ch: string) => (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");

/** The four parameters after the stop code in a BugCheck 1001 message, as numbers; null when they are not there exactly as Windows writes them. */
export function stopParametersOf(message: string): bigint[] | null {
  const lower = message.toLowerCase();
  const marker = "bugcheck was: ";
  const at = lower.indexOf(marker);
  if (at < 0) return null;
  let i = at + marker.length;
  while (i < message.length && message[i] !== "(" && i - at < 40) i++;
  if (message[i] !== "(") return null;
  i++;
  const out: bigint[] = [];
  while (out.length < 4) {
    while (message[i] === " ") i++;
    if (lower.slice(i, i + 2) !== "0x") return null;
    i += 2;
    let hex = "";
    while (i < message.length && hex.length < 16 && isHex(message[i]!)) hex += message[i++];
    if (hex.length === 0 || (i < message.length && isHex(message[i]!))) return null;
    out.push(BigInt("0x" + hex));
    while (message[i] === " ") i++;
    const sep = message[i++];
    if (out.length < 4 ? sep !== "," : sep !== ")") return null;
  }
  return out;
}

export interface CrashSignature {
  /** "0x0000003B" or "0x0000003B/0xC0000005": stable across cabinets and crashes; the URL and grouping key. */
  key: string;
  stopCode: ReturnType<typeof describeStopCode>;
  /** The exception or subtype that refines it, when the stop code has one and it was in the message. */
  detail: { kind: "exception" | "subtype"; value: string; meaning: string | null } | null;
  /** One line for people: "0x0000003B SYSTEM_SERVICE_EXCEPTION, exception 0xC0000005 access violation (…)". */
  title: string;
}

const hex8 = (n: number) => `0x${n.toString(16).toUpperCase().padStart(8, "0")}`;

/** The signature of one blue-screen message; null when it carries no stop code. */
export function crashSignature(message: string): CrashSignature | null {
  const code = stopCodeOf(message);
  if (code === null) return null;
  const stopCode = describeStopCode(code);
  const p1 = stopParametersOf(message)?.[0];
  let detail: CrashSignature["detail"] = null;
  if (p1 !== undefined && EXCEPTION_FIRST.has(code)) {
    const ex = Number(p1 & 0xFFFFFFFFn);
    detail = { kind: "exception", value: hex8(ex), meaning: EXCEPTIONS[ex] ?? null };
  } else if (p1 !== undefined && SUBTYPE_FIRST.has(code) && p1 <= 0xFFFFFFFFn) {
    const sub = Number(p1);
    detail = { kind: "subtype", value: `0x${sub.toString(16).toUpperCase()}`, meaning: SUBTYPES[code]?.[sub] ?? null };
  }
  const base = `${stopCodeText(code)}${stopCode.name ? ` ${stopCode.name}` : ""}`;
  const title = detail ? `${base}, ${detail.kind} ${detail.value}${detail.meaning ? ` ${detail.meaning}` : ""}` : base;
  return { key: detail ? `${stopCodeText(code)}/${detail.value}` : stopCodeText(code), stopCode, detail, title };
}

/** A signature key as the console sends it back: exactly what crashSignature makes, nothing else. */
export function isSignatureKey(key: string): boolean {
  const [code, detail, extra] = key.split("/");
  const isHexRun = (s: string, min: number, max: number) => s.length >= min && s.length <= max && [...s].every(c => isHex(c) && c === c.toUpperCase());
  if (extra !== undefined || !code || !code.startsWith("0x") || !isHexRun(code.slice(2), 8, 8)) return false;
  return detail === undefined || (detail.startsWith("0x") && isHexRun(detail.slice(2), 1, 8));
}

/** The BugCheck sources that write the stop code; Kernel-Power 41 and EventLog 6008 say a restart was unexpected but not why. */
const SOURCES = ["bugcheck", "microsoft-windows-wer-systemerrorreporting"];

interface Crash { cabinetId: string; at: Date; sig: CrashSignature }

/** Blue screens in the window on active cabinets (optionally one client's), one per crash: Windows logs the same crash under both sources. */
async function crashesIn(db: Queryable, f: { from: Date; to: Date; clientId?: string | undefined }): Promise<{ crashes: Crash[]; cabinets: Map<string, Population> }> {
  const pop = (await db.query<{ id: string; name: string; site: string; client: string; agent_version: string | null; demo: number }>(
    `SELECT k.id, k.name, s.name AS site, c.name AS client, k.agent_version, CASE WHEN k.demo_scenario IS NULL THEN 0 ELSE 1 END AS demo
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
      WHERE k.status = 'active' ${f.clientId ? "AND s.client_id = $1" : ""}`, f.clientId ? [f.clientId] : [])).rows;
  const cabinets = new Map(pop.map(p => [p.id.toLowerCase(), { ...p, id: p.id.toLowerCase(), demo: p.demo === 1 }]));
  const rows = (await db.query<{ cabinet_id: string; occurred_at: Date; message: string | null; src: string }>(
    `SELECT e.cabinet_id, e.occurred_at, LOWER(JSON_VALUE(e.source, '$.source')) AS src,
            (SELECT j.message FROM OPENJSON(e.detail) WITH (message nvarchar(max) '$.message') j) AS message
       FROM events e
      WHERE e.occurred_at BETWEEN $1 AND $2 AND e.cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($3))
        AND LOWER(JSON_VALUE(e.source, '$.source')) IN ($4, $5) AND TRY_CAST(JSON_VALUE(e.source, '$.eventId') AS int) = 1001
      ORDER BY e.cabinet_id, e.occurred_at`, [f.from, f.to, [...cabinets.keys()], ...SOURCES])).rows;
  const crashes: Crash[] = [];
  // Windows logs one crash under both sources. An entry is the other half of the crash before it when it is the same cabinet and signature,
  // from the other source, within 10 minutes, and that crash has not been paired yet; two real crashes minutes apart (a reboot loop) stay two.
  const last = new Map<string, { at: Date; src: string; paired: boolean }>();
  for (const r of rows) {
    const sig = r.message ? crashSignature(r.message) : null;
    if (!sig) continue;
    const id = r.cabinet_id.toLowerCase(), k = `${id}|${sig.key}`, prev = last.get(k);
    if (prev && !prev.paired && prev.src !== r.src && r.occurred_at.getTime() - prev.at.getTime() < BUG_CHECK_PAIR_MS) { prev.paired = true; continue; }
    last.set(k, { at: r.occurred_at, src: r.src, paired: false });
    crashes.push({ cabinetId: id, at: r.occurred_at, sig });
  }
  return { crashes, cabinets };
}

interface Population { id: string; name: string; site: string; client: string; agent_version: string | null; demo: boolean }

export interface SignatureRow {
  key: string; title: string; stopCode: CrashSignature["stopCode"]; detail: CrashSignature["detail"]; demo: boolean;
  crashes: number; cabinets: number; sites: number; clients: number; firstSeen: string; lastSeen: string;
  /** Crashes in the last 24 hours of the window, and in the 24 before: whether it is growing. */
  lastDay: number; dayBefore: number;
}

const DAY = 86_400_000;

/** Every crash signature in the window across the fleet, widest first. Demo cabinets' crashes are their own rows, never mixed with real ones. */
export async function fleetCrashSignatures(db: Queryable, f: { from: Date; to: Date; clientId?: string | undefined }): Promise<SignatureRow[]> {
  const { crashes, cabinets } = await crashesIn(db, f);
  return group(crashes, cabinets, f.to).slice(0, 200);
}

function group(crashes: readonly Crash[], cabinets: ReadonlyMap<string, Population>, to: Date): SignatureRow[] {
  const groups = new Map<string, { sig: CrashSignature; demo: boolean; list: Crash[] }>();
  for (const c of crashes) {
    const demo = cabinets.get(c.cabinetId)!.demo, k = `${demo ? "demo|" : ""}${c.sig.key}`;
    (groups.get(k) ?? groups.set(k, { sig: c.sig, demo, list: [] }).get(k)!).list.push(c);
  }
  const end = to.getTime();
  return [...groups.values()].map(({ sig, demo, list }) => {
    const ks = new Set(list.map(c => c.cabinetId)), who = [...ks].map(id => cabinets.get(id)!);
    const times = list.map(c => c.at.getTime());
    return {
      key: sig.key, title: sig.title, stopCode: sig.stopCode, detail: sig.detail, demo,
      crashes: list.length, cabinets: ks.size, sites: new Set(who.map(p => `${p.client}\u0000${p.site}`)).size, clients: new Set(who.map(p => p.client)).size,
      firstSeen: new Date(Math.min(...times)).toISOString(), lastSeen: new Date(Math.max(...times)).toISOString(),
      lastDay: times.filter(t => t > end - DAY).length, dayBefore: times.filter(t => t <= end - DAY && t > end - 2 * DAY).length,
    };
  }).sort((a, b) => b.cabinets - a.cabinets || b.crashes - a.crashes);
}

export interface SignatureReport {
  signature: SignatureRow;
  cabinets: { id: string; name: string; site: string; client: string; crashes: number; firstAt: string; lastAt: string; agentVersion: string | null }[];
  /** What the crashed cabinets had in common before their first crash with this signature, against the rest of their kind (real or demo). */
  commonFactors: ChangeComparison[];
}

/** One signature: who has it, and what they have in common. Null when no crash in the window has it. */
export async function crashSignatureReport(db: Queryable, f: { from: Date; to: Date; clientId?: string | undefined; key: string; demo: boolean }): Promise<SignatureReport | null> {
  const { crashes, cabinets } = await crashesIn(db, f);
  const mine = crashes.filter(c => c.sig.key === f.key && cabinets.get(c.cabinetId)!.demo === f.demo);
  if (mine.length === 0) return null;
  const row = group(mine, cabinets, f.to)[0]!;
  const per = new Map<string, { crashes: number; first: Date; last: Date }>();
  for (const c of mine) {
    const p = per.get(c.cabinetId) ?? { crashes: 0, first: c.at, last: c.at };
    p.crashes++; if (c.at < p.first) p.first = c.at; if (c.at > p.last) p.last = c.at;
    per.set(c.cabinetId, p);
  }
  const ids = [...cabinets.values()].filter(p => p.demo === f.demo).map(p => p.id);
  const commonFactors = (await compareChanges(db, { ids, affected: new Map([...per].map(([id, p]) => [id, p.first])), from: new Date(f.from.getTime() - 3 * DAY), to: f.to }))
    .filter(c => c.category !== "error" || c.standsOut);
  return {
    signature: row,
    cabinets: [...per].sort(([, a], [, b]) => a.first.getTime() - b.first.getTime()).slice(0, 1000).map(([id, p]) => {
      const c = cabinets.get(id)!;
      return { id, name: c.name, site: c.site, client: c.client, crashes: p.crashes, firstAt: p.first.toISOString(), lastAt: p.last.toISOString(), agentVersion: c.agent_version };
    }),
    commonFactors,
  };
}
