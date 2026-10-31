import { useLoad } from "../../lib/useLoad";
import { fullTime } from "../../lib/time";
import { Pager, usePaged } from "../../components/Pager";
import { Badge, Empty } from "../../components/ui";
import { useState } from "react";
import { actorText, incidentLine, linkLabel, stateOf, stepLabel, type IncidentDetail, type IncidentSummary } from "../../lib/incidents";

interface Row { id: string; operation: string; status: string; issuedAt: string; resultAt: string | null; issuedBy: string; errorCode: string | null; }

const TONE: Record<string, "ok" | "warn" | "crit" | "info" | "off"> = { succeeded: "ok", failed: "crit", rejected: "crit", expired: "warn", queued: "info", delivered: "info" };

export function History({ cabinetId }: { cabinetId: string }) {
  return (<><Incidents cabinetId={cabinetId} /><Commands cabinetId={cabinetId} /></>);
}

/** The cabinet's incidents, newest first; each opens to show its steps in order and what it links to. */
function Incidents({ cabinetId }: { cabinetId: string }) {
  const { data, problem, reload } = useLoad<IncidentSummary[]>(`/api/cabinets/${cabinetId}/incidents`);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="panel" aria-labelledby="incidents-heading">
      <div className="panel-head"><h2 id="incidents-heading">Incidents</h2><button className="btn" onClick={reload}>Refresh</button></div>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && data.length === 0 && <Empty>No incidents have been recorded on this cabinet.</Empty>}
      {data && data.length > 0 && (
        <ul className="plain">{data.map(i => {
          const [label, tone] = stateOf(i.state);
          return (
            <li key={i.id}>
              <p><Badge tone={tone}>{label}</Badge> <strong>{i.symptom}</strong> <span className="muted">opened {fullTime(i.openedAt)}</span></p>
              <p className="muted">{incidentLine(i)}</p>
              <button className="btn" aria-expanded={open === i.id} onClick={() => setOpen(open === i.id ? null : i.id)}>{open === i.id ? "Hide steps" : "Show steps"}</button>
              {open === i.id && <IncidentSteps cabinetId={cabinetId} incidentId={i.id} />}
            </li>);
        })}</ul>
      )}
    </section>
  );
}

function IncidentSteps({ cabinetId, incidentId }: { cabinetId: string; incidentId: string }) {
  const { data, problem } = useLoad<IncidentDetail>(`/api/cabinets/${cabinetId}/incidents/${incidentId}`);
  if (problem) return <p className="error" role="alert">{problem}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div>
      <ol className="timeline" aria-label="Steps, in order">{data.steps.map(s => (
        <li key={s.position}><span className="when">{fullTime(s.at)}</span><span><strong>{stepLabel(s.kind)}</strong>: {s.summary} <span className="muted">({actorText(s.actor)})</span></span></li>))}
      </ol>
      {data.links.length > 0 && <p className="muted">Linked: {data.links.map(l => linkLabel(l.kind)).join(", ")}</p>}
    </div>
  );
}

function Commands({ cabinetId }: { cabinetId: string }) {
  const { data, problem, reload } = useLoad<Row[]>(`/api/cabinets/${cabinetId}/commands`);
  const paged = usePaged(data ?? []);
  return (
    <section className="panel" aria-labelledby="history-heading">
      <div className="panel-head"><h2 id="history-heading">Command history</h2><button className="btn" onClick={reload}>Refresh</button></div>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && data.length === 0 && <Empty>No commands have been run on this cabinet yet.</Empty>}
      {data && data.length > 0 && (
        <table className="table">
          <caption className="sr-only">Last 50 commands</caption>
          <thead><tr><th scope="col">Issued</th><th scope="col">Operation</th><th scope="col">By</th><th scope="col">Outcome</th><th scope="col">Answered</th></tr></thead>
          <tbody>{paged.rows.map(r => (
            <tr key={r.id}><td>{fullTime(r.issuedAt)}</td><td><code>{r.operation}</code></td><td>{r.issuedBy}</td>
              <td><Badge tone={TONE[r.status] ?? "off"}>{r.status}{r.errorCode ? ` (${r.errorCode})` : ""}</Badge></td><td>{r.resultAt ? fullTime(r.resultAt) : "—"}</td></tr>))}
          </tbody>
        </table>
      )}
      <Pager {...paged} label="commands" />
    </section>
  );
}
