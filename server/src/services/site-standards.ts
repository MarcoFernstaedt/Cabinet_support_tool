// What a site's standards could be, worked out from what its cabinets already report, so onboarding is "use what this cabinet has"
// instead of typing it all in. This only suggests; nothing is saved here. Saving goes through the same step-up routes as any other
// edit (site.network_baseline, site time zone, client firewall policy).
import { type Queryable } from "../db/db.js";
import type { NetworkBaseline } from "../diagnose/network-findings.js";
import { fleetPolicy, type FirewallPolicy } from "./firewall-policy.js";
import { TIME_ZONES } from "./time.js";

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
  const site = (await db.query<{ client_id: string; time_zone: string | null; network_baseline: NetworkBaseline | null; client_policy: unknown }>(
    `SELECT s.client_id, s.time_zone, s.network_baseline, c.firewall_policy AS client_policy FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = $1 AND s.removed_at IS NULL`, [siteId])).rows[0];
  if (!site) return null;
  const cabs = (await db.query<{ id: string; name: string; time_zone_id: string | null; firewall_profiles: { domain: boolean; private: boolean; public: boolean } | null }>(
    "SELECT id, name, time_zone_id, firewall_profiles FROM cabinets WHERE site_id = $1 AND status <> 'removed' ORDER BY name", [siteId])).rows;
  const read = (await db.query<{ cabinet_id: string; name: string; finished_at: Date; adapters: unknown }>(
    `SELECT DISTINCT ON (d.cabinet_id) d.cabinet_id, k.name, d.finished_at, d.readings->'adapters' AS adapters
       FROM diagnoses d JOIN cabinets k ON k.id = d.cabinet_id
      WHERE k.site_id = $1 AND k.status <> 'removed' AND d.state = 'done' AND d.readings IS NOT NULL
      ORDER BY d.cabinet_id, d.finished_at DESC`, [siteId])).rows
    .map(r => ({ r, baseline: baselineFrom(r.adapters) })).filter(x => x.baseline !== null)
    .sort((a, b) => b.r.finished_at.getTime() - a.r.finished_at.getTime());
  const zone = mostCommon(cabs.filter(c => c.time_zone_id && (TIME_ZONES as readonly string[]).includes(c.time_zone_id)), c => c.time_zone_id!);
  const profiles = mostCommon(cabs.filter(c => c.firewall_profiles), c => JSON.stringify(c.firewall_profiles));
  const onOff = (b: boolean) => (b ? "on" : "off") as "on" | "off";
  const own = site.client_policy as FirewallPolicy | null;
  return {
    current: { networkBaseline: site.network_baseline, timeZone: site.time_zone, clientFirewall: own, fleetFirewall: await fleetPolicy(db) },
    clientId: site.client_id,
    suggested: {
      networkBaseline: read[0] ? { baseline: read[0].baseline!, fromCabinet: { id: read[0].r.cabinet_id, name: read[0].r.name }, readAt: read[0].r.finished_at.toISOString() } : null,
      timeZone: zone ? { timeZone: zone.time_zone_id!, fromCabinet: { id: zone.id, name: zone.name } } : null,
      firewall: profiles ? { policy: { domain: onOff(profiles.firewall_profiles!.domain), private: onOff(profiles.firewall_profiles!.private), public: onOff(profiles.firewall_profiles!.public) },
        fromCabinet: { id: profiles.id, name: profiles.name } } : null,
    },
  };
}
