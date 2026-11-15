// A difference nobody declared, as it appears (F17, decision-log D54). Drift needs a baseline to say what a setting should be. Where none
// declares it, the cabinet's peers can: the other active cabinets of its role at its site. When a cabinet reports a configuration
// change, each item it changed in the last 30 days is compared with the same item on its peers. Where at least two peers report the item
// and every one of them agrees, and this cabinet does not, that is a difference: the item missing where they all have it, present where
// none has it, or one field with another value than theirs. Fields that differ from cabinet to cabinet by nature (addresses, a service's
// running state, install dates) and the per-cabinet categories (devices) are never compared, and an item a baseline in force declares is
// left to drift. One minor alert per cabinet, saying what differs; closed automatically (audited) once nothing does. Nothing runs on a
// cabinet; no regular expressions.
import { lock, transaction, type Pool, type Queryable } from "../db/db.js";
import { valueText, type Item } from "./config-canonical.js";
import { currentItems, type Category } from "./config-ingest.js";
import { CABINET_ONLY, CAPTURE_SKIP, PER_CABINET, resolveForCabinet } from "./baselines.js";
import { closeSignatureAlert, retitleAlert, upsertAlert } from "./alerts.js";
import { ISSUE } from "./rules.js";

export const PEER_DIFFERENCE_SIGNATURE = "peer-difference";
/** Peers that must report the item, all agreeing, before this cabinet's value is a difference. */
export const MIN_PEERS = 2;
/** How recent a change of this cabinet's must be for its result to count as appearing. */
export const RECENT_DAYS = 30;
/** Peers read per cabinet, at most. */
export const MAX_PEERS = 50;

export interface PeerDifference {
  category: string; itemKey: string;
  /** "" when the item itself is missing or extra. */
  field: string;
  kind: "missing" | "extra" | "value";
  /** This cabinet's value of the field, and the one every peer has. */
  mine: unknown; theirs: unknown;
  peers: number;
}

const skipped = (category: Category) => new Set([...(CAPTURE_SKIP[category] ?? []), ...(PER_CABINET[category] ?? [])]);

/**
 * Pure: the differences between this cabinet and its peers, among the candidate items (the ones it changed recently), leaving out the
 * items a baseline declares. `peers` is each peer's current items by category; a peer that has not reported a category does not count.
 */
export function peerDifferences(mine: ReadonlyMap<Category, readonly Item[]>, peers: readonly ReadonlyMap<Category, readonly Item[]>[],
  candidates: readonly { category: Category; itemKey: string }[], declared: ReadonlySet<string>): PeerDifference[] {
  const out: PeerDifference[] = [];
  const seen = new Set<string>();
  for (const { category, itemKey } of candidates) {
    const id = `${category}|${itemKey}`;
    if (seen.has(id) || declared.has(id) || CABINET_ONLY.includes(category) || !mine.has(category)) continue;
    seen.add(id);
    const reporting = peers.map(p => p.get(category)).filter((x): x is readonly Item[] => x !== undefined);
    if (reporting.length < MIN_PEERS) continue;
    const own = mine.get(category)!.find(i => i.key === itemKey);
    const theirs = reporting.map(list => list.find(i => i.key === itemKey));
    const base = { category, itemKey, peers: reporting.length };
    if (theirs.every(i => i !== undefined)) {
      if (!own) { out.push({ ...base, field: "", kind: "missing", mine: false, theirs: true }); continue; }
      const skip = skipped(category);
      const fields = new Set([...Object.keys(own.values), ...theirs.flatMap(i => Object.keys(i!.values))]);
      for (const field of [...fields].sort()) {
        if (skip.has(field)) continue;
        const values = new Set(theirs.map(i => valueText((i!.values as Record<string, unknown>)[field])));
        if (values.size !== 1) continue; // the peers do not agree among themselves: nothing to stand out from
        const mineValue = (own.values as Record<string, unknown>)[field];
        if (valueText(mineValue) === [...values][0]) continue;
        out.push({ ...base, field, kind: "value", mine: mineValue ?? null, theirs: (theirs[0]!.values as Record<string, unknown>)[field] ?? null });
      }
    } else if (theirs.every(i => i === undefined) && own) {
      out.push({ ...base, field: "", kind: "extra", mine: true, theirs: false });
    }
  }
  return out;
}

const show = (v: unknown) => v === null || v === undefined ? "nothing" : typeof v === "string" ? v : JSON.stringify(v);
/** One difference in words: "service:W32Time startType manual (they have automatic)". */
export const describe = (d: PeerDifference) => d.kind === "missing" ? `${d.itemKey} is missing (they all have it)`
  : d.kind === "extra" ? `${d.itemKey} is present (none of them has it)` : `${d.itemKey} ${d.field} ${show(d.mine)} (they have ${show(d.theirs)})`;

