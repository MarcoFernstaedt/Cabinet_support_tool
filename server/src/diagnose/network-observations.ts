// What the full network read says even when everything matches its baseline (docs/spec/14-network-troubleshooting.md): the DHCP lease,
// the size limit, errors on the network card, packet loss and delay to the gateway, the route to the sync cabinet and the platform,
// and what the ARP table says about the gateway. Nothing here is a verdict: each line states what was read and why it may matter, and
// an observation that needs a person at the site says so. Pure; no regular expressions.
import type { NetworkTraceOutput } from "@mashura/cabinet-contracts/types";
import type { Finding, NetworkEvidence, TestRun } from "./network-findings.js";

export interface TraceRun { key: string; label: string; params: Record<string, unknown>; output?: NetworkTraceOutput; failure?: string }
type Add = (x: Omit<Finding, "layer">) => void;

const HOUR = 3_600_000;
const span = (ms: number) => ms < 0 ? "already over" : ms < HOUR ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 48 * HOUR ? `${Math.round(ms / HOUR)} h` : `${Math.round(ms / (24 * HOUR))} days`;
const count = (n: number) => n.toLocaleString("en-US");
const hopText = (t: NetworkTraceOutput) => t.hops.map(h => {
  const rtts = h.rttMs.filter((x): x is number => x !== null);
  return `${h.hop}. ${h.address ?? "no reply"}${rtts.length ? ` (${rtts.map(x => `${x} ms`).join(", ")})` : ""}`;
});

