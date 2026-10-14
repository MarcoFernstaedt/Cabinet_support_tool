// The cabinet's alerts section: its active alerts, recently resolved ones, and what its
// monitors reported, with Map to issue on anything not yet recognized.
import { useState } from "react";
import { describeMatch, KIND_LABEL, type Alert, type StoredEvent } from "../../lib/alerts";
import { useAlertNews } from "../../lib/commands";
import { atLeast, useSession } from "../../lib/session";
import { fullTime } from "../../lib/time";
import { AlertList, matchFor } from "../../components/AlertList";
import { MapToIssue } from "../../components/MapToIssue";
import { Badge, Empty } from "../../components/ui";
import { useLoad } from "../../lib/useLoad";

export const SCANNER_ISSUE = "00000000-0000-4000-8000-000000000101";

export function CabinetAlerts({ cabinetId, issueTypeId, title = "Alerts" }: { cabinetId: string; issueTypeId?: string; title?: string }) {
  const [resolved, setResolved] = useState(false);
  const base = `/api/alerts?cabinetId=${cabinetId}${issueTypeId ? `&issueTypeId=${issueTypeId}` : ""}`;
  const active = useLoad<Alert[]>(base);
  const done = useLoad<Alert[]>(resolved ? `${base}&state=resolved` : null);
  const reload = () => { active.reload(); if (resolved) done.reload(); };
  useAlertNews(n => { if (n.cabinet.id === cabinetId) reload(); });
  return (
    <section className="panel" aria-labelledby={`alerts-${issueTypeId ?? "all"}`}>
      <div className="panel-head">
        <h2 id={`alerts-${issueTypeId ?? "all"}`}>{title}</h2>
        <button className="btn ghost small" onClick={() => setResolved(r => !r)} aria-expanded={resolved}>{resolved ? "Hide resolved" : "Show resolved"}</button>
      </div>
      {active.problem && <p className="error" role="alert">{active.problem}</p>}
      {active.data && <AlertList alerts={active.data} onChanged={reload} showCabinet={false} empty="No open alerts." />}
      {resolved && done.data && (<><h3>Resolved</h3><AlertList alerts={done.data.slice(0, 50)} onChanged={reload} showCabinet={false} empty="Nothing resolved yet." /></>)}
    </section>
  );
}

/** What the agent's background monitors sent, newest first. */
export function MonitorEvents({ cabinetId }: { cabinetId: string }) {
  const { me } = useSession();
  const { data, problem, reload } = useLoad<(StoredEvent | null)[]>(`/api/cabinets/${cabinetId}/events`);
  const [mapping, setMapping] = useState<StoredEvent | null>(null);
  useAlertNews(n => { if (n.cabinet.id === cabinetId) reload(); });
  const events = (data ?? []).filter((e): e is StoredEvent => e !== null);
  return (
    <section className="panel" aria-labelledby="monitor-heading">
      <h2 id="monitor-heading">Reported by the cabinet</h2>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && events.length === 0 && <Empty>Nothing reported yet.</Empty>}
      {events.length > 0 && (
        <table className="table compact">
          <caption className="sr-only">Events reported by the cabinet</caption>
          <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">Detail</th><th scope="col">Maps to</th></tr></thead>
          <tbody>{events.map(e => (
            <tr key={e.eventId}>
              <td>{fullTime(e.occurredAt)}</td>
              <td>{KIND_LABEL[e.kind] ?? e.kind}{e.source && <div className="muted small">{e.source.source} · {e.source.eventId} · {e.source.log}</div>}
                {e.device && <div className="muted small">{e.device.state.replace("_", " ")}</div>}</td>
              <td className="wrap">{e.detail?.message ?? ""}</td>
              <td>{e.issueName ? <Badge tone="info">{e.issueName}</Badge> : e.alertId ? <Badge tone="off">Unrecognized</Badge> : <span className="muted">—</span>}
                {!e.issueName && e.alertId && atLeast(me, "tier2") && <div><button className="btn small" onClick={() => setMapping(e)}>Map to issue</button></div>}</td>
            </tr>))}
          </tbody>
        </table>)}
      <MapToIssue open={mapping !== null} initial={mapping ? matchFor(mapping) : {}} onClose={() => { setMapping(null); reload(); }} />
      {mapping && <span className="sr-only">{describeMatch(matchFor(mapping))}</span>}
    </section>
  );
}
