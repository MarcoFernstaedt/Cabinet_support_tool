// Setup (docs/platform/demo.md): the Admin's path from an empty platform to a working one. Add the support
// team, install the agent on a computer, approve it, see it work, and turn demo mode on to show the platform at fleet
// scale. Every step is an existing, server-checked action; this page only puts them in order.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, describeError } from "../../lib/api";
import { withBase } from "../../lib/base";
import { Link } from "../../lib/router";
import { fullTime } from "../../lib/time";
import { Breadcrumbs } from "../../components/Layout";
import { Badge, StepUpDialog } from "../../components/ui";
import { useLoad } from "../../lib/useLoad";
import { NewAccount } from "./Users";
import { PendingCard, type KnownClient, type Pending } from "./Admin";
import { LiveCheck } from "../../components/LiveCheck";
import { DemoMode } from "./DemoMode";
import { ARCHITECTURE_HELP, DEFAULT_INSTALL_ARCHITECTURE, DEFAULT_INSTALL_ENGINE, INSTALL_ARCHITECTURES, INSTALL_ENGINES, VERSION_HELP, architectureFromText, architectureInfo, engineFromVersionText, engineInfo, installCommand, type InstallArchitecture, type InstallEngine } from "../../lib/install-command";

interface SetupState {
  otherUsers: number; realCabinets: number; pendingCabinets: number; newestCabinetId: string | null; newestCabinetName: string | null;
  agent: { host: string | null; port: number | null; packages: { architecture: InstallArchitecture; name: string; bytes: number | null; sha256: string | null }[]; caSha256: string };
}

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
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Setup" }]} />
      <h1>Setup</h1>
      <p className="muted">Add your team, enroll a cabinet's agent, approve it and check its readings. Demo mode adds simulated cabinets for practice.</p>
      {done && <p className="notice ok" role="status">{done}</p>}
      {state.problem && <p className="error" role="alert">{state.problem}</p>}

      <Step n={1} title="Add your support team" done={(s?.otherUsers ?? 0) > 0}>
        {s && <p>{s.otherUsers === 0 ? "Only you so far." : `${s.otherUsers} other ${s.otherUsers === 1 ? "account" : "accounts"}.`} <Link to="/admin/users">Manage all accounts</Link></p>}
        <NewAccount heading="New support account" onCreated={t => { setDone(t); state.reload(); }} />
      </Step>

      <Step n={2} title="Install the agent on a computer" done={(s?.realCabinets ?? 0) > 0 || (s?.pendingCabinets ?? 0) > 0}>
        {s && <InstallAgent setup={s} />}
      </Step>

      <Step n={3} title="Approve it" done={(s?.realCabinets ?? 0) > 0}>
        {pending.data && pending.data.length === 0 && <p className="muted">Nothing is waiting yet. This list refreshes by itself.</p>}
        {pending.data?.map(p => <PendingCard key={p.id} p={p} clients={clients.data ?? []} onDone={() => { pending.reload(); state.reload(); clients.reload(); }} />)}
      </Step>

      <Step n={4} title="See it work" done={false}>
        {s?.newestCabinetId && s.newestCabinetName && <LiveCheck key={s.newestCabinetId} cabinetId={s.newestCabinetId} cabinetName={s.newestCabinetName} />}
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
  // Which PowerShell is on the computer being set up. Windows PowerShell 5.1 is on every machine and PowerShell 7
  // only sometimes, so the pasted line is built for the engine the operator picks, and the help below finds it for
  // them rather than leaving them to read a version number off a screenshot.
  const [engine, setEngine] = useState<InstallEngine>(DEFAULT_INSTALL_ENGINE);
  // Which Windows the computer being set up runs. This one is not a preference the way the engine is: the agent is
  // built once per architecture and the other package cannot install there at all, because Windows cannot run a
  // 64-bit program on 32-bit Windows (docs/platform/second-architecture.md). It is offered like the engine, with the
  // same kind of "which one am I?" help.
  const [architecture, setArchitecture] = useState<InstallArchitecture>(DEFAULT_INSTALL_ARCHITECTURE);
  const [help, setHelp] = useState(false);
  const [archHelp, setArchHelp] = useState(false);
  const [issued, setIssued] = useState<{ token: string; expiresAt: string; platformCaPem: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const files = useMemo(() => issued ? {
    ca: URL.createObjectURL(new Blob([issued.platformCaPem], { type: "application/x-pem-file" })),
    token: URL.createObjectURL(new Blob([issued.token], { type: "text/plain" })),
  } : null, [issued]);
  useEffect(() => () => { if (files) { URL.revokeObjectURL(files.ca); URL.revokeObjectURL(files.token); } }, [files]);
  const host = setup.agent.host ?? "<server>";
  const port = setup.agent.port ?? 8443;
  // The package for the architecture the operator picked, and only that one: the page never falls back to the other
  // architecture's package, because that one cannot install on the machine being set up.
  const pkg = setup.agent.packages.find(p => p.architecture === architecture) ?? null;
  const installed = pkg && pkg.bytes !== null && pkg.sha256 !== null ? { name: pkg.name, bytes: pkg.bytes, sha256: pkg.sha256 } : null;
  const command = installCommand({ host: setup.agent.host, port: setup.agent.port, caSha256: setup.agent.caSha256, engine, architecture, unsigned: true, packageName: installed?.name });
  return (
    <ol className="steps">
      <li>Download the agent{installed ? <> (<span className="muted small">{(installed.bytes / 1024 / 1024).toFixed(0)} MB, SHA-256 <code className="hash">{installed.sha256.slice(0, 16)}…</code></span>)</> : null}:{" "}
        <fieldset>
          <legend>Which Windows is on that computer?</legend>
          <div className="row gap wrap">
            {INSTALL_ARCHITECTURES.map(a => (
              <label key={a.id} className="check">
                <input type="radio" name="install-architecture" checked={architecture === a.id} onChange={() => setArchitecture(a.id)} /> {a.label}
              </label>))}
            <button type="button" className="btn small" onClick={() => setArchHelp(true)}>Which Windows am I on?</button>
          </div>
          <p className="muted small">{architectureInfo(architecture).note} The other package cannot be installed on it: Windows cannot run a 64-bit program on 32-bit Windows, and the installer says so rather than half-installing.</p>
        </fieldset>
        {installed ? <>
          <p className="row gap wrap"><a className="btn primary" data-tour="download-agent" href={withBase(`/api/admin/agent-package?architecture=${architecture}`)} download={installed.name}>Download {installed.name}</a>{" "}
            <a className="btn" href={withBase(`/api/admin/installer?unsigned=1&architecture=${architecture}`)} download="Install-CabinetAgent.cmd">Download the installer instead</a></p>
          <p className="muted small">Keep it in <code>Downloads</code>. The installer is a small script this server generates for this machine: it finds the package, checks it against the SHA-256 above, unpacks it and runs it, so it does step 4 for you in one double-click.</p></>
          : <span className="muted">this server has no {architectureInfo(architecture).label} package yet. Build one with <code>agent/install/Publish-CabinetAgent.ps1 -Architecture {architecture}</code> (see deploy/README.md).</span>}</li>
      <li>Create a one-time install token (valid for 7 days).{" "}
        <button className="btn primary" data-tour="create-token" onClick={() => { setProblem(null); setConfirm(true); }}>Create install token</button>
        {problem && <p className="error" role="alert">{problem}</p>}</li>
      <li>Download the token and the platform certificate.{" "}
        {issued && files ? (
          <div className="notice warn" aria-live="polite">
            <p>Download both files now: the token is shown only once. Valid until {fullTime(issued.expiresAt)}.</p>
            <p className="row gap wrap"><a className="btn" href={files.token} download="token.txt">Download token.txt</a>
              <a className="btn" href={files.ca} download="platform-ca.pem">Download platform-ca.pem</a></p>
            <p className="muted small">Save both in <code>Downloads</code>, beside the package. <code>token.txt</code> is that computer's one-time pass to ask to join; <code>platform-ca.pem</code> is the certificate it must trust, and step 4 checks it against its SHA-256 before anything is installed.</p>
          </div>
        ) : <span className="muted">nothing to download yet: create the token in step 2 first.</span>}</li>
      <li>On the cabinet, in an <strong>administrator PowerShell</strong>: keep the package, <code>token.txt</code> and <code>platform-ca.pem</code> together in <code>Downloads</code>, paste the three lines below and press Enter. The first unpacks the package and puts the two files where the installer reads them; the last installs the agent, which then comes online and waits for your approval below. Or double-click <code>Install-CabinetAgent.cmd</code> from step 1, which runs exactly these lines. The block holds no secret: it reads <code>token.txt</code> from your Downloads, so a copied block is not a copied pass.
        <fieldset>
          <legend>Which PowerShell is on that computer?</legend>
          <div className="row gap wrap">
            {INSTALL_ENGINES.map(e => (
              <label key={e.id} className="check">
                <input type="radio" name="install-engine" checked={engine === e.id} onChange={() => setEngine(e.id)} /> {e.label}
              </label>))}
            <button type="button" className="btn small" onClick={() => setHelp(true)}>What PowerShell version am I on?</button>
          </div>
          <p className="muted small">{engineInfo(engine).note} Either engine installs the same agent; your choice only changes which program the line below starts.</p>
        </fieldset>
        <pre className="code" tabIndex={0}>{command}</pre>
        <button className="btn small" data-tour="copy-commands" onClick={() => void navigator.clipboard?.writeText(command)}>Copy commands</button>
        <p className="muted small">The agent connects out to <code>{host}:{port}</code> only; nothing connects in. The installer verifies <code>platform-ca.pem</code>, refuses a folder other users can change, and deletes <code>token.txt</code> after use.
          <code>-AllowUnsigned</code> is needed only for this unsigned demo build; production builds are signed.</p></li>
      <StepUpDialog open={confirm} action="token.create" target="fleet" onClose={() => setConfirm(false)}
        description={<p>Create a one-time token that lets one computer ask to join.</p>}
        onToken={async token => {
          try { setIssued(await api("POST", "/api/admin/bootstrap-tokens", { stepUpToken: token })); } catch (e) { setProblem(describeError(e)); }
        }} />
      <VersionHelpDialog open={help} engine={engine} onUse={e => { setEngine(e); setHelp(false); }} onClose={() => setHelp(false)} />
      <ArchitectureHelpDialog open={archHelp} architecture={architecture} onUse={a => { setArchitecture(a); setArchHelp(false); }} onClose={() => setArchHelp(false)} />
    </ol>
  );
}

