import { useState } from "react";
import { ZONE_NAMES, zoneName } from "./cabinet/Time";
import { PORTS_SOURCE, PortsEditor, ScannerIdsEditor } from "../components/DeviceSettings";
import { api, describeError } from "../lib/api";
import { useLoad } from "../lib/useLoad";
import { parseSyncPorts, SYNC_PORTS_RULE } from "../lib/ports";
import { Link } from "../lib/router";
import { atLeast, useSession } from "../lib/session";
import { ago } from "../lib/time";
import { Breadcrumbs } from "../components/Layout";
import { Badge, Empty, OnlineBadge, StepUpDialog } from "../components/ui";
import { useAlertNews } from "../lib/commands";
import { DemoTag } from "../components/DemoBanner";
import { BulkPolicyApply, PolicyEditor, type Policy } from "../components/FirewallPolicy";
import { WatchListEditor } from "./cabinet/Services";

interface ClientRow { id: string; name: string; demo?: boolean; sites: number; cabinets: number; offline: number; openAlerts: number; openMajor: number; }

/**
 * Open alerts on the home page and client pages: major ones only. Minor alerts show only on their cabinet,
 * so the fleet view is not buried in early signs that only matter once someone is looking at that cabinet.
 */
export function AlertCount({ major }: { open?: number; major?: number }) {
  if (!major) return <Badge tone="ok">No major alerts</Badge>;
  return <Badge tone="crit">{major} major</Badge>;
}

export function FleetHome() {
  const { me } = useSession();
  const { data, problem, reload } = useLoad<ClientRow[]>("/api/fleet/clients");
  useAlertNews(reload);
  return (
    <div className="page">
      <h1>Fleet</h1>
      <p className="muted">Clients, their sites and cabinets. Use the jump box at the top to go straight to any cabinet.</p>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && data.length === 0 && <Empty>No cabinets have been approved yet. {atLeast(me, "admin")
        ? <>Start with <Link to="/admin/setup">Admin → Set up and demo</Link>: add your team, install the agent on a computer, or turn on demo mode.</>
        : "An admin approves new cabinets under Admin → Pending cabinets."}</Empty>}
      {data && data.length > 0 && (
        <table className="table">
          <caption className="sr-only">Clients</caption>
          <thead><tr><th scope="col">Client</th><th scope="col">Sites</th><th scope="col">Cabinets</th><th scope="col">Offline</th><th scope="col">Alerts</th></tr></thead>
          <tbody>{data.map(c => (
            <tr key={c.id}>
              <th scope="row"><Link to={`/clients/${c.id}`}>{c.name}</Link>{c.demo && <> <DemoTag /></>}</th>
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

interface ClientDetail { id: string; name: string; writePaused: boolean;
  scanner: { hardwareIds: string[] | null; fleetHardwareIds: string[] | null }; syncPorts: { ports: number[] | null; fleetPorts: number[] | null };
  sites: { id: string; name: string; cabinets: number; offline: number; openAlerts: number; openMajor: number }[]; }

export function ClientPage({ id }: { id: string }) {
  const { me } = useSession();
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
        <section className="panel" aria-labelledby="client-scanner">
          <h2 id="client-scanner">Fingerprint scanner for {data.name}</h2>
          <p className="muted small">Every cabinet of this client looks for these hardware IDs, unless its site or the cabinet has its own. When the client changes scanner, change it here once.</p>
          <ScannerIdsEditor key={data.id} label="This client's scanner IDs" current={data.scanner.hardwareIds}
            inherited={data.scanner.fleetHardwareIds ? <>the fleet default applies (<code>{data.scanner.fleetHardwareIds.join(", ")}</code>).</> : "cabinets find the scanner automatically (the Biometric device)."}
            endpoint={`/api/clients/${data.id}/scanner`} action="client.scanner" target={data.id} what={`every cabinet of ${data.name}`} editable={atLeast(me, "tier2")} onSaved={reload} />
        </section>
        <section className="panel" aria-labelledby="client-ports">
          <h2 id="client-ports">Sync cabinet ports for {data.name}</h2>
          <p className="muted small">The TCP ports the "Test sync cabinet" checks use at every site of this client, unless a site has its own.</p>
          <PortsEditor key={data.id} current={data.syncPorts.ports}
            inherited={data.syncPorts.fleetPorts?.length ? <>the fleet default applies (<strong>{data.syncPorts.fleetPorts.join(", ")}</strong>).</> : "no ports are set, so only ping and DNS tests run."}
            endpoint={`/api/clients/${data.id}/sync-ports`} action="client.sync" target={data.id} what={`every site of ${data.name}`} editable={atLeast(me, "admin")} onSaved={reload} />
        </section>
        <WatchedServices key={`watch-${data.id}`} level="clients" id={data.id} name={data.name} editable={atLeast(me, "tier2")} />
        <ClientFirewallPolicy key={data.id} clientId={data.id} name={data.name} editable={atLeast(me, "admin")} />
        <BulkPolicyApply key={`bulk-${data.id}`} scope="client" id={data.id} name={data.name} allowed={atLeast(me, "tier1")} />
      </>)}
    </div>
  );
}

export interface CabinetRow { id: string; name: string; demo?: boolean; role: string; status: string; online: boolean; lastHeartbeatAt: string | null; agentVersion: string | null; readOnly: boolean | null; hostname: string | null; openAlerts: number; }
interface SiteDetail { id: string; name: string; client: { id: string; name: string }; timeZone: string | null;
  sync: { address: string | null; ports: number[] | null; effectivePorts: number[]; portsSource: string };
  scanner: { hardwareIds: string[] | null; clientHardwareIds: string[] | null; fleetHardwareIds: string[] | null };
  cabinets: CabinetRow[]; }

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
              <th scope="row"><Link to={`/cabinets/${c.id}`}>{c.name}</Link>{c.demo && <> <DemoTag /></>}{c.hostname && <div className="muted small">{c.hostname}</div>}</th>
              <td>{roleLabel(c.role)}</td><td><OnlineBadge online={c.online} /></td><td>{ago(c.lastHeartbeatAt)}</td>
              <td>{c.agentVersion ?? "unknown"}</td><td>{c.readOnly ? "Yes" : "No"}</td>
              <td>{c.openAlerts > 0 ? <Link to={`/cabinets/${c.id}/alerts`}>{c.openAlerts} open</Link> : <span className="muted">None</span>}</td>
            </tr>))}
          </tbody>
        </table>
        <SiteTimeZone key={`tz-${data.id}`} siteId={data.id} name={data.name} current={data.timeZone} editable={atLeast(me, "tier2")} onSaved={reload} />
        <SyncSettings key={data.id} siteId={data.id} sync={data.sync} editable={atLeast(me, "admin")} onSaved={reload} />
        <section className="panel" aria-labelledby="site-scanner">
          <h2 id="site-scanner">Fingerprint scanner at {data.name}</h2>
          <p className="muted small">Only when this site uses a different scanner from the rest of {data.client.name}.</p>
          <ScannerIdsEditor key={data.id} label="This site's scanner IDs" current={data.scanner.hardwareIds}
            inherited={data.scanner.clientHardwareIds ? <>the client's setting applies (<code>{data.scanner.clientHardwareIds.join(", ")}</code>).</>
              : data.scanner.fleetHardwareIds ? <>the fleet default applies (<code>{data.scanner.fleetHardwareIds.join(", ")}</code>).</> : "cabinets find the scanner automatically (the Biometric device)."}
            endpoint={`/api/sites/${data.id}/scanner`} action="site.scanner" target={data.id} what={`every cabinet at ${data.name}`} editable={atLeast(me, "tier2")} onSaved={reload} />
        </section>
        <WatchedServices key={`watch-${data.id}`} level="sites" id={data.id} name={data.name} editable={atLeast(me, "tier2")} />
        <BulkPolicyApply key={`bulk-${data.id}`} scope="site" id={data.id} name={data.name} allowed={atLeast(me, "tier1")} />
      </>)}
    </div>
  );
}

