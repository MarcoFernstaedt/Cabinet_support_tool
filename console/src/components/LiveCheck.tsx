// Test a real cabinet: runs the read-only checks the console depends on, one after another, against the actual machine, and says for each
// what it read or why it could not. Nothing here changes the cabinet. It is how you confirm a freshly installed agent is doing the real
// thing (event logs, services, firewall, the network and the path to the platform) and not simulated data. "Copy results" gives a plain
// report to paste into a ticket.
import { useEffect, useRef, useState } from "react";
import { OVERVIEW_CHECKS as CHECKS, useChecks } from "../lib/checks";
import { Badge } from "./ui";

export function LiveCheck({ cabinetId, cabinetName, simulated = false }: { cabinetId: string; cabinetName: string; simulated?: boolean }) {
  const section = useRef<HTMLElement>(null);
  // The guided demo links here with #live-check, so the panel is on screen when the step opens.
  useEffect(() => { if (window.location.hash === "#live-check") section.current?.scrollIntoView({ block: "start" }); }, []);
  const { rows, busy, start } = useChecks(cabinetId, CHECKS);
  const [copied, setCopied] = useState(false);
  const finished = CHECKS.filter(c => rows[c.id] && rows[c.id]!.status !== "waiting" && rows[c.id]!.status !== "running").length;
  const passed = CHECKS.filter(c => rows[c.id]?.status === "passed").length;
  const report = () => [`Live check of ${cabinetName} at ${new Date().toISOString()}`, ...CHECKS.map(c => `${rows[c.id]?.status === "passed" ? "PASS" : rows[c.id]?.status === "failed" ? "FAIL" : "----"}  ${c.label} (${c.operation}): ${rows[c.id]?.text ?? ""}`)].join("\n");
  const copy = async () => { try { await navigator.clipboard.writeText(report()); setCopied(true); } catch { setCopied(false); } };
  return (
    <section className="panel" aria-labelledby="live-check" ref={section}>
      <div className="panel-head">
        <div>
          <h2 id="live-check">Test {cabinetName}</h2>
          <p className="muted small">Read-only. Changes nothing on the machine.{simulated && <> Simulated cabinet: answers are generated.</>}</p>
        </div>
        <button className="btn primary" data-tour="live-run" onClick={() => { setCopied(false); void start(); }} disabled={busy}>{busy ? `Running ${finished + 1} of ${CHECKS.length}…` : finished > 0 ? "Run again" : "Run the checks"}</button>
      </div>
      {finished > 0 && <p role="status" className="small"><Badge tone={passed === CHECKS.length ? "ok" : finished === CHECKS.length ? "warn" : "info"}>{passed} of {CHECKS.length} passed</Badge> {!busy && <button className="btn small ghost" onClick={() => void copy()}>{copied ? "Copied" : "Copy results"}</button>}</p>}
      <ul className="plain live-check">{(busy ? CHECKS : [...CHECKS].sort((a, b) => Number(rows[b.id]?.status === "failed") - Number(rows[a.id]?.status === "failed"))).map(c => {
        const r = rows[c.id];
        return (
          <li key={c.id} className="row gap wrap">
            <span style={{ minWidth: "5.5rem" }}>{!r ? <Badge tone="off">Not run</Badge> : r.status === "passed" ? <Badge tone="ok">Passed</Badge> : r.status === "failed" ? <Badge tone="crit">Failed</Badge> : r.status === "running" ? <Badge tone="info">Running</Badge> : <Badge tone="off">Waiting</Badge>}</span>
            <strong>{c.label}</strong> <code className="small muted">{c.operation}</code>
            {r?.ms != null && <span className="muted small">{(r.ms / 1000).toFixed(1)} s</span>}
            {r?.text && <div className="small" style={{ flexBasis: "100%" }}>{r.text}</div>}
            {r?.raw && <details style={{ flexBasis: "100%" }}><summary className="small">What the cabinet sent</summary><pre className="small" style={{ maxHeight: "16rem", overflow: "auto" }}>{r.raw}</pre></details>}
          </li>);
      })}</ul>
    </section>
  );
}
