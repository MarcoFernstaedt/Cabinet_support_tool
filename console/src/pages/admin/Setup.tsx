// Setup (docs/platform/demo.md): the Admin's path from an empty platform to a working one. Add the support
// team, install the agent on a computer, approve it, see it work, and turn demo mode on to show the platform at fleet
// scale. Every step is an existing, server-checked action; this page only puts them in order.
import { useEffect, useState } from "react";
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
import { INSTALL_ARCHITECTURES, type InstallArchitecture } from "../../lib/install-command";

export interface SetupState {
  otherUsers: number; realCabinets: number; pendingCabinets: number; newestCabinetId: string | null; newestCabinetName: string | null;
  agent: { host: string | null; port: number | null; unsigned: boolean; packages: { architecture: InstallArchitecture; name: string; bytes: number | null; sha256: string | null }[]; caSha256: string };
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
      <p className="muted">Add your team, install the agent on a cabinet, approve it, and check that it reports.</p>
      {done && <p className="notice ok" role="status">{done}</p>}
      {state.problem && <p className="error" role="alert">{state.problem}</p>}

      <Step n={1} title="Add your support team" done={(s?.otherUsers ?? 0) > 0}>
        {s && <p>{s.otherUsers === 0 ? "Only you so far." : `${s.otherUsers} other ${s.otherUsers === 1 ? "account" : "accounts"}.`} <Link to="/admin/users">Manage all accounts</Link></p>}
        <NewAccount heading="New support account" onCreated={t => { setDone(t); state.reload(); }} />
      </Step>

      <Step n={2} title="Install the agent" done={(s?.realCabinets ?? 0) > 0 || (s?.pendingCabinets ?? 0) > 0}>
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
            <li><Link to={`/cabinets/${s.newestCabinetId}/firewall`}>Firewall</Link>: profiles, rules and the firewall policy, with one-click apply.</li>
            <li><Link to={`/cabinets/${s.newestCabinetId}/network`}>Network</Link>: adapters, DNS and connection tests.</li>
          </ul>) : <p className="muted">Links to the cabinet's event logs, services, scanner and firewall appear here once it is approved.</p>}
      </Step>

      <DemoMode />
    </div>
  );
}

/** One step per action: get the agent once, make an installer per cabinet, double-click it on the cabinet. The installer
 *  picks the package for the machine's Windows (32-bit or 64-bit) and runs on the Windows PowerShell every machine has. */
