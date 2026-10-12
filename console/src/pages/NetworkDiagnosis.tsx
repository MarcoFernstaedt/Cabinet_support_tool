// Network diagnosis of several cabinets or a whole site (docs/spec/14-network-troubleshooting.md): what is wrong across them,
// grouped so the same problem on many cabinets is one row with the fix, and each cabinet's path from the link up to the
// firewall. Read only to run; the fixes are confirmed like any change (a code for one cabinet, the password for many).
import { Fragment, useEffect, useRef, useState } from "react";
import { api, describeError } from "../lib/api";
import { Link, useRouter } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { ago } from "../lib/time";
import { Breadcrumbs } from "../components/Layout";
import { Badge, Empty } from "../components/ui";
import { KEY_LABEL, KnownFixes, SaveFix } from "../components/KnownFixes";
import { ReadingsView, type Readings } from "../components/NetworkReadings";
import { FixAll, FixButton, JOB_LABEL, LAYERS, type FixAction, type Layer, type LayerState } from "../components/NetworkFix";

interface Group {
  key: string; title: string; severity: "problem" | "warning"; fix: string | null; kind: string | null; operation: string | null;
  affected: string[]; targets: { cabinetId: string; cabinetName: string; label: string; action: Exclude<FixAction, { kind: "open" }> }[];
}
interface Row { diagnosisId: string; cabinetId: string; name: string; role: string; site: string; state: "running" | "done" | "failed" | "offline"; failure: string | null;
  layers: Record<Layer, LayerState> | null; problems: number; warnings: number }
interface Batch { id: string; hasBaseline: boolean; label: string; siteId: string | null; startedAt: string; startedBy: string; total: number; finished: number; waiting: number; state: "running" | "done"; cabinets: Row[]; groups: Group[] }

const CELL: Record<LayerState, string> = { ok: "OK", warning: "Warning", problem: "Problem", unknown: "—" };

/** Starts a diagnosis on cabinets or a site, then opens its page. Used by the site page and Fleet operations. */
export function useStartDiagnosis() {
  const { navigate } = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const start = async (body: { cabinetIds: string[] } | { siteId: string }) => {
    setBusy(true); setProblem(null);
    try { const r = await api<{ batchId: string }>("POST", "/api/diagnose/network", body); navigate(`/network/diagnosis/${r.batchId}`); }
    catch (e) { setProblem(describeError(e)); setBusy(false); }
  };
  return { start, busy, problem };
}

