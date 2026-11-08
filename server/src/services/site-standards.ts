// What a site's standards could be, worked out from what its cabinets already report, so onboarding is "use what this cabinet has"
// instead of typing it all in. siteStandards only suggests. Saving goes through the same writers as any other edit (site.network_baseline,
// site time zone, site firewall policy), one at a time or all at once with applySiteStandards (F6.R3).
import { audit, transaction, type Pool, type Queryable } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import type { NetworkBaseline } from "../diagnose/network-findings.js";
import { Refused } from "./errors.js";
import { sitePolicy, writeSitePolicy, type FirewallPolicy } from "./firewall-policy.js";
import { writeNetworkBaseline } from "./network-baseline.js";
import { parseJson } from "./settings.js";
import { siteTimeZone, TIME_ZONES, writeSiteTimeZone, type TimeZoneId } from "./time.js";

interface Adapter { connected: boolean; type: string; ipv4: { dhcp: boolean; addresses: { address: string; prefixLength: number }[]; gateways: string[] }; dns: { servers: string[] } }

const v4 = (v: string) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(v) && v.split(".").every(n => Number(n) <= 255);

/** The baseline a cabinet's connected network card implies, or null when it has no usable gateway, address or DNS server. */
export function baselineFrom(adapters: unknown): NetworkBaseline | null {
  if (!Array.isArray(adapters)) return null;
  for (const a of adapters as Adapter[]) {
    const gateway = a?.ipv4?.gateways?.[0], first = a?.ipv4?.addresses?.[0];
    if (!a?.connected || !gateway || !first || first.prefixLength < 8 || first.prefixLength > 30) continue;
    const dnsServers = [...new Set((a.dns?.servers ?? []).filter(v4))].slice(0, 4);
    if (!v4(gateway) || dnsServers.length === 0) continue;
    return { addressing: a.ipv4.dhcp ? "dhcp" : "static", prefixLength: first.prefixLength, gateway, dnsServers };
  }
  return null;
}

const mostCommon = <T,>(items: T[], key: (t: T) => string): T | null => {
  const n = new Map<string, { item: T; count: number }>();
  for (const i of items) { const k = key(i), e = n.get(k); if (e) e.count++; else n.set(k, { item: i, count: 1 }); }
  return [...n.values()].sort((a, b) => b.count - a.count)[0]?.item ?? null;
};

export async function siteStandards(db: Queryable, siteId: string) {
  const site = (await db.query<{ client_id: string; time_zone: string | null; network_baseline: NetworkBaseline | null }>(
    `SELECT s.client_id, s.time_zone, s.network_baseline FROM sites s WHERE s.id = $1 AND s.removed_at IS NULL`, [siteId])).rows[0];
  if (!site) return null;
  const firewall = await sitePolicy(db, siteId);
  const zone_ = await siteTimeZone(db, siteId);
  const cabs = (await db.query<{ id: string; name: string; time_zone_id: string | null; firewall_profiles: { domain: boolean; private: boolean; public: boolean } | null }>(
    "SELECT id, name, time_zone_id, firewall_profiles FROM cabinets WHERE site_id = $1 AND status <> 'removed' ORDER BY name", [siteId])).rows;
  // The newest finished diagnosis of each cabinet (the adapters are cut out of the readings as JSON text).
  const read = (await db.query<{ cabinet_id: string; name: string; finished_at: Date; adapters: string | null }>(
    `SELECT cabinet_id, name, finished_at, adapters FROM (
       SELECT d.cabinet_id, k.name, d.finished_at, JSON_QUERY(d.readings, '$.adapters') AS adapters,
              ROW_NUMBER() OVER (PARTITION BY d.cabinet_id ORDER BY d.finished_at DESC) AS rn
         FROM diagnoses d JOIN cabinets k ON k.id = d.cabinet_id
        WHERE k.site_id = $1 AND k.status <> 'removed' AND d.kind = 'network' AND d.state = 'done' AND d.readings IS NOT NULL) x
      WHERE rn = 1`, [siteId])).rows
    .map(r => ({ r, baseline: baselineFrom(parseJson<unknown>(r.adapters)) })).filter(x => x.baseline !== null)
    .sort((a, b) => b.r.finished_at.getTime() - a.r.finished_at.getTime());
  const zone = mostCommon(cabs.filter(c => c.time_zone_id && (TIME_ZONES as readonly string[]).includes(c.time_zone_id)), c => c.time_zone_id!);
  const profiles = mostCommon(cabs.filter(c => c.firewall_profiles), c => JSON.stringify(c.firewall_profiles));
  const onOff = (b: boolean) => (b ? "on" : "off") as "on" | "off";
  return {
    // What the site sets itself, and what it follows when it sets nothing (its client's, else the fleet's).
    current: { networkBaseline: site.network_baseline, timeZone: site.time_zone, inheritedTimeZone: site.time_zone ? null : zone_.zone,
      siteFirewall: firewall.own, inheritedFirewall: firewall.client ?? firewall.fleet, inheritedFirewallFrom: firewall.client ? "client" as const : "fleet" as const },
    clientId: site.client_id,
    suggested: {
      networkBaseline: read[0] ? { baseline: read[0].baseline!, fromCabinet: { id: read[0].r.cabinet_id, name: read[0].r.name }, readAt: read[0].r.finished_at.toISOString() } : null,
      timeZone: zone ? { timeZone: zone.time_zone_id!, fromCabinet: { id: zone.id, name: zone.name } } : null,
      firewall: profiles ? { policy: { domain: onOff(profiles.firewall_profiles!.domain), private: onOff(profiles.firewall_profiles!.private), public: onOff(profiles.firewall_profiles!.public) },
        fromCabinet: { id: profiles.id, name: profiles.name } } : null,
    },
  };
}

