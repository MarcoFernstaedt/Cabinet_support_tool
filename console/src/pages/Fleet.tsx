import { useEffect, useState, type ReactNode } from "react";
import { ZONE_NAMES, zoneName } from "./cabinet/Time";
import { PORTS_SOURCE, PortsEditor, ScannerIdsEditor } from "../components/DeviceSettings";
import { api, describeError } from "../lib/api";
import { useAction } from "../lib/useAction";
import { useLoad } from "../lib/useLoad";
import { parseSyncPorts, SYNC_PORTS_RULE } from "../lib/ports";
import { Link } from "../lib/router";
import { atLeast, useSession } from "../lib/session";
import { ago } from "../lib/time";
import { Breadcrumbs } from "../components/Layout";
import { Badge, Empty, OnlineBadge, StepUpDialog } from "../components/ui";
import { useAlertNews } from "../lib/commands";
import { DemoTag } from "../components/DemoBanner";
import { BulkPolicyApply, describePolicy, PolicyEditor, type Policy } from "../components/FirewallPolicy";
import { WatchListEditor } from "./cabinet/Services";
import { useStartDiagnosis } from "./NetworkDiagnosis";

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
        <div className="totals"><span><strong>{data.sites.length}</strong> sites</span><span><strong>{total}</strong> cabinets</span><span><strong>{offline}</strong> offline</span><span><strong>{alerts}</strong> major {alerts === 1 ? "alert" : "alerts"}</span></div>
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
interface SiteDetail { id: string; name: string; client: { id: string; name: string }; timeZone: string | null; networkBaseline: Baseline | null;
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
        <SiteStandards key={`std-${data.id}`} siteId={data.id} name={data.name} role={me.role} onSaved={reload} />
        <SiteNetwork key={`net-${data.id}`} siteId={data.id} name={data.name} baseline={data.networkBaseline} cabinets={data.cabinets.length} editable={atLeast(me, "tier2")} onSaved={reload} />
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

interface Standards {
  clientId: string;
  current: { networkBaseline: Baseline | null; timeZone: string | null; clientFirewall: Policy | null; fleetFirewall: Policy };
  suggested: { networkBaseline: { baseline: Baseline; fromCabinet: { id: string; name: string }; readAt: string } | null;
    timeZone: { timeZone: string; fromCabinet: { id: string; name: string } } | null; firewall: { policy: Policy; fromCabinet: { id: string; name: string } } | null };
}

/**
 * Onboarding for a site: the three standards cabinets are compared with (network baseline, time zone, firewall policy), each with a
 * button to adopt what a cabinet here already reports. Those settings only say what "right" looks like; nothing changes on a cabinet.
 * The server checks the role and the authenticator code for each save.
 */
function SiteStandards({ siteId, name, role, onSaved }: { siteId: string; name: string; role: string; onSaved: () => void }) {
  const { data, reload } = useLoad<Standards>(`/api/sites/${siteId}/standards`);
  const [ask, setAsk] = useState<null | "baseline" | "firewall">(null);
  const [problem, setProblem] = useState<string | null>(null);
  const timeZone = useAction();
  const diagnose = useStartDiagnosis();
  if (!data) return null;
  const canTier2 = role === "tier2" || role === "admin", canAdmin = role === "admin";
  const { current: cur, suggested: sug } = data;
  const done = () => { reload(); onSaved(); };
  const rows: { label: string; value: ReactNode | null; action: ReactNode }[] = [
    { label: "Network",
      value: cur.networkBaseline ? <>{cur.networkBaseline.addressing === "dhcp" ? "DHCP" : "Fixed addresses"}, gateway <code>{cur.networkBaseline.gateway}</code>, DNS <code>{cur.networkBaseline.dnsServers.join(", ")}</code></> : null,
      action: cur.networkBaseline || !canTier2 ? null : sug.networkBaseline
        ? <button className="btn" onClick={() => setAsk("baseline")}>Use {sug.networkBaseline.fromCabinet.name}'s network</button>
        : <button className="btn" disabled={diagnose.busy} onClick={() => void diagnose.start({ siteId })}>Read the network first</button> },
    { label: "Time zone", value: cur.timeZone ? zoneName(cur.timeZone) : null,
      action: cur.timeZone || !canTier2 || !sug.timeZone ? null : <button className="btn" onClick={async () => {
        if (await timeZone.run(() => api("PUT", `/api/sites/${siteId}/time-zone`, { timeZone: sug.timeZone!.timeZone }))) done();
      }}>Use {zoneName(sug.timeZone.timeZone)} (from {sug.timeZone.fromCabinet.name})</button> },
    { label: "Firewall", value: cur.clientFirewall ? describePolicy(cur.clientFirewall) : null,
      action: cur.clientFirewall || !canAdmin || !sug.firewall ? null : <button className="btn" onClick={() => setAsk("firewall")}>Use {sug.firewall.fromCabinet.name}'s settings for the client</button> },
  ];
  const missing = rows.filter(r => !r.value).length;
  return (
    <section className="panel" aria-labelledby={`std-${siteId}`}>
      <h2 id={`std-${siteId}`}>Standards for {name}</h2>
      <p className="muted small">What this site's cabinets are compared with. {missing === 0 ? "All three are set." : "Set them once, from a cabinet that is already right, and every cabinet here is checked against them."} Nothing changes on a cabinet.</p>
      <ul className="plain">{rows.map(r => (
        <li key={r.label} className="row gap wrap"><strong>{r.label}:</strong> {r.value ?? <span className="muted">Not set{r.label === "Firewall" ? `; the fleet default applies (${describePolicy(cur.fleetFirewall)})` : ""}</span>} {r.action}</li>))}</ul>
      {diagnose.problem && <p className="error" role="alert">{diagnose.problem}</p>}
      {(problem ?? timeZone.problem) && <p className="error" role="alert">{problem ?? timeZone.problem}</p>}
      {sug.networkBaseline && !cur.networkBaseline && <StepUpDialog open={ask === "baseline"} action="site.network_baseline" target={siteId} params={{ baseline: sug.networkBaseline.baseline }} onClose={() => setAsk(null)}
        description={<p>Set the network baseline for <strong>{name}</strong> from <strong>{sug.networkBaseline.fromCabinet.name}</strong>: {sug.networkBaseline.baseline.addressing === "dhcp" ? "DHCP" : "fixed addresses"}, gateway {sug.networkBaseline.baseline.gateway}/{sug.networkBaseline.baseline.prefixLength}, DNS {sug.networkBaseline.baseline.dnsServers.join(", ")}. Check that this cabinet's network is the right one first. Nothing changes on a cabinet.</p>}
        onToken={async token => { try { await api("PUT", `/api/sites/${siteId}/network-baseline`, { baseline: sug.networkBaseline!.baseline, stepUpToken: token }); done(); } catch (e) { setProblem(describeError(e)); throw e; } }} />}
      {sug.firewall && !cur.clientFirewall && <StepUpDialog open={ask === "firewall"} action="client.firewall_policy" target={data.clientId} params={{ policy: sug.firewall.policy }} onClose={() => setAsk(null)}
        description={<p>Set the client's firewall policy to <strong>{describePolicy(sug.firewall.policy)}</strong>, as {sug.firewall.fromCabinet.name} has it now. It applies to every site of this client. Nothing changes on a cabinet until someone applies it.</p>}
        onToken={async token => { try { await api("PUT", `/api/clients/${data.clientId}/firewall-policy`, { policy: sug.firewall!.policy, stepUpToken: token }); done(); } catch (e) { setProblem(describeError(e)); throw e; } }} />}
    </section>
  );
}

interface Baseline { addressing: "dhcp" | "static"; prefixLength: number; gateway: string; dnsServers: string[] }

/**
 * The site's network: its baseline (what the network should look like), and the diagnosis of every cabinet here at once. A
 * baseline changes nothing on a cabinet; it is what the diagnosis compares each cabinet with. Tier 2 and up set it.
 */
function SiteNetwork({ siteId, name, baseline, cabinets, editable, onSaved }: { siteId: string; name: string; baseline: Baseline | null; cabinets: number; editable: boolean; onSaved: () => void }) {
  const diagnose = useStartDiagnosis();
  const [form, setForm] = useState({ addressing: baseline?.addressing ?? "dhcp", prefixLength: String(baseline?.prefixLength ?? 24), gateway: baseline?.gateway ?? "", dns: baseline?.dnsServers.join(", ") ?? "" });
  const [pending, setPending] = useState<{ baseline: Baseline | null } | undefined>();
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Opened from the demo guide: run the diagnosis straight away.
  useEffect(() => { if (new URLSearchParams(window.location.search).get("diagnose") === "network") void diagnose.start({ siteId }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = (): Baseline => ({ addressing: form.addressing as "dhcp" | "static", prefixLength: Number(form.prefixLength), gateway: form.gateway.trim(), dnsServers: form.dns.split(/[\s,]+/).filter(Boolean) });
  return (
    <section className="panel" aria-labelledby={`net-${siteId}`}>
      <div className="panel-head">
        <div>
          <h2 id={`net-${siteId}`}>Network at {name}</h2>
          <p className="muted small">Check every cabinet here at once: link, address, gateway, DNS, the sync cabinet and the firewall, compared with the baseline below. Where something differs, the fix is offered.</p>
        </div>
        <button className="btn primary" data-tour="site-diagnose" onClick={() => void diagnose.start({ siteId })} disabled={diagnose.busy || cabinets === 0 || cabinets > 60}>
          {diagnose.busy ? "Starting…" : `Diagnose network (${cabinets} ${cabinets === 1 ? "cabinet" : "cabinets"})`}</button>
      </div>
      {diagnose.problem && <p className="error" role="alert">{diagnose.problem}</p>}
      {baseline
        ? <p>Baseline: <strong>{baseline.addressing === "dhcp" ? "addresses from DHCP" : "fixed addresses"}</strong>, gateway <code>{baseline.gateway}</code>/{baseline.prefixLength}, DNS <code>{baseline.dnsServers.join(", ")}</code>.</p>
        : <p className="notice warn">No baseline is set for this site, so the diagnosis cannot tell whether an address, gateway or DNS server is wrong.{editable ? " Set it below." : " A Tier 2 person can set it."}</p>}
      {editable && (
        <form className="row gap wrap" onSubmit={e => { e.preventDefault(); setProblem(null); setSaved(false); setPending({ baseline: parsed() }); }}>
          <label className="field inline"><span>Addresses</span>
            <select value={form.addressing} onChange={e => setForm(f => ({ ...f, addressing: e.target.value as "dhcp" | "static" }))}><option value="dhcp">From DHCP</option><option value="static">Fixed</option></select></label>
          <label className="field inline"><span>Gateway</span><input required value={form.gateway} onChange={e => setForm(f => ({ ...f, gateway: e.target.value }))} placeholder="10.21.4.1" size={14} /></label>
          <label className="field inline"><span>Prefix length</span><input required inputMode="numeric" value={form.prefixLength} onChange={e => setForm(f => ({ ...f, prefixLength: e.target.value.replace(/\D/g, "") }))} size={3} /></label>
          <label className="field inline"><span>DNS servers (up to 4)</span><input required value={form.dns} onChange={e => setForm(f => ({ ...f, dns: e.target.value }))} placeholder="10.21.4.10, 10.21.4.11" size={26} /></label>
          <button className="btn" type="submit">Save baseline</button>
          {baseline && <button className="btn ghost" type="button" onClick={() => { setProblem(null); setSaved(false); setPending({ baseline: null }); }}>Remove</button>}
          {saved && <span className="ok" role="status">Saved.</span>}
          {problem && <span className="error" role="alert">{problem}</span>}
        </form>)}
      <StepUpDialog open={pending !== undefined} action="site.network_baseline" target={siteId} params={{ baseline: pending?.baseline ?? null }} onClose={() => setPending(undefined)}
        description={<p>{pending?.baseline ? <>Set the network baseline for <strong>{name}</strong>: {pending.baseline.addressing === "dhcp" ? "DHCP" : "fixed addresses"}, gateway {pending.baseline.gateway}/{pending.baseline.prefixLength}, DNS {pending.baseline.dnsServers.join(", ")}.</> : <>Remove the network baseline for <strong>{name}</strong>.</>} Nothing changes on a cabinet.</p>}
        onToken={async token => {
          try { await api("PUT", `/api/sites/${siteId}/network-baseline`, { baseline: pending?.baseline ?? null, stepUpToken: token }); setSaved(true); onSaved(); }
          catch (e) { setProblem(describeError(e)); throw e; }
        }} />
    </section>
  );
}

/**
 * The time zone a site's cabinets should use (module 21). Setting it changes nothing on a cabinet: cabinets in another
 * zone get a minor "Wrong time zone" alert, and are corrected from their Time section or Fleet operations. Tier 2 and up.
 */
function SiteTimeZone({ siteId, name, current, editable, onSaved }: { siteId: string; name: string; current: string | null; editable: boolean; onSaved: () => void }) {
  const [zone, setZone] = useState(current ?? "");
  const { run, problem, saved } = useAction();
  const save = async () => { if (await run(() => api("PUT", `/api/sites/${siteId}/time-zone`, { timeZone: zone || null }))) onSaved(); };
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
