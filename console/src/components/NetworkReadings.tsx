// Everything a network diagnosis read from a cabinet, shown whether or not anything is wrong: each adapter's DHCP lease, packet size and
// card counters, the routes and the ARP table, the connectivity tests (with loss and jitter for pings) and the path traces. A cabinet
// that matches its baseline can still show a lease about to end, errors on the card, or a path that goes somewhere unexpected.
import type { ReactNode } from "react";
import { Badge, KeyValues } from "./ui";
import { fullTime } from "../lib/time";
import { Pager, usePaged } from "./Pager";

export interface AdapterReading {
  interfaceIndex: number; name: string; description: string | null; type: string; connected: boolean; linkSpeedBps: number | null; macAddress: string | null;
  ipv4: { dhcp: boolean; addresses: { address: string; prefixLength: number }[]; gateways: string[] }; ipv6Addresses?: string[]; dns: { automatic: boolean; servers: string[] }; dnsSuffix: string | null;
  details?: { dhcpServer: string | null; leaseObtained: string | null; leaseExpires: string | null; mtu: number | null;
    interfaceMetric?: number | null; adminStatus?: string | null; netbios?: string | null;
    driver?: { provider: string | null; version: string | null; date: string | null } | null;
    networkProfile?: { name: string | null; category: string } | null;
    statistics: { bytesReceived: number; bytesSent: number; receiveErrors: number; sendErrors: number; receiveDiscards: number; sendDiscards: number } | null };
}
export interface RouteReading { destination: string; prefixLength: number; nextHop: string; metric: number; interfaceIndex: number }
export interface NeighborReading { interfaceIndex: number; address: string; macAddress: string | null; state: string }
export interface PingStats { sent: number; received: number; lossPercent: number; minMs: number | null; avgMs: number | null; maxMs: number | null; jitterMs: number | null }
export interface TestReading { key: string; label: string; params: Record<string, unknown>; failure?: string;
  output?: { success: boolean; resolvedTarget: string | null; latencyMs: number | null; resolvedAddresses: string[]; error: string | null; statistics?: PingStats | null } }
export interface TraceReading { key: string; label: string; failure?: string; output?: { reached: boolean; resolvedTarget: string | null; error: string | null; hops: { hop: number; address: string | null; rttMs: (number | null)[] }[] } }
export interface Readings { takenAt: string; adapters: AdapterReading[]; routes: RouteReading[]; neighbors: NeighborReading[]; tests: TestReading[]; traces: TraceReading[] }

