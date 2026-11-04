// Crash investigation (docs/spec/13-roadmap.md phase 2): on a cabinet, its blue screens, unexpected restarts and what changed
// in the 72 hours before the first; on the Incidents page, a fleet crash incident with the cabinets that crashed compared
// with the ones that did not. What is shown is evidence and correlation; the page says so and never names a root cause.
import { causesLine, type ShutdownCauses } from "../lib/shutdown-causes";
import { durationText, endText, type BootRecord } from "../lib/boot-history";
import { sizeText, stopCodeText, type Minidump } from "../lib/crash-dumps";
import { orderPatterns, reachText, type FleetPattern } from "../lib/fleet-patterns";
import { useOperation } from "../lib/commands";
import { useMemo, useState } from "react";
import { Pager, usePaged } from "../components/Pager";
import { EncryptedExport } from "../components/EncryptedExport";
import { Link } from "../lib/router";
import { fullTime, ago } from "../lib/time";
import { useLoad } from "../lib/useLoad";
import { Badge, Empty } from "../components/ui";
import { DemoTag } from "../components/DemoBanner";

interface StopCode { code: number | null; text: string; name: string | null; hint: string | null }
interface TimelineItem { at: string; category: string; title: string; detail: string; stopCode?: StopCode }
interface CabinetCrashes {
  days: number; crashes: number; unexpectedShutdowns: number; boots: number; storageErrors: number; hardwareErrors: number;
  /** Absent from a server older than the classification. */
  shutdownCauses?: ShutdownCauses;
  stopCodes: { stopCode: StopCode; count: number }[]; rebootLoop: { open: boolean; title: string; since: string } | null;
  firstAt: string | null; beforeFirst: TimelineItem[]; timeline: TimelineItem[];
}

const CATEGORY: Record<string, { label: string; tone: "crit" | "warn" | "info" | "ok" | "off" }> = {
  crash: { label: "Blue screen", tone: "crit" }, unexpected_shutdown: { label: "Unexpected restart", tone: "crit" }, hardware: { label: "Hardware", tone: "crit" },
  storage: { label: "Storage", tone: "warn" }, update_installed: { label: "Update", tone: "info" }, update_started: { label: "Update", tone: "off" },
  update_failed: { label: "Update failed", tone: "warn" }, driver_installed: { label: "Driver", tone: "info" }, driver_failed: { label: "Driver failed", tone: "warn" },
  service_installed: { label: "Service", tone: "info" }, service_failure: { label: "Service failed", tone: "warn" }, software_installed: { label: "Software", tone: "info" },
  software_removed: { label: "Software", tone: "info" }, boot: { label: "Start", tone: "off" }, shutdown: { label: "Shutdown", tone: "off" },
  restart_requested: { label: "Restart", tone: "off" }, scanner: { label: "Scanner", tone: "warn" }, service: { label: "Service", tone: "warn" },
  firewall: { label: "Firewall", tone: "warn" }, platform_change: { label: "Platform", tone: "info" }, error: { label: "Error", tone: "warn" },
};
const Cat = ({ c }: { c: string }) => { const x = CATEGORY[c] ?? { label: c, tone: "off" as const }; return <Badge tone={x.tone}>{x.label}</Badge>; };
const CORRELATION = "Things that happened before a crash are evidence to check first, not proof of the cause.";

export function StopCodeLine({ s }: { s: StopCode }) {
  return <><code>{s.text}</code>{s.name && <> <strong>{s.name}</strong></>}{s.hint && <span className="muted small"> — {s.hint}</span>}</>;
}

function TimelineTable({ items, label }: { items: TimelineItem[]; label: string }) {
  const [only, setOnly] = useState<"all" | "important">("important");
  const shown = only === "all" ? items : items.filter(i => !["boot", "shutdown", "update_started", "error"].includes(i.category));
  const paged = usePaged(shown);
  return (<>
    <div className="row gap wrap filters">
      <label className="field inline"><span>Show</span><select value={only} onChange={e => setOnly(e.target.value as typeof only)}>
        <option value="important">Changes, crashes and hardware</option><option value="all">Everything, including starts and other errors</option></select></label>
      <span className="muted small">{shown.length} of {items.length}</span>
    </div>
    {shown.length === 0 ? <Empty>Nothing recorded in this period.</Empty> : (
      <table className="table compact">
        <caption className="sr-only">{label}</caption>
        <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">Details</th></tr></thead>
        <tbody>{paged.rows.map((i, n) => (
          <tr key={n} className={i.category === "crash" ? "row-crit" : undefined}>
            <td className="small nowrap">{fullTime(i.at)}</td>
            <td><Cat c={i.category} /> {i.stopCode ? <StopCodeLine s={i.stopCode} /> : i.title}</td>
            <td className="small muted wrap">{i.detail}</td>
          </tr>))}
        </tbody>
      </table>)}
    <Pager {...paged} label="timeline entries" />
  </>);
}

