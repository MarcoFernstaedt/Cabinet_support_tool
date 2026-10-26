// The approved-programs list as the console edits it: the key a request names an entry by, and what an entry needs before it is added.
export interface AppEntry { key: string; kind: "application" | "service"; name: string; path: string; serviceName?: string }
export interface StoredApp { key: string; kind: "application" | "service"; name: string; root: string; file: string; serviceName: string | null }
export interface AppList { version: number; entries: StoredApp[]; setAt: string; signed?: { document: string; signature: { keyId: string } } | null }

const PATH = /^[A-Za-z]:\\(?!.*(^|\\)\.{1,2}(\\|$))[^\u0000-\u001f\u007f<>:"/|?*]+\.[Ee][Xx][Ee]$/;
const SERVICE = /^[A-Za-z0-9_.$-](?:[A-Za-z0-9_.$ -]{0,78}[A-Za-z0-9_.$-])?$/;
const MAX = 32;

/** The key a request names the entry by: app: and the name. The name's own rules (below) keep it a valid key. */
export function entryKey(name: string): string {
  return "app:" + name.trim();
}

/** The characters the server refuses in a name (approved-apps.ts clean()): a name is text, never a path or an argument. */
const NAME_FORBIDDEN = /[\u0000-\u001f\u007f\\/:*?"<>|]/;

/** What the stored list looks like as the request that would set it again. */
export const toEntry = (a: StoredApp): AppEntry => ({ key: a.key, kind: a.kind, name: a.name, path: `${a.root.replace(/\\$/, "")}\\${a.file}`,
  ...(a.kind === "service" && a.serviceName ? { serviceName: a.serviceName } : {}) });

/** Why a new entry cannot be added, or null when it can. */
export function entryProblem(e: AppEntry, existing: AppEntry[]): string | null {
  const name = e.name.trim();
  if (!name) return "Give it a name.";
  if (NAME_FORBIDDEN.test(name)) return "The name cannot contain \\ / : * ? \" < > |.";
  if (name.length > 59) return "Keep the name to 59 characters.";
  if (/[. ]$/.test(name)) return "The name cannot end with a dot or a space.";
  if (existing.some(x => x.key.toLowerCase() === e.key.toLowerCase())) return "A program with that name is already on the list.";
  if (!PATH.test(e.path) || !pathShapeOk(e.path)) return "The path must be the full path to the program in a folder, such as C:\\Program Files\\Vendor\\app.exe.";
  if (e.kind === "service" && !SERVICE.test(e.serviceName ?? "")) return "Give the service's key name, such as BioScanSvc.";
  if (existing.length >= MAX) return `A list holds at most ${MAX} programs.`;
  return null;
}


/** What the server's canonical form also refuses: a program directly on the drive, empty folder names, and names ending in a dot or space. */
function pathShapeOk(path: string): boolean {
  const parts = path.slice(3).split("\\");
  if (parts.length < 2) return false;
  return parts.every(p => p.length > 0 && !/[. ]$/.test(p));
}

/** A signature file as Sign-ApprovedList.ps1 writes it. */
export interface ListSignature { keyId: string; algorithm: "ecdsa-p256-sha256"; signature: string }

/**
 * The signature in a file the Admin picked, or why it is not one. The server checks it again, and checks it cryptographically; this
 * only turns a wrong file (the list itself, a release signature with extra fields, a damaged copy) into a plain sentence first.
 */
export function readSignatureFile(text: string): { ok: true; signature: ListSignature } | { ok: false; problem: string } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, problem: "That file is not a signature file (it is not JSON)." }; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, problem: "That file is not a signature file." };
  const v = value as Record<string, unknown>;
  if ("product" in v || "entries" in v) return { ok: false, problem: "That is the list itself. Upload the .signature.json file the signing script wrote next to it." };
  const keys = Object.keys(v).sort().join(",");
  if (keys !== "algorithm,keyId,signature") return { ok: false, problem: "That file is not a signature file from Sign-ApprovedList.ps1." };
  if (v.algorithm !== "ecdsa-p256-sha256") return { ok: false, problem: "The signature uses an algorithm the cabinets do not accept." };
  if (typeof v.keyId !== "string" || !/^[0-9a-f]{64}$/.test(v.keyId)) return { ok: false, problem: "The signature file names no key." };
  if (typeof v.signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.signature) || v.signature.length < 8 || v.signature.length > 100)
    return { ok: false, problem: "The signature in that file is damaged." };
  return { ok: true, signature: { keyId: v.keyId, algorithm: "ecdsa-p256-sha256", signature: v.signature } };
}

/** The document's exact bytes from the server's base64, for the download: the file must hold exactly what is signed. */
export function documentBytes(base64: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(text.length));
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}
