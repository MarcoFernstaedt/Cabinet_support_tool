// Services and processes on one cabinet (docs/spec/12-milestones-8-to-12.md, milestone 10): every Windows service with
// its state, start type and account; the watched services and how the broker is keeping them running; start, stop and
// restart (Tier 2 and up, a confirmation click); and the processes, as Task Manager shows them. The agent refuses its own
// and remote-access services and never changes a start type; the server checks every role again.
import { useEffect, useState, type ReactNode } from "react";
import type { ProcessEndOutput, ProcessesListOutput, ServiceControlOutput, ServicesListOutput, SystemPerformanceOutput } from "@mashura/cabinet-contracts/types";
import { api, describeError } from "../../lib/api";
import { useOperation } from "../../lib/commands";
import { atLeast, useSession } from "../../lib/session";
import { useLoad } from "../../lib/useLoad";
import { ago } from "../../lib/time";
import { PerformanceStrip } from "../../components/PerformanceStrip";
import { Pager, usePaged } from "../../components/Pager";
import { Badge, ConfirmDialog, Empty, OperationPanel, WriteOutcome } from "../../components/ui";
import { useCanWrite, useConfirmedWrite } from "./Writes";
import type { CabinetDetail } from "./CabinetPage";

type Service = ServicesListOutput["services"][number];
type Watched = ServicesListOutput["watched"][number];
interface WatchLevels { cabinet: string[] | null; site: string[] | null; client: string[] | null; fleet: string[] | null; effective: string[]; source: string }

const STATE: Record<string, { label: string; tone: "ok" | "warn" | "crit" | "off" | "info" }> = {
  running: { label: "Running", tone: "ok" }, stopped: { label: "Stopped", tone: "off" }, start_pending: { label: "Starting", tone: "info" },
  stop_pending: { label: "Stopping", tone: "info" }, paused: { label: "Paused", tone: "warn" }, pause_pending: { label: "Pausing", tone: "info" },
  continue_pending: { label: "Resuming", tone: "info" }, unknown: { label: "Unknown", tone: "off" },
};
const START: Record<string, string> = { automatic: "Automatic", automatic_delayed: "Automatic (delayed)", manual: "Manual", disabled: "Disabled", boot: "Boot", system: "System", unknown: "Unknown" };
export const WATCH: Record<string, { label: string; tone: "ok" | "warn" | "crit" | "off" | "info" }> = {
  running: { label: "Running", tone: "ok" }, restarted: { label: "Restarted", tone: "warn" }, failing: { label: "Will not stay running", tone: "crit" },
  missing: { label: "Not on this cabinet", tone: "warn" }, disabled: { label: "Disabled", tone: "warn" }, refused: { label: "Never touched by the agent", tone: "off" },
  waiting: { label: "Not checked yet", tone: "off" },
};
/** Pages a list of rows: the children draw the table for the rows of the current page. */
function PagedRows<T>({ rows, label, children }: { rows: readonly T[]; label: string; children: (page: T[]) => ReactNode }) {
  const paged = usePaged(rows);
  return (<>{children(paged.rows)}<Pager {...paged} label={label} /></>);
}

const SOURCE: Record<string, string> = { cabinet: "this cabinet's own list", site: "the site's list", client: "the client's list", fleet: "the fleet default", none: "no list anywhere" };

/** The services the cabinet keeps running, where the list comes from, and each one's status. */
function WatchedPanel({ cabinet, levels, watched, onChanged }: { cabinet: CabinetDetail; levels: WatchLevels | null; watched: Watched[]; onChanged: () => void }) {
  if (!levels) return null;
  return (
    <section className="panel" aria-labelledby="watched-heading">
      <h2 id="watched-heading">Watched services</h2>
      <p className="muted small">These must always be running: the agent starts them again when they stop, and raises a major alert after 3 failed restarts in a row.
        This cabinet uses {SOURCE[levels.source] ?? levels.source}.</p>
      {levels.effective.length === 0 ? <Empty>No services are watched on this cabinet.</Empty> : (
        <table className="table">
          <caption className="sr-only">Watched services on {cabinet.name}</caption>
          <thead><tr><th scope="col">Service</th><th scope="col">Status</th><th scope="col">Restarts today</th><th scope="col">Last restart</th><th scope="col">Last error</th></tr></thead>
          <tbody>{levels.effective.map(name => {
            const w = watched.find(x => x.name.toLowerCase() === name.toLowerCase());
            const s = w ? WATCH[w.state] : WATCH.waiting!;
            return (
              <tr key={name}><th scope="row">{name}</th><td><Badge tone={s!.tone}>{s!.label}</Badge></td><td>{w?.restartsToday ?? 0}</td>
                <td>{w?.lastRestartAt ? ago(w.lastRestartAt) : <span className="muted">never</span>}</td><td>{w?.lastError ?? <span className="muted">none</span>}</td></tr>);
          })}</tbody>
        </table>)}
      {levels.cabinet !== null && <p className="muted small">This cabinet has its own list. <ResetOwnList cabinet={cabinet} onChanged={onChanged} /></p>}
    </section>
  );
}

