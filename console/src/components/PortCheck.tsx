// "Why can't anything reach port N on this cabinet?" Reads the listeners and the active network profile, applies the firewall rules already
// loaded on the page, and says which of the three is the problem.
import { useState } from "react";
import type { FirewallStateOutput, NetworkConfigOutput, NetworkListenersOutput } from "@mashura/cabinet-contracts/types";
import { useOperation } from "../lib/commands";
import { analysePort, type PortAnalysis } from "../lib/portcheck";
import { Badge } from "./ui";

export function PortCheck({ cabinetId, firewall }: { cabinetId: string; firewall: FirewallStateOutput }) {
  const listeners = useOperation<NetworkListenersOutput>(cabinetId, "network.listeners");
  const config = useOperation<NetworkConfigOutput>(cabinetId, "network.config");
  const [text, setText] = useState("1433");
  const [result, setResult] = useState<PortAnalysis | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const port = Number(text);
  const valid = Number.isInteger(port) && port >= 1 && port <= 65535;
  const busy = listeners.state === "running" || config.state === "running";
  const run = async () => {
    setProblem(null);
    const [l, c] = await Promise.all([listeners.start(), config.start()]);
    if (!l || l.status !== "succeeded" || !l.output) { setProblem(l?.error?.message ?? "The cabinet did not return its listening ports."); setResult(null); return; }
    const active = (c?.output?.adapters ?? []).filter(a => a.connected).map(a => a.details?.networkProfile?.category).filter((x): x is "public" | "private" | "domain" => !!x);
    setResult(analysePort(port, firewall.rules as never, firewall.profiles as never, l.output.listeners as never, active, { listeners: l.output.truncated, rules: firewall.rulesTruncated }));
  };
  return (
    <section className="panel" aria-labelledby="portcheck-heading">
      <div className="panel-head">
        <h3 id="portcheck-heading">Check a port</h3>
        <form className="row gap" onSubmit={e => { e.preventDefault(); if (valid) void run(); }}>
          <label className="sr-only" htmlFor="portcheck-port">TCP port</label>
          <input id="portcheck-port" inputMode="numeric" size={7} value={text} onChange={e => { setText(e.target.value.replace(/\D/g, "").slice(0, 5)); setResult(null); }} />
          <button className="btn primary" disabled={!valid || busy}>{busy ? "Checking…" : "Check"}</button>
        </form>
      </div>
      {problem && <p className="error" role="alert">{problem}</p>}
      {result && (<div aria-live="polite">
        {result.incomplete.map(t => <p key={t} className="small"><Badge tone="warn">Incomplete</Badge> {t}</p>)}
        <p><Badge tone={result.summary.tone}>{result.summary.tone === "ok" ? "Reachable" : result.summary.tone === "warn" ? "Check" : "Not reachable"}</Badge> {result.summary.text}</p>
        <table className="table compact">
          <caption className="sr-only">Port {result.port}</caption>
          <thead><tr><th scope="col">Where</th><th scope="col">Result</th><th scope="col">Why</th></tr></thead>
          <tbody>
            {result.listeners.length === 0 ? <tr><th scope="row">Listening</th><td><Badge tone="crit">No</Badge></td><td /></tr>
              : result.listeners.map((l, i) => <tr key={i}><th scope="row">Listening</th><td><Badge tone="ok">Yes</Badge></td><td>{l.address}:{l.port}{l.process ? ` · ${l.process}` : ""}{l.processId ? ` (PID ${l.processId})` : ""}</td></tr>)}
            {result.verdicts.map(v => (
              <tr key={v.profile}><th scope="row">{v.profile[0]!.toUpperCase() + v.profile.slice(1)} profile{v.inUse ? " (in use)" : ""}</th>
                <td><Badge tone={v.outcome === "allowed" ? "ok" : v.outcome === "conditional" ? "warn" : "crit"}>{v.outcome === "allowed" ? "Allowed" : v.outcome === "conditional" ? "Limited" : "Blocked"}</Badge></td>
                <td>{v.because}{v.rules.length > 0 && <>: {v.rules.map((r, i) => <span key={r}>{i > 0 && ", "}<code>{r}</code></span>)}</>}</td></tr>))}
          </tbody>
        </table>
      </div>)}
    </section>
  );
}