/** The cabinet's "Crashes and restarts" section. */
export function CabinetCrashes({ cabinetId }: { cabinetId: string }) {
  const [days, setDays] = useState("30");
  const { data, problem } = useLoad<CabinetCrashes>(`/api/cabinets/${cabinetId}/crashes?days=${days}`);
  return (
    <section className="panel" aria-labelledby="crashes-heading">
      <div className="panel-head">
        <div>
          <h2 id="crashes-heading">Crashes and restarts</h2>
        </div>
        <label className="field inline"><span>Period</span><select value={days} onChange={e => setDays(e.target.value)}>
          {["7", "30", "90"].map(d => <option key={d} value={d}>Last {d} days</option>)}</select></label>
        {/* Everything the platform holds about this cabinet for the period, hashed and with where each part came from; the download is audited. */}
        <a className="btn small" href={`/api/cabinets/${cabinetId}/evidence?days=${days}`} download>Download evidence package</a>
        <EncryptedExport cabinetId={cabinetId} days={days} />
      </div>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && (<>
        <dl className="kv">
          {[["Blue screens", data.crashes, data.crashes > 0], ["Unexpected restarts", data.unexpectedShutdowns, data.unexpectedShutdowns > 0], ["Starts", data.boots, false],
            ["Storage errors", data.storageErrors, data.storageErrors > 0], ["Hardware errors", data.hardwareErrors, data.hardwareErrors > 0]].map(([k, v, bad]) => (
            <div key={String(k)}><dt>{k}</dt><dd>{bad ? <Badge tone="crit">{String(v)}</Badge> : String(v)}</dd></div>))}
          {causesLine(data.shutdownCauses) && <div><dt>Why they restarted</dt><dd>{causesLine(data.shutdownCauses)}</dd></div>}
          <div><dt>Reboot loop</dt><dd>{data.rebootLoop?.open ? <Badge tone="crit">Restarting repeatedly since {ago(data.rebootLoop.since)}</Badge> : data.rebootLoop ? "Ended" : "No"}</dd></div>
        </dl>
        {data.stopCodes.length > 0 && (
          <table className="table compact">
            <caption className="sr-only">Stop codes</caption>
            <thead><tr><th scope="col">Stop code</th><th scope="col">Times</th></tr></thead>
            <tbody>{data.stopCodes.map(s => <tr key={s.stopCode.text}><td><StopCodeLine s={s.stopCode} /></td><td>{s.count}</td></tr>)}</tbody>
          </table>)}
        {data.firstAt ? (<>
          <h3>In the 72 hours before the first crash ({fullTime(data.firstAt)})</h3>
          <p className="muted small">{CORRELATION}</p>
          {data.beforeFirst.length === 0 ? <Empty>No updates, drivers, software or errors were recorded in the 72 hours before it.</Empty> : (
            <ul className="findings">{data.beforeFirst.map((i, n) => (
              <li key={n} className={`finding ${i.category === "storage" || i.category === "hardware" ? "warning" : "info"}`}>
                <div className="finding-head"><Cat c={i.category} /><strong>{i.title}</strong><span className="muted small">{fullTime(i.at)}</span></div>
              </li>))}</ul>)}
        </>) : <p className="muted">No blue screen or unexpected restart in the last {data.days} days.</p>}
        <h3>Timeline</h3>
        <TimelineTable items={data.timeline} label="Timeline of changes, crashes and errors" />
      </>)}
      <BootHistoryPanel cabinetId={cabinetId} days={Number(days)} />
      <CrashDumpsPanel cabinetId={cabinetId} />
    </section>
  );
}

