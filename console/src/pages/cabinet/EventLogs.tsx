// Event logs (docs/spec/06-console-spec.md "Event logs").
import { useEffect, useRef, useState } from "react";
import type { EventlogChannelsOutput, EventlogGetOutput, EventlogQueryOutput } from "@mashura/cabinet-contracts/types";
import { useOperation } from "../../lib/commands";
import { fullTime } from "../../lib/time";
import { Badge, Empty, KeyValues, OperationPanel } from "../../components/ui";
import { MapToIssue } from "../../components/MapToIssue";
import { useLoad } from "../../lib/useLoad";
import { atLeast, useSession } from "../../lib/session";

type Level = "critical" | "error" | "warning" | "information" | "verbose";
const LEVELS: Level[] = ["critical", "error", "warning", "information", "verbose"];
const LEVEL_TONE: Record<Level, "crit" | "warn" | "info" | "off"> = { critical: "crit", error: "crit", warning: "warn", information: "info", verbose: "off" };
const LEVEL_LABEL: Record<Level, string> = { critical: "Critical", error: "Error", warning: "Warning", information: "Information", verbose: "Verbose" };

/** Groups the allowed logs so support can find the right one quickly. Plain substring checks, no patterns. */
function group(log: string): string {
  const l = log.toLowerCase();
  if (["biometric", "pnp", "driver", "device", "userpnp", "codeintegrity"].some(k => l.includes(k))) return "Devices, drivers and the scanner";
  if (["storage", "ntfs", "partition", "storport", "classpnp", "kernel-io"].some(k => l.includes(k))) return "Drives and storage";
  if (["whea", "power", "boot", "performance", "exhaustion", "hardwareevents"].some(k => l.includes(k))) return "Hardware and power";
  if (["dhcp", "dns", "tcpip", "network", "ncsi", "wlan", "smb", "firewall", "time-service"].some(k => l.includes(k))) return "Network and sync";
  if (["update", "bits", "defender", "taskscheduler", "grouppolicy", "printservice"].some(k => l.includes(k))) return "Updates, security software and tasks";
  return "Windows";
}

