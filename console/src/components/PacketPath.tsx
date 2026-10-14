// Packets and path: the route to one target hop by hop with loss and round trips per hop, and a 20-request ping series to the same
// target with min, average, max, jitter and loss. Both are fixed reads the agent already offers; this puts them side by side.
import { useState } from "react";
import type { NetworkTestOutput, NetworkTraceOutput } from "@mashura/cabinet-contracts/types";
import { useRunner } from "../lib/commands";
import { Badge } from "./ui";

interface Target { key: string; label: string; trace: Record<string, unknown>; ping: Record<string, unknown> | null }
type Reading = { trace: NetworkTraceOutput | null; ping: NetworkTestOutput | null; problem: string | null };

export const targetsFor = (dnsCount: number): Target[] => [
  { key: "gateway", label: "Gateway", trace: { target: "gateway" }, ping: { target: "gateway", method: "ping", count: 20 } },
  ...Array.from({ length: Math.max(dnsCount, 1) }, (_, i) => ({ key: `dns${i}`, label: `DNS server ${i + 1}`, trace: { target: "dns_server", dnsServerIndex: i }, ping: { target: "dns_server", method: "ping", dnsServerIndex: i, count: 20 } })),
  { key: "sync", label: "Sync cabinet", trace: { target: "sync_cabinet" }, ping: { target: "sync_cabinet", method: "ping", count: 20 } },
  { key: "platform", label: "Platform server", trace: { target: "platform_server" }, ping: null },
];

const avg = (v: (number | null)[]) => { const a = v.filter((x): x is number => x !== null); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; };

/** Per-hop loss and a flag where the path degrades: any lost probe, or an average more than doubling and at least 20 ms above the last good hop. */
export function analyseHops(hops: NetworkTraceOutput["hops"]) {
  let last: number | null = null;
  return hops.map(h => {
    const lost = h.rttMs.filter(x => x === null).length, a = avg(h.rttMs as (number | null)[]);
    const jump = a !== null && last !== null && a > last * 2 && a - last >= 20;
    if (a !== null) last = a;
    return { hop: h.hop, address: h.address, rtt: h.rttMs as (number | null)[], lossPercent: Math.round(100 * lost / Math.max(1, h.rttMs.length)), avg: a, flag: lost > 0 ? "loss" : jump ? "latency" : null };
  });
}

