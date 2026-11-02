// Diagnose this cabinet (docs/spec/12-milestones-8-to-12.md "Milestone 12"): one click runs a fixed set of safe reads and the network checks, and
// lists what is wrong, most important first, each with its evidence, how sure the platform is, the suggested fix, the runbook that applies and a
// fix button where there is a safe one. The server runs the checks; this shows them.
import { useEffect, useState } from "react";
import { api, describeError } from "../../lib/api";
import { Link } from "../../lib/router";
import { ago } from "../../lib/time";
import { Badge } from "../../components/ui";
import { KnownFixes } from "../../components/KnownFixes";
import { FixButton, type FixAction } from "../../components/NetworkFix";
import { OpFix } from "../../components/OpFix";
import { RunbookPanel } from "../../components/Runbook";
import { CabinetNotes } from "../../components/CabinetNotes";

type Severity = "problem" | "warning" | "info";
type Action = { kind: "operation"; operation: string; params: Record<string, unknown>; label: string; cabinetId: string; cabinetName: string } | { kind: "open"; section: string; label: string; cabinetId: string };
export interface BundleFinding {
  id: string; key: string; area: string; source: "cabinet" | "network"; severity: Severity; certainty: "confirmed" | "probable" | "possible" | "not_checked"; title: string; evidence: string[];
  fix: string | null; priority: number; issueTypeId?: string; action?: Action; networkAction?: FixAction; causedBy?: string; rank?: number;
  runbook: { title: string; steps: number; builtIn: boolean; target: { kind: "finding"; key: string } | { kind: "issue"; issueTypeId: string } } | null;
  knownFixes: number; usualFix: { fix: string; count: number } | null;
}
interface Diagnosis {
  id: string; state: "running" | "done" | "failed"; startedAt: string; finishedAt: string | null; runBy: string; failure: string | null; findings: BundleFinding[] | null;
  readings: { headline: string; areas: { area: string; label: string; state: "ok" | "warning" | "problem" | "unknown"; summary: string }[]; skipped: { read: string; why: string }[]; networkDiagnosisId: string | null } | null;
  context?: { openAlerts: { id: string; title: string; severity: string; state: string }[] };
}

const SEVERITY: Record<Severity, { label: string; tone: "crit" | "warn" | "info" }> = { problem: { label: "Problem", tone: "crit" }, warning: { label: "Warning", tone: "warn" }, info: { label: "Note", tone: "info" } };
const CERTAINTY: Record<BundleFinding["certainty"], string> = { confirmed: "Confirmed", probable: "Probable cause", possible: "Possible cause", not_checked: "Could not check" };
const AREA_TONE = { ok: "ok", warning: "warn", problem: "crit", unknown: "off" } as const;
const AREA_WORD = { ok: "OK", warning: "Warning", problem: "Problem", unknown: "Not checked" } as const;