/** The help behind "What PowerShell version am I on?": the steps to look, how to read the answer, and a box that takes
 *  the number straight off the operator's screen and says which engine it is. */
function VersionHelpDialog({ open, engine, onUse, onClose }: { open: boolean; engine: InstallEngine; onUse: (e: InstallEngine) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [seen, setSeen] = useState("");
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setSeen(""); d.showModal(); }
    if (!open && d.open) d.close();
  }, [open]);
  const found = engineFromVersionText(seen);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="ps-help-title" onClose={onClose}>
      <div className="dialog-body">
        <h2 id="ps-help-title">{VERSION_HELP.title}</h2>
        <ol>{VERSION_HELP.steps.map(s => <li key={s}>{s}</li>)}</ol>
        <ul>{VERSION_HELP.read.map(r => <li key={r.when}><code>{r.when}</code> {r.means}</li>)}</ul>
        <label className="field">
          <span>Type the number it showed</span>
          <input autoFocus value={seen} onChange={e => setSeen(e.target.value)} placeholder="5.1.26100.9711" />
        </label>
        {seen.trim() !== "" && (found
          ? <p className="notice ok" role="status">That is {engineInfo(found).label}.{found === engine ? " The command is already set to it." : " "}
              {found !== engine && <button type="button" className="btn small" onClick={() => onUse(found)}>Use {engineInfo(found).label}</button>}</p>
          : <p className="notice warn" role="status">That is not a PowerShell version. The window shows a number starting with 5.1 (Windows PowerShell) or 7 (PowerShell 7).</p>)}
        {VERSION_HELP.notes.map(n => <p className="muted small" key={n}>{n}</p>)}
        <div className="row gap end"><button type="button" className="btn" onClick={onClose}>Close</button></div>
      </div>
    </dialog>
  );
}

