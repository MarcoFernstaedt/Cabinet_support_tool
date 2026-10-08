import { useEffect, useState } from "react";
import { api, describeError } from "../lib/api";
import { Link } from "../lib/router";
import { atLeast, useSession } from "../lib/session";
import { ago } from "../lib/time";
import { Breadcrumbs } from "../components/Layout";
import { Badge, Empty, OnlineBadge, StepUpDialog } from "../components/ui";
import { useAlertNews } from "../lib/commands";

export function useLoad<T>(path: string | null): { data: T | null; problem: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setProblem(null);
    api<T>("GET", path).then(d => { if (live) setData(d); }, e => { if (live) setProblem(describeError(e)); });
    return () => { live = false; };
  }, [path, tick]);
  return { data, problem, reload: () => setTick(t => t + 1) };
}

interface ClientRow { id: string; name: string; sites: number; cabinets: number; offline: number; openAlerts: number; openMajor: number; }

/**
 * Open alerts on the home page and client pages: major ones only. Minor alerts show only on their cabinet,
 * so the fleet view is not buried in early signs that only matter once someone is looking at that cabinet.
 */
export function AlertCount({ major }: { open?: number; major?: number }) {
  if (!major) return <Badge tone="ok">No major alerts</Badge>;
  return <Badge tone="crit">{major} major</Badge>;
}

export function FleetHome() {
  const { data, problem, reload } = useLoad<ClientRow[]>("/api/fleet/clients");
  useAlertNews(reload);
  return (
    <div className="page">
      <h1>Fleet</h1>
      <p className="muted">Clients, their sites and cabinets. Use the jump box at the top to go straight to any cabinet.</p>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && data.length === 0 && <Empty>No cabinets have been approved yet. An admin approves new cabinets under Admin → Pending cabinets.</Empty>}
      {data && data.length > 0 && (
        <table className="table">
          <caption className="sr-only">Clients</caption>
          <thead><tr><th scope="col">Client</th><th scope="col">Sites</th><th scope="col">Cabinets</th><th scope="col">Offline</th><th scope="col">Alerts</th></tr></thead>
          <tbody>{data.map(c => (
            <tr key={c.id}>
              <th scope="row"><Link to={`/clients/${c.id}`}>{c.name}</Link></th>
              <td>{c.sites}</td><td>{c.cabinets}</td>
              <td>{c.offline > 0 ? <Badge tone="warn">{c.offline} offline</Badge> : <Badge tone="ok">All online</Badge>}</td>
              <td><AlertCount open={c.openAlerts} major={c.openMajor} /></td>
            </tr>))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface ClientDetail { id: string; name: string; writePaused: boolean; sites: { id: string; name: string; cabinets: number; offline: number; openAlerts: number; openMajor: number }[]; }

export function ClientPage({ id }: { id: string }) {
  const { data, problem, reload } = useLoad<ClientDetail>(`/api/fleet/clients/${id}`);
  useAlertNews(reload);
  const total = data?.sites.reduce((n, s) => n + s.cabinets, 0) ?? 0;
  const offline = data?.sites.reduce((n, s) => n + s.offline, 0) ?? 0;
  const alerts = data?.sites.reduce((n, s) => n + s.openMajor, 0) ?? 0;
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Fleet", to: "/" }, { label: data?.name ?? "Client" }]} />
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && (<>
        <h1>{data.name}</h1>
        <div className="totals"><span><strong>{data.sites.length}</strong> sites</span><span><strong>{total}</strong> cabinets</span><span><strong>{offline}</strong> offline</span><span><strong>{alerts}</strong> major alerts</span></div>
        <table className="table">
          <caption className="sr-only">Sites of {data.name}</caption>
          <thead><tr><th scope="col">Site</th><th scope="col">Cabinets</th><th scope="col">Offline</th><th scope="col">Alerts</th></tr></thead>
          <tbody>{data.sites.map(s => (
            <tr key={s.id}><th scope="row"><Link to={`/sites/${s.id}`}>{s.name}</Link></th><td>{s.cabinets}</td>
              <td>{s.offline > 0 ? <Badge tone="warn">{s.offline} offline</Badge> : <Badge tone="ok">All online</Badge>}</td>
              <td><AlertCount open={s.openAlerts} major={s.openMajor} /></td></tr>))}
          </tbody>
        </table>
      </>)}
    </div>
  );
}

export interface CabinetRow { id: string; name: string; role: string; status: string; online: boolean; lastHeartbeatAt: string | null; agentVersion: string | null; readOnly: boolean | null; hostname: string | null; openAlerts: number; }
interface SiteDetail { id: string; name: string; client: { id: string; name: string }; sync: { address: string | null; ports: number[] }; cabinets: CabinetRow[]; }

export const roleLabel = (r: string) => ({ sync: "Sync", satellite: "Satellite", standalone: "Standalone" } as Record<string, string>)[r] ?? r;

export function SitePage({ id }: { id: string }) {
  const { me } = useSession();
  const { data, problem, reload } = useLoad<SiteDetail>(`/api/fleet/sites/${id}`);
  useAlertNews(reload);
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Fleet", to: "/" }, ...(data ? [{ label: data.client.name, to: `/clients/${data.client.id}` }] : []), { label: data?.name ?? "Site" }]} />
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && (<>
        <h1>{data.name}</h1>
        <table className="table">
          <caption className="sr-only">Cabinets at {data.name}</caption>
          <thead><tr><th scope="col">Cabinet</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Last heard</th><th scope="col">Agent</th><th scope="col">Read-only</th><th scope="col">Alerts</th></tr></thead>
          <tbody>{data.cabinets.map(c => (
            <tr key={c.id}>
              <th scope="row"><Link to={`/cabinets/${c.id}`}>{c.name}</Link>{c.hostname && <div className="muted small">{c.hostname}</div>}</th>
              <td>{roleLabel(c.role)}</td><td><OnlineBadge online={c.online} /></td><td>{ago(c.lastHeartbeatAt)}</td>
              <td>{c.agentVersion ?? "unknown"}</td><td>{c.readOnly ? "Yes" : "No"}</td>
              <td>{c.openAlerts > 0 ? <Link to={`/cabinets/${c.id}/alerts`}>{c.openAlerts} open</Link> : <span className="muted">None</span>}</td>
            </tr>))}
          </tbody>
        </table>
        <SyncSettings siteId={data.id} sync={data.sync} editable={atLeast(me, "admin")} onSaved={reload} />
      </>)}
    </div>
  );
}