export function NetworkDiagnosisPage({ id }: { id: string }) {
  const { data, problem, reload } = useLoad<Batch>(`/api/diagnose/network/batches/${id}`);
  const again = useStartDiagnosis();
  useEffect(() => {
    if (data?.state !== "running") return;
    const t = setInterval(reload, 1000);
    return () => clearInterval(t);
  }, [data?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const problems = data?.groups.filter(g => g.severity === "problem") ?? [];
  const warnings = data?.groups.filter(g => g.severity === "warning") ?? [];
  const checked = data?.cabinets.filter(c => c.state === "done") ?? [];
  const clean = checked.filter(c => c.problems === 0 && c.warnings === 0).length;
  const [open, setOpen] = useState<string | null>(null);
  const [fixed, setFixedState] = useState<FixedNote | null>(readFixed);
  const setFixed = (what: string | null) => { const v = what === null ? null : { what, siteId: data?.siteId ?? null, at: Date.now() }; setFixedState(v); writeFixed(v); };
  // A fix made while the first check is still going (the last cabinets are waiting their turn) checks again once that has finished.
  const latest = useRef(data);
  latest.current = data;
  const rerun = async () => {
    if (!data) return;
    for (let i = 0; i < 90 && latest.current?.state === "running"; i++) await new Promise(r => setTimeout(r, 1000));
    return again.start(data.siteId ? { siteId: data.siteId } : { cabinetIds: data.cabinets.map(c => c.cabinetId) });
  };
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Fleet", to: "/" }, ...(data?.siteId ? [{ label: "Site", to: `/sites/${data.siteId}` }] : []), { label: "Network diagnosis" }]} />
      <h1>Network diagnosis{data ? `: ${data.label}` : ""}</h1>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && (<>
        <p className="muted">Run by {data.startedBy} {ago(data.startedAt)}. Each cabinet's link, address, gateway, DNS servers, the platform, the sync cabinet and its firewall are checked
          {data.hasBaseline ? ", and its address, gateway and DNS are compared with the site's baseline" : ""}.
          {!data.hasBaseline && " This site has no baseline set, so nothing is compared; these are the readings straight from the cabinets."}</p>
        <p className="row gap wrap" role="status" aria-live="polite">
          {data.state === "running"
            ? <Badge tone="info">Checking: {data.finished} of {data.total} done</Badge>
            : <><Badge tone={problems.length ? "crit" : warnings.length ? "warn" : "ok"}>
                {problems.length === 0 && warnings.length === 0 ? "No problems found" : `${problems.length} ${problems.length === 1 ? "problem" : "problems"}, ${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}`}</Badge>
              <span className="muted small">{clean} of {data.total} cabinets are clean{data.cabinets.some(c => c.state === "offline") ? `; ${data.cabinets.filter(c => c.state === "offline").length} offline, not checked` : ""}.</span></>}
          <button className="btn small" onClick={() => { setFixed(null); void rerun(); }} disabled={again.busy || data.state === "running"}>Run again</button>
          {again.problem && <span className="error small" role="alert">{again.problem}</span>}
        </p>

        {fixed && fixed.siteId === (data.siteId ?? null) && <p className="notice ok" role="status"><strong>Done:</strong> {fixed.what}. The site was checked again; the result is below.</p>}
        <section className="panel" aria-labelledby="what-wrong">
          <h2 id="what-wrong">What is wrong</h2>
          {data.state === "running" && data.groups.length === 0 && <p className="muted">Waiting for the first results…</p>}
          {data.state === "done" && data.groups.length === 0 && <Empty>Nothing to fix: every checked cabinet matches its site and reaches what it needs.</Empty>}
          {(() => { const done = new Set(problems.flatMap(g => g.targets.map(t => `${t.cabinetId}:${t.action.kind}`)));
            return [...problems, ...warnings].map(g => <GroupCard key={g.key} g={g} sameFixAbove={g.severity === "warning" && g.targets.length > 0 && g.targets.every(t => done.has(`${t.cabinetId}:${t.action.kind}`))}
              onFixed={what => { setFixed(what); void rerun(); }} />); })()}
        </section>

        <section className="panel" aria-labelledby="by-cabinet">
          <h2 id="by-cabinet">Cabinet by cabinet</h2>
          <p className="muted small">The path from the network link up to the firewall. A problem low down (the link, the address) explains the ones above it.</p>
          <div className="table-wrap"><table className="table compact matrix">
            <caption className="sr-only">Each cabinet's network path</caption>
            <thead><tr><th scope="col">Cabinet</th>{LAYERS.map(([k, n]) => <th key={k} scope="col">{n}</th>)}</tr></thead>
            <tbody>
              {data.cabinets.map(c => (<Fragment key={c.cabinetId}>
                <tr>
                  <th scope="row"><Link to={`/cabinets/${c.cabinetId}/network`}>{c.name}</Link><div className="muted small">{c.site}</div>
                    {c.layers && <button className="btn small ghost" aria-expanded={open === c.diagnosisId} onClick={() => setOpen(o => o === c.diagnosisId ? null : c.diagnosisId)}>{open === c.diagnosisId ? "Hide the full read" : "Full read"}</button>}</th>
                  {c.layers ? LAYERS.map(([k]) => <td key={k}><span className={`cell ${c.layers![k]}`}>{CELL[c.layers![k]]}</span></td>)
                    : <td colSpan={LAYERS.length} className="muted small">{c.state === "offline" ? "Offline: not heard from in the last 5 minutes, so nothing was checked." : c.state === "running" ? "Checking…" : c.failure ?? "Could not be checked."}</td>}
                </tr>
                {open === c.diagnosisId && <tr><td colSpan={LAYERS.length + 1}><CabinetRead id={c.diagnosisId} /></td></tr>}
              </Fragment>))}
              {data.waiting > 0 && <tr><td colSpan={LAYERS.length + 1} className="muted small">{data.waiting} more waiting their turn…</td></tr>}
            </tbody>
          </table></div>
        </section>
      </>)}
    </div>
  );
}

