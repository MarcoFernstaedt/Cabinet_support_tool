// Diagnose network (docs/spec/12-milestones-8-to-12.md): one click runs the cabinet's network reads and tests and lists what
// is wrong, worst first, each with its evidence, how sure it is, and the fix. The server runs the checks; this shows them.
import { useEffect, useState } from "react";
import { api, describeError } from "../../lib/api";
import { Link } from "../../lib/router";
import { ago } from "../../lib/time";
import { Badge } from "../../components/ui";

type Severity = "problem" | "warning" | "info" | "ok";
interface Finding {
  id: string; severity: Severity; certainty: "confirmed" | "probable" | "possible" | "not_checked"; title: string; evidence: string[]; fix: string | null;
  action?: { kind: "apply_policy"; cabinetId: string; cabinetName: string } | { kind: "open"; section: string; cabinetId: string; label: string };
}
interface Diagnosis { id: string; state: "running" | "done" | "failed"; startedAt: string; finishedAt: string | null; runBy: string; findings: Finding[] | null; failure: string | null }

const SEVERITY: Record<Severity, { label: string; tone: "crit" | "warn" | "info" | "ok" }> = {
  problem: { label: "Problem", tone: "crit" }, warning: { label: "Warning", tone: "warn" }, info: { label: "Note", tone: "info" }, ok: { label: "OK", tone: "ok" },
};
const CERTAINTY: Record<Finding["certainty"], string> = { confirmed: "Confirmed", probable: "Probable cause", possible: "Possible cause", not_checked: "Could not check" };

export function DiagnoseNetwork({ cabinetId, cabinetName }: { cabinetId: string; cabinetName: string }) {
  const [d, setD] = useState<Diagnosis | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [showOk, setShowOk] = useState(false);
  useEffect(() => { api<{ latest: Diagnosis | null }>("GET", `/api/cabinets/${cabinetId}/diagnose/network`).then(r => setD(r.latest), () => undefined); }, [cabinetId]);
  // While it runs, look every second (it takes a few seconds).
  useEffect(() => {
    if (d?.state !== "running") return;
    const t = setTimeout(() => { api<Diagnosis>("GET", `/api/diagnoses/${d.id}`).then(setD, e => setProblem(describeError(e))); }, 1000);
    return () => clearTimeout(t);
  }, [d]);
  const start = async () => {
    setProblem(null);
    try {
      const r = await api<{ diagnosisId: string }>("POST", `/api/cabinets/${cabinetId}/diagnose/network`, {});
      setD({ id: r.diagnosisId, state: "running", startedAt: new Date().toISOString(), finishedAt: null, runBy: "you", findings: null, failure: null });
    } catch (e) { setProblem(describeError(e)); }
  };
  const findings = d?.findings ?? [];
  const notOk = findings.filter(f => f.severity !== "ok");
  const okOnes = findings.filter(f => f.severity === "ok");
  const counts = (["problem", "warning"] as const).map(s => [s, findings.filter(f => f.severity === s).length] as const);
  return (
    <section className="panel" aria-labelledby="diagnose-heading">
      <div className="panel-head">
        <div>
          <h2 id="diagnose-heading">Diagnose network</h2>
          <p className="muted small">Checks the link, the address, the gateway, every DNS server, the platform server and the site's sync cabinet and its ports, and compares the firewall with the client policy. Is it the cable, the IP, DNS, routing or a firewall?</p>
        </div>
        <button className="btn primary" onClick={() => void start()} disabled={d?.state === "running"} aria-busy={d?.state === "running"}>
          {d?.state === "running" ? "Diagnosing…" : d ? "Run again" : "Diagnose network"}</button>
      </div>
      {problem && <p className="error" role="alert">{problem}</p>}
      <div aria-live="polite">
        {d?.state === "running" && <p className="muted" role="status">Running the checks on {cabinetName}…</p>}
        {d?.state === "failed" && <p className="error" role="alert">The diagnosis did not finish: {d.failure}</p>}
        {d?.state === "done" && (<>
          <p className="small muted" role="status">
            {notOk.length === 0 ? <Badge tone="ok">No problems found</Badge> : counts.filter(([, n]) => n > 0).map(([s, n]) => <span key={s}><Badge tone={SEVERITY[s].tone}>{n} {s === "problem" ? (n === 1 ? "problem" : "problems") : (n === 1 ? "warning" : "warnings")}</Badge> </span>)}
            {" "}Run by {d.runBy} {ago(d.finishedAt ?? d.startedAt)}. {okOnes.length} checks passed.</p>
          <ul className="findings">{notOk.map(f => <FindingRow key={f.id} f={f} />)}</ul>
          {okOnes.length > 0 && (
            <details open={showOk} onToggle={e => setShowOk((e.target as HTMLDetailsElement).open)}>
              <summary>Checks that passed ({okOnes.length})</summary>
              <ul className="findings">{okOnes.map(f => <FindingRow key={f.id} f={f} />)}</ul>
            </details>)}
        </>)}
      </div>
    </section>
  );
}

function FindingRow({ f }: { f: Finding }) {
  const s = SEVERITY[f.severity];
  return (
    <li className={`finding ${f.severity}`}>
      <div className="finding-head">
        <Badge tone={s.tone}>{s.label}</Badge>
        <strong>{f.title}</strong>
        {f.severity !== "ok" && <span className="muted small">{CERTAINTY[f.certainty]}</span>}
      </div>
      {f.evidence.length > 0 && <ul className="evidence">{f.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      {f.fix && <p className="fix"><span className="muted">Fix:</span> {f.fix}</p>}
      {f.action && (f.action.kind === "apply_policy"
        ? <Link className="btn small primary" to={`/cabinets/${f.action.cabinetId}/firewall`}>Apply the policy on {f.action.cabinetName}</Link>
        : <Link className="btn small" to={`/cabinets/${f.action.cabinetId}/${f.action.section}`}>{f.action.label}</Link>)}
    </li>
  );
}