/** The site's sync cabinet (Admin, with step-up). Each cabinet also refuses an address not on its own network. */
function SyncSettings({ siteId, sync, editable, onSaved }: { siteId: string; sync: SiteDetail["sync"]; editable: boolean; onSaved: () => void }) {
  const [address, setAddress] = useState(sync.address ?? "");
  const [ports, setPorts] = useState(sync.ports.join(", "));
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const parsedPorts = ports.split(/[\s,]+/).filter(Boolean).map(Number);
  const portsValid = parsedPorts.length <= 4 && parsedPorts.every(p => Number.isInteger(p) && p >= 1 && p <= 65535);
  return (
    <section className="panel" aria-labelledby="sync-heading">
      <h2 id="sync-heading">Sync cabinet</h2>
      <p className="muted small">Used by the "Test sync cabinet" network tests on this site's cabinets. Cabinets only accept a private address on their own network.</p>
      {!editable && <p>{sync.address ? <>Address <code>{sync.address}</code>, ports {sync.ports.length ? sync.ports.join(", ") : "none"}.</> : "Not set yet."}</p>}
      {editable && (
        <form className="row gap wrap" onSubmit={e => { e.preventDefault(); setProblem(null); setSaved(false); setConfirming(true); }}>
          <label className="field"><span>IPv4 address</span><input value={address} placeholder="e.g. 10.20.0.15" onChange={e => setAddress(e.target.value.trim())} /></label>
          <label className="field"><span>TCP ports (up to 4, comma separated)</span><input value={ports} placeholder="e.g. 1433" onChange={e => setPorts(e.target.value)} /></label>
          <button className="btn" disabled={!portsValid}>Save</button>
          {!portsValid && <span className="error">Up to 4 ports between 1 and 65535.</span>}
          {problem && <span className="error" role="alert">{problem}</span>}
          {saved && <span className="ok" role="status">Saved.</span>}
        </form>
      )}
      <StepUpDialog open={confirming} action="site.sync" target={siteId} onClose={() => setConfirming(false)}
        description={<p>Set this site's sync cabinet to <strong>{address || "none"}</strong> with ports <strong>{parsedPorts.join(", ") || "none"}</strong>.</p>}
        onToken={async token => {
          try {
            await api("PUT", `/api/sites/${siteId}/sync`, { address: address || null, ports: parsedPorts, stepUpToken: token });
            setSaved(true);
            onSaved();
          } catch (e) { setProblem(describeError(e)); }
        }} />
    </section>
  );
}
