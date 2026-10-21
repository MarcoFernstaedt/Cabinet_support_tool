// The fingerprint of a configuration category (docs/spec/15-baselines-and-recovery.md): SHA-256 of the canonical JSON of its items sorted
// by key. The agent computes the same thing (agent/src/Cabinet.Agent.Core/Configuration/ConfigCanonical.cs); contracts/vectors holds the
// shared test vectors. Items are sorted by key (UTF-16 code units, as the agent's ordinal sort), object keys sorted the same way at
// every level, no spaces, arrays in their own order, strings escaped as JSON.stringify does. The server recomputes every hash from the
// items it receives and refuses a snapshot whose hash does not match, so a stored hash always describes the stored items.
import { createHash } from "node:crypto";
import type { ConfigItem } from "@mashura/cabinet-contracts/types";

export type ConfigValue = string | number | boolean | null | string[];
export type Item = ConfigItem;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function value(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new TypeError("a configuration value is never a fraction");
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(value).join(",")}]`;
  throw new TypeError("not a configuration value");
}

export function canonicalItems(items: readonly Item[]): string {
  const sorted = [...items].sort((a, b) => compare(a.key, b.key));
  return `[${sorted.map(i => {
    const keys = Object.keys(i.values).filter(k => i.values[k] !== undefined).sort(compare);
    return `{"key":${JSON.stringify(i.key)},"values":{${keys.map(k => `${JSON.stringify(k)}:${value(i.values[k])}`).join(",")}}}`;
  }).join(",")}]`;
}

export const configHash = (items: readonly Item[]): string => createHash("sha256").update(canonicalItems(items), "utf8").digest("hex");

/** One value as the canonical text, for comparing two values without caring how they were parsed. */
export const valueText = (v: unknown): string => value(v === undefined ? null : v);
