// Where the console lives. It is served from the root of its own origin by default; a deployment
// that puts it under a path (a shared domain, say) sets CONSOLE_BASE at build time, which Vite
// bakes into the asset URLs and this module applies to the console's own addresses: routes, API
// calls and the live stream. BASE is "" at the origin root and "/console" under a path.

/** Cleans a configured base ("/", "console/", "/console/", "//evil") into "" or "/console". */
export function normalizeBase(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  // A base has to be an absolute path, and never protocol-relative.
  if (!value.startsWith("/") || value.startsWith("//")) return "";
  const parts = value.split("/").filter(Boolean);
  // Plain words only: a base holding ".", "%" or "?" would build addresses no proxy can match.
  if (parts.some(p => !/^[A-Za-z0-9._~-]+$/.test(p) || p === "." || p === "..")) return "";
  return parts.length ? `/${parts.join("/")}` : "";
}

/** An app path ("/fleet?a=1") as the address the browser must use ("/console/fleet?a=1"). */
export function withBaseAt(base: string, to: string): string {
  if (base === "" || !to.startsWith("/") || to.startsWith("//")) return to;
  if (to === base || to.startsWith(`${base}/`)) return to;
  return `${base}${to}`;
}

/** The browser's address ("/console/fleet?a=1") as the app path ("/fleet?a=1"). */
export function stripBaseAt(base: string, address: string): string {
  if (base === "") return address;
  if (address === base) return "/";
  // Only the base's own path: "/consolex" is a different address, not ours.
  return address.startsWith(`${base}/`) ? address.slice(base.length) : address;
}

/** Where the console lives on this build: "" at the origin root, "/console" under a path. */
export const BASE: string = normalizeBase(import.meta.env?.BASE_URL);

export const withBase = (to: string): string => withBaseAt(BASE, to);

/** Where the console is now, as an app path rather than the address in the browser. */
export function currentPath(): string {
  return stripBaseAt(BASE, window.location.pathname + window.location.search);
}
