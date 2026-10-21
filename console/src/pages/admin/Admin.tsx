// Admin home, pending cabinets, install tokens and the scanner default. The other admin screens are in their own files.
import { PolicyEditor, type Policy } from "../../components/FirewallPolicy";
import { useEffect, useMemo, useState } from "react";
import { PortsEditor, ScannerIdsEditor } from "../../components/DeviceSettings";
import { api, describeError } from "../../lib/api";
import { Link } from "../../lib/router";
import { fullTime } from "../../lib/time";
import { Breadcrumbs } from "../../components/Layout";
import { Empty, KeyValues, StepUpDialog } from "../../components/ui";
import { useLoad } from "../../lib/useLoad";
import { WatchListEditor } from "../cabinet/Services";

export function AdminHome() {
  const { data } = useLoad<unknown[]>("/api/admin/enrollments");
  return (
    <div className="page">
      <h1>Admin</h1>
      <ul className="tiles">
        <li><Link to="/admin/setup"><strong>Set up and demo</strong><span>Team, agent, demo</span></Link></li>
        <li><Link to="/fixes"><strong>Known fixes</strong><span>Review saved fixes</span></Link></li>
        <li><Link to="/admin/security"><strong>Security alerts</strong><span>Security events</span></Link></li>
        <li><Link to="/admin/users"><strong>Users</strong><span>Accounts and roles</span></Link></li>
        <li><Link to="/admin/online"><strong>Online now</strong><span>Active sessions</span></Link></li>
        <li><Link to="/admin/audit"><strong>Audit log</strong><span>Search and verify</span></Link></li>
        <li><Link to="/admin/safety"><strong>Fleet safety</strong><span>Pause and resume changes</span></Link></li>
        <li><Link to="/admin/pending"><strong>Pending cabinets</strong><span>{data ? `${data.length} waiting` : "Approve or reject"}</span></Link></li>
        <li><Link to="/admin/tokens"><strong>Install a cabinet</strong><span>Install tokens and files</span></Link></li>
        <li><Link to="/admin/clients"><strong>Clients and sites</strong><span>Clients and sites</span></Link></li>
        <li><Link to="/admin/issues"><strong>Issue types and suppressions</strong><span>Types and suppressions</span></Link></li>
        <li><Link to="/admin/baselines"><strong>Baselines</strong><span>How cabinets should be set up</span></Link></li>
        <li><Link to="/admin/software"><strong>Software library</strong><span>Packages</span></Link></li>
        <li><Link to="/admin/upgrades"><strong>Agent upgrades</strong><span>Releases and rollouts</span></Link></li>
        <li><Link to="/admin/scanner"><strong>Device defaults</strong><span>Scanner IDs, sync ports</span></Link></li>
        <li><Link to="/admin/health"><strong>System health</strong><span>Database, disk, backup, counters</span></Link></li>
        <li><Link to="/admin/settings"><strong>Settings</strong><span>Timeouts, retention, 2FA</span></Link></li>
      </ul>
    </div>
  );
}

export interface Pending { id: string; createdAt: string; sourceAddress: string | null;
  fingerprints: { hostname: string; serialNumber: string | null; macAddresses: string[]; osVersion: string; agentVersion: string; onlineSince: string }; }

export function PendingCabinets() {
  const { data, problem, reload } = useLoad<Pending[]>("/api/admin/enrollments");
  const clients = useLoad<KnownClient[]>("/api/admin/clients");
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Pending cabinets" }]} />
      <h1>Pending cabinets</h1>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && data.length === 0 && <Empty>No cabinets are waiting. A cabinet appears here after it is installed with an install token.</Empty>}
      {data?.map(p => <PendingCard key={p.id} p={p} clients={clients.data ?? []} onDone={reload} />)}
    </div>
  );
}

export interface KnownClient { id: string; name: string; sites: { id: string; name: string }[] }

/** Whether a typed name is an existing one, the same name in other letters (likely a typo), or new. */
function known(name: string, names: string[]): { exact: boolean; near: string | null } {
  const t = name.trim();
  if (names.includes(t)) return { exact: true, near: null };
  return { exact: false, near: names.find(n => n.toLowerCase() === t.toLowerCase()) ?? null };
}