/** Lists the cabinet's crash dumps (crash.list): names, times and stop codes from each small dump's header. No dump is copied. */
function CrashDumpsPanel({ cabinetId }: { cabinetId: string }) {
  const op = useOperation<{ folderFound: boolean; minidumps: Minidump[]; memoryDump: { writtenAt: string; sizeBytes: number } | null; truncated: boolean }>(cabinetId, "crash.list");
  const out = op.result?.output;
  return (
    <div aria-live="polite">
      <h3>Crash dumps</h3>
      <p className="muted small">What Windows saved when it stopped: each small dump's time and stop code, read from its first few kilobytes on the cabinet. Nothing is copied off the cabinet.</p>
      <button className="btn" onClick={() => void op.start({})} disabled={op.state === "running"}>{op.state === "running" ? "Reading…" : "List the crash dumps"}</button>
      {op.problem && <p className="error" role="alert">{op.problem}</p>}
      {op.result && op.result.status !== "succeeded" && <p className="error" role="alert">{op.result.error?.message}</p>}
      {out && (out.minidumps.length === 0
        ? <Empty>{out.folderFound ? "The crash dump folder is empty." : "Windows has never saved a small crash dump on this cabinet."}</Empty>
        : <table className="table compact"><caption className="sr-only">Small crash dumps, newest first</caption>
            <thead><tr><th scope="col">File</th><th scope="col">Written</th><th scope="col">Stop code</th><th scope="col">Size</th></tr></thead>
            <tbody>{out.minidumps.map(d => (
              <tr key={d.name}><th scope="row"><code>{d.name}</code></th><td>{fullTime(d.writtenAt)}</td><td>{stopCodeText(d)}</td><td>{sizeText(d.sizeBytes)}</td></tr>))}</tbody>
          </table>)}
      {out?.memoryDump && <p className="small">A full memory dump (MEMORY.DMP) is also on the cabinet: {sizeText(out.memoryDump.sizeBytes)}, written {fullTime(out.memoryDump.writtenAt)}.</p>}
      {out?.truncated && <p className="muted small">The folder holds more than 50 small dumps; the newest are shown.</p>}
    </div>
  );
}

/** Reads the cabinet's own start and shutdown records (boot.history): each start, how the run before it ended, and how long it lasted. */
function BootHistoryPanel({ cabinetId, days }: { cabinetId: string; days: number }) {
  const op = useOperation<{ days: number; boots: BootRecord[]; truncated: boolean }>(cabinetId, "boot.history");
  const out = op.result?.output;
  return (
    <div aria-live="polite">
      <h3>Boot history</h3>
      <p className="muted small">Read from the cabinet's System log: every start in the period, how the run before it ended, and how long that run lasted.</p>
      <button className="btn" onClick={() => void op.start({ days })} disabled={op.state === "running"}>{op.state === "running" ? "Reading…" : "Read the boot history"}</button>
      {op.problem && <p className="error" role="alert">{op.problem}</p>}
      {op.result && op.result.status !== "succeeded" && <p className="error" role="alert">{op.result.error?.message}</p>}
      {out && (out.boots.length === 0 ? <Empty>No starts in the last {out.days} days.</Empty> : (
        <table className="table compact"><caption className="sr-only">Boot history, newest first</caption>
          <thead><tr><th scope="col">Started</th><th scope="col">How the run before ended</th><th scope="col">That run lasted</th></tr></thead>
          <tbody>{out.boots.map(b => (
            <tr key={b.startedAt}><th scope="row">{fullTime(b.startedAt)}</th><td>{endText(b)}</td><td>{durationText(b.uptimeBeforeSeconds)}</td></tr>))}</tbody>
        </table>))}
      {out?.truncated && <p className="muted small">The log had more than could be read; the oldest starts are not shown.</p>}
    </div>
  );
}

interface Incident {
  from: string; to: string; cabinets: number; affected: number; unaffected: number; firstAt: string | null; lastAt: string | null; stillDown: number; inRebootLoop: number;
  stopCodes: { stopCode: StopCode; cabinets: number }[]; onset: { hour: string; cabinets: number }[];
  byClient: { name: string; total: number; affected: number }[]; bySite: { name: string; total: number; affected: number }[];
  comparisons: { category: string; change: string; affected: number; affectedShare: number; unaffected: number; unaffectedShare: number; standsOut: boolean }[];
  cabinetsAffected: { id: string; name: string; site: string; client: string; demo: boolean; firstAt: string; crashes: number; unexpectedShutdowns: number; boots: number;
    stopCodes: StopCode[]; rebootLoop: boolean; online: boolean; lastHeardAt: string | null }[];
}