/** The help behind "Which Windows am I on?": the line to run, how to read its answer, and a box that takes that answer
 *  straight off the operator's screen and says which architecture it is — the same shape as the PowerShell help, because
 *  it is the same kind of question. */
function ArchitectureHelpDialog({ open, architecture, onUse, onClose }: { open: boolean; architecture: InstallArchitecture; onUse: (a: InstallArchitecture) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [seen, setSeen] = useState("");
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setSeen(""); d.showModal(); }
    if (!open && d.open) d.close();
  }, [open]);
  const found = architectureFromText(seen);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="arch-help-title" onClose={onClose}>
      <div className="dialog-body">
        <h2 id="arch-help-title">{ARCHITECTURE_HELP.title}</h2>
        <ol>{ARCHITECTURE_HELP.steps.map(s => <li key={s}>{s}</li>)}</ol>
        <ul>{ARCHITECTURE_HELP.read.map(r => <li key={r.when}><code>{r.when}</code> {r.means}</li>)}</ul>
        <label className="field">
          <span>Type what it showed</span>
          <input autoFocus value={seen} onChange={e => setSeen(e.target.value)} placeholder="64-bit" />
        </label>
        {seen.trim() !== "" && (found
          ? <p className="notice ok" role="status">That is {architectureInfo(found).label}.{found === architecture ? " The page is already set to it." : " "}
              {found !== architecture && <button type="button" className="btn small" onClick={() => onUse(found)}>Use {architectureInfo(found).label}</button>}</p>
          : <p className="notice warn" role="status">That does not name either. Windows answers 64-bit or 32-bit; x86 is what a 32-bit shell says about a 64-bit machine, so it is not the answer here.</p>)}
        {ARCHITECTURE_HELP.notes.map(n => <p className="muted small" key={n}>{n}</p>)}
        <div className="row gap end"><button type="button" className="btn" onClick={onClose}>Close</button></div>
      </div>
    </dialog>
  );
}