export function observations(e: NetworkEvidence, traces: readonly TraceRun[], add: Add, now = Date.now()): void {
  const connected = e.config?.adapters.filter(a => a.connected && a.type !== "other") ?? [];

  for (const a of connected) {
    const d = a.details;
    if (!d) continue;
    const dhcp = a.ipv4.dhcp;
    if (dhcp && d.dhcpServer) {
      const parsed = d.leaseExpires ? new Date(d.leaseExpires).getTime() : null;
      const ends = parsed !== null && Number.isFinite(parsed) ? parsed : null;
      const evidence = [`${a.name} got its address from the DHCP server ${d.dhcpServer}.`,
        ...(d.leaseObtained ? [`Lease obtained ${d.leaseObtained}.`] : []), ...(ends !== null ? [`Lease ends ${d.leaseExpires} (${span(ends - now)}${ends < now ? "" : " from now"}).`] : [])];
      if (ends !== null && ends < now)
        add({ id: `obs-lease-${a.interfaceIndex}`, severity: "warning", certainty: "confirmed", title: `The DHCP lease on ${a.name} has run out`, evidence, fix: "The lease should have been renewed. Check that the DHCP server still answers (see the gateway and DNS results), then renew the lease." });
      else if (ends !== null && ends - now < 2 * HOUR)
        add({ id: `obs-lease-${a.interfaceIndex}`, severity: "info", certainty: "confirmed", title: `The DHCP lease on ${a.name} ends in ${span(ends - now)}`, evidence, fix: "Normal if the cabinet renews it halfway through. If it does not and the lease is not extended, the DHCP server is not answering renewals." });
      else add({ id: `obs-dhcp-${a.interfaceIndex}`, severity: "ok", certainty: "confirmed", title: `${a.name} has a DHCP lease from ${d.dhcpServer}`, evidence, fix: null });
    }
    if (d.mtu !== null && d.mtu !== 1500)
      add({ id: `obs-mtu-${a.interfaceIndex}`, severity: "info", certainty: "confirmed", title: `${a.name} uses a packet size of ${d.mtu}, not the usual 1500`,
        evidence: [`The maximum packet size on ${a.name} is ${d.mtu} bytes.`], fix: d.mtu < 1500 ? "A smaller size is set on purpose by some VPNs and tunnels. If large transfers stall while small ones work, this is worth a look." : "A larger size (jumbo frames) only works if every switch on the path allows it." });
    const s = d.statistics;
    if (s && (s.receiveErrors > 0 || s.sendErrors > 0))
      add({ id: `obs-errors-${a.interfaceIndex}`, severity: s.receiveErrors + s.sendErrors > 100 ? "warning" : "info", certainty: "probable",
        title: `${a.name} has counted ${count(s.receiveErrors + s.sendErrors)} packet errors since Windows started`,
        evidence: [`Receive errors ${count(s.receiveErrors)}, send errors ${count(s.sendErrors)}, discarded in ${count(s.receiveDiscards)}, discarded out ${count(s.sendDiscards)}.`],
        fix: "Errors on the card itself point at the cable, the switch port or the card. Swap the patch cable first, then try another port. The counters start at zero when Windows starts, so run this again after a change to see if they grow." });
    else if (s && s.receiveDiscards + s.sendDiscards > 1000)
      add({ id: `obs-errors-${a.interfaceIndex}`, severity: "info", certainty: "possible", title: `${a.name} has dropped ${count(s.receiveDiscards + s.sendDiscards)} packets since Windows started`,
        evidence: [`Discarded in ${count(s.receiveDiscards)}, out ${count(s.sendDiscards)}; no errors.`], fix: "Usually the network is busy or the cabinet was slow to keep up. Worth a look only if it keeps growing." });
  }

  // The gateway, pinged several times: loss and delay on a local link are never normal.
  const gw = e.tests.find(t => t.key === "gateway");
  const st = gw?.output?.statistics;
  if (gw && st) {
    const text = `${st.received} of ${st.sent} replies${st.avgMs !== null ? `, ${st.minMs} to ${st.maxMs} ms (average ${st.avgMs} ms, jitter ${st.jitterMs} ms)` : ""}.`;
    if (st.lossPercent > 0 && st.received > 0)
      add({ id: "obs-ping-loss", severity: st.lossPercent >= 20 ? "problem" : "warning", certainty: "confirmed", title: `Packet loss to the gateway: ${st.lossPercent}%`, evidence: [text],
        fix: "Lost packets on a link this short mean a bad cable, a failing port or a duplex mismatch. Swap the patch cable, then the switch port. Look at the card's error counts above." });
    else if (st.avgMs !== null && st.avgMs > 20)
      add({ id: "obs-ping-slow", severity: "warning", certainty: "probable", title: `The gateway is slow to answer: ${st.avgMs} ms`, evidence: [text],
        fix: "A gateway on the same network answers in a millisecond or two. Slow answers mean a busy or overloaded switch, or a link running at a low speed." });
    else if (st.jitterMs !== null && st.jitterMs > 10)
      add({ id: "obs-ping-jitter", severity: "info", certainty: "possible", title: `The gateway's answer times jump around (jitter ${st.jitterMs} ms)`, evidence: [text], fix: "Uneven times can mean a busy network. Worth a look if users report intermittent slowness." });
    else if (st.received > 0) add({ id: "obs-ping-ok", severity: "ok", certainty: "confirmed", title: "The gateway answers every request, quickly", evidence: [text], fix: null });
  }

  // What the ARP table says about the gateway: an entry that never completes is a problem below the IP layer.
  const gateway = connected.flatMap(a => a.ipv4.gateways)[0];
  const arp = gateway ? e.config?.neighbors?.find(n => n.address === gateway) : undefined;
  if (gateway && e.config?.neighbors) {
    if (arp && (arp.state === "incomplete" || arp.state === "unreachable"))
      add({ id: "obs-arp", severity: "warning", certainty: "probable", title: `The gateway ${gateway} does not answer ARP`, evidence: [`The ARP table lists ${gateway} as ${arp.state} with no hardware address.`],
        fix: "The cabinet cannot find the gateway on the local network, a problem below IP. Check the cable, the switch port and that the port is on the right VLAN." });
    else if (arp?.macAddress)
      add({ id: "obs-arp-ok", severity: "ok", certainty: "confirmed", title: `The gateway ${gateway} is ${arp.macAddress} on the local network`, evidence: [`ARP state: ${arp.state}.`], fix: null });
  }

  // Routes: more than one default route decides which adapter carries the traffic.
  const defaults = e.config?.routes?.filter(r => r.prefixLength === 0 && r.destination === "0.0.0.0") ?? [];
  if (defaults.length > 1)
    add({ id: "obs-routes", severity: "info", certainty: "confirmed", title: `${defaults.length} default routes`, evidence: defaults.map(r => `Via ${r.nextHop} on adapter ${r.interfaceIndex}, metric ${r.metric}`),
      fix: "With more than one default route the lowest metric wins. If a second adapter (Wi-Fi, a VPN) is up, traffic may leave by the wrong one." });

  // The paths: where along the way replies stop, or how many routers are crossed.
  for (const t of traces) {
    const where = t.key === "trace-sync" ? "sync" : "platform";
    const what = where === "sync" ? "the sync cabinet" : "the platform server";
    if (!t.output) { add({ id: `obs-trace-${where}`, severity: "info", certainty: "not_checked", title: `Could not trace the path to ${what}`, evidence: [t.failure ?? "No answer."], fix: null }); continue; }
    const o = t.output;
    if (o.reached) {
      const routers = o.hops.length - 1;
      add({ id: `obs-trace-${where}`, severity: "ok", certainty: "confirmed", title: `The path to ${what} is ${o.hops.length} hop${o.hops.length === 1 ? "" : "s"}${routers === 0 ? ", on the same network" : `, through ${routers} router${routers === 1 ? "" : "s"}`}`,
        evidence: hopText(o), fix: where === "sync" && routers > 0 ? "A sync cabinet is normally on the same network. Traffic that crosses a router can be blocked or slowed by it." : null });
    } else {
      const last = [...o.hops].reverse().find(h => h.address !== null);
      add({ id: `obs-trace-${where}`, severity: where === "sync" ? "warning" : "info", certainty: "probable", title: `The path to ${what} stops${last ? ` after ${last.address}` : " at the first hop"}`,
        evidence: [...hopText(o), ...(o.error ? [o.error] : [])],
        fix: last ? `Replies stop beyond ${last.address}. Look at what is next after it: its firewall, its route, or a link that is down.${where === "platform" ? " Many networks block these probes on purpose, so this alone is not a fault." : ""}` : "Nothing answers from the first hop: check the gateway and the link." });
    }
  }
}

export type { TestRun };
