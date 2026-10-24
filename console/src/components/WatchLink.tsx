// Watch a link for a few minutes. One reading cannot show an intermittent fault, which is what a weak Wi-Fi link or a failing cable is: this
// samples the same target every 15 seconds and keeps every sample, so drops, spikes and a slow slide are visible. Samples live in this
// page only; "Copy summary" puts the result into the case notes.
import { useEffect, useRef, useState } from "react";
import type { NetworkTestOutput } from "@mashura/cabinet-contracts/types";
import { useRunner } from "../lib/commands";
import { Badge } from "./ui";

/** failure: the cabinet refused or did not answer the command itself (a rate limit, offline); such a sample says nothing about the link and is left out of the loss figures. */
export interface Sample { at: Date; sent: number; received: number; avg: number | null; max: number | null; tcpSent: number; tcpReceived: number; failure: string | null }
const EVERY_MS = 15_000, MAX_SAMPLES = 20;

export function summarize(all: Sample[]) {
  const samples = all.filter(s => !s.failure);
  const unread = all.length - samples.length;
  const sent = samples.reduce((n, s) => n + s.sent, 0), got = samples.reduce((n, s) => n + s.received, 0);
  const tSent = samples.reduce((n, s) => n + s.tcpSent, 0), tGot = samples.reduce((n, s) => n + s.tcpReceived, 0);
  const avgs = samples.map(s => s.avg).filter((x): x is number => x !== null), maxes = samples.map(s => s.max).filter((x): x is number => x !== null);
  const lossy = samples.filter(s => s.received < s.sent || s.tcpReceived < s.tcpSent).length;
  const loss = sent === 0 ? 0 : Math.round(1000 * (sent - got) / sent) / 10;
  const tcpLoss = tSent === 0 ? null : Math.round(1000 * (tSent - tGot) / tSent) / 10;
  const worst = Math.max(loss, tcpLoss ?? 0);
  const verdict: { tone: "ok" | "warn" | "crit"; text: string } =
    all.length === 0 ? { tone: "ok", text: "No samples yet." }
    : samples.length === 0 ? { tone: "warn", text: "The cabinet did not answer the checks (offline, busy or limited), so nothing is known about the link yet." }
    : got === 0 ? { tone: "crit", text: "Nothing answered in any sample: the link is down, not weak." }
    : worst >= 20 ? { tone: "crit", text: `Heavy loss (${worst}%). Syncs will stall on this link.` }
    : worst > 0 || lossy > 0 ? { tone: "warn", text: `Intermittent: ${lossy} of ${samples.length} samples dropped something (${worst}% lost overall).` }
    : { tone: "ok", text: unread > 0 ? `Every sample that was read answered (${unread} could not be read).` : "Every sample answered." };
  return { read: samples.length, sent, got, loss, tcpLoss, lossy, avg: avgs.length ? Math.round(10 * avgs.reduce((a, b) => a + b, 0) / avgs.length) / 10 : null, max: maxes.length ? Math.max(...maxes) : null, verdict };
}

