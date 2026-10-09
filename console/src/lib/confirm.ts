// How each operation is confirmed and who may run it, read from the operation catalog the agent and server use
// (docs/spec/12-milestones-8-to-12.md "Confirmation levels"). The console only chooses which dialog to show; the
// server checks the role and the confirmation again on every request.
import catalog from "@mashura/cabinet-contracts/schemas/operations/catalog.json";
import type { Role } from "./session";

interface Entry { name: string; kind: "read" | "write"; minimumRole: Role; confirm: "none" | "click" | "code" }
const BY_NAME = new Map((catalog.operations as Entry[]).map(e => [e.name, e]));

export const confirmFor = (operation: string): Entry["confirm"] => BY_NAME.get(operation)?.confirm ?? "code";
export const minimumRoleFor = (operation: string): Role => BY_NAME.get(operation)?.minimumRole ?? "admin";

/** Canonical JSON: object keys sorted at every level, no spaces. Must match the server's (server/src/auth/canonical.ts). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new TypeError("not JSON");
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("not JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

/** SHA-256 (lowercase hex) of the canonical JSON: what a confirmation token is bound to. */
export async function paramsHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