export function PendingCard({ p, clients, onDone }: { p: Pending; clients: KnownClient[]; onDone: () => void }) {
  const [form, setForm] = useState({ client: "", site: "", cabinet: p.fingerprints.hostname, role: "standalone" });
  // Approving with a name that does not exist creates that client or site, so existing ones are offered and a new one is said out loud.
  const client = known(form.client, clients.map(c => c.name));
  const sites = clients.find(c => c.name === form.client.trim())?.sites.map(s => s.name) ?? [];
  const site = known(form.site, sites);
  const lists = `pending-${p.id}`;
  const [confirm, setConfirm] = useState<"approve" | "reject" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <section className="panel" aria-label={`Request from ${p.fingerprints.hostname}`}>
      <h2>{p.fingerprints.hostname}</h2>
      <KeyValues rows={[["Requested", fullTime(p.createdAt)], ["From address", p.sourceAddress], ["Serial number", p.fingerprints.serialNumber],
        ["MAC addresses", p.fingerprints.macAddresses.join(", ") || null], ["Windows", p.fingerprints.osVersion], ["Agent version", p.fingerprints.agentVersion],
        ["Running since", fullTime(p.fingerprints.onlineSince)], ["Request ID", <code>{p.id}</code>]]} />
      {done ? <p className="ok" role="status">{done}</p> : (
        <form className="row gap wrap" onSubmit={e => { e.preventDefault(); setProblem(null); setConfirm("approve"); }}>
          <label className="field"><span>Client</span><input required maxLength={128} placeholder="e.g. Mashura Office" list={`${lists}-clients`} value={form.client} onChange={e => setForm(f => ({ ...f, client: e.target.value }))} /></label>
          <datalist id={`${lists}-clients`}>{clients.map(c => <option key={c.id} value={c.name} />)}</datalist>
          <label className="field"><span>Site</span><input required maxLength={128} placeholder="e.g. Support desk" list={`${lists}-sites`} value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} /></label>
          <datalist id={`${lists}-sites`}>{sites.map(n => <option key={n} value={n} />)}</datalist>
          <label className="field"><span>Cabinet name</span><input required maxLength={128} value={form.cabinet} onChange={e => setForm(f => ({ ...f, cabinet: e.target.value }))} /></label>
          <label className="field"><span>Role</span><select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
            <option value="sync">Sync</option><option value="satellite">Satellite</option><option value="standalone">Standalone</option></select></label>
          <button className="btn primary" data-tour="approve-cabinet" disabled={!!client.near || !!site.near}>Approve</button>
          {client.near && <span className="error">There is already a client named "{client.near}". Use that name, or a clearly different one.</span>}
          {site.near && <span className="error">{form.client.trim()} already has a site named "{site.near}".</span>}
          <button type="button" className="btn danger" onClick={() => { setProblem(null); setConfirm("reject"); }}>Reject</button>
        </form>)}
      {problem && <p className="error" role="alert">{problem}</p>}
      <StepUpDialog open={confirm !== null} action={confirm === "reject" ? "enrollment.reject" : "enrollment.approve"} target={p.id} onClose={() => setConfirm(null)}
        params={confirm === "reject" ? undefined : form}
        description={confirm === "reject" ? <p>Reject the request from <strong>{p.fingerprints.hostname}</strong>. It will need a new install token to try again.</p>
          : <p>Approve <strong>{p.fingerprints.hostname}</strong> as <strong>{form.cabinet}</strong> ({form.role}) at <strong>{form.client} / {form.site}</strong>.
            {!client.exact && <> This creates the new client <strong>{form.client.trim()}</strong>.</>}
            {client.exact && !site.exact && <> This creates the new site <strong>{form.site.trim()}</strong>.</>}
            {" "}It receives its certificate on its next check-in.</p>}
        onToken={async token => {
          try {
            if (confirm === "reject") { await api("POST", `/api/admin/enrollments/${p.id}/reject`, { stepUpToken: token }); setDone("Rejected."); }
            else { await api("POST", `/api/admin/enrollments/${p.id}/approve`, { ...form, stepUpToken: token }); setDone(`Approved. ${form.cabinet} will come online within a minute.`); }
            setTimeout(onDone, 1500);
          } catch (e) { setProblem(describeError(e)); }
        }} />
    </section>
  );
}

