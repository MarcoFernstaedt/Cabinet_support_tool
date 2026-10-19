// The Alerts area (docs/spec/06-console-spec.md "Alerts area"): every alert with filters,
// the unrecognized errors, and the offline filter from clients down to cabinets.
import { useState } from "react";
import { type Alert, type IssueType } from "../../lib/alerts";
import { useAlertNews } from "../../lib/commands";
import { Link, useRouter } from "../../lib/router";
import { ago } from "../../lib/time";
import { AlertList } from "../../components/AlertList";
import { Badge, Empty } from "../../components/ui";
import { useLoad } from "../../lib/useLoad";

type View = "alerts" | "unrecognized" | "offline";
interface Filters { state: string; issueTypeId: string; claimedBy: string; clientId: string; siteId: string }

export function AlertsPage() {
  const { path, navigate } = useRouter();
  const query = new URLSearchParams(path.split("?")[1] ?? "");
  const view = (["alerts", "unrecognized", "offline"].includes(query.get("view") ?? "") ? query.get("view") : "alerts") as View;
  const setView = (v: View) => navigate(v === "alerts" ? "/alerts" : `/alerts?view=${v}`);
  return (
    <div className="page">
      <h1>Alerts</h1>
      <div className="subtabs" role="group" aria-label="Alert views">
        <button aria-pressed={view === "alerts"} onClick={() => setView("alerts")}>Major alerts</button>
        <button aria-pressed={view === "unrecognized"} onClick={() => setView("unrecognized")}>Unrecognized errors</button>
        <button aria-pressed={view === "offline"} onClick={() => setView("offline")}>Offline cabinets</button>
        <button aria-pressed={false} onClick={() => navigate("/triage")}>Triage and trends</button>
      </div>
      {view === "offline" ? <Offline clientId={query.get("clientId")} siteId={query.get("siteId")} /> : <AlertsView unrecognized={view === "unrecognized"} />}
    </div>
  );
}

function AlertsView({ unrecognized }: { unrecognized: boolean }) {
  const [f, setF] = useState<Filters>({ state: "active", issueTypeId: "", claimedBy: "", clientId: "", siteId: "" });
  const issues = useLoad<IssueType[]>("/api/issues");
  const clients = useLoad<{ id: string; name: string }[]>("/api/fleet/clients");
  const client = useLoad<{ sites: { id: string; name: string }[] }>(f.clientId ? `/api/fleet/clients/${f.clientId}` : null);
  const q = new URLSearchParams();
  if (f.state) q.set("state", f.state);
  if (unrecognized) q.set("unrecognized", "true");
  else {
    // The Alerts tab shows major alerts; minor ones show only on their cabinet (issue types and rules set which is which).
    q.set("severity", "major");
    if (f.issueTypeId) q.set("issueTypeId", f.issueTypeId);
  }
  if (f.claimedBy) q.set("claimedBy", f.claimedBy);
  if (f.siteId) q.set("siteId", f.siteId);
  else if (f.clientId) q.set("clientId", f.clientId);
  const { data, problem, reload } = useLoad<Alert[]>(`/api/alerts?${q.toString()}`);
  useAlertNews(reload);
  return (<>
    <form className="filters" onSubmit={e => e.preventDefault()} aria-label="Filter alerts">
      {!unrecognized && <label className="field"><span>Issue</span>
        <select value={f.issueTypeId} onChange={e => setF({ ...f, issueTypeId: e.target.value })}><option value="">Any</option>
          {issues.data?.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>}
      <label className="field"><span>Client</span>
        <select value={f.clientId} onChange={e => setF({ ...f, clientId: e.target.value, siteId: "" })}><option value="">Any</option>
          {clients.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      {f.clientId && <label className="field"><span>Site</span>
        <select value={f.siteId} onChange={e => setF({ ...f, siteId: e.target.value })}><option value="">Any</option>
          {client.data?.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
      <label className="field"><span>State</span>
        <select value={f.state} onChange={e => setF({ ...f, state: e.target.value })}>
          <option value="active">Open or claimed</option><option value="open">Open</option><option value="claimed">Claimed</option><option value="resolved">Resolved</option></select></label>
      <label className="field"><span>Assigned</span>
        <select value={f.claimedBy} onChange={e => setF({ ...f, claimedBy: e.target.value })}><option value="">Anyone</option><option value="me">Claimed by me</option></select></label>
    </form>
    {problem && <p className="error" role="alert">{problem}</p>}
    {data && <AlertList alerts={data} onChanged={reload} empty={unrecognized ? "No unrecognized errors match." : "No alerts match these filters."} />}
  </>);
}

interface OfflineLevel { level: "clients" | "sites" | "cabinets"; thresholdDays: number; items: { id: string; name: string; offline?: number; cabinets?: number; lastHeartbeatAt?: string | null; pastThreshold?: boolean }[] }

function Offline({ clientId, siteId }: { clientId: string | null; siteId: string | null }) {
  const path = siteId ? `/api/alerts/offline?siteId=${encodeURIComponent(siteId)}` : clientId ? `/api/alerts/offline?clientId=${encodeURIComponent(clientId)}` : "/api/alerts/offline";
  const { data, problem } = useLoad<OfflineLevel>(path);
  return (<>
    <p className="muted">A cabinet is offline after 5 minutes without a heartbeat. Past {data?.thresholdDays ?? 5} days it also becomes an alert, which resolves itself when the cabinet returns.</p>
    {(clientId || siteId) && <p><Link to="/alerts?view=offline">All clients</Link></p>}
    {problem && <p className="error" role="alert">{problem}</p>}
    {data && data.items.length === 0 && <Empty>No cabinets are offline here.</Empty>}
    {data && data.items.length > 0 && (
      <table className="table">
        <caption className="sr-only">Offline {data.level}</caption>
        <thead><tr><th scope="col">{data.level === "clients" ? "Client" : data.level === "sites" ? "Site" : "Cabinet"}</th>
          <th scope="col">{data.level === "cabinets" ? "Last heard from" : "Offline"}</th>{data.level === "cabinets" && <th scope="col">Alert</th>}</tr></thead>
        <tbody>{data.items.map(i => (
          <tr key={i.id}>
            <th scope="row">{data.level === "clients" ? <Link to={`/alerts?view=offline&clientId=${i.id}`}>{i.name}</Link>
              : data.level === "sites" ? <Link to={`/alerts?view=offline&siteId=${i.id}`}>{i.name}</Link> : <Link to={`/cabinets/${i.id}`}>{i.name}</Link>}</th>
            <td>{data.level === "cabinets" ? ago(i.lastHeartbeatAt) : <>{i.offline} of {i.cabinets} cabinets</>}</td>
            {data.level === "cabinets" && <td>{i.pastThreshold ? <Badge tone="warn">Past the threshold</Badge> : <Badge tone="off">Status only</Badge>}</td>}
          </tr>))}
        </tbody>
      </table>)}
  </>);
}
