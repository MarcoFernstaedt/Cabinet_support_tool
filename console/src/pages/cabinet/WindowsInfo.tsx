// The cabinet's Windows section: what is on the machine and how it is set up, one reading per panel, each run on demand.
// Panels are declared in READINGS; adding a reading means adding an entry, not another component.
import { useState, type ReactNode } from "react";
import type { DiskFoldersOutput, DnsCacheOutput, PowerStatusOutput, ReliabilityListOutput, SessionsListOutput, SharesListOutput, SoftwareListOutput, StartupListOutput, SystemSecurityOutput } from "@mashura/cabinet-contracts/types";
import { useOperation } from "../../lib/commands";
import { ago, bytes, fullTime } from "../../lib/time";
import { Badge, KeyValues, OperationPanel } from "../../components/ui";
import { DataTable, orDash } from "../../components/DataTable";
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

const Power = ({ o }: { o: PowerStatusOutput }) => (
  <KeyValues rows={[
    ["Power plan", o.plan], ["Fast Startup", yesNo(o.fastStartup, false)], ["Hibernate", o.hibernate === null ? "Not reported" : o.hibernate ? "On" : "Off"],
    ["USB selective suspend (plugged in)", yesNo(o.usbSelectiveSuspend?.pluggedIn, false)], ["USB selective suspend (battery)", yesNo(o.usbSelectiveSuspend?.onBattery, false)],
  ]} />);

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

interface Reading<T> { op: string; title: string; description: string; view: (o: T) => ReactNode }
const READINGS: Reading<never>[] = [
  { op: "system.security", title: "Security and activation", description: "Pending restart, Defender, BitLocker, Windows activation and certificates near expiry.", view: o => <Security o={o} /> },
  { op: "reliability.list", title: "Reliability history", description: "Crashes, hangs and Windows failures, newest first.", view: o => <Reliability o={o} /> },
  { op: "software.list", title: "Installed software", description: "Programs and Windows updates, to compare cabinets or find what changed.", view: o => <Software o={o} /> },
  { op: "startup.list", title: "Startup and scheduled tasks", description: "What starts with Windows and what runs on a schedule.", view: o => <Startup o={o} /> },
  { op: "sessions.list", title: "Signed-in users", description: "Who is signed in at the cabinet or over remote desktop.", view: o => <Sessions o={o} /> },
  { op: "shares.list", title: "Network shares", description: "Folders this cabinet shares with other computers.", view: o => <Shares o={o} /> },
  { op: "power.status", title: "Power settings", description: "Power plan, Fast Startup and USB power saving: common causes of devices dropping off after sleep or restart.", view: o => <Power o={o} /> },
  { op: "dns.cache", title: "DNS cache", description: "Names this cabinet has looked up and what it was told.", view: o => <Dns o={o} /> },
] as Reading<never>[];

function ReadingPanel({ cabinetId, reading }: { cabinetId: string; reading: Reading<never> }) {
  const run = useOperation<never>(cabinetId, reading.op);
  return <OperationPanel title={reading.title} description={reading.description} run={run} onRun={() => void run.start()}>{o => reading.view(o)}</OperationPanel>;
}

export function WindowsInfo({ cabinet }: { cabinet: CabinetDetail }) {
  return (<>
    {READINGS.map(r => <ReadingPanel key={r.op} cabinetId={cabinet.id} reading={r} />)}
    <Folders cabinetId={cabinet.id} />
  </>);
}
