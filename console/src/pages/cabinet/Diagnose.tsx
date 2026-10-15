// Diagnose network (docs/spec/12-milestones-8-to-12.md): one click runs the cabinet's network reads and tests and lists what
// is wrong, worst first, each with its evidence, how sure it is, and the fix. The server runs the checks; this shows them.
import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../../lib/api";
import { Link } from "../../lib/router";
import { ago } from "../../lib/time";
import { Badge } from "../../components/ui";
import { KEY_LABEL, KnownFixes, SaveFix, findingKey } from "../../components/KnownFixes";
import { ReadingsView, type Readings } from "../../components/NetworkReadings";
import { FixButton, LAYERS, PathBar, type FixAction, type Layer, type LayerState } from "../../components/NetworkFix";

type Severity = "problem" | "warning" | "info" | "ok";
interface Finding {
  id: string; layer: Layer; severity: Severity; certainty: "confirmed" | "probable" | "possible" | "not_checked"; title: string; evidence: string[]; fix: string | null;
  action?: FixAction; causedBy?: string;
}
/** One word per layer, worst finding first; "unknown" when nothing there was checked. */
export function layerStates(findings: Finding[]): Record<Layer, LayerState> {
  const out = {} as Record<Layer, LayerState>;
  for (const [layer] of LAYERS) {
    const mine = findings.filter(f => f.layer === layer);
    out[layer] = mine.some(f => f.severity === "problem") ? "problem" : mine.some(f => f.severity === "warning") ? "warning" : mine.some(f => f.severity === "ok") ? "ok" : "unknown";
  }
  return out;
}
interface Diagnosis { id: string; state: "running" | "done" | "failed"; startedAt: string; finishedAt: string | null; runBy: string; findings: Finding[] | null; failure: string | null; readings?: Readings | null }

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
  // A problem that was in the last check and is gone from this one has been fixed: that is when its fix is worth saving, if it is new.
  const prev = useRef<{ id: string; list: Finding[] } | null>(null);
  const [resolved, setResolved] = useState<Finding[]>([]);
  useEffect(() => {
    if (d?.state !== "done" || !d.findings) return;
    const now = d.findings.filter(f => (f.severity === "problem" || f.severity === "warning") && !f.causedBy);
    const keys = new Set(now.map(f => findingKey(f.id)));
    if (prev.current && prev.current.id !== d.id) {
      const seen = new Set<string>();
      setResolved(prev.current.list.filter(f => { const k = findingKey(f.id); if (keys.has(k) || seen.has(k)) return false; seen.add(k); return true; }));
    }
    prev.current = { id: d.id, list: now };
  }, [d?.id, d?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const findings = d?.findings ?? [];
  const notOk = findings.filter(f => f.severity !== "ok");
  const okOnes = findings.filter(f => f.severity === "ok");
  const counts = (["problem", "warning"] as const).map(s => [s, findings.filter(f => f.severity === s).length] as const);
  return (
    <section className="panel" aria-labelledby="diagnose-heading">
      <div className="panel-head">
        <div>
          <h2 id="diagnose-heading">Diagnose network</h2>
        </div>
        <button className="btn primary" data-tour="diagnose" onClick={() => void start()} disabled={d?.state === "running"} aria-busy={d?.state === "running"}>
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
          <PathBar layers={layerStates(findings)} />
          {resolved.length > 0 && <div className="notice ok" role="status"><strong>Fixed since the last check:</strong>
            <ul className="plain">{resolved.map(f => <ResolvedRow key={f.id} f={f} cabinetId={cabinetId} />)}</ul></div>}
          <ul className="findings">{notOk.map(f => <FindingRow key={f.id} f={f} cabinetId={cabinetId} onFixed={() => void start()} />)}</ul>
          {d.readings && (
            <details data-tour="full-read"><summary>Everything that was read</summary><ReadingsView readings={d.readings} /></details>)}
          {okOnes.length > 0 && (
            <details open={showOk} onToggle={e => setShowOk((e.target as HTMLDetailsElement).open)}>
              <summary>Checks that passed ({okOnes.length})</summary>
              <ul className="findings">{okOnes.map(f => <FindingRow key={f.id} f={f} cabinetId={cabinetId} onFixed={() => undefined} />)}</ul>
            </details>)}
        </>)}
      </div>
    </section>
  );
}

function FindingRow({ f, cabinetId, onFixed }: { f: Finding; cabinetId: string; onFixed: () => void }) {
  const s = SEVERITY[f.severity];
  const [fixes, setFixes] = useState(0);
  return (
    <li className={`finding ${f.severity}`}>
      <div className="finding-head">
        <Badge tone={s.tone}>{s.label}</Badge>
        <strong>{f.title}</strong>
        {f.severity !== "ok" && <span className="muted small">{CERTAINTY[f.certainty]}</span>}
        {f.causedBy && <span className="muted small">Probably a result of another problem on this page</span>}
      </div>
      {f.evidence.length > 0 && <ul className="evidence">{f.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      {f.fix && <p className="fix"><span className="muted">Fix:</span> {f.fix}</p>}
      {f.action && (f.action.kind === "open"
        ? <Link className="btn small" to={`/cabinets/${f.action.cabinetId}/${f.action.section}`}>{f.action.label}</Link>
        : <FixButton action={f.action} onDone={onFixed} />)}
      {f.severity !== "ok" && !f.causedBy && (<>
        <KnownFixes symptom={{ kind: "finding", key: findingKey(f.id) }} cabinetId={cabinetId} reloadKey={fixes} />
      </>)}
    </li>
  );
}

/** A problem that is gone since the last check: the fix is offered for saving if it is new, and shown once it is saved. */
function ResolvedRow({ f, cabinetId }: { f: Finding; cabinetId: string }) {
  const [saved, setSaved] = useState(0);
  const symptom = { kind: "finding" as const, key: findingKey(f.id) };
  return (
    <li>{f.title}
      <SaveFix symptom={symptom} cabinetId={cabinetId} suggestedTitle={KEY_LABEL[symptom.key] ?? f.title} onSaved={() => setSaved(n => n + 1)} />
      <KnownFixes symptom={symptom} cabinetId={cabinetId} reloadKey={saved} />
    </li>
  );
}