/**
 * The time zone a site's cabinets should use (module 21). Setting it changes nothing on a cabinet: cabinets in another
 * zone get a minor "Wrong time zone" alert, and are corrected from their Time section or Fleet operations. Tier 2 and up.
 */
function SiteTimeZone({ siteId, name, current, editable, onSaved }: { siteId: string; name: string; current: string | null; editable: boolean; onSaved: () => void }) {
  const [zone, setZone] = useState(current ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async () => {
    setProblem(null); setSaved(false);
    try { await api("PUT", `/api/sites/${siteId}/time-zone`, { timeZone: zone || null }); setSaved(true); onSaved(); }
    catch (e) { setProblem(describeError(e)); }
  };
  return (
    <section className="panel" aria-labelledby={`tz-${siteId}`}>
      <h2 id={`tz-${siteId}`}>Time zone at {name}</h2>
      <p className="muted small">The zone this site's cabinets should use. A cabinet in another zone gets a "Wrong time zone" alert; nothing changes on a cabinet until someone corrects it.</p>
      {editable ? (
        <form className="row gap wrap" onSubmit={e => { e.preventDefault(); void save(); }}>
          <label className="field inline"><span>Time zone</span>
            <select value={zone} onChange={e => setZone(e.target.value)}>
              <option value="">Not set</option>
              {Object.entries(ZONE_NAMES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select></label>
          <button className="btn" disabled={zone === (current ?? "")}>Save</button>
          {saved && <span className="ok" role="status">Saved. Cabinets are compared with it at once.</span>}
          {problem && <span className="error" role="alert">{problem}</span>}
        </form>) : <p>{zoneName(current)}</p>}
    </section>
  );
}

/** The services this client's (or site's) cabinets keep running (milestone 10); Tier 2 and up change the list. */
function WatchedServices({ level, id, name, editable }: { level: "clients" | "sites"; id: string; name: string; editable: boolean }) {
  const { data, reload } = useLoad<{ own: string[] | null; client: string[] | null; fleet: string[] | null }>(`/api/${level}/${id}/watched-services`);
  const above = data?.client ? <>the client's list applies (<code>{data.client.join(", ") || "none"}</code>).</>
    : data?.fleet ? <>the fleet default applies (<code>{data.fleet.join(", ") || "none"}</code>).</> : null;
  return (
    <section className="panel" aria-labelledby={`${level}-watched`}>
      <h2 id={`${level}-watched`}>Watched services for {name}</h2>
      <p className="muted small">Windows services that must always run, such as the fingerprint scanner's. The agent starts them again whenever they stop and raises
        an alert after 3 failed restarts. A site or a cabinet can have its own list; the most specific one applies.</p>
      {data && <WatchListEditor endpoint={`/api/${level}/${id}/watched-services`} own={data.own} inherited={above}
        what={level === "clients" ? `every cabinet of ${name}` : `every cabinet at ${name}`} editable={editable} onSaved={reload} />}
    </section>
  );
}

/** The site's sync cabinet (Admin, with step-up). Each cabinet also refuses an address not on its own network. Empty ports use the client's (else the fleet's). */
function SyncSettings({ siteId, sync, editable, onSaved }: { siteId: string; sync: SiteDetail["sync"]; editable: boolean; onSaved: () => void }) {
  const [address, setAddress] = useState(sync.address ?? "");
  const [ports, setPorts] = useState((sync.ports ?? []).join(", "));
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { ports: parsedPorts, valid: portsValid } = parseSyncPorts(ports);
  return (
    <section className="panel" aria-labelledby="sync-heading">
      <h2 id="sync-heading">Sync cabinet</h2>
      <p className="muted small">Used by the "Test sync cabinet" network tests on this site's cabinets. Cabinets only accept a private address on their own network.</p>
      <p>{sync.address ? <>Address <code>{sync.address}</code></> : "No address set yet."} · Ports in use: <strong>{sync.effectivePorts.length ? sync.effectivePorts.join(", ") : "none"}</strong>
        <span className="muted"> (from {PORTS_SOURCE[sync.portsSource] ?? sync.portsSource})</span></p>
      {editable && (
        <form className="row gap wrap" onSubmit={e => { e.preventDefault(); setProblem(null); setSaved(false); setConfirming(true); }}>
          <label className="field"><span>IPv4 address</span><input value={address} placeholder="e.g. 10.20.0.15" onChange={e => setAddress(e.target.value.trim())} /></label>
          <label className="field"><span>This site's TCP ports (up to 4; empty to use the client's)</span><input value={ports} placeholder="e.g. 1433" onChange={e => setPorts(e.target.value)} /></label>
          <button className="btn" disabled={!portsValid}>Save</button>
          {!portsValid && <span className="error">{SYNC_PORTS_RULE}</span>}
          {problem && <span className="error" role="alert">{problem}</span>}
          {saved && <span className="ok" role="status">Saved.</span>}
        </form>
      )}
      <StepUpDialog open={confirming} action="site.sync" target={siteId} onClose={() => setConfirming(false)}
        params={{ address: address || null, ports: parsedPorts.length ? parsedPorts : null }}
        description={<p>Set this site's sync cabinet to <strong>{address || "none"}</strong> with {parsedPorts.length ? <>ports <strong>{parsedPorts.join(", ")}</strong></> : "the client's default ports"}.</p>}
        onToken={async token => {
          try {
            await api("PUT", `/api/sites/${siteId}/sync`, { address: address || null, ports: parsedPorts.length ? parsedPorts : null, stepUpToken: token });
            setSaved(true);
            onSaved();
          } catch (e) { setProblem(describeError(e)); }
        }} />
    </section>
  );
}

/** A client's own firewall policy (Admin, with a code), or the fleet default when it has none. */
function ClientFirewallPolicy({ clientId, name, editable }: { clientId: string; name: string; editable: boolean }) {
  const { data, reload } = useLoad<{ own: Policy | null; fleet: Policy }>(`/api/clients/${clientId}/firewall-policy`);
  return (
    <section className="panel" aria-labelledby="client-firewall">
      <h2 id="client-firewall">Firewall policy for {name}</h2>
      <p className="muted small">Which Windows firewall profiles this client's cabinets should have on or off. Cabinets that differ raise a minor alert;
        Tier 1 and up apply the policy from the cabinet page, or to all of them below.</p>
      {data && <PolicyEditor current={data.own} inherited={data.fleet} endpoint={`/api/clients/${clientId}/firewall-policy`} action="client.firewall_policy"
        target={clientId} what={name} editable={editable} onSaved={reload} />}
    </section>
  );
}