function summaryText(i: Incident): string {
  const lines = [
    `Crash incident, ${fullTime(i.from)} to ${fullTime(i.to)}`,
    `Issue: ${i.affected} of ${i.cabinets} cabinets had a blue screen, an unexpected restart or a reboot loop.${i.firstAt ? ` First at ${fullTime(i.firstAt)}, last at ${fullTime(i.lastAt)}.` : ""}`,
    `Findings: ${i.stillDown} still down, ${i.inRebootLoop} restarting repeatedly.`,
    ...i.stopCodes.slice(0, 3).map(s => `- Stop code ${s.stopCode.text}${s.stopCode.name ? ` ${s.stopCode.name}` : ""} on ${s.cabinets} cabinets.`),
    ...i.comparisons.filter(c => c.standsOut).map(c => `- Stands out: ${c.change}: ${c.affected} of ${i.affected} affected (${c.affectedShare}%) vs ${c.unaffected} of ${i.unaffected} unaffected (${c.unaffectedShare}%).`),
    `Pending: confirm the cause; this is a correlation, not proof.`,
    `Next steps: check the cabinets still down first; compare one crash dump with the change that stands out.`,
  ];
  return lines.join("\n");
}

/** The Incidents page: a crash incident across the fleet. */
interface FleetPatternReport {
  pattern: FleetPattern;
  byClient: { client: string; sites: number; cabinets: number }[];
  bySite: { client: string; site: string; cabinets: number; occurrences: number }[];
  cabinets: { id: string; name: string; client: string; site: string; occurrences: number; firstSeen: string; lastSeen: string; state: string; agentVersion: string | null }[];
  byAgentVersion: { version: string; affected: number; total: number }[];
  commonFactors: { change: string; affected: number; affectedShare: number; unaffected: number; unaffectedShare: number; standsOut: boolean }[];
}

/** Fleet patterns (D22): the same problem at many sites, each one alert, with who has it and what they have in common. */
function FleetPatternsPanel() {
  const { data, problem } = useLoad<{ patterns: FleetPattern[] }>("/api/fleet-patterns");
  const [open, setOpen] = useState<string | null>(null);
  const list = orderPatterns(data?.patterns ?? []);
  return (
    <section className="panel" aria-labelledby="fleet-patterns-heading">
      <h2 id="fleet-patterns-heading">Fleet patterns</h2>
      <p className="muted">The same problem at many sites at once: one alert each, counted up as it spreads.</p>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && list.length === 0 && <Empty>No problem is showing up across sites.</Empty>}
      {list.length > 0 && (
        <table className="table compact"><caption className="sr-only">Fleet patterns</caption>
          <thead><tr><th scope="col">Problem</th><th scope="col">Reach</th><th scope="col">Times</th><th scope="col">Since</th><th scope="col">State</th><th scope="col"><span className="sr-only">Report</span></th></tr></thead>
          <tbody>{list.map(p => (
            <tr key={p.id}><td>{p.title}</td><td>{reachText(p)}</td><td>{p.occurrences.toLocaleString("en-US")}</td><td>{fullTime(p.firstSeen)}</td>
              <td>{p.resolvedAt ? "Resolved" : <Badge tone={p.severity === "major" ? "crit" : "warn"}>Open</Badge>}</td>
              <td><button className="btn small" onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>{open === p.id ? "Hide report" : "Report"}</button></td></tr>))}</tbody>
        </table>)}
      {open && <FleetPatternReportView id={open} />}
    </section>);
}

