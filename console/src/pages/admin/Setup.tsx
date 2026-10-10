// Set up and demo (docs/platform/demo.md): the Admin's path from an empty platform to a working one. Add the support
// team, install the agent on a computer, approve it, see it work, and turn demo mode on to show the platform at fleet
// scale. Every step is an existing, server-checked action; this page only puts them in order.
import { useEffect, useMemo, useState } from "react";
import { api, describeError } from "../../lib/api";
import { Link } from "../../lib/router";
import { fullTime } from "../../lib/time";
import { Breadcrumbs } from "../../components/Layout";
import { Badge, ConfirmDialog, StepUpDialog } from "../../components/ui";
import { useLoad } from "../../lib/useLoad";
import { NewAccount } from "./Users";
import { PendingCard, type KnownClient, type Pending } from "./Admin";

interface SetupState {
  otherUsers: number; realCabinets: number; pendingCabinets: number; newestCabinetId: string | null;
  agent: { host: string | null; port: number | null; package: { name: string; bytes: number; sha256: string } | null };
}
export interface DemoState { enabled: boolean; clients: number; cabinets: number }

const Step = ({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) => (
  <section className="panel setup-step" aria-labelledby={`step-${n}`}>
    <h2 id={`step-${n}`}><span className="step-number" aria-hidden="true">{n}</span> {title} {done ? <Badge tone="ok">Done</Badge> : <Badge tone="off">To do</Badge>}</h2>
    {children}
  </section>
);

export function Setup() {
  const state = useLoad<SetupState>("/api/admin/setup");
  const pending = useLoad<Pending[]>("/api/admin/enrollments");
  const clients = useLoad<KnownClient[]>("/api/admin/clients");
  const [done, setDone] = useState<string | null>(null);
  // While a computer is being installed, look for it every 5 seconds.
  useEffect(() => {
    const t = setInterval(() => { pending.reload(); state.reload(); }, 5000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const s = state.data;
  return (
    <div className="page narrow">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Set up and demo" }]} />
      <h1>Set up and demo</h1>
      <p className="muted">From an empty platform to a working one: add your support team, put the agent on a computer, approve it, and see its event logs, services and scanner checks. Demo mode then adds simulated cabinets so you can show the platform at fleet scale.</p>
      {done && <p className="notice ok" role="status">{done}</p>}
      {state.problem && <p className="error" role="alert">{state.problem}</p>}

      <Step n={1} title="Add your support team" done={(s?.otherUsers ?? 0) > 0}>
        <p className="muted small">Tier 1 runs diagnostics and the everyday fixes (firewall policy, scanner checks, restarts). Tier 2 also changes services, rules and network settings. Admins also enrol cabinets and manage accounts.
          Each person gets a temporary password and must choose their own, and set up an authenticator, at first sign-in.</p>
        {s && <p>{s.otherUsers === 0 ? "Only you so far." : `${s.otherUsers} other ${s.otherUsers === 1 ? "account" : "accounts"}.`} <Link to="/admin/users">Manage all accounts</Link></p>}
        <NewAccount heading="New support account" onCreated={t => { setDone(t); state.reload(); }} />
      </Step>

      <Step n={2} title="Install the agent on a computer" done={(s?.realCabinets ?? 0) > 0 || (s?.pendingCabinets ?? 0) > 0}>
        {s && <InstallAgent setup={s} />}
      </Step>

      <Step n={3} title="Approve it" done={(s?.realCabinets ?? 0) > 0}>
        <p className="muted small">Within a minute of installing, the computer asks to join. Check its host name and serial number, then file it under a client and site.</p>
        {pending.data && pending.data.length === 0 && <p className="muted">Nothing is waiting yet. This list refreshes by itself.</p>}
        {pending.data?.map(p => <PendingCard key={p.id} p={p} clients={clients.data ?? []} onDone={() => { pending.reload(); state.reload(); clients.reload(); }} />)}
      </Step>

      <Step n={4} title="See it work" done={false}>
        {s?.newestCabinetId ? (
          <ul className="links">
            <li><Link to={`/cabinets/${s.newestCabinetId}/events`}>Event logs</Link>: browse System and Application errors, open any entry in full.</li>
            <li><Link to={`/cabinets/${s.newestCabinetId}/services`}>Services</Link>: every Windows service; watch one so the agent keeps it running.</li>
            <li><Link to={`/cabinets/${s.newestCabinetId}/scanner`}>Fingerprint scanner</Link>: the standard scanner checklist in one click.</li>
            <li><Link to={`/cabinets/${s.newestCabinetId}/firewall`}>Firewall</Link>: profiles, rules and the client policy, with one-click apply.</li>
            <li><Link to={`/cabinets/${s.newestCabinetId}/network`}>Network</Link>: adapters, DNS and connection tests.</li>
          </ul>) : <p className="muted">Once a computer is approved, links to its event logs, services, scanner and firewall appear here.</p>}
      </Step>

      <DemoMode />
    </div>
  );
}

function InstallAgent({ setup }: { setup: SetupState }) {
  const [confirm, setConfirm] = useState(false);
  const [issued, setIssued] = useState<{ token: string; expiresAt: string; platformCaPem: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const files = useMemo(() => issued ? {
    ca: URL.createObjectURL(new Blob([issued.platformCaPem], { type: "application/x-pem-file" })),
    token: URL.createObjectURL(new Blob([issued.token], { type: "text/plain" })),
  } : null, [issued]);
  useEffect(() => () => { if (files) { URL.revokeObjectURL(files.ca); URL.revokeObjectURL(files.token); } }, [files]);
  const host = setup.agent.host ?? "<server>";
  const port = setup.agent.port ?? 8443;
  const command = [
    "cd $HOME\\Downloads\\CabinetAgent",
    "Get-ChildItem -Recurse | Unblock-File",
    `powershell -ExecutionPolicy Bypass -File .\\install\\Install-CabinetAgent.ps1 -PlatformServerHost ${host} -PlatformServerPort ${port} -PlatformCaFile .\\platform-ca.pem -BootstrapTokenFile .\\token.txt`,
  ].join("\n");
  const pkg = setup.agent.package;
  return (
    <ol className="steps">
      <li>Download the agent{pkg ? <> (<span className="muted small">{(pkg.bytes / 1024 / 1024).toFixed(0)} MB, SHA-256 <code className="hash">{pkg.sha256.slice(0, 16)}…</code></span>)</> : null}:{" "}
        {pkg ? <a className="btn" href="/api/admin/agent-package" download={pkg.name}>Download {pkg.name}</a>
          : <span className="muted">this server has no agent package (see deploy/README.md); build one with agent/install/Publish-CabinetAgent.ps1.</span>}</li>
      <li>Create a one-time install token. It works once and expires in 7 days.{" "}
        <button className="btn primary" onClick={() => { setProblem(null); setConfirm(true); }}>Create install token</button>
        {problem && <p className="error" role="alert">{problem}</p>}
        {issued && files && (
          <div className="notice warn" aria-live="polite">
            <p>Download both files now: the token is shown only once. Valid until {fullTime(issued.expiresAt)}.</p>
            <p className="row gap wrap"><a className="btn" href={files.token} download="token.txt">Download token.txt</a>
              <a className="btn" href={files.ca} download="platform-ca.pem">Download platform-ca.pem</a></p>
          </div>)}
      </li>
      <li>On the computer, unzip the agent into <code>Downloads</code> (it makes a <code>CabinetAgent</code> folder) and put <code>token.txt</code> and <code>platform-ca.pem</code> in that folder.
        Then open PowerShell as administrator and run:
        <pre className="code" tabIndex={0}>{command}</pre>
        <button className="btn small" onClick={() => void navigator.clipboard?.writeText(command)}>Copy commands</button>
        <p className="muted small">The computer connects out to <code>{host}:{port}</code> only; nothing connects in to it. Delete token.txt once it is approved.</p></li>
      <StepUpDialog open={confirm} action="token.create" target="fleet" onClose={() => setConfirm(false)}
        description={<p>Create a one-time token that lets one computer ask to join.</p>}
        onToken={async token => {
          try { setIssued(await api("POST", "/api/admin/bootstrap-tokens", { stepUpToken: token })); } catch (e) { setProblem(describeError(e)); }
        }} />
    </ol>
  );
}

/** The demo switch: Admins only (the server checks). */
export function DemoMode() {
  const demo = useLoad<DemoState>("/api/demo");
  const [ask, setAsk] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const on = demo.data?.enabled ?? false;
  return (
    <section className="panel" aria-labelledby="demo-heading">
      <h2 id="demo-heading">Demo mode {demo.data && (on ? <Badge tone="info">On</Badge> : <Badge tone="off">Off</Badge>)}</h2>
      <p className="muted small">Adds 4 simulated clients with 41 cabinets at sites in the Eastern, Central, Mountain, Arizona and Pacific time zones, next to your real cabinets, so you can show what the platform does at fleet scale.
        One client has an overnight crash incident: 15 of its 24 cabinets blue-screened after a storage driver update, and 5 are still restarting (see Incidents).
        Each has a problem to find: firewall on unlike the policy, a disconnected scanner, a service that will not stay running, a failing drive, repeated blue screens, DNS failures, a failing Windows update, new unrecognized errors, a cabinet offline for days.
        Their alerts come from the real alerts engine, and fixes made on them take effect. Simulated clients are named "Demo · …" and marked Demo everywhere. Turning it off deletes all of them; real cabinets are never touched.</p>
      {demo.data && <p>{on ? `${demo.data.cabinets} simulated cabinets in ${demo.data.clients} clients.` : "No simulated cabinets."}{" "}
        <button className={on ? "btn" : "btn primary"} onClick={() => { setProblem(null); setAsk(!on); }}>{on ? "Turn demo mode off" : "Turn demo mode on"}</button></p>}
      {problem && <p className="error" role="alert">{problem}</p>}
      <ConfirmDialog open={ask !== null} onClose={() => setAsk(null)}
        description={<p>{ask ? "Add the simulated demo clients, sites and cabinets for everyone signed in to see." : "Delete every simulated demo client, site and cabinet, with their alerts and history. Real cabinets are not touched."}</p>}
        onConfirm={async () => {
          try { await api("PUT", "/api/admin/demo", { enabled: ask }); demo.reload(); window.dispatchEvent(new Event("demo-changed")); }
          catch (e) { setProblem(describeError(e)); throw e; }
        }} />
    </section>
  );
}