export function EventLogs({ cabinetId }: { cabinetId: string }) {
  const channels = useOperation<EventlogChannelsOutput>(cabinetId, "eventlog.channels");
  // A link can open one log directly (the guided demo does: ?log=System); the server checks the name against the readable logs.
  const [log, setLog] = useState<string | null>(() => { const l = new URLSearchParams(window.location.search).get("log"); return l && l.length <= 80 && ![...l].some(ch => ch.charCodeAt(0) < 32) ? l : null; });
  useEffect(() => { void channels.start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (log) return <LogView cabinetId={cabinetId} log={log} onBack={() => setLog(null)} />;
  return (
    <OperationPanel title="Event logs" description="Every log this agent may read. The Security log and logs that record sign-ins, typed commands or printed documents are never readable."
      run={channels} onRun={() => void channels.start()} buttonLabel="Load logs">
      {out => {
        const groups = new Map<string, EventlogChannelsOutput["channels"]>();
        for (const c of out.channels) groups.set(group(c.log), [...(groups.get(group(c.log)) ?? []), c]);
        return [...groups.entries()].map(([name, list]) => (
          <div key={name} className="group">
            <h3>{name}</h3>
            <ul className="log-list">
              {list.map(c => (
                <li key={c.log}>
                  <button className="log-button" onClick={() => setLog(c.log)} disabled={!c.available}>
                    <span className="name">{c.log}</span>
                    <span className="meta">
                      {!c.available ? <Badge tone="off">Not on this Windows build</Badge>
                        : !c.enabled ? <Badge tone="warn">Turned off in Windows</Badge>
                        : <>{c.entryCount ?? "?"} entries · newest {fullTime(c.newestEntryAt)}</>}
                    </span>
                  </button>
                </li>))}
            </ul>
          </div>));
      }}
    </OperationPanel>
  );
}

interface Filters { levels: Level[]; from: string; to: string; source: string; eventIds: string; pageSize: number; }

function LogView({ cabinetId, log, onBack }: { cabinetId: string; log: string; onBack: () => void }) {
  const query = useOperation<EventlogQueryOutput>(cabinetId, "eventlog.query");
  const [filters, setFilters] = useState<Filters>({ levels: ["critical", "error", "warning"], from: "", to: "", source: "", eventIds: "", pageSize: 100 });
  const [pages, setPages] = useState<(number | null)[]>([null]); // beforeRecordId for each page shown
  const [entry, setEntry] = useState<number | null>(null);
  const [filterProblem, setFilterProblem] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const params = (before: number | null): Record<string, unknown> | null => {
    const p: Record<string, unknown> = { log, pageSize: filters.pageSize };
    if (filters.levels.length > 0 && filters.levels.length < LEVELS.length) p.levels = filters.levels;
    if (filters.from) p.from = new Date(filters.from).toISOString();
    if (filters.to) p.to = new Date(filters.to).toISOString();
    if (filters.source.trim()) p.source = filters.source.trim();
    if (filters.eventIds.trim()) {
      const ids = filters.eventIds.split(/[\s,]+/).filter(Boolean).map(Number);
      if (ids.some(i => !Number.isInteger(i) || i < 0 || i > 65535) || ids.length > 20) { setFilterProblem("Event IDs are whole numbers from 0 to 65535, at most 20."); return null; }
      p.eventIds = ids;
    }
    if (before !== null) p.beforeRecordId = before;
    setFilterProblem(null);
    return p;
  };
  const load = (before: number | null, stack: (number | null)[]) => { const p = params(before); if (p) { setPages(stack); void query.start(p); } };
  useEffect(() => { load(null, [null]); heading.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (entry !== null) return <EntryDetail cabinetId={cabinetId} log={log} recordId={entry} onBack={() => setEntry(null)} />;
  return (
    <section className="panel" aria-labelledby="log-heading">
      <div className="panel-head">
        <h2 id="log-heading" ref={heading} tabIndex={-1}>{log}</h2>
        <button className="btn ghost" onClick={onBack}>All logs</button>
      </div>
      <form className="filters" onSubmit={e => { e.preventDefault(); load(null, [null]); }}>
        <fieldset><legend>Levels</legend>
          {LEVELS.map(l => (
            <label key={l} className="check"><input type="checkbox" checked={filters.levels.includes(l)}
              onChange={e => setFilters(f => ({ ...f, levels: e.target.checked ? [...f.levels, l] : f.levels.filter(x => x !== l) }))} /> {LEVEL_LABEL[l]}</label>))}
        </fieldset>
        <label className="field"><span>From</span><input type="datetime-local" step={1} value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} /></label>
        <label className="field"><span>To</span><input type="datetime-local" step={1} value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} /></label>
        <label className="field"><span>Source</span><input value={filters.source} maxLength={256} onChange={e => setFilters(f => ({ ...f, source: e.target.value }))} /></label>
        <label className="field"><span>Event IDs</span><input value={filters.eventIds} placeholder="e.g. 7, 51" onChange={e => setFilters(f => ({ ...f, eventIds: e.target.value }))} /></label>
        <label className="field"><span>Per page</span>
          <select value={filters.pageSize} onChange={e => setFilters(f => ({ ...f, pageSize: Number(e.target.value) }))}>{[25, 50, 100, 250, 500].map(n => <option key={n}>{n}</option>)}</select></label>
        <button className="btn primary" disabled={query.state === "running"}>Apply filters</button>
        {filterProblem && <p className="error" role="alert">{filterProblem}</p>}
      </form>
      <div aria-live="polite">
        {query.state === "running" && <p className="muted">Reading the log on the cabinet…</p>}
        {query.problem && <p className="error" role="alert">{query.problem}</p>}
        {query.result && query.result.status !== "succeeded" && <p className="error" role="alert">{query.result.error?.message ?? "The cabinet did not answer."}</p>}
      </div>
      {query.state !== "running" && query.result?.output && (() => {
        const out = query.result.output;
        return (<>
          {out.entries.length === 0 ? <Empty>No entries match these filters.</Empty> : (
            <ol className="entries" aria-label={`Entries in ${log}, newest first`}>
              {out.entries.map(e => (
                <li key={e.recordId}>
                  <button className="entry" data-tour="event-entry" onClick={() => setEntry(e.recordId)} aria-label={`${LEVEL_LABEL[e.level as Level]} at ${fullTime(e.time)}, ${e.source} event ${e.eventId}: ${e.firstLine}. Open details.`}>
                    <span className="when">{fullTime(e.time)}</span>
                    <Badge tone={LEVEL_TONE[e.level as Level]}>{LEVEL_LABEL[e.level as Level]}</Badge>
                    <span className="source">{e.source} <span className="muted">· {e.eventId}</span></span>
                    <span className="line">{e.firstLine || <span className="muted">(no message)</span>}</span>
                  </button>
                </li>))}
            </ol>)}
          {out.truncated && <p className="muted small">The cabinet stopped reading early to stay responsive; use Older entries to continue.</p>}
          <div className="row gap">
            <button className="btn" disabled={pages.length <= 1} onClick={() => load(pages[pages.length - 2] ?? null, pages.slice(0, -1))}>Newer entries</button>
            <button className="btn" disabled={out.nextBeforeRecordId === null} onClick={() => load(out.nextBeforeRecordId, [...pages, out.nextBeforeRecordId])}>Older entries</button>
            <span className="muted small">Page {pages.length}</span>
          </div>
        </>);
      })()}
    </section>
  );
}

function EntryDetail({ cabinetId, log, recordId, onBack }: { cabinetId: string; log: string; recordId: number; onBack: () => void }) {
  const get = useOperation<EventlogGetOutput>(cabinetId, "eventlog.get");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { void get.start({ log, recordId }); heading.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const e = get.result?.output;
  return (
    <section className="panel" aria-labelledby="entry-heading">
      <div className="panel-head">
        <h2 id="entry-heading" ref={heading} tabIndex={-1}>Event {recordId} in {log}</h2>
        <button className="btn ghost" onClick={onBack}>Back to the list</button>
      </div>
      <div aria-live="polite">
        {get.state === "running" && <p className="muted">Opening the entry on the cabinet…</p>}
        {get.problem && <p className="error" role="alert">{get.problem}</p>}
        {get.result && get.result.status !== "succeeded" && <p className="error" role="alert">{get.result.error?.message}</p>}
      </div>
      {e && (<>
        <KeyValues rows={[
          ["Time", fullTime(e.time)], ["Level", <Badge tone={LEVEL_TONE[e.level as Level]}>{LEVEL_LABEL[e.level as Level]}</Badge>],
          ["Source", e.source], ["Event ID", e.eventId], ["Task category", e.taskCategory], ["Opcode", e.opcode],
          ["Keywords", e.keywords.length ? e.keywords.join(", ") : null], ["Process / thread", e.processId !== null ? `${e.processId} / ${e.threadId}` : null],
          ["Computer", e.computer], ["Device involved", e.deviceInstanceId ? <code>{e.deviceInstanceId}</code> : "none"],
        ]} />
        <h3>Message</h3>
        <pre className="message">{e.message || "(no message text)"}</pre>
        {e.eventData.length > 0 && (<>
          <h3>Event data</h3>
          <table className="table compact">
            <caption className="sr-only">Event data fields</caption>
            <thead><tr><th scope="col">Field</th><th scope="col">Value</th></tr></thead>
            <tbody>{e.eventData.map((d, i) => <tr key={i}><th scope="row">{d.name}</th><td className="wrap">{d.value}</td></tr>)}</tbody>
          </table>
        </>)}
        <details><summary>Raw event XML</summary><pre className="xml">{e.rawXml}</pre></details>
        <SeenElsewhere cabinetId={cabinetId} log={log} source={e.source} eventId={e.eventId} />
      </>)}
    </section>
  );
}

/** Which issue this error maps to, how many other cabinets reported it in the last 30 days, and Map to issue. */
function SeenElsewhere({ cabinetId, log, source, eventId }: { cabinetId: string; log: string; source: string; eventId: number }) {
  const { me } = useSession();
  const [mapping, setMapping] = useState(false);
  const q = new URLSearchParams({ cabinetId, log, source, eventId: String(eventId) });
  const { data, problem, reload } = useLoad<{ otherCabinets: number; events: number; issueName: string | null; days: number }>(`/api/events/lookup?${q.toString()}`);
  return (
    <section aria-labelledby="mapping-heading">
      <h3 id="mapping-heading">Across the fleet</h3>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && (<>
        <p>{data.issueName ? <>Maps to <Badge tone="info">{data.issueName}</Badge></> : <>Not mapped to an issue yet.</>}</p>
        <p>{data.otherCabinets === 0 ? "No other cabinet" : `${data.otherCabinets} other ${data.otherCabinets === 1 ? "cabinet" : "cabinets"}`} reported this source and event ID in the last {data.days} days.</p>
      </>)}
      {atLeast(me, "tier2") && <button className="btn" onClick={() => setMapping(true)}>Map to issue</button>}
      <MapToIssue open={mapping} initial={{ log, source, eventId }} onClose={() => { setMapping(false); reload(); }} />
    </section>
  );
}
