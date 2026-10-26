// The approved-programs list as the console edits it: the key a request names an entry by, and what an entry needs before it is added.
export interface AppEntry { key: string; kind: "application" | "service"; name: string; path: string; serviceName?: string }
export interface StoredApp { key: string; kind: "application" | "service"; name: string; root: string; file: string; serviceName: string | null }
export interface AppList { version: number; entries: StoredApp[]; setAt: string }

const PATH = /^[A-Za-z]:\\(?!.*(^|\\)\.{1,2}(\\|$))[^\u0000-\u001f\u007f<>:"/|?*]+\.[Ee][Xx][Ee]$/;
const SERVICE = /^[A-Za-z0-9_.$-](?:[A-Za-z0-9_.$ -]{0,78}[A-Za-z0-9_.$-])?$/;
const MAX = 32;

/** The key a request names the entry by: app: and the name, without the characters a key may not hold. */
export function entryKey(name: string): string {
  return "app:" + name.trim().replace(/[\\/:*?"<>|]/g, "").slice(0, 59);
}

/** What the stored list looks like as the request that would set it again. */
export const toEntry = (a: StoredApp): AppEntry => ({ key: a.key, kind: a.kind, name: a.name, path: `${a.root.replace(/\\$/, "")}\\${a.file}`,
  ...(a.kind === "service" && a.serviceName ? { serviceName: a.serviceName } : {}) });

/** Why a new entry cannot be added, or null when it can. */
export function entryProblem(e: AppEntry, existing: AppEntry[]): string | null {
  if (!e.name.trim()) return "Give it a name.";
  if (entryKey(e.name).length < 5) return "The name needs at least one letter or digit.";
  if (existing.some(x => x.key.toLowerCase() === e.key.toLowerCase())) return "A program with that name is already on the list.";
  if (!PATH.test(e.path)) return "The path must be the full path to the program, such as C:\\Program Files\\Vendor\\app.exe.";
  if (e.kind === "service" && !SERVICE.test(e.serviceName ?? "")) return "Give the service's key name, such as BioScanSvc.";
  if (existing.length >= MAX) return `A list holds at most ${MAX} programs.`;
  return null;
}