export function peerTitle(diffs: readonly PeerDifference[], role: string, site: string): string {
  const n = Math.max(...diffs.map(d => d.peers));
  const more = diffs.length > 1 ? `, and ${diffs.length - 1} more` : "";
  return `Differs from the other ${n} ${role} cabinets at ${site}: ${describe(diffs[0]!)}${more}`.slice(0, 300);
}

/** The differences for one cabinet now, read from the database. */
export async function cabinetPeerDifferences(c: Queryable, cabinetId: string): Promise<{ diffs: PeerDifference[]; role: string; site: string }> {
  const k = (await c.query<{ site_id: string; role: string; site: string; demo: number }>(
    `SELECT k.site_id, k.role, s.name AS site, CASE WHEN k.demo_scenario IS NULL THEN 0 ELSE 1 END AS demo FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1`,
    [cabinetId])).rows[0];
  if (!k) return { diffs: [], role: "", site: "" };
  const candidates = (await c.query<{ category: Category; item_key: string }>(
    `SELECT DISTINCT category, item_key FROM config_changes WHERE cabinet_id = $1 AND observed_at > DATEADD(day, -$2, SYSUTCDATETIME())`,
    [cabinetId, RECENT_DAYS])).rows.map(r => ({ category: r.category, itemKey: r.item_key }));
  if (candidates.length === 0) return { diffs: [], role: k.role, site: k.site };
  const peerIds = (await c.query<{ id: string }>(
    `SELECT TOP (${MAX_PEERS}) id FROM cabinets WHERE site_id = $1 AND role = $2 AND status = 'active' AND id <> $3
        AND CASE WHEN demo_scenario IS NULL THEN 0 ELSE 1 END = $4 ORDER BY id`, [k.site_id, k.role, cabinetId, k.demo])).rows.map(r => r.id);
  if (peerIds.length < MIN_PEERS) return { diffs: [], role: k.role, site: k.site };
  const categories = [...new Set(candidates.map(x => x.category))];
  const asItems = (m: Awaited<ReturnType<typeof currentItems>>) => new Map([...m].map(([cat, v]) => [cat, v.items]));
  const mine = asItems(await currentItems(c, cabinetId, categories));
  const peers = [];
  for (const id of peerIds) peers.push(asItems(await currentItems(c, id, categories)));
  const declared = new Set((await resolveForCabinet(c, cabinetId)).items.map(i => `${i.category}|${i.key}`));
  return { diffs: peerDifferences(mine, peers, candidates, declared), role: k.role, site: k.site };
}

/** Opens, updates or closes the cabinet's one peer-difference alert from what differs now. */
export async function checkPeerDifferences(pool: Pool, cabinetId: string): Promise<PeerDifference[]> {
  return transaction(pool, async c => {
    await lock(c, `peers:${cabinetId}`);
    const { diffs, role, site } = await cabinetPeerDifferences(c, cabinetId);
    if (diffs.length > 0) {
      const title = peerTitle(diffs, role, site);
      const { id } = await upsertAlert(c, { cabinetId, issueTypeId: ISSUE.peerDifference, severity: "minor", signature: PEER_DIFFERENCE_SIGNATURE, title, seenAt: new Date(), ruleId: null, eventId: null });
      await retitleAlert(c, id, title);
      return diffs;
    }
    await closeSignatureAlert(c, "peer-difference", cabinetId, PEER_DIFFERENCE_SIGNATURE,
      "The cabinet matches the other cabinets of its role at its site again, or a baseline now declares the setting (seen in its configuration).");
    return diffs;
  });
}

/**
 * After a cabinet's configuration changed: check it, and re-check its peers that have the alert open, since this cabinet changing can
 * make them match the rest again (or no longer have peers that all agree).
 */
export async function checkPeerDifferencesAround(pool: Pool, cabinetId: string): Promise<void> {
  await checkPeerDifferences(pool, cabinetId);
  const open = (await pool.query<{ cabinet_id: string }>(
    `SELECT TOP (${MAX_PEERS}) a.cabinet_id FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id JOIN cabinets me ON me.id = $1
      WHERE a.signature = $2 AND a.state <> 'resolved' AND k.site_id = me.site_id AND k.role = me.role AND k.id <> me.id`, [cabinetId, PEER_DIFFERENCE_SIGNATURE])).rows;
  for (const o of open) await checkPeerDifferences(pool, o.cabinet_id);
}
