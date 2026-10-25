// What changed between two versions of a category, item by item (docs/spec/15-baselines-and-config.md). Pure.
import { valueText, type Item } from "./config-canonical.js";

export interface ItemChange {
  key: string;
  change: "added" | "removed" | "changed";
  /** For a change, each field that differs as { before, after }; for an add or a remove, { value } per field. */
  fields: Record<string, { before: unknown; after: unknown }>;
}

const same = (a: unknown, b: unknown) => valueText(a) === valueText(b);

export function diffItems(before: readonly Item[], after: readonly Item[]): ItemChange[] {
  const old = new Map(before.map(i => [i.key, i.values]));
  const now = new Map(after.map(i => [i.key, i.values]));
  const out: ItemChange[] = [];
  for (const [key, values] of now) {
    const was = old.get(key);
    if (!was) { out.push({ key, change: "added", fields: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined).map(([f, v]) => [f, { before: null, after: v }])) }); continue; }
    const fields: ItemChange["fields"] = {};
    for (const f of new Set([...Object.keys(was), ...Object.keys(values)]))
      if (!same(was[f], values[f])) fields[f] = { before: was[f] ?? null, after: values[f] ?? null };
    if (Object.keys(fields).length > 0) out.push({ key, change: "changed", fields });
  }
  for (const [key, values] of old)
    if (!now.has(key)) out.push({ key, change: "removed", fields: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined).map(([f, v]) => [f, { before: v, after: null }])) });
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