export function InstallAgent({ setup }: { setup: SetupState }) {
  const [confirm, setConfirm] = useState(false);
  const [made, setMade] = useState<{ fileName: string; href: string; expiresAt: string; cabinets?: number } | null>(null);
  // A site installer (F6.R1): one installer for up to N cabinets of one site, and optionally one role, for D days.
  const clients = useLoad<{ id: string; name: string; sites: { id: string; name: string }[] }[]>("/api/admin/clients");
  const [forSite, setForSite] = useState(false);
  const [siteId, setSiteId] = useState("");
  const [role, setRole] = useState("");
  const [cabinets, setCabinets] = useState(10);
  const [days, setDays] = useState(7);
  const site = forSite && siteId ? { siteId, ...(role ? { role } : {}), cabinets, days } : undefined;
  const body = site ? { site } : {};
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => () => { if (made) URL.revokeObjectURL(made.href); }, [made]);
  const packages = INSTALL_ARCHITECTURES.map(a => ({ ...a, pkg: setup.agent.packages.find(p => p.architecture === a.id && p.bytes !== null) ?? null }));
  const any = packages.some(p => p.pkg);
  return (
    <>
      {setup.agent.unsigned && <p className="notice warn">Development build: these packages are not code-signed. Use them on test machines only.</p>}
      <ol className="steps">
        <li><strong>Download the agent.</strong> Download once and keep it with the installers.
          <p className="row gap wrap">
            {packages.map(p => p.pkg
              ? <a key={p.id} className="btn" data-tour={p.id === "windows-x86" ? "download-agent" : undefined} href={withBase(`/api/admin/agent-package?architecture=${p.id}`)} download={p.pkg.name}>
                  {p.label}{(p.pkg.bytes ?? 0) >= 1024 * 1024 && <span className="muted small"> ({((p.pkg.bytes ?? 0) / 1024 / 1024).toFixed(0)} MB)</span>}</a>
              : <span key={p.id} className="muted small">{p.label}: not published on this server.</span>)}
          </p></li>
        <li><strong>Create an installer for the cabinet.</strong> Each installer works for one cabinet, once, for 7 days, or, made for a site, for the number of that site's cabinets you choose.
          <label className="check"><input type="checkbox" checked={forSite} onChange={e => setForSite(e.target.checked)} /> One installer for several cabinets of one site</label>
          {forSite && (
            <div className="row gap wrap">
              <label className="field inline"><span>Site</span><select required value={siteId} onChange={e => setSiteId(e.target.value)}>
                <option value="">Choose</option>
                {(clients.data ?? []).flatMap(c => c.sites.map(s => <option key={s.id} value={s.id}>{c.name} / {s.name}</option>))}</select></label>
              {/* A failed read of the sites says so, with a way to ask again, instead of an empty list and a disabled button. */}
              {clients.problem && <p className="error small" role="alert">Could not read the sites: {clients.problem}{" "}
                <button type="button" className="btn small" onClick={() => clients.reload()}>Try again</button></p>}
              <label className="field inline"><span>Role</span><select value={role} onChange={e => setRole(e.target.value)}>
                <option value="">Chosen at approval</option><option value="sync">Sync</option><option value="satellite">Satellite</option><option value="standalone">Standalone</option></select></label>
              <label className="field inline"><span>Cabinets</span><input type="number" min={1} max={100} value={cabinets} onChange={e => setCabinets(Math.max(1, Math.min(100, Math.floor(Number(e.target.value) || 1))))} /></label>
              <label className="field inline"><span>Days</span><input type="number" min={1} max={30} value={days} onChange={e => setDays(Math.max(1, Math.min(30, Math.floor(Number(e.target.value) || 1))))} /></label>
            </div>)}
          <p className="row gap wrap">
            <button className="btn primary" data-tour="create-token" disabled={!any || (forSite && !siteId)} onClick={() => { setProblem(null); setConfirm(true); }}>Create installer</button>
            {made && <a className="btn" href={made.href} download={made.fileName}>Download {made.fileName}</a>}
          </p>
          {made && <p className="muted small" role="status">Ready. {made.cabinets ? `For up to ${made.cabinets} cabinets of that site` : "Single use"}, valid until {fullTime(made.expiresAt)}. Every cabinet that uses it still waits for your approval.</p>}
          {problem && <p className="error" role="alert">{problem}</p>}</li>
        <li><strong>On the cabinet,</strong> put the installer in the same folder as the agent files and double-click it. Approve the Windows prompt. The cabinet then appears below for approval.</li>
      </ol>
      <details className="muted small">
        <summary>Requirements and troubleshooting</summary>
        <ul>
          <li>Windows 10 (1607 or later) or Windows 11, 32-bit or 64-bit. The installer uses the built-in Windows PowerShell; nothing else is needed.</li>
          <li>The cabinet must reach <code>{setup.agent.host ?? "this server"}:{setup.agent.port ?? 8443}</code>. It only connects out.</li>
          <li>If Windows SmartScreen appears, choose <em>More info</em>, then <em>Run anyway</em>.</li>
          <li>Elevating as another administrator account: keep the installer and agent files in a folder that account can read.</li>
          <li>If setup stops, the window says what happened and what to do. The installer keeps its token so you can run it again; it deletes itself after a successful install.</li>
        </ul>
      </details>
      <StepUpDialog open={confirm} action="token.create" target="fleet" onClose={() => setConfirm(false)} {...(site ? { params: body } : {})}
        description={<p>{site ? `Create an installer that lets up to ${cabinets} cabinets of this site ask to join, for ${days} days.` : "Create a single-use installer that lets one cabinet ask to join."}</p>}
        onToken={async token => {
          try {
            const r = await api<{ fileName: string; script: string; expiresAt: string; cabinets?: number }>("POST", "/api/admin/installer", { stepUpToken: token, ...body });
            setMade({ fileName: r.fileName, expiresAt: r.expiresAt, ...(r.cabinets ? { cabinets: r.cabinets } : {}), href: URL.createObjectURL(new Blob([r.script], { type: "application/octet-stream" })) });
          } catch (e) { setProblem(describeError(e)); }
        }} />
    </>
  );
}