export function PacketPath({ cabinetId, dnsCount }: { cabinetId: string; dnsCount: number }) {
  const run = useRunner();
  const targets = targetsFor(dnsCount);
  const [key, setKey] = useState("gateway");
  const [busy, setBusy] = useState(false);
  const [readings, setReadings] = useState<Record<string, Reading>>({});
  const probe = async (t: Target) => {
    const [trace, ping] = await Promise.allSettled([run<NetworkTraceOutput>(cabinetId, "network.trace", t.trace), t.ping ? run<NetworkTestOutput>(cabinetId, "network.test", t.ping) : Promise.resolve(null)]);
    const ok = <T,>(r: PromiseSettledResult<{ status: string; output?: T } | null>) => (r.status === "fulfilled" && r.value?.status === "succeeded" ? r.value.output ?? null : null);
    const failed = trace.status === "rejected" ? trace.reason : null;
    setReadings(r => ({ ...r, [t.key]: { trace: ok<NetworkTraceOutput>(trace as never), ping: ok<NetworkTestOutput>(ping as never), problem: failed ? String(failed instanceof Error ? failed.message : failed) : null } }));
  };
  const start = async (list: Target[]) => { setBusy(true); try { for (const t of list) await probe(t); } finally { setBusy(false); } };
  const current = targets.find(t => t.key === key) ?? targets[0]!;
  const reading = readings[current.key];
  return (
    <section className="panel" aria-labelledby="packets-heading" data-tour="packet-path">
      <div className="panel-head">
        <h2 id="packets-heading">Packets and path</h2>
        <div className="row gap wrap">
          <label className="sr-only" htmlFor="packet-target">Target</label>
          <select id="packet-target" value={current.key} onChange={e => setKey(e.target.value)}>{targets.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select>
          <button className="btn primary" disabled={busy} onClick={() => void start([current])}>{busy ? "Running…" : "Trace and ping"}</button>
          <button className="btn" disabled={busy} onClick={() => void start(targets)}>All targets</button>
        </div>
      </div>
      <table className="table compact">
        <caption className="sr-only">Last result per target</caption>
        <thead><tr><th scope="col">Target</th><th scope="col">Loss</th><th scope="col">Min</th><th scope="col">Avg</th><th scope="col">Max</th><th scope="col">Jitter</th><th scope="col">Hops</th><th scope="col">Path</th></tr></thead>
        <tbody>{targets.map(t => {
          const r = readings[t.key], s = r?.ping?.statistics, hops = r?.trace ? analyseHops(r.trace.hops) : null, flagged = hops?.find(h => h.flag);
          return (
            <tr key={t.key} aria-current={t.key === current.key ? "true" : undefined}>
              <th scope="row"><button className="linkish" onClick={() => setKey(t.key)}>{t.label}</button></th>
              <td>{s ? <Badge tone={s.lossPercent === 0 ? "ok" : s.lossPercent >= 20 ? "crit" : "warn"}>{s.lossPercent}%</Badge> : "—"}</td>
              <td>{s?.minMs ?? "—"}</td><td>{s?.avgMs ?? "—"}</td><td>{s?.maxMs ?? "—"}</td><td>{s?.jitterMs ?? "—"}</td>
              <td>{r?.trace ? r.trace.hops.length : "—"}</td>
              <td>{!r ? "—" : !r.trace ? <Badge tone="off">No trace</Badge> : !r.trace.reached ? <Badge tone="crit">{flagged ? `Stops after hop ${Math.max(0, ...r.trace.hops.filter(h => h.address).map(h => h.hop))}` : "Not reached"}</Badge> : flagged ? <Badge tone="warn">{flagged.flag === "loss" ? "Loss" : "Latency"} at hop {flagged.hop}</Badge> : <Badge tone="ok">Clean</Badge>}</td>
            </tr>);
        })}</tbody>
      </table>
      {reading?.problem && <p className="error" role="alert">{reading.problem}</p>}
      {reading?.trace && <HopTable trace={reading.trace} />}
    </section>
  );
}

function HopTable({ trace }: { trace: NetworkTraceOutput }) {
  const hops = analyseHops(trace.hops), max = Math.max(1, ...hops.map(h => Math.max(0, ...h.rtt.map(x => x ?? 0))));
  return (
    <div className="table-wrap"><table className="table compact">
      <caption>{trace.target} → {trace.resolvedTarget ?? "unresolved"}{trace.error ? ` · ${trace.error}` : ""}</caption>
      <thead><tr><th scope="col">Hop</th><th scope="col">Address</th><th scope="col">Probe 1</th><th scope="col">Probe 2</th><th scope="col">Probe 3</th><th scope="col">Loss</th><th scope="col">Avg ms</th><th scope="col"><span className="sr-only">Round trip</span></th></tr></thead>
      <tbody>{hops.map(h => (
        <tr key={h.hop} className={h.flag ? "warn" : undefined}>
          <th scope="row">{h.hop}</th><td>{h.address ?? <span className="muted">*</span>}</td>
          {[0, 1, 2].map(i => <td key={i}>{h.rtt[i] == null ? <span className="muted">*</span> : h.rtt[i]}</td>)}
          <td>{h.lossPercent}%</td><td>{h.avg === null ? "—" : h.avg.toFixed(1)}</td>
          <td style={{ width: "12rem" }}>{h.avg !== null && <span aria-hidden="true" style={{ display: "block", height: ".6rem", width: `${Math.max(2, 100 * h.avg / max)}%`, background: h.flag ? "var(--warn, #d97706)" : "var(--accent, #22d3ee)", borderRadius: 2 }} />}</td>
        </tr>))}</tbody>
    </table></div>
  );
}