function FleetPatternReportView({ id }: { id: string }) {
  const { data, problem } = useLoad<FleetPatternReport>(`/api/fleet-patterns/${id}`);
  const cabinets = usePaged(data?.cabinets ?? []);
  if (problem) return <p className="error" role="alert">{problem}</p>;
  if (!data) return null;
  const standing = data.commonFactors.filter(c => c.standsOut);
  return (
    <div className="report" aria-label={`Report: ${data.pattern.title}`}>
      <h3>{data.pattern.title}</h3>
      <p>{reachText(data.pattern)}, {data.pattern.occurrences.toLocaleString("en-US")} times since {fullTime(data.pattern.firstSeen)}.</p>
      <h4>What they have in common</h4>
      {standing.length === 0 ? <p>Nothing stands out yet among the changes recorded before each cabinet's problem began.</p> : (
        <ul>{standing.map(c => <li key={c.change}><strong>{c.change}</strong>: {c.affectedShare}% of affected cabinets ({c.affected}), {c.unaffectedShare}% of the others ({c.unaffected})</li>)}</ul>)}
      <h4>Clients</h4>
      <ul>{data.byClient.map(c => <li key={c.client}>{c.client}: {c.sites} site{c.sites === 1 ? "" : "s"}, {c.cabinets} cabinet{c.cabinets === 1 ? "" : "s"}</li>)}</ul>
      {data.byAgentVersion.length > 1 && (<><h4>Agent versions</h4>
        <ul>{data.byAgentVersion.map(v => <li key={v.version}>{v.version}: {v.affected} of {v.total}</li>)}</ul></>)}
      <h4>Cabinets</h4>
      <table className="table compact"><caption className="sr-only">Affected cabinets</caption>
        <thead><tr><th scope="col">Cabinet</th><th scope="col">Client / site</th><th scope="col">Times</th><th scope="col">First</th><th scope="col">State</th></tr></thead>
        <tbody>{cabinets.rows.map(c => (
          <tr key={c.id}><td><Link to={`/cabinets/${c.id}`}>{c.name}</Link></td><td>{c.client} / {c.site}</td><td>{c.occurrences}</td><td>{fullTime(c.firstSeen)}</td>
            <td>{c.state === "open" ? <Badge tone="crit">Open</Badge> : "Resolved"}</td></tr>))}</tbody>
      </table>
      <Pager {...cabinets} label="cabinets" />
    </div>);
}