const mb = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`;
const count = (n: number) => n.toLocaleString("en-US");
const ms = (v: number | null) => v === null ? "no reply" : `${v} ms`;

const CATEGORY: Record<string, string> = { public: "Public", private: "Private", domain: "Domain" };

export function adapterRows(a: AdapterReading): [string, ReactNode][] {
  const d = a.details;
  const s = d?.statistics;
  const net = d?.networkProfile;
  const drv = d?.driver;
  return [
    ["Status", `${a.connected ? "Connected" : "Disconnected"}${d?.adminStatus && d.adminStatus !== "up" ? `, admin ${d.adminStatus}` : ""}`],
    ["Type", a.type === "wifi" ? "Wi-Fi" : a.type === "ethernet" ? "Ethernet" : "Other"], ["Description", a.description],
    ["Link speed", a.linkSpeedBps ? `${(a.linkSpeedBps / 1e6).toLocaleString()} Mbps` : null], ["MAC address", a.macAddress],
    ["Addressing", a.ipv4.dhcp ? "DHCP" : "Static"], ["IPv4", a.ipv4.addresses.map(x => `${x.address}/${x.prefixLength}`).join(", ") || null],
    ["Gateway", a.ipv4.gateways.join(", ") || "None"], ["DNS servers", `${a.dns.servers.join(", ") || "none"} (${a.dns.automatic ? "automatic" : "set by hand"})`], ["DNS suffix", a.dnsSuffix],
    ["IPv6", a.ipv6Addresses?.length ? a.ipv6Addresses.join(", ") : "none"],
    ...(d ? [
      ["Network profile", net ? `${net.name ?? "unnamed"} (${CATEGORY[net.category] ?? net.category})` : null],
      ["Interface metric", d.interfaceMetric ?? null],
      ["DHCP server", a.ipv4.dhcp ? d.dhcpServer : "Not used"],
      ["Lease obtained", a.ipv4.dhcp ? (d.leaseObtained ? fullTime(d.leaseObtained) : null) : "Not used"], ["Lease ends", a.ipv4.dhcp ? (d.leaseExpires ? fullTime(d.leaseExpires) : null) : "Not used"],
      ["MTU", d.mtu === null ? null : `${d.mtu}${d.mtu === 1500 ? "" : " (not 1500)"}`],
      ["NetBIOS over TCP/IP", d.netbios ?? null],
      ["Driver", drv ? [drv.provider, drv.version, drv.date ? drv.date.slice(0, 10) : null].filter(Boolean).join(" · ") || null : null],
      ["Traffic", s ? `${mb(s.bytesReceived)} in, ${mb(s.bytesSent)} out` : null],
      ["Card errors", s ? `${count(s.receiveErrors)} in, ${count(s.sendErrors)} out` : null],
      ["Dropped packets", s ? `${count(s.receiveDiscards)} in, ${count(s.sendDiscards)} out` : null],
    ] as [string, ReactNode][] : []),
  ];
}

/** The adapters as plain text in the order of `ipconfig /all`, for pasting into a ticket. */
export function ipconfigText(cabinet: string, adapters: AdapterReading[], proxy?: { winHttp: string | null } | null): string {
  const lines = [`${cabinet}: network configuration`, ""];
  for (const a of adapters) {
    lines.push(`${a.type === "wifi" ? "Wireless LAN adapter" : "Ethernet adapter"} ${a.name}:`);
    for (const [k, v] of adapterRows(a)) if (v !== null && v !== undefined && v !== "") lines.push(`   ${k.padEnd(22, ".")}: ${typeof v === "string" || typeof v === "number" ? v : ""}`);
    lines.push("");
  }
  if (proxy) lines.push(`WinHTTP proxy: ${proxy.winHttp ?? "direct access"}`);
  return lines.join("\n");
}

export function RoutesTable({ routes }: { routes: RouteReading[] }) {
  const paged = usePaged(routes);
  if (routes.length === 0) return <p className="muted small">No routes were reported.</p>;
  return (
    <div className="table-wrap"><table className="table compact">
      <caption className="sr-only">Routes</caption>
      <thead><tr><th scope="col">Destination</th><th scope="col">Via</th><th scope="col">Metric</th><th scope="col">Adapter</th></tr></thead>
      <tbody>{paged.rows.map((r, i) => <tr key={i}><th scope="row">{r.prefixLength === 0 && r.destination === "0.0.0.0" ? "Everything else (default)" : `${r.destination}/${r.prefixLength}`}</th><td>{r.nextHop === "0.0.0.0" ? "directly connected" : r.nextHop}</td><td>{r.metric}</td><td>{r.interfaceIndex}</td></tr>)}</tbody>
    </table><Pager {...paged} label="routes" /></div>
  );
}

export function NeighborsTable({ neighbors }: { neighbors: NeighborReading[] }) {
  const paged = usePaged(neighbors);
  if (neighbors.length === 0) return <p className="muted small">The ARP table was empty or not reported.</p>;
  return (
    <div className="table-wrap"><table className="table compact">
      <caption className="sr-only">ARP table</caption>
      <thead><tr><th scope="col">Address</th><th scope="col">Hardware address</th><th scope="col">State</th></tr></thead>
      <tbody>{paged.rows.map((n, i) => <tr key={i}><th scope="row">{n.address}</th><td>{n.macAddress ?? <span className="muted">none</span>}</td>
        <td><Badge tone={n.state === "reachable" ? "ok" : n.state === "stale" ? "off" : "warn"}>{n.state}</Badge></td></tr>)}</tbody>
    </table><Pager {...paged} label="ARP entries" /></div>
  );
}

export function PingSummary({ s }: { s: PingStats }) {
  return <span>{s.received} of {s.sent} replies{s.lossPercent > 0 && <> <Badge tone={s.lossPercent >= 20 ? "crit" : "warn"}>{s.lossPercent}% lost</Badge></>}
    {s.avgMs !== null && <>, {s.minMs} to {s.maxMs} ms, average {s.avgMs} ms, jitter {s.jitterMs} ms</>}</span>;
}

export function TraceTable({ t }: { t: NonNullable<TraceReading["output"]> }) {
  return (
    <div className="table-wrap"><table className="table compact">
      <caption className="sr-only">Path to {t.resolvedTarget ?? "the target"}</caption>
      <thead><tr><th scope="col">Hop</th><th scope="col">Answered by</th><th scope="col">Round trips</th></tr></thead>
      <tbody>{t.hops.map(h => <tr key={h.hop}><th scope="row">{h.hop}</th><td>{h.address ?? <span className="muted">no reply</span>}</td><td>{h.rttMs.map(ms).join(", ")}</td></tr>)}</tbody>
    </table>
    <p className="small">{t.reached ? <Badge tone="ok">Reached {t.resolvedTarget}</Badge> : <Badge tone="warn">Did not reach {t.resolvedTarget ?? "the target"}</Badge>}{t.error && <span className="muted"> {t.error}</span>}</p></div>
  );
}

/** The full read of one diagnosis. */
export function ReadingsView({ readings }: { readings: Readings }) {
  return (
    <div className="stack readings">
      <p className="muted small">Read {fullTime(readings.takenAt)}.</p>
      <div className="cards">{readings.adapters.map(a => (
        <article key={a.interfaceIndex} className="card" aria-label={`Adapter ${a.name}`}>
          <h3>{a.name} <Badge tone={a.connected ? "ok" : "off"}>{a.connected ? "Connected" : "Disconnected"}</Badge></h3>
          <KeyValues rows={adapterRows(a)} />
        </article>))}</div>
      <h3>Tests</h3>
      <ul className="plain">{readings.tests.map(t => (
        <li key={t.key}><strong>{t.label}:</strong> {!t.output ? <span className="muted">no result ({t.failure ?? "no answer"})</span>
          : <>{t.output.success ? <Badge tone="ok">Reached</Badge> : <Badge tone="crit">Failed</Badge>}{" "}{t.output.resolvedTarget && <code>{t.output.resolvedTarget}</code>}
            {t.output.statistics ? <> <PingSummary s={t.output.statistics} /></> : t.output.latencyMs !== null && ` in ${t.output.latencyMs} ms`}
            {t.output.error && <span className="muted"> {t.output.error}</span>}</>}</li>))}</ul>
      {readings.traces.length > 0 && <><h3>Paths</h3>{readings.traces.map(t => (
        <div key={t.key}><h4>{t.label}</h4>{t.output ? <TraceTable t={t.output} /> : <p className="muted small">Not traced: {t.failure ?? "no answer"}</p>}</div>))}</>}
      <h3>Routes</h3><RoutesTable routes={readings.routes} />
      <h3>ARP table</h3><NeighborsTable neighbors={readings.neighbors} />
    </div>
  );
}
