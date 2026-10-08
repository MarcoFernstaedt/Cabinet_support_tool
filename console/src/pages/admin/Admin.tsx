// Admin home, pending cabinets, install tokens and the scanner default. The other admin screens are in their own files.
import { useState } from "react";
import { PortsEditor, ScannerIdsEditor } from "../../components/DeviceSettings";
import { api, describeError } from "../../lib/api";
import { Link } from "../../lib/router";
import { fullTime } from "../../lib/time";
import { Breadcrumbs } from "../../components/Layout";
import { Badge, Empty, KeyValues, StepUpDialog } from "../../components/ui";
import { useLoad } from "../Fleet";

export function AdminHome() {
  const { data } = useLoad<unknown[]>("/api/admin/enrollments");
  return (
    <div className="page">
      <h1>Admin</h1>
      <ul className="tiles">
        <li><Link to="/admin/security"><strong>Security alerts</strong><span>Unusual write volume, failed sign-ins, new networks, audit chain, agent and certificate problems.</span></Link></li>
        <li><Link to="/admin/users"><strong>Users</strong><span>Create accounts, change roles and write limits, reset passwords and authenticators.</span></Link></li>
        <li><Link to="/admin/online"><strong>Online now</strong><span>Who is signed in, their role, last activity and the cabinet they have open.</span></Link></li>
        <li><Link to="/admin/audit"><strong>Audit log</strong><span>Search by person, cabinet, action and date; verify the chain.</span></Link></li>
        <li><Link to="/admin/safety"><strong>Fleet safety</strong><span>Pause changes fleet-wide or per client; resume people paused by their limit.</span></Link></li>
        <li><Link to="/admin/pending"><strong>Pending cabinets</strong><span>Approve or reject cabinets asking to join{data ? ` (${data.length} waiting)` : ""}.</span></Link></li>
        <li><Link to="/admin/tokens"><strong>Install a cabinet</strong><span>Create a one-time install token and get the files the installer needs.</span></Link></li>
        <li><Link to="/admin/clients"><strong>Clients and sites</strong><span>Create, rename and remove clients and sites.</span></Link></li>
        <li><Link to="/admin/issues"><strong>Issue types and suppressions</strong><span>Create and edit issue types; review, renew and disable suppressions.</span></Link></li>
        <li><Link to="/admin/software"><strong>Software library</strong><span>Upload driver packages and installers, approve another Admin's uploads, retire old versions.</span></Link></li>
        <li><Link to="/admin/upgrades"><strong>Agent upgrades</strong><span>Add signed agent releases, run staged rollouts, pause or stop them, and see each cabinet's result.</span></Link></li>
        <li><Link to="/admin/scanner"><strong>Scanner and port defaults</strong><span>The fingerprint scanner's hardware IDs and the sync cabinet ports for any client that has none of its own.</span></Link></li>
        <li><Link to="/admin/settings"><strong>Settings</strong><span>Offline alerts, sign-in timeouts, two-factor for everyone, how long data is kept.</span></Link></li>
      </ul>
    </div>
  );
}

interface Pending { id: string; createdAt: string; sourceAddress: string | null;
  fingerprints: { hostname: string; serialNumber: string | null; macAddresses: string[]; osVersion: string; agentVersion: string; onlineSince: string }; }

export function PendingCabinets() {
  const { data, problem, reload } = useLoad<Pending[]>("/api/admin/enrollments");
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Pending cabinets" }]} />
      <h1>Pending cabinets</h1>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && data.length === 0 && <Empty>No cabinets are waiting. A cabinet appears here after it is installed with an install token.</Empty>}
      {data?.map(p => <PendingCard key={p.id} p={p} onDone={reload} />)}
    </div>
  );
}

function PendingCard({ p, onDone }: { p: Pending; onDone: () => void }) {
  const [form, setForm] = useState({ client: "", site: "", cabinet: p.fingerprints.hostname, role: "standalone" });
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
          <label className="field"><span>Client</span><input required maxLength={128} value={form.client} onChange={e => setForm(f => ({ ...f, client: e.target.value }))} /></label>
          <label className="field"><span>Site</span><input required maxLength={128} value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} /></label>
          <label className="field"><span>Cabinet name</span><input required maxLength={128} value={form.cabinet} onChange={e => setForm(f => ({ ...f, cabinet: e.target.value }))} /></label>
          <label className="field"><span>Role</span><select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
            <option value="sync">Sync</option><option value="satellite">Satellite</option><option value="standalone">Standalone</option></select></label>
          <button className="btn primary">Approve</button>
          <button type="button" className="btn danger" onClick={() => { setProblem(null); setConfirm("reject"); }}>Reject</button>
        </form>)}
      {problem && <p className="error" role="alert">{problem}</p>}
      <StepUpDialog open={confirm !== null} action={confirm === "reject" ? "enrollment.reject" : "enrollment.approve"} target={p.id} onClose={() => setConfirm(null)}
        description={confirm === "reject" ? <p>Reject the request from <strong>{p.fingerprints.hostname}</strong>. It will need a new install token to try again.</p>
          : <p>Approve <strong>{p.fingerprints.hostname}</strong> as <strong>{form.cabinet}</strong> ({form.role}) at <strong>{form.client} / {form.site}</strong>. It receives its certificate on its next check-in.</p>}
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
  const caHref = issued ? URL.createObjectURL(new Blob([issued.platformCaPem], { type: "application/x-pem-file" })) : undefined;
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Install a cabinet" }]} />
      <h1>Install a cabinet</h1>
      <ol className="steps">
        <li>Create an install token below. It works once and expires in 7 days.</li>
        <li>On the cabinet, in an elevated PowerShell, run the installer with the server, the platform CA file and the token:<br />
          <code>./Install-CabinetAgent.ps1 -PlatformServerHost &lt;server&gt; -PlatformServerPort 8443 -PlatformCaFile platform-ca.pem -BootstrapToken &lt;token&gt;</code></li>
        <li>The cabinet then appears under <Link to="/admin/pending">Pending cabinets</Link> for approval.</li>
      </ol>
      <button className="btn primary" onClick={() => { setProblem(null); setConfirm(true); }}>Create install token</button>
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
  const ports = useLoad<{ ports: number[] | null }>("/api/settings/sync-ports");
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Scanner and port defaults" }]} />
      <h1>Scanner and port defaults</h1>
      <p className="muted">Fleet-wide defaults. A client, a site or a cabinet can have its own, set on its page; the most specific one applies, and cabinets pick changes up at their next heartbeat.</p>
      <section className="panel" aria-labelledby="fleet-scanner">
        <h2 id="fleet-scanner">Fingerprint scanner</h2>
        <p className="muted small">Find the IDs on a cabinet under Fingerprint scanner → Likely scanners. With none set anywhere, cabinets find their scanner automatically.</p>
        {scanner.data && <ScannerIdsEditor label="Fleet default scanner IDs" current={scanner.data.hardwareIds}
          inherited="cabinets find the scanner automatically (the Biometric device)." endpoint="/api/settings/scanner" action="settings.scanner" target="fleet"
          what="every cabinet without its own setting" editable onSaved={scanner.reload} />}
      </section>
      <section className="panel" aria-labelledby="fleet-ports">
        <h2 id="fleet-ports">Sync cabinet ports</h2>
        {ports.data && <PortsEditor current={ports.data.ports} inherited="no ports are set, so sync tests use ping and DNS only."
          endpoint="/api/settings/sync-ports" action="settings.sync" target="fleet" what="every site without its own or its client's ports" editable onSaved={ports.reload} />}
      </section>
    </div>
  );
}
