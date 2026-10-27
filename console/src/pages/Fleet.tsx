import { Pager, usePaged } from "../components/Pager";
import { DrivesAtRisk } from "../components/DriveTrends";
import { useEffect, useState, type ReactNode } from "react";
import { ZONE_NAMES, zoneName } from "./cabinet/Time";
import { PortsEditor, ScannerIdsEditor } from "../components/DeviceSettings";
import { SiteSync, type SiteSyncInfo } from "../components/SyncCabinets";
import { ClientScannerPanel, type ClientScannerState } from "../components/ClientScanner";
import { api, describeError } from "../lib/api";
import { useAction } from "../lib/useAction";
import { useLoad } from "../lib/useLoad";
import { Link } from "../lib/router";
import { atLeast, useSession } from "../lib/session";
import { ago } from "../lib/time";
import { architectureLabel } from "../lib/architecture";
import { Breadcrumbs } from "../components/Layout";
import { Badge, ConfirmDialog, Empty, OnlineBadge, StepUpDialog } from "../components/ui";
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
  const paged = usePaged(data ?? []);
  return (
    <div className="page">
      <h1>Fleet</h1>
      {problem && <p className="error" role="alert">{problem}</p>}
      <DrivesAtRisk />
      {data && data.length === 0 && <Empty>No cabinets have been approved yet. {atLeast(me, "admin")
        ? <>Set up from <Link to="/admin/setup">Admin → Setup</Link>: create your team, install the agent on a cabinet, then approve it.</>
        : "An admin approves new cabinets under Admin → Pending cabinets."}</Empty>}
      {data && data.length > 0 && (
        <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Clients</caption>
          <thead><tr><th scope="col">Client</th><th scope="col">Sites</th><th scope="col">Cabinets</th><th scope="col">Offline</th><th scope="col">Alerts</th></tr></thead>
          <tbody>{paged.rows.map(c => (
            <tr key={c.id}>
              <th scope="row"><Link to={`/clients/${c.id}`}>{c.name}</Link>{c.demo && <> <DemoTag /></>}</th>
              <td>{c.sites}</td><td>{c.cabinets}</td>
              <td>{c.offline > 0 ? <Badge tone="warn">{c.offline} offline</Badge> : <Badge tone="ok">All online</Badge>}</td>
              <td><AlertCount open={c.openAlerts} major={c.openMajor} /></td>
            </tr>))}
          </tbody>
        </table></div>
      )}
      <Pager {...paged} label="clients" />
    </div>
  );
}

interface ClientDetail { id: string; name: string; writePaused: boolean;
  scanner: { hardwareIds: string[] | null; fleetHardwareIds: string[] | null }; syncPorts: { ports: number[] | null; fleetPorts: number[] | null };
  fingerprintScanner: ClientScannerState | null;
  sites: { id: string; name: string; cabinets: number; offline: number; openAlerts: number; openMajor: number }[]; }