export function DiagnoseCabinet({ cabinetId, cabinetName }: { cabinetId: string; cabinetName: string }) {
  const [d, setD] = useState<Diagnosis | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { api<{ latest: Diagnosis | null }>("GET", `/api/cabinets/${cabinetId}/diagnose`).then(r => setD(r.latest), () => undefined); }, [cabinetId]);
  useEffect(() => {
    if (d?.state !== "running") return;
    const t = setTimeout(() => { api<Diagnosis>("GET", `/api/cabinet-diagnoses/${d.id}`).then(setD, e => setProblem(describeError(e))); }, 1000);
    return () => clearTimeout(t);
  }, [d]);
  const start = async () => {
    setProblem(null);
    try {
      const r = await api<{ diagnosisId: string }>("POST", `/api/cabinets/${cabinetId}/diagnose`, {});
      setD({ id: r.diagnosisId, state: "running", startedAt: new Date().toISOString(), finishedAt: null, runBy: "you", failure: null, findings: null, readings: null });
    } catch (e) { setProblem(describeError(e)); }
  };
  const findings = d?.findings ?? [];
  const explained = new Map(findings.filter(f => f.causedBy).map(f => [f.id, f.causedBy!]));
  return (
    <section className="panel" aria-labelledby="diagnose-cabinet-heading">
      <div className="panel-head">
        <div>
          <h2 id="diagnose-cabinet-heading">Diagnose this cabinet</h2>
          <p className="muted small">Reads the cabinet's drives, memory, services, devices, scanner, updates, clock, event logs and network. Nothing is changed.</p>
        </div>
        <button className="btn primary" data-tour="diagnose-cabinet" onClick={() => void start()} disabled={d?.state === "running"} aria-busy={d?.state === "running"}>
          {d?.state === "running" ? "Diagnosing…" : d ? "Run again" : "Diagnose this cabinet"}</button>
      </div>
      {problem && <p className="error" role="alert">{problem}</p>}
      <div aria-live="polite">
        {d?.state === "running" && <p className="muted" role="status">Reading {cabinetName}… this usually takes under a minute, and up to two when something does not answer.</p>}
        {d?.state === "failed" && <p className="error" role="alert">The diagnosis did not finish: {d.failure}</p>}
        {d?.state === "done" && d.readings && (<>
          <p role="status"><strong>{d.readings.headline}</strong> <span className="muted small">Run by {d.runBy} {ago(d.finishedAt ?? d.startedAt)}.</span></p>
          <ul className="plain row gap wrap small" aria-label="What was checked">
            {d.readings.areas.map(a => <li key={a.area} title={a.summary}><Badge tone={AREA_TONE[a.state]}>{a.label}: {AREA_WORD[a.state]}</Badge></li>)}
          </ul>
          {d.context && d.context.openAlerts.length > 0 && <p className="small">Open alerts on this cabinet: {d.context.openAlerts.map((a, i) => <span key={a.id}>{i > 0 && ", "}<Link to={`/cabinets/${cabinetId}/alerts`}>{a.title}</Link></span>)}.</p>}
          {findings.length === 0 && <p><Badge tone="ok">Nothing wrong found</Badge> in what was checked. A check that could not run is listed above as Not checked, never as OK.</p>}
          <ol className="findings">{findings.map(f => <Row key={f.id} f={f} cabinetId={cabinetId} cabinetName={cabinetName} cause={explained.get(f.id)} titleOf={id => findings.find(x => x.id === id)?.title} onFixed={() => void start()} />)}</ol>
          {d.readings.skipped.length > 0 && <details><summary>Reads that did not answer ({d.readings.skipped.length})</summary>
            <ul className="plain small">{d.readings.skipped.map(s => <li key={s.read}><code>{s.read}</code>: {s.why}</li>)}</ul></details>}
          {d.readings.networkDiagnosisId && <p className="small"><Link to={`/cabinets/${cabinetId}/network`}>Open the full network diagnosis</Link></p>}
        </>)}
      </div>
      <CabinetNotes cabinetId={cabinetId} compact />
    </section>
  );
}

function Row({ f, cabinetId, cabinetName, cause, titleOf, onFixed }: { f: BundleFinding; cabinetId: string; cabinetName: string; cause: string | undefined; titleOf: (id: string) => string | undefined; onFixed: () => void }) {
  const s = SEVERITY[f.severity];
  return (
    <li className={`finding ${f.severity === "info" ? "info" : f.severity}`}>
      <div className="finding-head">
        <span className="muted small" aria-label={`Number ${f.rank}`}>#{f.rank}</span>
        <Badge tone={s.tone}>{s.label}</Badge>
        <strong>{f.title}</strong>
        <span className="muted small">{CERTAINTY[f.certainty]}</span>
        {cause && <span className="muted small">Probably a result of “{titleOf(cause) ?? "another finding"}”</span>}
      </div>
      {f.evidence.length > 0 && <ul className="evidence">{f.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      {f.fix && <p className="fix"><span className="muted">Fix:</span> {f.fix}</p>}
      {f.usualFix && <p className="small"><span className="muted">Usually fixed by:</span> {f.usualFix.fix} <span className="muted">({f.usualFix.count} {f.usualFix.count === 1 ? "time" : "times"})</span></p>}
      <p className="row gap wrap">
        {f.action?.kind === "operation" && <OpFix cabinetId={f.action.cabinetId} cabinetName={f.action.cabinetName} operation={f.action.operation} params={f.action.params} label={f.action.label} onDone={onFixed} />}
        {f.action?.kind === "open" && <Link className="btn small" to={`/cabinets/${f.action.cabinetId}/${f.action.section}`}>{f.action.label}</Link>}
        {f.networkAction && (f.networkAction.kind === "open"
          ? <Link className="btn small" to={`/cabinets/${f.networkAction.cabinetId}/${f.networkAction.section}`}>{f.networkAction.label}</Link>
          : <FixButton action={f.networkAction} onDone={onFixed} />)}
      </p>
      {f.runbook && <RunbookPanel target={f.runbook.target.kind === "finding" ? { findingKey: f.runbook.target.key } : { issueTypeId: f.runbook.target.issueTypeId }} cabinetId={cabinetId} cabinetName={cabinetName}
        label={`Runbook: ${f.runbook.title} (${f.runbook.steps} steps)`} />}
      {f.severity !== "info" && f.knownFixes > 0 && (<>
        <KnownFixes symptom={{ kind: "finding", key: f.key }} cabinetId={cabinetId} />
        {f.issueTypeId && <KnownFixes symptom={{ kind: "issue", issueTypeId: f.issueTypeId }} cabinetId={cabinetId} />}
      </>)}
    </li>
  );
}
