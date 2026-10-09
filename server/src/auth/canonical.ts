// The canonical JSON of a value: object keys sorted at every level, no spaces. A confirmation token is bound to
// sha256(canonical JSON of the parameters the person saw), so it works for those exact parameters only
// (docs/spec/12-milestones-8-to-12.md "Confirmation levels"). The console computes the same hash.
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("not JSON");
    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new TypeError("not JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export const paramsHash = (value: unknown): string => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