export function ClientPage({ id }: { id: string }) {
  const { me } = useSession();
  const { data, problem, reload } = useLoad<ClientDetail>(`/api/fleet/clients/${id}`);
  useAlertNews(reload);
  const sitesPaged = usePaged(data?.sites ?? []);
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
        <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Sites of {data.name}</caption>
          <thead><tr><th scope="col">Site</th><th scope="col">Cabinets</th><th scope="col">Offline</th><th scope="col">Alerts</th></tr></thead>
          <tbody>{sitesPaged.rows.map(s => (
            <tr key={s.id}><th scope="row"><Link to={`/sites/${s.id}`}>{s.name}</Link></th><td>{s.cabinets}</td>
              <td>{s.offline > 0 ? <Badge tone="warn">{s.offline} offline</Badge> : <Badge tone="ok">All online</Badge>}</td>
              <td><AlertCount open={s.openAlerts} major={s.openMajor} /></td></tr>))}
          </tbody>
        </table></div>
        <Pager {...sitesPaged} label="sites" />
        <section className="panel" aria-labelledby="client-scanner">
          <h2 id="client-scanner">Fingerprint scanner for {data.name}</h2>
          <ClientScannerPanel key={`fs-${data.id}`} clientId={data.id} name={data.name} state={data.fingerprintScanner} admin={atLeast(me, "admin")} onSaved={reload} />
          {data.fingerprintScanner?.enabled !== false && <ScannerIdsEditor key={data.id} label="This client's scanner IDs" current={data.scanner.hardwareIds}
            inherited={data.scanner.fleetHardwareIds ? <>the fleet default applies (<code>{data.scanner.fleetHardwareIds.join(", ")}</code>).</> : "cabinets find the scanner automatically (the Biometric device)."}
            endpoint={`/api/clients/${data.id}/scanner`} action="client.scanner" target={data.id} what={`every cabinet of ${data.name}`} editable={atLeast(me, "tier2")} onSaved={reload} />}
        </section>
        <section className="panel" aria-labelledby="client-ports">
          <h2 id="client-ports">Sync cabinet ports for {data.name}</h2>
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

export interface CabinetRow { id: string; name: string; demo?: boolean; role: string; status: string; online: boolean; lastHeartbeatAt: string | null; agentVersion: string | null; architecture: string | null; readOnly: boolean | null; hostname: string | null; openAlerts: number; unsignedUpgrades?: boolean; syncUnassigned?: boolean; }
export interface SiteDetail { id: string; name: string; client: { id: string; name: string }; timeZone: string | null; networkBaseline: Baseline | null;
  sync: SiteSyncInfo;
  scanner: { hardwareIds: string[] | null; clientHardwareIds: string[] | null; fleetHardwareIds: string[] | null };
  cabinets: CabinetRow[]; }

export const roleLabel = (r: string) => ({ sync: "Sync", satellite: "Satellite", standalone: "Standalone" } as Record<string, string>)[r] ?? r;

export function SitePage({ id }: { id: string }) {
  const { me } = useSession();
  const { data, problem, reload } = useLoad<SiteDetail>(`/api/fleet/sites/${id}`);
  useAlertNews(reload);
  const cabinetsPaged = usePaged(data?.cabinets ?? []);
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Fleet", to: "/" }, ...(data ? [{ label: data.client.name, to: `/clients/${data.client.id}` }] : []), { label: data?.name ?? "Site" }]} />
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && (<>
        <h1>{data.name}</h1>
        <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Cabinets at {data.name}</caption>
          <thead><tr><th scope="col">Cabinet</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Last heard</th><th scope="col">Agent</th><th scope="col">Read-only</th><th scope="col">Alerts</th></tr></thead>
          <tbody>{cabinetsPaged.rows.map(c => (
            <tr key={c.id}>
              <th scope="row"><Link to={`/cabinets/${c.id}`}>{c.name}</Link>{c.demo && <> <DemoTag /></>}{c.hostname && <div className="muted small">{c.hostname}</div>}</th>
              <td>{roleLabel(c.role)}{c.syncUnassigned && <div><Badge tone="warn">Enrollment incomplete</Badge></div>}</td><td><OnlineBadge online={c.online} /></td><td>{ago(c.lastHeartbeatAt)}</td>
              <td>{c.agentVersion ?? "unknown"}{architectureLabel(c.architecture) && <div className="muted small">{architectureLabel(c.architecture)}</div>}
                {c.unsignedUpgrades && <div><Badge tone="warn">Test build</Badge></div>}</td><td>{c.readOnly ? "Yes" : "No"}</td>
              <td>{c.openAlerts > 0 ? <Link to={`/cabinets/${c.id}/alerts`}>{c.openAlerts} open</Link> : <span className="muted">None</span>}</td>
            </tr>))}
          </tbody>
        </table></div>
        <Pager {...cabinetsPaged} label="cabinets" />
        <SiteStandards key={`std-${data.id}`} siteId={data.id} name={data.name} role={me.role} onSaved={reload} />
        <SiteNetwork key={`net-${data.id}`} siteId={data.id} name={data.name} baseline={data.networkBaseline} cabinets={data.cabinets.length} editable={atLeast(me, "tier2")} onSaved={reload} />
        <SiteTimeZone key={`tz-${data.id}`} siteId={data.id} name={data.name} current={data.timeZone} editable={atLeast(me, "tier2")} onSaved={reload} />
        <SiteSync key={data.id} siteId={data.id} name={data.name} sync={data.sync} editable={atLeast(me, "admin")} onSaved={reload} />
        <section className="panel" aria-labelledby="site-scanner">
          <h2 id="site-scanner">Fingerprint scanner at {data.name}</h2>
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
      <ul className="plain">{rows.map(r => (
        <li key={r.label} className="row gap wrap"><strong>{r.label}:</strong> {r.value ?? <span className="muted">Not set{r.label === "Firewall" ? `; the fleet default applies (${describePolicy(cur.fleetFirewall)})` : ""}</span>} {r.action}</li>))}</ul>
      {diagnose.problem && <p className="error" role="alert">{diagnose.problem}</p>}
      {(problem ?? timeZone.problem) && <p className="error" role="alert">{problem ?? timeZone.problem}</p>}
      {sug.networkBaseline && !cur.networkBaseline && <ConfirmDialog open={ask === "baseline"} onClose={() => setAsk(null)}
        description={<p>Set the network baseline for <strong>{name}</strong> from <strong>{sug.networkBaseline.fromCabinet.name}</strong>: {sug.networkBaseline.baseline.addressing === "dhcp" ? "DHCP" : "fixed addresses"}, gateway {sug.networkBaseline.baseline.gateway}/{sug.networkBaseline.baseline.prefixLength}, DNS {sug.networkBaseline.baseline.dnsServers.join(", ")}. Check that this cabinet's network is the right one first. Nothing changes on a cabinet.</p>}
        onConfirm={async () => { try { await api("PUT", `/api/sites/${siteId}/network-baseline`, { baseline: sug.networkBaseline!.baseline }); done(); } catch (e) { setProblem(describeError(e)); throw e; } }} />}
      {sug.firewall && !cur.clientFirewall && <StepUpDialog open={ask === "firewall"} action="client.firewall_policy" target={data.clientId} params={{ policy: sug.firewall.policy }} onClose={() => setAsk(null)}
        description={<p>Set the client's firewall policy to <strong>{describePolicy(sug.firewall.policy)}</strong>, as {sug.firewall.fromCabinet.name} has it now. It applies to every site of this client. Nothing changes on a cabinet until someone applies it.</p>}
        onToken={async token => { try { await api("PUT", `/api/clients/${data.clientId}/firewall-policy`, { policy: sug.firewall!.policy, stepUpToken: token }); done(); } catch (e) { setProblem(describeError(e)); throw e; } }} />}
    </section>
  );
}

export interface Baseline { addressing: "dhcp" | "static"; prefixLength: number; gateway: string; dnsServers: string[] }

/**
 * The site's network: its baseline (what the network should look like), and the diagnosis of every cabinet here at once. A
 * baseline changes nothing on a cabinet; it is what the diagnosis compares each cabinet with. Tier 2 and up set it.
 */
export function SiteNetwork({ siteId, name, baseline, cabinets, editable, onSaved }: { siteId: string; name: string; baseline: Baseline | null; cabinets: number; editable: boolean; onSaved: () => void }) {
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
      <ConfirmDialog open={pending !== undefined} onClose={() => setPending(undefined)}
        description={<p>{pending?.baseline ? <>Set the network baseline for <strong>{name}</strong>: {pending.baseline.addressing === "dhcp" ? "DHCP" : "fixed addresses"}, gateway {pending.baseline.gateway}/{pending.baseline.prefixLength}, DNS {pending.baseline.dnsServers.join(", ")}.</> : <>Remove the network baseline for <strong>{name}</strong>.</>} Nothing changes on a cabinet.</p>}
        onConfirm={async () => {
          try { await api("PUT", `/api/sites/${siteId}/network-baseline`, { baseline: pending?.baseline ?? null }); setSaved(true); onSaved(); }
          catch (e) { setProblem(describeError(e)); throw e; }
        }} />
    </section>
  );
}

/**
 * The time zone a site's cabinets should use (module 21). Setting it changes nothing on a cabinet: cabinets in another
 * zone get a minor "Wrong time zone" alert, and are corrected from their Time section or Fleet operations. Tier 2 and up.
 */
export function SiteTimeZone({ siteId, name, current, editable, onSaved }: { siteId: string; name: string; current: string | null; editable: boolean; onSaved: () => void }) {
  const [zone, setZone] = useState(current ?? "");
  const { run, problem, saved } = useAction();
  const save = async () => { if (await run(() => api("PUT", `/api/sites/${siteId}/time-zone`, { timeZone: zone || null }))) onSaved(); };
  return (
    <section className="panel" aria-labelledby={`tz-${siteId}`}>
      <h2 id={`tz-${siteId}`}>Time zone at {name}</h2>
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
export function WatchedServices({ level, id, name, editable }: { level: "clients" | "sites"; id: string; name: string; editable: boolean }) {
  const { data, reload } = useLoad<{ own: string[] | null; client: string[] | null; fleet: string[] | null }>(`/api/${level}/${id}/watched-services`);
  const above = data?.client ? <>the client's list applies (<code>{data.client.join(", ") || "none"}</code>).</>
    : data?.fleet ? <>the fleet default applies (<code>{data.fleet.join(", ") || "none"}</code>).</> : null;
  return (
    <section className="panel" aria-labelledby={`${level}-watched`}>
      <h2 id={`${level}-watched`}>Watched services for {name}</h2>
      {data && <WatchListEditor endpoint={`/api/${level}/${id}/watched-services`} own={data.own} inherited={above}
        what={level === "clients" ? `every cabinet of ${name}` : `every cabinet at ${name}`} editable={editable} onSaved={reload} />}
    </section>
  );
}

/** A client's own firewall policy (Admin, with a code), or the fleet default when it has none. */
export function ClientFirewallPolicy({ clientId, name, editable }: { clientId: string; name: string; editable: boolean }) {
  const { data, reload } = useLoad<{ own: Policy | null; fleet: Policy }>(`/api/clients/${clientId}/firewall-policy`);
  return (
    <section className="panel" aria-labelledby="client-firewall">
      <h2 id="client-firewall">Firewall policy for {name}</h2>
      {data && <PolicyEditor current={data.own} inherited={data.fleet} endpoint={`/api/clients/${clientId}/firewall-policy`} action="client.firewall_policy"
        target={clientId} what={name} editable={editable} onSaved={reload} />}
    </section>
  );
}
