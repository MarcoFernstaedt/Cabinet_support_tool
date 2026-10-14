// Two cabinets side by side: where a working one and a failing one differ. Every difference is a plain field comparison of the agent's own readings.
import type { DriversListOutput, FirewallStateOutput, NetworkConfigOutput, ServicesListOutput, SystemInfoOutput, UpdatesStatusOutput } from "@mashura/cabinet-contracts/types";

export interface Reading {
  info?: SystemInfoOutput; net?: NetworkConfigOutput; services?: ServicesListOutput; firewall?: FirewallStateOutput; drivers?: DriversListOutput; updates?: UpdatesStatusOutput;
}
export interface Difference { area: string; what: string; a: string; b: string }

export const MAX_DIFFERENCES = 200;
const MAX = MAX_DIFFERENCES;
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : Array.isArray(v) ? (v.length ? v.join(", ") : "none") : String(v));

function pair(out: Difference[], area: string, what: string, a: unknown, b: unknown) {
  if (show(a) !== show(b) && out.length < MAX) out.push({ area, what, a: show(a), b: show(b) });
}

export function compareReadings(x: Reading, y: Reading): Difference[] {
  const out: Difference[] = [];
  if (x.info && y.info) {
    pair(out, "System", "Windows", x.info.osVersion, y.info.osVersion);
    pair(out, "System", "Build", x.info.osBuild, y.info.osBuild);
    pair(out, "System", "Agent", x.info.agentVersion, y.info.agentVersion);
  }
  // Pair the connected adapters by name, then by type, so a cabinet with two adapters is not compared against the wrong one.
  const ax = x.net?.adapters.find(a => a.connected);
  const ay = y.net?.adapters.find(a => a.connected && a.name === ax?.name) ?? y.net?.adapters.find(a => a.connected && a.type === ax?.type) ?? y.net?.adapters.find(a => a.connected);
  if (ax && ay) {
    pair(out, "Network", "Adapter type", ax.type, ay.type);
    pair(out, "Network", "Link speed (Mbps)", ax.linkSpeedBps ? ax.linkSpeedBps / 1e6 : null, ay.linkSpeedBps ? ay.linkSpeedBps / 1e6 : null);
    pair(out, "Network", "Addressing", ax.ipv4.dhcp ? "DHCP" : "Static", ay.ipv4.dhcp ? "DHCP" : "Static");
    pair(out, "Network", "Gateway", ax.ipv4.gateways, ay.ipv4.gateways);
    pair(out, "Network", "DNS servers", ax.dns.servers, ay.dns.servers);
    pair(out, "Network", "DNS", ax.dns.automatic ? "automatic" : "set by hand", ay.dns.automatic ? "automatic" : "set by hand");
    pair(out, "Network", "DNS suffix", ax.dnsSuffix, ay.dnsSuffix);
    pair(out, "Network", "Prefix length", ax.ipv4.addresses[0]?.prefixLength, ay.ipv4.addresses[0]?.prefixLength);
    const dx = ax.details, dy = ay.details;
    pair(out, "Network", "MTU", dx?.mtu, dy?.mtu);
    pair(out, "Network", "Interface metric", dx?.interfaceMetric, dy?.interfaceMetric);
    pair(out, "Network", "Network profile", dx?.networkProfile?.category, dy?.networkProfile?.category);
    pair(out, "Network", "NetBIOS", dx?.netbios, dy?.netbios);
    pair(out, "Network", "Adapter driver", dx?.driver?.version, dy?.driver?.version);
    pair(out, "Network", "Wi-Fi signal (dBm)", dx?.wifi?.signalDbm, dy?.wifi?.signalDbm);
    pair(out, "Network", "Card errors", dx?.statistics ? dx.statistics.receiveErrors + dx.statistics.sendErrors : null, dy?.statistics ? dy.statistics.receiveErrors + dy.statistics.sendErrors : null);
  }
  if (x.net && y.net) pair(out, "Network", "WinHTTP proxy", x.net.proxy?.winHttp ?? "direct", y.net.proxy?.winHttp ?? "direct");
  if (x.firewall && y.firewall) {
    for (const p of x.firewall.profiles) {
      const q = y.firewall.profiles.find(r => r.profile === p.profile);
      if (q) { pair(out, "Firewall", `${p.profile} profile`, p.enabled ? "on" : "off", q.enabled ? "on" : "off"); pair(out, "Firewall", `${p.profile} default inbound`, p.defaultInbound, q.defaultInbound); }
    }
    // Rule names can repeat in Windows: the second one with a name gets a number so neither is lost.
    const keyed = (rules: FirewallStateOutput["rules"]) => { const seen = new Map<string, number>(); return new Map(rules.map(r => { const base = `${r.direction}|${r.name}`, n = seen.get(base) ?? 0; seen.set(base, n + 1); return [n ? `${base}#${n}` : base, r] as const; })); };
    const rx = keyed(x.firewall.rules), ry = keyed(y.firewall.rules);
    for (const [k, r] of rx) {
      const o = ry.get(k);
      if (!o) pair(out, "Firewall", `Rule ${r.name}`, `${r.action} ${r.enabled ? "enabled" : "disabled"}`, "missing");
      else pair(out, "Firewall", `Rule ${r.name}`, `${r.action} ${r.enabled ? "enabled" : "disabled"} ${r.localPorts ?? ""}`.trim(), `${o.action} ${o.enabled ? "enabled" : "disabled"} ${o.localPorts ?? ""}`.trim());
    }
    for (const [k, r] of ry) if (!rx.has(k)) pair(out, "Firewall", `Rule ${r.name}`, "missing", `${r.action} ${r.enabled ? "enabled" : "disabled"}`);
  }
  if (x.services && y.services) {
    const sy = new Map(y.services.services.map(s => [s.name, s]));
    for (const s of x.services.services) {
      const o = sy.get(s.name);
      if (!o) pair(out, "Services", s.displayName, `${s.state}, ${s.startType}`, "not installed");
      else pair(out, "Services", s.displayName, `${s.state}, ${s.startType}`, `${o.state}, ${o.startType}`);
    }
    const sx = new Set(x.services.services.map(s => s.name));
    for (const s of y.services.services) if (!sx.has(s.name)) pair(out, "Services", s.displayName, "not installed", `${s.state}, ${s.startType}`);
  }
  if (x.drivers && y.drivers) {
    // One driver can have several published packages (oem1.inf, oem5.inf): the version shown is the newest of them.
    const key = (d: DriversListOutput["drivers"][number]) => `${d.provider ?? ""}|${d.originalName ?? d.publishedName}`;
    const newest = (list: DriversListOutput["drivers"]) => { const m = new Map<string, DriversListOutput["drivers"][number]>(); for (const d of list) { const o = m.get(key(d)); if (!o || (d.date ?? "") > (o.date ?? "")) m.set(key(d), d); } return m; };
    const dy = newest(y.drivers.drivers);
    const dxm = newest(x.drivers.drivers);
    for (const d of dxm.values()) {
      const o = dy.get(key(d));
      pair(out, "Drivers", `${d.provider ?? "?"} ${d.originalName ?? d.publishedName}`, d.version, o ? o.version : "not installed");
    }
    for (const d of dy.values()) if (!dxm.has(key(d))) pair(out, "Drivers", `${d.provider ?? "?"} ${d.originalName ?? d.publishedName}`, "not installed", d.version);
  }
  if (x.updates && y.updates) {
    const kx = new Set(x.updates.installed.filter(u => u.kb).map(u => u.kb!)), ky = new Set(y.updates.installed.filter(u => u.kb).map(u => u.kb!));
    for (const k of kx) if (!ky.has(k)) pair(out, "Updates", k, "installed", "not installed");
    for (const k of ky) if (!kx.has(k)) pair(out, "Updates", k, "not installed", "installed");
  }
  return out;
}