// ---- Applying them (F6.R3, decision-log D37) ------------------------------------------------------------------------------------

export type StandardPart = "networkBaseline" | "timeZone" | "firewall";
export type StandardsSource = "suggested" | { siteId: string };
export interface ApplyResult { applied: StandardPart[]; skipped: { part: StandardPart; why: string }[] }

/**
 * Applies a site's standards in one action, instead of typing each one in (F6.R3): from what its own cabinets report (`suggested`), or
 * from another site's own settings (`{ siteId }`, a site set up the way the others should be). Each chosen part is written by the same
 * writer, with the same audit entry, as when it is set on its own, all in one transaction with the code that confirmed exactly this
 * request; a part with nothing to apply is skipped and the answer says why. The whole action is audited once as site.apply_standards.
 * Admin only (the firewall policy is), checked by the route.
 */
export async function applySiteStandards(pool: Pool, userId: string, siteId: string, from: StandardsSource, parts: StandardPart[], stepUpToken: string): Promise<ApplyResult> {
  return transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, userId, "site.apply_standards", siteId);
    let values: { networkBaseline: NetworkBaseline | null; timeZone: string | null; firewall: FirewallPolicy | null };
    let missing: string;
    if (from === "suggested") {
      const s = await siteStandards(c, siteId);
      if (!s) throw new Refused("not_found", 404, "no such site");
      values = { networkBaseline: s.suggested.networkBaseline?.baseline ?? null, timeZone: s.suggested.timeZone?.timeZone ?? null, firewall: s.suggested.firewall?.policy ?? null };
      missing = "none of this site's cabinets reports it yet";
    } else {
      if (from.siteId.toLowerCase() === siteId.toLowerCase()) throw new Refused("invalid_request", 400, "a site's standards are copied from another site");
      const src = (await c.query<{ network_baseline: NetworkBaseline | null; time_zone: string | null }>(
        "SELECT network_baseline, time_zone FROM sites WHERE id = $1 AND removed_at IS NULL", [from.siteId])).rows[0];
      if (!src) throw new Refused("not_found", 404, "no such site to copy from");
      values = { networkBaseline: src.network_baseline, timeZone: src.time_zone, firewall: (await sitePolicy(c, from.siteId)).own };
      missing = "the other site does not set it itself";
    }
    if (!(await c.query("SELECT 1 AS x FROM sites WITH (UPDLOCK, ROWLOCK) WHERE id = $1 AND removed_at IS NULL", [siteId])).rows[0]) throw new Refused("not_found", 404, "no such site");
    const result: ApplyResult = { applied: [], skipped: [] };
    for (const part of [...new Set(parts)]) {
      if (part === "networkBaseline" && values.networkBaseline) await writeNetworkBaseline(c, userId, siteId, values.networkBaseline);
      else if (part === "timeZone" && values.timeZone && (TIME_ZONES as readonly string[]).includes(values.timeZone)) await writeSiteTimeZone(c, userId, siteId, values.timeZone as TimeZoneId);
      else if (part === "firewall" && values.firewall) await writeSitePolicy(c, userId, siteId, values.firewall);
      else { result.skipped.push({ part, why: missing }); continue; }
      result.applied.push(part);
    }
    if (result.applied.length === 0) throw new Refused("nothing_to_apply", 409, "nothing to apply", { reason: `Nothing was applied: ${missing}.` });
    await audit(c, { actorKind: "user", actorId: userId, action: "site.apply_standards", targetKind: "site", targetId: siteId.toLowerCase(), outcome: "succeeded",
      details: { from: from === "suggested" ? "suggested" : { siteId: from.siteId.toLowerCase() }, applied: result.applied, skipped: result.skipped } });
    return result;
  });
}