// The fix just made, kept for this tab so the page that re-checks the site (a new page each time) can say what was done.
const FIXED = "network-fix-done";
interface FixedNote { what: string; siteId: string | null; at: number }
const readFixed = (): FixedNote | null => { try { const v = JSON.parse(sessionStorage.getItem(FIXED) ?? "null") as FixedNote | null; return v && Date.now() - v.at < 120_000 ? v : null; } catch { return null; } };
const writeFixed = (v: FixedNote | null) => { try { if (v === null) sessionStorage.removeItem(FIXED); else sessionStorage.setItem(FIXED, JSON.stringify(v)); } catch { /* storage unavailable */ } };

function GroupCard({ g, onFixed, sameFixAbove }: { g: Group; onFixed: (what: string) => void; sameFixAbove: boolean }) {
  const many = g.targets.length > 1;
  const first = g.targets[0]?.cabinetId;
  return (
    <article className={`group-card ${g.severity}`} aria-label={g.title}>
      <div className="finding-head">
        <Badge tone={g.severity === "problem" ? "crit" : "warn"}>{g.severity === "problem" ? "Problem" : "Warning"}</Badge>
        <strong>{g.title}</strong>
        <span className="muted small">{g.affected.length} {g.affected.length === 1 ? "cabinet" : "cabinets"}</span>
      </div>
      <ul className="chips" aria-label="Affected cabinets">{g.affected.map(n => <li key={n} className="chip">{n}</li>)}</ul>
      {g.fix && <p className="fix"><span className="muted">Fix:</span> {g.fix}</p>}
      {sameFixAbove ? <p className="muted small">The fix above covers this too.</p> : g.operation && g.targets.length > 0 ? (
        <div className="row gap wrap">
          {many && <FixAll operation={g.operation} cabinetIds={g.targets.map(t => t.cabinetId)}>{JOB_LABEL[g.operation] ?? g.operation} on all {g.targets.length}</FixAll>}
          {!many && g.targets[0] && <FixButton action={g.targets[0].action} onDone={onFixed}>{g.targets[0].label}</FixButton>}
        </div>
      ) : <p className="muted small">No change can be made from here: someone at the site needs to look.</p>}
      {first && <KnownFixes symptom={{ kind: "finding", key: g.key.split("|")[0]! }} cabinetId={first} />}
      {first && <SaveFix symptom={{ kind: "finding", key: g.key.split("|")[0]! }} cabinetId={first} suggestedTitle={KEY_LABEL[g.key.split("|")[0]!] ?? g.title} />}
      {many && <details><summary>Fix one at a time</summary>
        <ul className="plain">{g.targets.map(t => <li key={t.cabinetId} className="row gap wrap"><strong>{t.cabinetName}</strong> <span className="muted small">{t.label}</span>
          <FixButton action={t.action} onDone={onFixed}>Fix</FixButton></li>)}</ul>
      </details>}
    </article>
  );
}

interface ReadFinding { id: string; severity: "problem" | "warning" | "info" | "ok"; title: string; evidence: string[]; fix: string | null }

/** One cabinet's whole check: every finding (including the ones that passed and the observations) and everything that was read. */
function CabinetRead({ id }: { id: string }) {
  const { data, problem } = useLoad<{ findings: ReadFinding[] | null; readings: Readings | null }>(`/api/diagnoses/${id}`);
  if (problem) return <p className="error" role="alert">{problem}</p>;
  if (!data) return <p className="muted" role="status">Loading…</p>;
  const tone = { problem: "crit", warning: "warn", info: "info", ok: "ok" } as const;
  return (
    <div className="stack">
      <ul className="plain">{(data.findings ?? []).map(f => (
        <li key={f.id}><Badge tone={tone[f.severity]}>{{ problem: "Problem", warning: "Warning", info: "Note", ok: "OK" }[f.severity]}</Badge> <strong>{f.title}</strong>
          {f.evidence.length > 0 && <div className="muted small">{f.evidence.join(" ")}</div>}{f.fix && f.severity !== "ok" && <div className="small"><span className="muted">Fix:</span> {f.fix}</div>}</li>))}</ul>
      {data.readings ? <details><summary>Everything that was read</summary><ReadingsView readings={data.readings} /></details> : <p className="muted small">The full read was not kept for this check.</p>}
    </div>
  );
}
