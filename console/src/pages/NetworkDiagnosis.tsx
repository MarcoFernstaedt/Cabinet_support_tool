// Network diagnosis of several cabinets or a whole site (docs/spec/14-network-troubleshooting.md): what is wrong across them,
// grouped so the same problem on many cabinets is one row with the fix, and each cabinet's path from the link up to the
// firewall. Read only to run; the fixes are confirmed like any change (a code for one cabinet, the password for many).
import { useEffect, useState } from "react";
import { api, describeError } from "../lib/api";
import { Link, useRouter } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { ago } from "../lib/time";
import { Breadcrumbs } from "../components/Layout";
import { Badge, Empty } from "../components/ui";
import { FixAll, FixButton, JOB_LABEL, LAYERS, type FixAction, type Layer, type LayerState } from "../components/NetworkFix";

interface Group {
  key: string; title: string; severity: "problem" | "warning"; fix: string | null; kind: string | null; operation: string | null;
  affected: string[]; targets: { cabinetId: string; cabinetName: string; label: string; action: Exclude<FixAction, { kind: "open" }> }[];
}
interface Row { diagnosisId: string; cabinetId: string; name: string; role: string; site: string; state: "running" | "done" | "failed" | "offline"; failure: string | null;
  layers: Record<Layer, LayerState> | null; problems: number; warnings: number }
interface Batch { id: string; label: string; siteId: string | null; startedAt: string; startedBy: string; total: number; finished: number; waiting: number; state: "running" | "done"; cabinets: Row[]; groups: Group[] }

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
  const rerun = () => { if (!data) return; return again.start(data.siteId ? { siteId: data.siteId } : { cabinetIds: data.cabinets.map(c => c.cabinetId) }); };
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Fleet", to: "/" }, ...(data?.siteId ? [{ label: "Site", to: `/sites/${data.siteId}` }] : []), { label: "Network diagnosis" }]} />
      <h1>Network diagnosis{data ? `: ${data.label}` : ""}</h1>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && (<>
        <p className="muted">Run by {data.startedBy} {ago(data.startedAt)}. Each cabinet's link, address, gateway, DNS servers, the platform, the sync cabinet and its firewall are checked, and its address, gateway and DNS are compared with the site's baseline.</p>
        <p className="row gap wrap" role="status" aria-live="polite">
          {data.state === "running"
            ? <Badge tone="info">Checking: {data.finished} of {data.total} done</Badge>
            : <><Badge tone={problems.length ? "crit" : warnings.length ? "warn" : "ok"}>
                {problems.length === 0 && warnings.length === 0 ? "No problems found" : `${problems.length} ${problems.length === 1 ? "problem" : "problems"}, ${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}`}</Badge>
              <span className="muted small">{clean} of {data.total} cabinets are clean{data.cabinets.some(c => c.state === "offline") ? `; ${data.cabinets.filter(c => c.state === "offline").length} offline, not checked` : ""}.</span></>}
          <button className="btn small" onClick={() => void rerun()} disabled={again.busy || data.state === "running"}>Run again</button>
          {again.problem && <span className="error small" role="alert">{again.problem}</span>}
        </p>

        <section className="panel" aria-labelledby="what-wrong">
          <h2 id="what-wrong">What is wrong</h2>
          {data.state === "running" && data.groups.length === 0 && <p className="muted">Waiting for the first results…</p>}
          {data.state === "done" && data.groups.length === 0 && <Empty>Nothing to fix: every checked cabinet matches its site and reaches what it needs.</Empty>}
          {[...problems, ...warnings].map(g => <GroupCard key={g.key} g={g} onFixed={() => void rerun()} />)}
        </section>

        <section className="panel" aria-labelledby="by-cabinet">
          <h2 id="by-cabinet">Cabinet by cabinet</h2>
          <p className="muted small">The path from the network link up to the firewall. A problem low down (the link, the address) explains the ones above it.</p>
          <div className="table-wrap"><table className="table compact matrix">
            <caption className="sr-only">Each cabinet's network path</caption>
            <thead><tr><th scope="col">Cabinet</th>{LAYERS.map(([k, n]) => <th key={k} scope="col">{n}</th>)}</tr></thead>
            <tbody>
              {data.cabinets.map(c => (
                <tr key={c.cabinetId}>
                  <th scope="row"><Link to={`/cabinets/${c.cabinetId}/network`}>{c.name}</Link><div className="muted small">{c.site}</div></th>
                  {c.layers ? LAYERS.map(([k]) => <td key={k}><span className={`cell ${c.layers![k]}`}>{CELL[c.layers![k]]}</span></td>)
                    : <td colSpan={LAYERS.length} className="muted small">{c.state === "offline" ? "Offline: not heard from in the last 5 minutes, so nothing was checked." : c.state === "running" ? "Checking…" : c.failure ?? "Could not be checked."}</td>}
                </tr>))}
              {data.waiting > 0 && <tr><td colSpan={LAYERS.length + 1} className="muted small">{data.waiting} more waiting their turn…</td></tr>}
            </tbody>
          </table></div>
        </section>
      </>)}
    </div>
  );
}

function GroupCard({ g, onFixed }: { g: Group; onFixed: () => void }) {
  const many = g.targets.length > 1;
  return (
    <article className={`group-card ${g.severity}`} aria-label={g.title}>
      <div className="finding-head">
        <Badge tone={g.severity === "problem" ? "crit" : "warn"}>{g.severity === "problem" ? "Problem" : "Warning"}</Badge>
        <strong>{g.title}</strong>
        <span className="muted small">{g.affected.length} {g.affected.length === 1 ? "cabinet" : "cabinets"}</span>
      </div>
      <ul className="chips" aria-label="Affected cabinets">{g.affected.map(n => <li key={n} className="chip">{n}</li>)}</ul>
      {g.fix && <p className="fix"><span className="muted">Fix:</span> {g.fix}</p>}
      {g.operation && g.targets.length > 0 ? (
        <div className="row gap wrap">
          {many && <FixAll operation={g.operation} cabinetIds={g.targets.map(t => t.cabinetId)}>{JOB_LABEL[g.operation] ?? g.operation} on all {g.targets.length}</FixAll>}
          {!many && g.targets[0] && <FixButton action={g.targets[0].action} onDone={onFixed}>{g.targets[0].label}</FixButton>}
        </div>
      ) : <p className="muted small">No change can be made from here: someone at the site needs to look.</p>}
      {many && <details><summary>Fix one at a time</summary>
        <ul className="plain">{g.targets.map(t => <li key={t.cabinetId} className="row gap wrap"><strong>{t.cabinetName}</strong> <span className="muted small">{t.label}</span>
          <FixButton action={t.action} onDone={onFixed}>Fix</FixButton></li>)}</ul>
      </details>}
    </article>
  );
}
