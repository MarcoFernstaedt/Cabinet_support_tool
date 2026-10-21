// The cabinet's Windows section: what is on the machine and how it is set up, one reading per panel, each run on demand.
// Panels are declared in READINGS; adding a reading means adding an entry, not another component.
import { useState, type ReactNode } from "react";
import type { DiskFoldersOutput, DnsCacheOutput, NetworkHostsOutput, SystemHardwareOutput, SystemIdentityOutput, PowerSetOutput, PowerStatusOutput, SystemCheckHealthOutput, SystemRestartOutput, ReliabilityListOutput, SessionsListOutput, SharesListOutput, SoftwareListOutput, StartupListOutput, SystemSecurityOutput } from "@mashura/cabinet-contracts/types";
import { useOperation } from "../../lib/commands";
import { useLoad } from "../../lib/useLoad";
import { ago, bytes, fullTime } from "../../lib/time";
import { Badge, KeyValues, OperationPanel, WriteOutcome } from "../../components/ui";
import { DataTable, orDash } from "../../components/DataTable";
import { atLeast, useSession } from "../../lib/session";
import { useCanWrite, useConfirmedWrite } from "./Writes";
import type { CabinetDetail } from "./CabinetPage";

const yesNo = (v: boolean | null | undefined, good = true): ReactNode =>
  v === null || v === undefined ? <Badge tone="off">Not reported</Badge> : <Badge tone={v === good ? "ok" : "warn"}>{v ? "On" : "Off"}</Badge>;

function Security({ o }: { o: SystemSecurityOutput }) {
  return (<>
    <KeyValues rows={[
      ["Restart pending", o.pendingReboot.pending ? <Badge tone="warn">Yes: {o.pendingReboot.reasons.join(", ")}</Badge> : <Badge tone="ok">No</Badge>],
      ["Windows activation", o.activation ? <Badge tone={o.activation.licensed ? "ok" : "crit"}>{o.activation.status}</Badge> : "Not reported"],
      ["Defender", o.defender ? yesNo(o.defender.enabled) : "Not reported"],
      ["Real-time protection", o.defender ? yesNo(o.defender.realTimeProtection) : "Not reported"],
      ["Signatures updated", o.defender ? (o.defender.signatureAgeDays === null ? "Not reported" : <Badge tone={o.defender.signatureAgeDays > 7 ? "warn" : "ok"}>{o.defender.signatureAgeDays} days ago</Badge>) : "Not reported"],
      ["Last quick scan", o.defender?.lastQuickScan ? fullTime(o.defender.lastQuickScan) : "Not reported"],
    ]} />
    {o.defender && o.defender.threats.length > 0 && <DataTable label="Defender detections" rows={o.defender.threats} empty="" filterable={false} columns={[
      { header: "Threat", first: true, cell: t => t.name }, { header: "Detected", cell: t => orDash(t.detectedAt && fullTime(t.detectedAt)) },
      { header: "State", cell: t => <Badge tone={t.active ? "crit" : "info"}>{t.active ? "Active" : "Handled"}</Badge> }]} />}
    <h4>Drive encryption</h4>
    <DataTable label="volumes" rows={o.bitlocker} empty="No BitLocker volumes reported." filterable={false} columns={[
      { header: "Volume", first: true, cell: v => v.volume }, { header: "Protection", cell: v => <Badge tone={v.protection === "on" ? "ok" : "info"}>{v.protection === "on" ? "On" : v.protection === "off" ? "Off" : "Unknown"}</Badge> }]} />
    <h4>Certificates expired or expiring within 90 days</h4>
    <DataTable label="certificates" rows={o.certificates} empty="None." filterable={false} columns={[
      { header: "Subject", first: true, cell: c => c.subject, text: c => c.subject }, { header: "Store", cell: c => c.store },
      { header: "Expires", cell: c => fullTime(c.notAfter) }, { header: "Days left", cell: c => <Badge tone={c.expired ? "crit" : "warn"}>{c.expired ? `expired ${-c.daysLeft} days ago` : c.daysLeft}</Badge> }]} />
  </>);
}

