// How a difference from a baseline reads, in every view that shows one: the cabinet's Baseline tab, Compare and the fleet's
// Differences. A process item (decision-log D155) is judged on the cabinet's latest stored process list, so what it is says when
// that list was taken.

/** One stored value as plain text. An object is never shown as "[object Object]". */
export function valueText(v: unknown): string {
  if (v === null || v === undefined) return "none";
  if (Array.isArray(v)) return v.length ? v.map(valueText).join(", ") : "none";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "object") { const e = Object.entries(v as Record<string, unknown>); return e.length ? e.map(([k, x]) => `${k}: ${valueText(x)}`).join(", ") : "none"; }
  return String(v);
}

export interface Difference { category: string; field: string; mode: string; expected: unknown; actual: unknown }
export interface ProcessLimits { cpuPercent?: number; workingSetMb?: number }

export const PROCESS_PREFIX = "process:";
export const processName = (key: string) => key.startsWith(PROCESS_PREFIX) ? key.slice(PROCESS_PREFIX.length) : key;
const FIELD: Record<string, string> = { cpuPercent: "CPU", workingSetMb: "Memory" };
/** A difference's field as a person reads it. */
export const fieldName = (category: string, field: string) => category === "processes" ? FIELD[field] ?? field : field;

const amount = (field: string, n: unknown) => typeof n !== "number" ? "unknown" : field === "cpuPercent" ? `${n}% CPU` : field === "workingSetMb" ? `${n} MB of memory` : String(n);
const record = (v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** What a process item expects, as the editor and the baseline in force list it. */
export function processExpects(mode: string, limits?: ProcessLimits | null): string {
  if (mode === "absent") return "Must not be running";
  const parts = [limits?.cpuPercent !== undefined ? amount("cpuPercent", limits.cpuPercent) : null, limits?.workingSetMb !== undefined ? amount("workingSetMb", limits.workingSetMb) : null].filter(Boolean);
  return parts.length ? `Must be running, using at most ${parts.join(" and ")}` : "Must be running";
}

/** What the baseline says it should be. */
export function shouldBe(d: Difference): string {
  if (d.category === "processes") return d.mode === "absent" ? "Not running" : d.field ? `At most ${amount(d.field, record(d.expected).atMost)}` : "Running";
  return d.mode === "present" ? "Present" : d.mode === "absent" ? "Not present" : d.field ? valueText(d.expected) : "Present, as the baseline says";
}

/** What the cabinet reports, for a process with the time of the process list it was judged on (`when` formats it). */
export function isNow(d: Difference, when: (iso: string) => string): string {
  if (d.category === "processes") {
    const a = record(d.actual);
    const what = d.field ? amount(d.field, a.value) : a.running === true ? "Running" : "Not running";
    return typeof a.takenAt === "string" ? `${what}, in the process list of ${when(a.takenAt)}` : what;
  }
  return d.mode === "present" ? "Missing" : d.mode === "absent" ? "Present" : d.field ? valueText(d.actual) : "Missing";
}

/** Why a process expectation cannot be added as written, or null. The server checks it again against its contract. */
export function processProblem(name: string, cpu: string, memory: string, existing: readonly { category: string; key: string }[]): string | null {
  const n = name.trim();
  if (n.length === 0) return "Name the program, as the Processes tab shows it (for example SyncService.exe).";
  if (n.length > 180 || /[\u0000-\u001f\u007f<>]/.test(n)) return "A program name is at most 180 characters, with no control characters or angle brackets.";
  if (existing.some(i => i.category === "processes" && processName(i.key).toLowerCase() === n.toLowerCase())) return "This program is already in this version.";
  if (cpu.trim() !== "") { const c = Number(cpu); if (!Number.isFinite(c) || c <= 0 || c > 100) return "The CPU limit is a share of the whole machine, above 0 and at most 100."; }
  if (memory.trim() !== "") { const m = Number(memory); if (!Number.isInteger(m) || m < 1 || m > 1_048_576) return "The memory limit is a whole number of MB, from 1 to 1,048,576."; }
  return null;
}

/** The item the editor adds. Limits only when it must be running and at least one is set. */
export function processItem(name: string, mustRun: boolean, cpu: string, memory: string, required: boolean, severity: "minor" | "major") {
  const limits: ProcessLimits = {};
  if (mustRun && cpu.trim() !== "") limits.cpuPercent = Number(cpu);
  if (mustRun && memory.trim() !== "") limits.workingSetMb = Number(memory);
  return { category: "processes", key: PROCESS_PREFIX + name.trim(), mode: mustRun ? "present" : "absent", ...(Object.keys(limits).length ? { limits } : {}), required, severity };
}