export function WatchLink({ cabinetId, label, ping, tcp }: { cabinetId: string; label: string; ping: Record<string, unknown>; tcp: Record<string, unknown> | null }) {
  const run = useRunner();
  const [samples, setSamples] = useState<Sample[]>([]);
  const [on, setOn] = useState(false);
  const [copied, setCopied] = useState(false);
  const stop = useRef(false);
  useEffect(() => () => { stop.current = true; }, []);
  const take = async (): Promise<Sample> => {
    const at = new Date();
    try {
      const [p, t] = await Promise.all([run<NetworkTestOutput>(cabinetId, "network.test", { ...ping, count: 5 }), tcp ? run<NetworkTestOutput>(cabinetId, "network.test", { ...tcp, count: 3 }) : Promise.resolve(null)]);
      const ps = p.output?.statistics, ts = t?.output?.statistics;
      if (p.status !== "succeeded" || !p.output) return { at, sent: 0, received: 0, avg: null, max: null, tcpSent: 0, tcpReceived: 0, failure: p.error?.message ?? p.status };
      return { at, sent: ps?.sent ?? 5, received: ps?.received ?? (p.output.success ? 5 : 0), avg: ps?.avgMs ?? p.output.latencyMs, max: ps?.maxMs ?? null,
        tcpSent: ts?.sent ?? 0, tcpReceived: ts?.received ?? 0, failure: null };
    } catch (e) { return { at, sent: 0, received: 0, avg: null, max: null, tcpSent: 0, tcpReceived: 0, failure: e instanceof Error ? e.message : "no answer" }; }
  };
  const start = async () => {
    stop.current = false; setOn(true); setSamples([]); setCopied(false);
    for (let i = 0; i < MAX_SAMPLES && !stop.current; i++) {
      const started = Date.now();
      const s = await take();
      if (stop.current) break;
      setSamples(prev => [...prev, s]);
      const wait = EVERY_MS - (Date.now() - started);
      if (i < MAX_SAMPLES - 1 && wait > 0) await new Promise(r => setTimeout(r, wait));
    }
    setOn(false);
  };
  const sum = summarize(samples);
  const text = () => `Watched ${label} for ${sum.read} samples (${Math.round(samples.length * EVERY_MS / 60000 * 10) / 10} min): ${sum.verdict.text} Pings ${sum.got}/${sum.sent}${sum.tcpLoss !== null ? `, TCP ${sum.tcpLoss}% lost` : ""}, average ${sum.avg ?? "-"} ms, slowest ${sum.max ?? "-"} ms.`;
  const copy = async () => { try { await navigator.clipboard.writeText(text()); setCopied(true); } catch { setCopied(false); } };
  const top = Math.max(1, ...samples.map(s => s.max ?? s.avg ?? 0));
  return (
    <div className="stack" aria-label={`Watch ${label}`}>
      <div className="row gap wrap">
        {!on ? <button className="btn" onClick={() => void start()}>Watch {label} for 5 minutes</button> : <button className="btn danger" onClick={() => { stop.current = true; }}>Stop watching</button>}
        {samples.length > 0 && <><Badge tone={sum.verdict.tone}>{sum.verdict.tone === "ok" ? "Stable" : sum.verdict.tone === "warn" ? "Intermittent" : "Bad"}</Badge><span className="small">{sum.verdict.text}</span></>}
        {samples.length > 0 && !on && <button className="btn small" onClick={() => void copy()}>{copied ? "Copied" : "Copy summary"}</button>}
      </div>
      {samples.length > 0 && (<>
        <svg role="img" aria-label="Round trip per sample, one bar each" width={MAX_SAMPLES * 20} height="56" viewBox={`0 0 ${MAX_SAMPLES * 20} 56`}>
          {samples.map((s, i) => {
            const h = Math.max(2, 50 * ((s.avg ?? 0) / top)), bad = s.received < s.sent || s.tcpReceived < s.tcpSent || s.failure;
            return <g key={i}><rect x={i * 20 + 3} y={54 - h} width="14" height={h} fill={bad ? "var(--warn, #d97706)" : "var(--accent, #22d3ee)"} opacity={s.received === 0 ? 0.25 : 1} />
              {bad && <rect x={i * 20 + 3} y="0" width="14" height="3" fill="var(--crit, #ef4444)" />}</g>;
          })}
        </svg>
        <div className="table-wrap">
        <table className="table compact">
          <caption className="sr-only">Samples</caption>
          <thead><tr><th scope="col">Time</th><th scope="col">Ping</th><th scope="col">Average</th><th scope="col">Slowest</th>{tcp && <th scope="col">TCP</th>}</tr></thead>
          <tbody>{[...samples].reverse().slice(0, 12).map((s, i) => (
            <tr key={i}><th scope="row">{s.at.toISOString().slice(11, 19)}</th><td>{s.failure ?? `${s.received} of ${s.sent}`}</td><td>{s.avg ?? "—"}</td><td>{s.max ?? "—"}</td>{tcp && <td>{s.tcpSent ? `${s.tcpReceived} of ${s.tcpSent}` : "—"}</td>}</tr>))}</tbody>
        </table></div>
      </>)}
    </div>
  );
}
