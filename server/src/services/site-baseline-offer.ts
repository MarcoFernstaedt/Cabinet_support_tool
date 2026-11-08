// The offer to capture a cabinet's configuration as its site's baseline (F17, decision-log D53). A site with no baseline of its own has
// nothing to judge its cabinets' site-level settings against, and a capture from a cabinet that works is the fastest way to one. The offer
// is made on a cabinet when its site has no site baseline (approved, pending or in draft), the cabinet has reported every category the offer
// captures, and the cabinet is healthy.
//
// Healthy, where no baseline applies to judge the configuration, is the health judgement with the configuration part counted as met: in
// contact within the health settings' offline limit, its configuration reported, no required item drifting from a baseline that does apply
// (a client's, a model's), and no major alert open (offline and site outage aside), exactly as `judge` reads them. Where a baseline applies,
// that is the same as the judgement itself. Accepting the offer is the existing capture: a draft a person reviews and an Admin approves;
// nothing is approved by the offer and nothing runs on the cabinet.
import type { Queryable } from "../db/db.js";
import { resolveForCabinet } from "./baselines.js";
import type { Category } from "./config-ingest.js";
import { facts, judge } from "./cabinet-health.js";

/**
 * The categories the offer captures, and so the ones it waits for (review of #207): the capture form's defaults, the settings a site's
 * cabinets share. Updates, applications, scheduled tasks and the hardware differ from cabinet to cabinet and are left to a hand capture.
 */
export const OFFER_CATEGORIES: readonly Category[] = ["network", "services", "firewall", "time", "drivers", "hosts"];

export interface SiteBaselineOffer {
  offered: boolean;
  /** What accepting captures: exactly the categories the offer waited for. */
  categories: readonly Category[];
  site: { id: string; name: string };
  /** Why it is not offered, one sentence each; empty when it is. */
  notOffered: string[];
}

export async function siteBaselineOffer(db: Queryable, cabinetId: string, now = new Date()): Promise<SiteBaselineOffer> {
  const k = (await db.query<{ site_id: string; site: string }>(
    "SELECT k.site_id, s.name AS site FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1", [cabinetId])).rows[0];
  if (!k) throw new Error("cabinet not found");
  const siteId = k.site_id.toLowerCase();
  const notOffered: string[] = [];
  const own = (await db.query<{ status: string }>(
    `SELECT TOP (1) v.status FROM baselines b JOIN baseline_versions v ON v.baseline_id = b.id
      WHERE b.scope_kind = 'site' AND b.scope_id = $1 AND v.status IN ('approved', 'pending', 'draft')
      ORDER BY CASE v.status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END`, [siteId])).rows[0];
  if (own) notOffered.push(own.status === "approved" ? "The site has a baseline." : own.status === "pending" ? "A baseline for the site is waiting for approval." : "A baseline for the site is being drafted.");
  const need = OFFER_CATEGORIES;
  const have = new Set((await db.query<{ category: string }>("SELECT category FROM config_current WHERE cabinet_id = $1", [cabinetId])).rows.map(r => r.category));
  const missing = need.filter(c => !have.has(c));
  if (missing.length > 0) notOffered.push(`It has not reported all of its configuration yet (${missing.length} of ${need.length} parts missing).`);
  const f = await facts(db, cabinetId, now);
  const { state, reasons } = judge({ ...f, hasBaseline: true }, (await resolveForCabinet(db, cabinetId)).health);
  if (state !== "healthy") notOffered.push(`It is not healthy: ${reasons[0]?.text ?? state}`);
  return { offered: notOffered.length === 0, categories: OFFER_CATEGORIES, site: { id: siteId, name: k.site }, notOffered };
}