export function IncidentsPage() {
  const [range, setRange] = useState("3");
  const [clientId, setClientId] = useState("");
  const clients = useLoad<{ id: string; name: string }[]>("/api/fleet/clients");
  const { data, problem } = useLoad<Incident>(`/api/incidents/crashes?days=${range}${clientId ? `&clientId=${clientId}` : ""}`);
  const [copied, setCopied] = useState(false);
  const sorted = useMemo(() => [...(data?.cabinetsAffected ?? [])].sort((a, b) => Number(a.online) - Number(b.online) || a.firstAt.localeCompare(b.firstAt)), [data]);
  const affected = usePaged(sorted);
  const maxOnset = Math.max(1, ...(data?.onset.map(o => o.cabinets) ?? [1]));
  return (
    <div className="page">
      <h1>Incidents</h1>
      <FleetPatternsPanel />
      <div className="row gap wrap filters">
        <label className="field inline"><span>Period</span><select value={range} onChange={e => setRange(e.target.value)}>
          {[["1", "Last 24 hours"], ["3", "Last 3 days"], ["7", "Last 7 days"], ["14", "Last 14 days"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="field inline"><span>Client</span><select value={clientId} onChange={e => setClientId(e.target.value)}>
          <option value="">All clients</option>{clients.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        {data && data.affected > 0 && <button className="btn" onClick={() => { void navigator.clipboard?.writeText(summaryText(data)); setCopied(true); }}>{copied ? "Copied" : "Copy case notes"}</button>}
      </div>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && data.affected === 0 && <Empty>No blue screens, unexpected restarts or reboot loops in this period.</Empty>}
      {data && data.affected > 0 && (<>
        <dl className="kv summary">
          <div><dt>Cabinets affected</dt><dd><strong>{data.affected}</strong> of {data.cabinets}</dd></div>
          <div><dt>Still down</dt><dd>{data.stillDown > 0 ? <Badge tone="crit">{data.stillDown}</Badge> : "0"}</dd></div>
          <div><dt>Restarting repeatedly</dt><dd>{data.inRebootLoop > 0 ? <Badge tone="crit">{data.inRebootLoop}</Badge> : "0"}</dd></div>
          <div><dt>Began</dt><dd>{fullTime(data.firstAt)}</dd></div>
          <div><dt>Latest first crash</dt><dd>{fullTime(data.lastAt)}</dd></div>
        </dl>

        <section className="panel" aria-labelledby="common-heading">
          <h2 id="common-heading">What the crashed cabinets have in common</h2>
          {data.comparisons.length === 0 ? <Empty>No changes or errors were recorded before these crashes.</Empty> : (
            <table className="table compact">
              <caption className="sr-only">Changes and errors before the crashes, affected against unaffected cabinets</caption>
              <thead><tr><th scope="col">Change or error</th><th scope="col">Crashed cabinets</th><th scope="col">Other cabinets</th><th scope="col"><span className="sr-only">Stands out</span></th></tr></thead>
              <tbody>{data.comparisons.map(c => (
                <tr key={c.change}>
                  <th scope="row"><Cat c={c.category} /> {c.change}</th>
                  <td><Bar share={c.affectedShare} tone="crit" /> {c.affected} of {data.affected} ({c.affectedShare}%)</td>
                  <td><Bar share={c.unaffectedShare} tone="off" /> {c.unaffected} of {data.unaffected} ({c.unaffectedShare}%)</td>
                  <td>{c.standsOut && <Badge tone="warn">Stands out</Badge>}</td>
                </tr>))}
              </tbody>
            </table>)}
        </section>

        <div className="grid-2">
          <section className="panel" aria-labelledby="stop-heading">
            <h2 id="stop-heading">Stop codes</h2>
            <table className="table compact"><caption className="sr-only">Stop codes</caption>
              <thead><tr><th scope="col">Stop code</th><th scope="col">Cabinets</th></tr></thead>
              <tbody>{data.stopCodes.map(s => <tr key={s.stopCode.text}><td><StopCodeLine s={s.stopCode} /></td><td>{s.cabinets}</td></tr>)}
                {data.stopCodes.length === 0 && <tr><td colSpan={2} className="muted">No stop code recorded (unexpected restarts only).</td></tr>}</tbody>
            </table>
          </section>
          <section className="panel" aria-labelledby="onset-heading">
            <h2 id="onset-heading">When it began</h2>
            <table className="table compact"><caption className="sr-only">First crash per cabinet, by hour</caption>
              <thead><tr><th scope="col">Hour</th><th scope="col">Cabinets crashing first</th></tr></thead>
              <tbody>{data.onset.map(o => <tr key={o.hour}><td className="nowrap">{fullTime(o.hour)}</td><td><Bar share={(o.cabinets / maxOnset) * 100} tone="crit" /> {o.cabinets}</td></tr>)}</tbody>
            </table>
          </section>
        </div>

        <section className="panel" aria-labelledby="where-heading">
          <h2 id="where-heading">Where</h2>
          <table className="table compact"><caption className="sr-only">Affected cabinets by site</caption>
            <thead><tr><th scope="col">Client / site</th><th scope="col">Affected</th></tr></thead>
            <tbody>{data.bySite.map(s => <tr key={s.name}><td>{s.name}</td><td>{s.affected} of {s.total}</td></tr>)}</tbody>
          </table>
        </section>

        <section className="panel" aria-labelledby="affected-heading">
          <h2 id="affected-heading">Cabinets affected ({data.affected})</h2>
          <table className="table compact">
            <caption className="sr-only">Cabinets affected</caption>
            <thead><tr><th scope="col">Cabinet</th><th scope="col">Status</th><th scope="col">First crash</th><th scope="col">Stop code</th><th scope="col">Blue screens</th><th scope="col">Starts</th></tr></thead>
            <tbody>{affected.rows.map(c => (
              <tr key={c.id}>
                <th scope="row"><Link to={`/cabinets/${c.id}/crashes`}>{c.name}</Link>{c.demo && <> <DemoTag /></>}<div className="muted small">{c.client} / {c.site}</div></th>
                <td>{c.rebootLoop ? <Badge tone="crit">Restarting repeatedly</Badge> : c.online ? <Badge tone="ok">Back online</Badge> : <Badge tone="crit">Down</Badge>}
                  {!c.online && <div className="muted small">last heard {ago(c.lastHeardAt)}</div>}</td>
                <td className="small nowrap">{fullTime(c.firstAt)}</td>
                <td className="small">{c.stopCodes.length ? c.stopCodes.map(s => s.text).join(", ") : <span className="muted">none recorded</span>}</td>
                <td>{c.crashes || <span className="muted">0 ({c.unexpectedShutdowns} unexpected restarts)</span>}</td><td>{c.boots}</td>
              </tr>))}
            </tbody>
          </table>
          <Pager {...affected} label="cabinets" />
        </section>
      </>)}
    </div>
  );
}

function Bar({ share, tone }: { share: number; tone: "crit" | "off" }) {
  return <span className={`bar ${tone}`} aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, share))}%` }} /></span>;
}