export function InstallTokens() {
  const [confirm, setConfirm] = useState(false);
  const [issued, setIssued] = useState<{ token: string; expiresAt: string; platformCaPem: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // One download link per issued token, released when it is replaced or the page closes.
  const caHref = useMemo(() => issued ? URL.createObjectURL(new Blob([issued.platformCaPem], { type: "application/x-pem-file" })) : undefined, [issued]);
  useEffect(() => () => { if (caHref) URL.revokeObjectURL(caHref); }, [caHref]);
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Install a cabinet" }]} />
      <h1>Install a cabinet</h1>
      <ol className="steps">
        <li>Create an install token below. It works once and expires in 7 days.</li>
        <li>On the cabinet, save the token in a file, then in an elevated PowerShell run the installer with the server's agent address and port
          (8443 unless your server was set up with another <code>AGENT_API_PORT</code>), the platform CA file and the token file:<br />
          <code>./Install-CabinetAgent.ps1 -PlatformServerHost &lt;server&gt; -PlatformServerPort &lt;port&gt; -PlatformCaFile platform-ca.pem -BootstrapTokenFile token.txt</code><br />
          <span className="muted small">A token file keeps the token out of the command line, which Windows can record. Delete the file once the cabinet is approved.</span></li>
        <li>The cabinet then appears under <Link to="/admin/pending">Pending cabinets</Link> for approval.</li>
      </ol>
      <button className="btn primary" data-tour="create-token" onClick={() => { setProblem(null); setConfirm(true); }}>Create install token</button>
      {problem && <p className="error" role="alert">{problem}</p>}
      {issued && (
        <section className="panel" aria-live="polite">
          <h2>Install token</h2>
          <p className="notice warn">Copy it now: it is shown only once. Valid until {fullTime(issued.expiresAt)}.</p>
          <p><code className="secret">{issued.token}</code> <button className="btn small" onClick={() => void navigator.clipboard?.writeText(issued.token)}>Copy</button></p>
          <p><a className="btn" href={caHref} download="platform-ca.pem">Download platform-ca.pem</a></p>
        </section>)}
      <StepUpDialog open={confirm} action="token.create" target="fleet" onClose={() => setConfirm(false)}
        description={<p>Create a one-time token that lets one cabinet ask to join.</p>}
        onToken={async token => {
          try { setIssued(await api("POST", "/api/admin/bootstrap-tokens", { stepUpToken: token })); } catch (e) { setProblem(describeError(e)); }
        }} />
    </div>
  );
}

export function ScannerDefault() {
  const scanner = useLoad<{ hardwareIds: string[] | null }>("/api/settings/scanner");
  const firewall = useLoad<{ policy: Policy }>("/api/admin/firewall-policy");
  const ports = useLoad<{ ports: number[] | null }>("/api/settings/sync-ports");
  const watched = useLoad<{ names: string[] | null }>("/api/admin/watched-services");
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Device defaults" }]} />
      <h1>Device defaults</h1>
      <section className="panel" aria-labelledby="fleet-scanner">
        <h2 id="fleet-scanner">Fingerprint scanner</h2>
        {scanner.data && <ScannerIdsEditor label="Fleet default scanner IDs" current={scanner.data.hardwareIds}
          inherited="cabinets find the scanner automatically (the Biometric device)." endpoint="/api/settings/scanner" action="settings.scanner" target="fleet"
          what="every cabinet without its own setting" editable onSaved={scanner.reload} />}
      </section>
      <section className="panel" aria-labelledby="fleet-ports">
        <h2 id="fleet-ports">Sync cabinet ports</h2>
        {ports.data && <PortsEditor current={ports.data.ports} inherited="no ports are set, so sync tests use ping and DNS only."
          endpoint="/api/settings/sync-ports" action="settings.sync" target="fleet" what="every site without its own or its client's ports" editable onSaved={ports.reload} />}
      </section>
      <section className="panel" aria-labelledby="fleet-firewall">
        <h2 id="fleet-firewall">Firewall policy (fleet default)</h2>
        {firewall.data && <PolicyEditor current={firewall.data.policy} inherited={null} endpoint="/api/admin/firewall-policy" action="fleet.firewall_policy" target="fleet"
          what="the fleet" editable onSaved={firewall.reload} />}
      </section>
      <section className="panel" aria-labelledby="fleet-watched">
        <h2 id="fleet-watched">Watched services (fleet default)</h2>
        {watched.data && <WatchListEditor endpoint="/api/admin/watched-services" own={watched.data.names} inherited="no services are watched."
          what="every cabinet without its own list" editable onSaved={watched.reload} />}
      </section>
    </div>
  );
}
