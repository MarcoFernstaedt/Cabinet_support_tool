// The simulated cabinets' network (docs/platform/demo.md). Each simulated cabinet keeps its own network settings, so a fix made
// through the console (renew DHCP, set the DNS servers, set a fixed address) changes what the next check sees, exactly as on
// a real cabinet. What the checks find comes from comparing those settings with the site's real network, which the baseline
// describes: a cabinet can only reach the gateway if its address is on the site's network and its gateway is the site's router.
import { sameSubnet, type NetworkBaseline } from "../diagnose/network-findings.js";
import type { Scenario } from "./fleet.js";

export interface DemoNet {
  linkUp: boolean; speedBps: number;
  mode: "dhcp" | "static"; address: string; prefixLength: number; gateway: string | null;
  dnsAutomatic: boolean; dns: string[];
}

export const NET_SCENARIOS: readonly Scenario[] = ["dns_errors", "net_dns_wrong", "net_static_wrong", "net_dhcp_failed", "net_gateway_wrong", "net_link_slow"];
export const baselineFor = (subnet: string, addressing: "dhcp" | "static" = "dhcp"): NetworkBaseline =>
  ({ addressing, prefixLength: 24, gateway: `${subnet}.1`, dnsServers: [`${subnet}.10`, `${subnet}.11`] });

/** The address a cabinet at this site normally has. */
export const normalAddress = (subnet: string, index: number) => `${subnet}.${20 + index}`;

export function initialNet(scenario: Scenario, b: NetworkBaseline, subnet: string, index: number): DemoNet {
  const net: DemoNet = { linkUp: true, speedBps: 1_000_000_000, mode: b.addressing, address: normalAddress(subnet, index), prefixLength: b.prefixLength, gateway: b.gateway,
    dnsAutomatic: b.addressing === "dhcp", dns: [...b.dnsServers] };
  switch (scenario) {
    case "dns_errors": return { ...net, dnsAutomatic: false, dns: [b.dnsServers[0]!, "10.255.255.254"] };
    case "net_dns_wrong": return { ...net, dnsAutomatic: false, dns: ["10.1.1.5", "10.1.1.6"] };
    // Set by hand long ago on another network, and never changed back.
    case "net_static_wrong": return { ...net, mode: "static", address: `192.168.1.${50 + index}`, prefixLength: 24, gateway: "192.168.1.1", dnsAutomatic: false, dns: [...b.dnsServers] };
    // The adapter never got a lease: Windows gave itself a 169.254 address.
    case "net_dhcp_failed": return { ...net, mode: "dhcp", address: `169.254.${10 + index}.${200 + index}`, prefixLength: 16, gateway: null, dnsAutomatic: true, dns: [] };
    case "net_gateway_wrong": return { ...net, mode: "static", gateway: `${subnet}.254` };
    case "net_link_slow": return { ...net, speedBps: 100_000_000 };
    default: return net;
  }
}

/** Whether the cabinet can talk to the rest of its site's network at all. */
export function reachesGateway(n: DemoNet, b: NetworkBaseline): boolean {
  return n.linkUp && n.gateway !== null && n.gateway === b.gateway && sameSubnet(n.address, b.gateway, b.prefixLength);
}
export const dnsAnswers = (n: DemoNet, b: NetworkBaseline, server: string | undefined) => server !== undefined && reachesGateway(n, b) && b.dnsServers.includes(server);

/** What differs from the baseline, in the words the platform's own check uses (so the demo's alert matches what a diagnosis finds). */
export function netProblems(n: DemoNet, b: NetworkBaseline): string[] {
  const out: string[] = [];
  if (!sameSubnet(n.address, b.gateway, b.prefixLength)) out.push("has an address outside the site's network");
  else if (b.addressing === "dhcp" && n.mode === "static") out.push("has a fixed address, but this site uses DHCP");
  else if (n.gateway !== null && n.gateway !== b.gateway) out.push("uses the wrong gateway");
  if (n.dns.length > 0 && [...n.dns].sort().join() !== [...b.dnsServers].sort().join()) out.push("uses DNS servers that are not the site's");
  return out;
}

/** The change network.setIp makes. */
export function applySetIp(n: DemoNet, b: NetworkBaseline, subnet: string, index: number, p: { mode: string; address?: string; prefixLength?: number; gateway?: string }): DemoNet {
  if (p.mode === "dhcp") {
    const next: DemoNet = { ...n, mode: "dhcp", address: `${subnet}.${100 + index}`, prefixLength: b.prefixLength, gateway: b.gateway };
    return n.dnsAutomatic ? { ...next, dns: [...b.dnsServers] } : next;
  }
  return { ...n, mode: "static", address: p.address!, prefixLength: p.prefixLength!, gateway: p.gateway! };
}
/** The change network.setDns makes. */
export function applySetDns(n: DemoNet, b: NetworkBaseline, p: { mode: string; servers?: string[] }): DemoNet {
  return p.mode === "automatic" ? { ...n, dnsAutomatic: true, dns: [...b.dnsServers] } : { ...n, dnsAutomatic: false, dns: [...p.servers!] };
}
