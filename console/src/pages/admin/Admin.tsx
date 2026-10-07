// Admin home, pending cabinets, install tokens and the scanner default. The other admin screens are in their own files.
import { useState } from "react";
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
        <li><Link to="/admin/scanner"><strong>Scanner default</strong><span>The fingerprint scanner's hardware IDs for the whole fleet.</span></Link></li>
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
  const { data, reload } = useLoad<{ hardwareIds: string[] | null }>("/api/settings/scanner");
  const [text, setText] = useState<string | null>(null);
  const [pending, setPending] = useState<string[] | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const value = text ?? (data?.hardwareIds ?? []).join("\n");
  const ids = value.split(/\s+/).filter(Boolean);
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Scanner default" }]} />
      <h1>Fingerprint scanner default</h1>
      <p className="muted">The USB hardware IDs that identify the fingerprint scanner on every cabinet, unless a cabinet has its own. Find them on a cabinet under Fingerprint scanner → Likely scanners.</p>
      <form className="stack" onSubmit={e => { e.preventDefault(); setProblem(null); setSaved(false); setPending(ids.length ? ids : null); }}>
        <label className="field"><span>Hardware IDs, one per line (empty: none)</span>
          <textarea rows={4} value={value} onChange={e => setText(e.target.value)} placeholder={"USB\\VID_1234&PID_5678"} /></label>
        <div className="row gap"><button className="btn primary" disabled={ids.length > 16}>Save</button>
          {saved && <span className="ok" role="status">Saved. The next scanner check on every cabinet uses these IDs.</span>}</div>
        {problem && <p className="error" role="alert">{problem}</p>}
      </form>
      <StepUpDialog open={pending !== undefined} action="settings.scanner" target="fleet" onClose={() => setPending(undefined)}
        description={<p>{pending ? <>Use <code>{pending.join(", ")}</code> as the fleet's scanner IDs.</> : "Remove the fleet default scanner IDs."}</p>}
        onToken={async token => {
          try { await api("PUT", "/api/settings/scanner", { hardwareIds: pending ?? null, stepUpToken: token }); setSaved(true); setText(null); reload(); }
          catch (e) { setProblem(describeError(e)); }
        }} />
    </div>
  );
}