function ResetOwnList({ cabinet, onChanged }: { cabinet: CabinetDetail; onChanged: () => void }) {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  if (!atLeast(me, "tier2")) return null;
  return (<>
    <button type="button" className="btn small" onClick={() => setOpen(true)}>Use the site's list instead</button>
    <ConfirmDialog open={open} onClose={() => setOpen(false)} description={<p>Remove <strong>{cabinet.name}</strong>'s own watch list, so it uses its site's (or client's, or the fleet's) list again.</p>}
      onConfirm={async () => { await api("PUT", `/api/cabinets/${cabinet.id}/watched-services`, { names: null }); onChanged(); }} />
  </>);
}

export function Services({ cabinet }: { cabinet: CabinetDetail }) {
  const op = useOperation<ServicesListOutput>(cabinet.id, "services.list");
  const levels = useLoad<WatchLevels>(`/api/cabinets/${cabinet.id}/watched-services`);
  const { me } = useSession();
  const canControl = useCanWrite(cabinet, "service.control");
  const control = useConfirmedWrite<ServiceControlOutput>(cabinet, "service.control", r => { if (r.status === "succeeded") void op.start(); });
  const canStartType = useCanWrite(cabinet, "service.setStartType");
  const startType = useConfirmedWrite<{ name: string; before: string; after: string }>(cabinet, "service.setStartType", r => { if (r.status === "succeeded") void op.start(); });
  const [editing, setEditing] = useState<{ name: string; type: string } | null>(null);
  const [filter, setFilter] = useState({ text: "", state: "any" });
  const [watchChange, setWatchChange] = useState<{ name: string; watch: boolean } | null>(null);
  useEffect(() => { void op.start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const effective = levels.data?.effective ?? [];
  const isWatched = (name: string) => effective.some(n => n.toLowerCase() === name.toLowerCase());
  const ask = (s: Service, action: "start" | "stop" | "restart") => control.ask({ name: s.name, action }, <>
    <p>{action[0]!.toUpperCase() + action.slice(1)} the service <strong>{s.displayName}</strong> (<code>{s.name}</code>).</p>
    {action === "stop" && isWatched(s.name) && <p className="notice warn">This service is watched: the agent starts it again within a minute.</p>}
  </>);
  return (<>
    <WatchedPanel cabinet={cabinet} levels={levels.data} watched={op.result?.output?.watched ?? []} onChanged={levels.reload} />
    <OperationPanel title="Services" run={op} onRun={() => void op.start()}>
      {out => {
        const t = filter.text.toLowerCase();
        const shown = out.services.filter(s => (!t || s.name.toLowerCase().includes(t) || s.displayName.toLowerCase().includes(t) || (s.executablePath ?? "").toLowerCase().includes(t))
          && (filter.state === "any" || s.state === filter.state || (filter.state === "watched" && isWatched(s.name))));
        return (<>
          <div className="row gap wrap filters">
            <label className="field inline"><span>Name or path</span><input value={filter.text} onChange={e => setFilter(f => ({ ...f, text: e.target.value }))} /></label>
            <label className="field inline"><span>Show</span><select value={filter.state} onChange={e => setFilter(f => ({ ...f, state: e.target.value }))}>
              <option value="any">All</option><option value="running">Running</option><option value="stopped">Stopped</option><option value="watched">Watched</option></select></label>
            <span className="muted small">{shown.length} of {out.services.length} services</span>
          </div>
          <PagedRows rows={shown} label="services">{page => (<table className="table">
            <caption className="sr-only">Services on {cabinet.name}</caption>
            <thead><tr><th scope="col">Service</th><th scope="col">State</th><th scope="col">Start</th><th scope="col">Runs as</th><th scope="col">Program</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{page.map(s => (
              <tr key={s.name}>
                <th scope="row">{s.displayName}<div className="muted small"><code>{s.name}</code>{s.processId ? ` · PID ${s.processId}` : ""}{isWatched(s.name) && <> · <Badge tone="info">Watched</Badge></>}</div></th>
                <td><Badge tone={STATE[s.state]!.tone}>{STATE[s.state]!.label}</Badge></td>
                <td className="nowrap">{editing?.name === s.name
                  ? <form className="row gap wrap" aria-label={`Change the start type of ${s.displayName}`} onSubmit={e => {
                      e.preventDefault();
                      const type = editing.type;
                      startType.ask({ name: s.name, startType: type }, <>
                        <p>Set the start type of <strong>{s.displayName}</strong> (<code>{s.name}</code>) from <strong>{START[s.startType]}</strong> to <strong>{START_CHOICES.find(c => c[0] === type)?.[1]}</strong>.</p>
                        {type === "disabled" && <p className="notice warn">A disabled service cannot be started, by Windows or by anyone, until it is set to another start type.</p>}
                        <p className="muted small">The service is not started or stopped by this change.</p></>);
                      setEditing(null);
                    }}>
                      <select aria-label="Start type" value={editing.type} onChange={e => setEditing({ name: s.name, type: e.target.value })}>
                        {START_CHOICES.filter(c => c[0] !== s.startType).map(c => <option key={c[0]} value={c[0]}>{c[1]}</option>)}</select>
                      <button className="btn small primary">Review</button><button type="button" className="btn small ghost" onClick={() => setEditing(null)}>Cancel</button>
                    </form>
                  : <>{START[s.startType]}{canStartType && ["automatic", "automatic_delayed", "manual", "disabled"].includes(s.startType)
                    && <> <button className="btn small ghost" data-tour={s.startType === "disabled" ? "start-type" : undefined} onClick={() => setEditing({ name: s.name, type: START_CHOICES.find(c => c[0] !== s.startType)![0] })}>Change…</button></>}</>}</td>
                <td className="small">{s.account ?? <span className="muted">unknown</span>}</td>
                <td className="small wrap">{s.executablePath ?? <span className="muted">unknown</span>}
                  {s.recovery && s.recovery.firstFailure !== "none" && <div className="muted">On failure: {s.recovery.firstFailure.replace("_", " ")}</div>}</td>
                <td className="nowrap"><div className="row gap">
                  {canControl && s.startType !== "disabled" && s.state === "stopped" && <button className="btn small" onClick={() => ask(s, "start")}>Start</button>}
                  {canControl && s.state === "running" && <><button className="btn small" onClick={() => ask(s, "restart")}>Restart</button><button className="btn small" onClick={() => ask(s, "stop")}>Stop</button></>}
                  {atLeast(me, "tier2") && <button className="btn small ghost" onClick={() => setWatchChange({ name: s.name, watch: !isWatched(s.name) })}>{isWatched(s.name) ? "Stop watching" : "Watch"}</button>}
                </div></td>
              </tr>))}
            </tbody>
          </table>)}</PagedRows>
          {shown.length === 0 && <Empty>No service matches.</Empty>}
        </>);
      }}
    </OperationPanel>
    <WriteOutcome run={control.run} done={o => <>Service {o.name}: {o.action} done; it is now {STATE[o.after]?.label.toLowerCase() ?? o.after}.</>} />
    {control.dialog}
    <WriteOutcome run={startType.run} done={o => <>Service {o.name}: start type changed from {START[o.before as keyof typeof START] ?? o.before} to {START[o.after as keyof typeof START] ?? o.after}.</>} />
    {startType.dialog}
    <ConfirmDialog open={watchChange !== null} onClose={() => setWatchChange(null)}
      description={watchChange && <p>{watchChange.watch ? "Watch" : "Stop watching"} <strong>{watchChange.name}</strong> on {cabinet.name}.
        {" "}This gives the cabinet its own watch list{levels.data?.source !== "cabinet" ? `, starting from ${SOURCE[levels.data?.source ?? "none"]}` : ""}.
        {watchChange.watch && " The agent starts it again whenever it stops."}</p>}
      onConfirm={async () => {
        if (!watchChange) return;
        const next = watchChange.watch ? [...effective, watchChange.name] : effective.filter(n => n.toLowerCase() !== watchChange.name.toLowerCase());
        await api("PUT", `/api/cabinets/${cabinet.id}/watched-services`, { names: next });
        levels.reload();
      }} />
  </>);
}

const START_CHOICES: [string, string][] = [["automatic", "Automatic"], ["automatic_delayed", "Automatic (delayed)"], ["manual", "Manual"], ["disabled", "Disabled"]];
const megabytes = (b: number) => `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export function Processes({ cabinet }: { cabinet: CabinetDetail }) {
  const cabinetId = cabinet.id;
  const end = useConfirmedWrite<ProcessEndOutput>(cabinet, "process.end", r => { if (r.status === "succeeded") refresh(); });
  const canEnd = useCanWrite(cabinet, "process.end");
  // Only a program on the cabinet's approved list can be ended (the server and the cabinet refuse anything else), so only those
  // rows offer it. Paths are compared without regard to case, as Windows does.
  const approved = useLoad<{ effective: { entries: { root: string; file: string }[] } | null }>(`/api/cabinets/${cabinetId}/approved-apps`);
  const approvedPaths = new Set((approved.data?.effective?.entries ?? []).map(e => `${e.root.replace(/\\$/, "")}\\${e.file}`.toLowerCase()));
  const isApproved = (p: { executablePath?: string | null }) => !!p.executablePath && approvedPaths.has(p.executablePath.toLowerCase());
  const op = useOperation<ProcessesListOutput>(cabinetId, "processes.list");
  const perf = useOperation<SystemPerformanceOutput>(cabinetId, "system.performance");
  const [text, setText] = useState("");
  const [sort, setSort] = useState<"cpu" | "memory" | "threads" | "handles" | "name">("cpu");
  const [live, setLive] = useState(false);
  const refresh = () => { void op.start(); void perf.start(); };
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const busy = op.state === "running" || perf.state === "running";
  // Live: ask again 3 seconds after the last answer arrived, so reads never pile up on a slow cabinet.
  useEffect(() => {
    if (!live || busy) return;
    const t = setTimeout(refresh, 3000);
    return () => clearTimeout(t);
  }, [live, busy, op.at, perf.at]); // eslint-disable-line react-hooks/exhaustive-deps
  const sorters = { cpu: (a: P, b: P) => b.cpuPercent - a.cpuPercent, memory: (a: P, b: P) => b.workingSetBytes - a.workingSetBytes, threads: (a: P, b: P) => b.threads - a.threads,
    handles: (a: P, b: P) => b.handles - a.handles, name: (a: P, b: P) => a.name.localeCompare(b.name) };
  return (<>
    {perf.result?.output && <section className="panel" aria-label="Performance"><PerformanceStrip p={perf.result.output} /></section>}
    <OperationPanel title="Processes" run={op} onRun={refresh}>
      {out => {
        const t = text.toLowerCase();
        const shown = out.processes.filter(p => !t || p.name.toLowerCase().includes(t) || (p.executablePath ?? "").toLowerCase().includes(t) || String(p.processId) === t).sort(sorters[sort]);
        return (<>
          <div className="row gap wrap filters">
            <label className="field inline"><span>Filter</span><input value={text} onChange={e => setText(e.target.value)} placeholder="name, path or PID" /></label>
            <label className="field inline"><span>Sort</span><select value={sort} onChange={e => setSort(e.target.value as typeof sort)}>
              <option value="cpu">CPU</option><option value="memory">Memory</option><option value="threads">Threads</option><option value="handles">Handles</option><option value="name">Name</option></select></label>
            <label className="field inline"><input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} /><span>Live</span></label>
            <span className="muted small">{shown.length} of {out.processes.length}{out.truncated ? " (first 2,000)" : ""}</span>
            {canEnd && <span className="muted small">Only approved programs can be ended (Admin, Approved programs).</span>}
          </div>
          <PagedRows rows={shown} label="processes">{page => (<table className="table compact">
            <caption className="sr-only">Running processes</caption>
            <thead><tr><th scope="col">Process</th><th scope="col">PID</th><th scope="col">CPU</th><th scope="col">Memory</th><th scope="col">Threads</th><th scope="col">Handles</th><th scope="col">Account</th><th scope="col">Started</th>{canEnd && <th scope="col"><span className="sr-only">End</span></th>}</tr></thead>
            <tbody>{page.map(p => (
              <tr key={p.processId}>
                <th scope="row">{p.name}{p.executablePath && <div className="muted small wrap">{p.executablePath}</div>}</th>
                <td>{p.processId}</td><td>{p.cpuPercent.toFixed(1)}%</td><td>{megabytes(p.workingSetBytes)}</td><td>{p.threads}</td><td>{p.handles}</td>
                <td className="small">{p.account ?? <span className="muted">—</span>}</td><td className="small">{p.startTime ? ago(p.startTime) : <span className="muted">—</span>}</td>
                {canEnd && <td>{mayEnd(p) && isApproved(p) && <button className="btn small ghost" aria-label={`End ${p.name} (${p.processId})`} onClick={() => end.ask({ processId: p.processId, name: p.name },
                  <><p>End <strong>{p.name}</strong> (process {p.processId}).</p><p className="muted small">Anything it has not saved is lost. The cabinet ends it only if the ID and the name still match.</p></>)}>End</button>}</td>}
              </tr>))}
            </tbody>
          </table>)}</PagedRows>
        </>);
      }}
    </OperationPanel>
    <WriteOutcome run={end.run} done={o => o.ended ? <>Ended {o.name}.</> : <>{o.name} did not end within 5 seconds.</>} />
    {end.dialog}
  </>);
}

/** A hint for hiding the button on Windows' own processes; the agent refuses them whatever the console shows. */
const mayEnd = (p: { processId: number; name: string }) => p.processId > 4 && !["system", "registry", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe", "lsass.exe", "svchost.exe"].includes(p.name.toLowerCase())
  && !p.name.toLowerCase().startsWith("cabinet.agent");

type P = ProcessesListOutput["processes"][number];

/** A watch list editor for a client, a site or the fleet default (one name per line). */
export function WatchListEditor({ endpoint, own, inherited, what, editable, onSaved }: {
  endpoint: string; own: string[] | null; inherited: ReactNode; what: string; editable: boolean; onSaved: () => void;
}) {
  const [text, setText] = useState((own ?? []).join("\n"));
  const [pending, setPending] = useState<string[] | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const names = text.split(/\s*\n\s*/).map(s => s.trim()).filter(Boolean);
  const valid = names.length <= 16 && new Set(names.map(n => n.toLowerCase())).size === names.length && names.every(n => /^[A-Za-z0-9_.$-](?:[A-Za-z0-9_.$ -]{0,78}[A-Za-z0-9_.$-])?$/.test(n));
  return (
    <div className="stack">
      <p>{own === null ? <>Nothing set here; {inherited ?? "no services are watched."}</> : own.length === 0 ? <>Set here: <strong>no services are watched</strong>.</> : <>Set here: <code>{own.join(", ")}</code></>}</p>
      {editable && (
        <form className="stack" onSubmit={e => { e.preventDefault(); setProblem(null); setSaved(false); setPending(names); }}>
          <label className="field"><span>Service names (the key name, such as <code>BioScanSvc</code>; one per line; up to 16)</span>
            <textarea rows={3} value={text} onChange={e => setText(e.target.value)} /></label>
          <div className="row gap wrap"><button className="btn" disabled={!valid}>Save</button>
            {own !== null && <button type="button" className="btn ghost" onClick={() => { setProblem(null); setSaved(false); setPending(null); }}>Use the level above</button>}
            {!valid && <span className="error">Up to 16 different service names, letters, digits and _ . $ - only.</span>}
            {saved && <span className="ok" role="status">Saved. Cabinets use it from their next heartbeat.</span>}</div>
          {problem && <p className="error" role="alert">{problem}</p>}
        </form>)}
      <ConfirmDialog open={pending !== undefined} onClose={() => setPending(undefined)}
        description={<p>{pending === null ? <>Remove {what}'s own watch list, so the level above applies.</> : pending && pending.length > 0
          ? <>Keep <code>{pending.join(", ")}</code> running on {what}. The agent starts each one again whenever it stops.</> : <>Watch no services on {what}.</>}</p>}
        onConfirm={async () => {
          try { await api("PUT", endpoint, { names: pending ?? null }); setSaved(true); onSaved(); }
          catch (e) { setProblem(describeError(e)); throw e; }
        }} />
    </div>
  );
}