function Software({ o }: { o: SoftwareListOutput }) {
  return (<>
    <DataTable label="programs" rows={o.programs} truncated={o.truncated} empty="No installed programs reported." columns={[
      { header: "Program", first: true, cell: p => p.name, text: p => `${p.name} ${p.publisher ?? ""}` }, { header: "Version", cell: p => orDash(p.version) },
      { header: "Publisher", cell: p => orDash(p.publisher) }, { header: "Installed", cell: p => orDash(p.installedOn) }]} />
    <h4>Windows updates installed</h4>
    <DataTable label="updates" rows={o.hotfixes} empty="No hotfixes reported." columns={[
      { header: "Update", first: true, cell: h => h.id, text: h => h.id }, { header: "Type", cell: h => orDash(h.description) }, { header: "Installed", cell: h => orDash(h.installedOn) }]} />
  </>);
}

function Startup({ o }: { o: StartupListOutput }) {
  return (<>
    <DataTable label="startup programs" rows={o.startup} truncated={o.truncated} empty="No startup programs." columns={[
      { header: "Name", first: true, cell: s => s.name, text: s => `${s.name} ${s.command}` }, { header: "Command", cell: s => <code className="wrap">{s.command}</code> }, { header: "From", cell: s => s.location }]} />
    <h4>Scheduled tasks (not Microsoft's)</h4>
    <DataTable label="tasks" rows={o.tasks} empty="No other scheduled tasks." columns={[
      { header: "Task", first: true, cell: t => t.name, text: t => `${t.path}${t.name}` }, { header: "Folder", cell: t => t.path },
      { header: "State", cell: t => <Badge tone={t.state === "disabled" ? "off" : t.state === "running" ? "info" : "ok"}>{t.state}</Badge> }]} />
  </>);
}

const Sessions = ({ o }: { o: SessionsListOutput }) => (
  <DataTable label="sessions" rows={o.sessions} empty="Nobody is signed in." filterable={false} columns={[
    { header: "User", first: true, cell: s => s.user }, { header: "Session", cell: s => s.id },
    { header: "State", cell: s => <Badge tone={s.state === "active" ? "ok" : "info"}>{s.state}</Badge> },
    { header: "How", cell: s => <Badge tone={s.type === "remote" ? "warn" : "off"}>{s.type === "remote" ? "Remote desktop" : "At the cabinet"}</Badge> }]} />);

const Shares = ({ o }: { o: SharesListOutput }) => (
  <DataTable label="shares" rows={o.shares} empty="No shares." filterable={false} columns={[
    { header: "Share", first: true, cell: s => s.name }, { header: "Path", cell: s => orDash(s.path) },
    { header: "Kind", cell: s => <Badge tone={s.kind === "disk" ? "warn" : "off"}>{s.kind}</Badge> }, { header: "Comment", cell: s => orDash(s.description) }]} />);

const KIND: Record<string, string> = { appCrash: "App crash", appHang: "App hang", windowsFailure: "Windows failure", updateFailure: "Update failure", other: "Other" };
const Reliability = ({ o }: { o: ReliabilityListOutput }) => (
  <DataTable label="events" rows={o.records} truncated={o.truncated} empty="No reliability events." columns={[
    { header: "When", cell: r => <span title={fullTime(r.at)}>{ago(r.at)}</span> }, { header: "What", first: true, cell: r => <Badge tone={r.kind === "other" ? "off" : "warn"}>{KIND[r.kind] ?? r.kind}</Badge>, text: r => KIND[r.kind] ?? r.kind },
    { header: "Program", cell: r => orDash(r.product ?? r.source), text: r => `${r.product ?? ""} ${r.source}` }, { header: "Detail", cell: r => r.message, text: r => r.message }]} />);

const Dns = ({ o }: { o: DnsCacheOutput }) => (
  <DataTable label="cached names" rows={o.entries} truncated={o.truncated} empty="The DNS cache is empty." columns={[
    { header: "Name", first: true, cell: e => e.name, text: e => `${e.name} ${e.data}` }, { header: "Type", cell: e => e.type }, { header: "Answer", cell: e => e.data }, { header: "TTL", cell: e => `${e.ttlSeconds} s` }]} />);

/** The power settings, each with the one change that usually fixes a device that drops out. */
function Power({ o, cabinet }: { o: PowerStatusOutput; cabinet: CabinetDetail }) {
  // What the cabinet answered to a change replaces the reading shown, so the panel stays as it is and the answer stays on screen.
  const [changed, setChanged] = useState<{ fast_startup?: boolean | null; usb_selective_suspend?: boolean | null }>({});
  const set = useConfirmedWrite<PowerSetOutput>(cabinet, "power.set", r => { if (r.status === "succeeded" && r.output) setChanged(c => ({ ...c, [r.output!.setting]: r.output!.after })); });
  const can = useCanWrite(cabinet, "power.set");
  const usb = "usb_selective_suspend" in changed ? changed.usb_selective_suspend ?? null : o.usbSelectiveSuspend?.pluggedIn ?? null;
  const fast = "fast_startup" in changed ? changed.fast_startup ?? null : o.fastStartup;
  const turnOff = (setting: "usb_selective_suspend" | "fast_startup", what: string, why: string) =>
    <button className="btn small" onClick={() => set.ask({ setting, enabled: false }, <><p>Turn off <strong>{what}</strong>.</p><p className="muted small">{why}</p></>)}>Turn off</button>;
  return (<>
    <KeyValues rows={[
      ["Power plan", o.plan],
      ["Fast Startup", <>{yesNo(fast, false)} {can && fast === true && turnOff("fast_startup", "Fast Startup", "Windows then starts fresh each time instead of resuming a saved state, which clears devices stuck after a shutdown.")}</>],
      ["Hibernate", o.hibernate === null ? "Not reported" : o.hibernate ? "On" : "Off"],
      ["USB selective suspend", <>{yesNo(usb, false)} {can && usb === true && turnOff("usb_selective_suspend", "USB selective suspend", "Windows will no longer switch USB ports off to save power. A scanner or drawer that drops out and comes back is often this.")}</>],
    ]} />
    <WriteOutcome run={set.run} done={out => <>{out.setting === "fast_startup" ? "Fast Startup" : "USB selective suspend"} is now {out.after === null ? "changed" : out.after ? "on" : "off"}.</>} />
    {set.dialog}
  </>);
}

const notReported = <span className="muted">Not reported</span>;
const SECURE_BOOT = { on: ["ok", "On"], off: ["warn", "Off"], unsupported: ["off", "Not supported"] } as const;

/** Make and model, BIOS, processor, memory, TPM, Secure Boot, last start, displays and COM ports. Anything the cabinet could not read says so. */
function Hardware({ o }: { o: SystemHardwareOutput }) {
  const gib = (n: number | null) => (n === null ? "Not reported" : bytes(n));
  return (<>
    <KeyValues rows={[
      ["Make and model", o.manufacturer || o.model ? `${o.manufacturer ?? ""} ${o.model ?? ""}`.trim() : notReported],
      ["BIOS", o.bios.version ? `${o.bios.version}${o.bios.vendor ? `, ${o.bios.vendor}` : ""}${o.bios.date ? `, ${fullTime(o.bios.date).split(",")[0]}` : ""}` : notReported],
      ["Processor", o.cpu.model ? `${o.cpu.model}${o.cpu.logicalCores !== null ? `, ${o.cpu.logicalCores} logical cores` : ""}` : notReported],
      ["Memory", `${gib(o.memory.totalBytes)}${o.memory.moduleCount !== null ? `, ${o.memory.moduleCount} ${o.memory.moduleCount === 1 ? "module" : "modules"}` : ""}`],
      ["TPM", o.tpm === null ? notReported : !o.tpm.present ? <Badge tone="warn">None found</Badge> : <>{yesNo(o.tpm.enabled)} {o.tpm.version ? `version ${o.tpm.version}` : ""}</>],
      ["Secure Boot", o.secureBoot === null ? notReported : <Badge tone={SECURE_BOOT[o.secureBoot][0]}>{SECURE_BOOT[o.secureBoot][1]}</Badge>],
      ["Last started", o.lastBoot ? <span title={fullTime(o.lastBoot)}>{ago(o.lastBoot)}</span> : notReported],
    ]} />
    <h4>Displays</h4>
    <DataTable label="displays" rows={o.monitors} empty="No displays reported." filterable={false} columns={[
      { header: "Display", first: true, cell: m => orDash(m.name) }, { header: "Resolution", cell: m => (m.width && m.height ? `${m.width} × ${m.height}` : "Not reported") }]} />
    <h4>Serial (COM) ports</h4>
    <DataTable label="COM ports" rows={o.ports} empty="No serial ports are open on this cabinet." filterable={false} columns={[
      { header: "Port", first: true, cell: p => p.port }, { header: "Device", cell: p => orDash(p.deviceName) },
      { header: "Driver", cell: p => orDash(p.driverProvider) }, { header: "Version", cell: p => orDash(p.driverVersion) }]} />
    {o.memory.modules.length > 0 && <>
      <h4>Memory modules</h4>
      <DataTable label="memory modules" rows={o.memory.modules} empty="" filterable={false} columns={[
        { header: "Slot", first: true, cell: m => orDash(m.slot) }, { header: "Size", cell: m => gib(m.capacityBytes) }, { header: "Speed", cell: m => (m.speedMhz === null ? "Not reported" : `${m.speedMhz} MHz`) }]} />
    </>}
  </>);
}

/** Domain or workgroup, the local administrators, automatic sign-in and Group Policy. The automatic sign-in password is never read. */
function Identity({ o }: { o: SystemIdentityOutput }) {
  return (<>
    <KeyValues rows={[
      ["Joined to", o.joinType === "domain" ? `Domain ${o.name ?? ""}`.trim() : o.joinType === "workgroup" ? <>Workgroup {o.name ?? ""} <Badge tone="info">Not in a domain</Badge></> : notReported],
      ...(o.joinType === "domain" ? [["Domain controller", o.domainControllerFound === null ? notReported : <Badge tone={o.domainControllerFound ? "ok" : "warn"}>{o.domainControllerFound ? "Found" : "None answered"}</Badge>] as [string, ReactNode]] : []),
      ["Automatic sign-in", o.autoLogon === null ? notReported : o.autoLogon.enabled ? <Badge tone="warn">On{o.autoLogon.userName ? `, as ${o.autoLogon.userName}` : ""}</Badge> : <Badge tone="ok">Off</Badge>],
      ["Group Policy last applied", o.groupPolicyLastApplied ? <span title={fullTime(o.groupPolicyLastApplied)}>{ago(o.groupPolicyLastApplied)}</span> : "Not reported"],
    ]} />
    <h4>Local administrators</h4>
    <DataTable label="administrators" rows={(o.localAdministrators?.names ?? []).map(name => ({ name }))} truncated={o.localAdministrators?.truncated} filterable={false}
      empty={o.localAdministrators === null ? "The cabinet could not list its administrators." : "No members reported."} columns={[{ header: "Name", first: true, cell: a => a.name }]} />
  </>);
}

const Hosts = ({ o }: { o: NetworkHostsOutput }) => (
  <DataTable label="hosts entries" rows={o.entries} truncated={o.truncated} empty="The hosts file has no entries, so every name is looked up normally." columns={[
    { header: "Address", first: true, cell: e => e.address, text: e => `${e.address} ${e.names.join(" ")}` }, { header: "Names", cell: e => e.names.join(", ") }]} />);

const HEALTH = { healthy: ["ok", "Healthy"], repairable: ["warn", "Damaged, repairable"], corrupt: ["crit", "Damaged"], unknown: ["off", "Not clear"] } as const;
const Health = ({ o }: { o: SystemCheckHealthOutput }) => (
  <KeyValues rows={[["Component store", <Badge tone={HEALTH[o.state][0]}>{HEALTH[o.state][1]}</Badge>], ["Windows said", o.summary], ["Took", `${(o.elapsedMs / 1000).toFixed(1)} s`]]} />);

/** Restart or shut the cabinet down after a delay, with a message on its screen; or stop one that is waiting. */
function Restart({ cabinet }: { cabinet: CabinetDetail }) {
  const admin = atLeast(useSession().me, "admin");
  const can = useCanWrite(cabinet, "system.restart");
  const run = useConfirmedWrite<SystemRestartOutput>(cabinet, "system.restart");
  const [mode, setMode] = useState<"restart" | "shutdown">("restart");
  const [delay, setDelay] = useState(300);
  const [message, setMessage] = useState("");
  if (!can) return null;
  const params = { mode, delaySeconds: delay, ...(message.trim() ? { message: message.trim() } : {}) };
  return (
    <section className="panel" aria-labelledby="restart-heading">
      <h3 id="restart-heading">Restart or shut down</h3>
      <p className="muted small">Gives anyone at the cabinet the chance to save first. A cabinet that is shut down stays off until someone switches it on.</p>
      <form className="row gap wrap" aria-label="Restart or shut down" onSubmit={e => {
        e.preventDefault();
        run.ask(params, <><p><strong>{mode === "restart" ? "Restart" : "Shut down"}</strong> the cabinet {delay === 0 ? "now" : `in ${delay / 60} ${delay === 60 ? "minute" : "minutes"}`}.</p>
          {message.trim() && <p>Message on its screen: “{message.trim()}”</p>}{mode === "shutdown" && <p className="notice warn">It will stay off until someone switches it on at the cabinet.</p>}</>);
      }}>
        <label className="field inline"><span>Action</span><select value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
          <option value="restart">Restart</option>{admin && <option value="shutdown">Shut down</option>}</select></label>
        <label className="field inline"><span>In</span><select value={delay} onChange={e => setDelay(Number(e.target.value))}>
          {[[0, "Right away"], [60, "1 minute"], [300, "5 minutes"], [900, "15 minutes"], [3600, "1 hour"]].map(([s, l]) => <option key={s} value={s}>{l}</option>)}</select></label>
        <label className="field inline"><span>Message (optional)</span><input maxLength={200} value={message} onChange={e => setMessage(e.target.value.replace(/[\u0000-\u001f\u007f]/g, ""))} placeholder="Restarting to finish updates." /></label>
        <button className="btn" type="submit" disabled={run.run.state === "running"}>Review</button>
        <button className="btn ghost" type="button" disabled={run.run.state === "running"}
          onClick={() => run.ask({ mode: "cancel" }, <p>Cancel a restart or shutdown that is waiting on the cabinet.</p>)}>Cancel a waiting restart</button>
      </form>
      <WriteOutcome run={run.run} done={o => o.mode === "cancel" ? <>The waiting restart was cancelled.</> : <>{o.mode === "restart" ? "Restart" : "Shutdown"} scheduled for {fullTime(o.scheduledFor)}.</>} />
      {run.dialog}
    </section>
  );
}

/** Which top-level folder is taking the space: asks for one folder at a time. */
function Folders({ cabinetId }: { cabinetId: string }) {
  const run = useOperation<DiskFoldersOutput>(cabinetId, "disk.folders");
  const [path, setPath] = useState("C:\\");
  return (
    <OperationPanel title="Folder sizes" description="Where the disk space went, one folder level at a time. Reads sizes only; no file is opened." run={run} onRun={() => void run.start({ path })} buttonLabel="Measure">
      {o => (<>
        <p className="muted small">{o.path}: {bytes(o.totalBytes)}{o.partial ? " (stopped at the time limit, so some folders are under-counted)" : ""}, measured in {(o.elapsedMs / 1000).toFixed(1)} s</p>
        <DataTable label="folders" rows={o.folders} empty="No folders." filterable={false} columns={[
          { header: "Folder", first: true, cell: f => <button className="linkish" onClick={() => { const next = `${o.path.endsWith("\\") ? o.path : `${o.path}\\`}${f.name}`; setPath(next); void run.start({ path: next }); }}>{f.name}</button> },
          { header: "Size", cell: f => bytes(f.sizeBytes) }, { header: "Files", cell: f => f.files.toLocaleString("en-US") }]} />
      </>)}
    </OperationPanel>
  );
}

interface Reading<T> { op: string; title: string; description: string; view: (o: T, ctx: { cabinet: CabinetDetail }) => ReactNode }
const READINGS: Reading<never>[] = [
  { op: "system.security", title: "Security and activation", description: "Pending restart, Defender, BitLocker, Windows activation and certificates near expiry.", view: o => <Security o={o} /> },
  { op: "system.hardware", title: "Hardware", description: "Make and model, BIOS, processor, memory, TPM, Secure Boot, displays and COM ports: to match drivers and spot a bad batch.", view: o => <Hardware o={o} /> },
  { op: "system.identity", title: "Identity and policy", description: "Domain or workgroup, local administrators, automatic sign-in and when Group Policy last applied. No password is ever read.", view: o => <Identity o={o} /> },
  { op: "network.hosts", title: "Hosts file", description: "Names the hosts file sends to a fixed address, whatever DNS says. A stale line sends a name to the wrong place. Comments are not read.", view: o => <Hosts o={o} /> },
  { op: "reliability.list", title: "Reliability history", description: "Crashes, hangs and Windows failures, newest first.", view: o => <Reliability o={o} /> },
  { op: "software.list", title: "Installed software", description: "Programs and Windows updates, to compare cabinets or find what changed.", view: o => <Software o={o} /> },
  { op: "startup.list", title: "Startup and scheduled tasks", description: "What starts with Windows and what runs on a schedule.", view: o => <Startup o={o} /> },
  { op: "sessions.list", title: "Signed-in users", description: "Who is signed in at the cabinet or over remote desktop.", view: o => <Sessions o={o} /> },
  { op: "shares.list", title: "Network shares", description: "Folders this cabinet shares with other computers.", view: o => <Shares o={o} /> },
  { op: "power.status", title: "Power settings", description: "Power plan, Fast Startup and USB power saving: common causes of devices dropping off after sleep or restart.", view: (o, c) => <Power o={o} cabinet={c.cabinet} /> },
  { op: "system.checkHealth", title: "Windows health check", description: "Asks Windows whether its own files are damaged. Only looks; nothing is repaired. Can take a minute.", view: o => <Health o={o} /> },
  { op: "dns.cache", title: "DNS cache", description: "Names this cabinet has looked up and what it was told.", view: o => <Dns o={o} /> },
] as Reading<never>[];

function ReadingPanel({ cabinet, reading }: { cabinet: CabinetDetail; reading: Reading<never> }) {
  const run = useOperation<never>(cabinet.id, reading.op);
  // What the platform already holds from an earlier read shows at once, also while the cabinet is offline; Run reads it again.
  const stored = useLoad<{ reading: { at: string; output: never } | null }>(`/api/cabinets/${cabinet.id}/readings/${reading.op}`).data?.reading ?? null;
  return <OperationPanel title={reading.title} description={reading.description} run={run} onRun={() => void run.start()} stored={stored}>{o => reading.view(o, { cabinet })}</OperationPanel>;
}

export function WindowsInfo({ cabinet }: { cabinet: CabinetDetail }) {
  return (<>
    {READINGS.map(r => <ReadingPanel key={r.op} cabinet={cabinet} reading={r} />)}
    <Restart cabinet={cabinet} />
    <Folders cabinetId={cabinet.id} />
  </>);
}
