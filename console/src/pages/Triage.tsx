// Triage (docs/spec/12-milestones-8-to-12.md "Triage queue" and "Error trends"): what needs attention first across the fleet, grouped by likely
// cause and ranked with the reasons shown, the unrecognized errors to map, and how each error is trending. The ranking is the server's.
import { useState } from "react";
import { api, describeError } from "../lib/api";
import { useLoad } from "../lib/useLoad";
import { Link, useRouter } from "../lib/router";
import { atLeast, useSession } from "../lib/session";
import { ago, fullTime } from "../lib/time";
import { Badge, Empty } from "../components/ui";
import { Pager, usePaged } from "../components/Pager";
import { incidentHref, moduleArea, runsText, stateOf, stepLabel, type OpenIncident } from "../lib/incidents";

interface Item {
  key: string; issueTypeId: string; title: string; cause: string; severity: "major" | "minor"; cabinets: number; sites: number; clients: number; alerts: number; unclaimed: number;
  firstSeen: string; lastSeen: string; mark: "new" | "rising" | null; score: number; why: string[]; concentratedAt: { siteId: string; siteName: string; cabinets: number } | null;
  runbook: { title: string; steps: number; builtIn: boolean } | null; knownFixes: number; usualFix: { fix: string; count: number } | null; sample: { id: string; name: string; site: string }[];
}
interface Unrecognized { key: string; log: string; source: string; eventId: number; cabinets: number; sites: number; alerts: number; unclaimed: number; lastSeen: string; mark: "new" | "rising" | null; why: string[]; sample: string | null }
interface Triage { generatedAt: string; days: number; trendsAsOf: string | null; totals: { groups: number; cabinets: number; alerts: number; unclaimedMajor: number; unrecognized: number }; items: Item[]; unrecognized: Unrecognized[] }
interface Trend { key: string; mark: "new" | "rising" | null; cabinets: number; events: number; last7: number; prev7: number; series: { cabinets: number[]; events: number[] } }
interface IssueTrend extends Trend { issueTypeId: string; name: string; severity: string }
interface ErrorTrend extends Trend { log: string; source: string; eventId: number; issueName: string | null; unrecognized: boolean; sample: string | null }
interface Limit { shown: number; matched: number; limit: number }
interface Trends { computedThrough: string | null; computedAt: string | null; days: string[]; issues: IssueTrend[]; errors: ErrorTrend[]; running: boolean;
  limits?: { issues: Limit; errors: Limit; groupsPerDay: number; daysAtGroupLimit: string[] } }

/** Where a list was cut, said on screen (F17): how many matched and how many are shown, and the days that kept only the busiest groups. */
function TrendLimits({ limits }: { limits: NonNullable<Trends["limits"]> }) {
  const cut = (what: string, l: Limit) => l.matched > l.shown ? `${what}: the ${l.shown} most important of ${l.matched} are shown.` : null;
  const lines = [cut("Issue types", limits.issues), cut("Errors", limits.errors),
    limits.daysAtGroupLimit.length > 0 ? `On ${limits.daysAtGroupLimit.join(", ")} more than ${limits.groupsPerDay.toLocaleString("en-US")} different errors arrived; only the busiest ${limits.groupsPerDay.toLocaleString("en-US")} were counted.` : null]
    .filter((l): l is string => l !== null);
  if (lines.length === 0) return null;
  return <div className="notice warn small" role="note"><p>Not everything is listed. {lines.join(" ")} Choose a client or a mark to see the rest.</p></div>;
}

type View = "queue" | "unrecognized" | "trends" | "incidents";

const MARK = { new: <Badge tone="info">New</Badge>, rising: <Badge tone="warn">Rising</Badge> } as const;

/** A small line of the last days' events; the numbers are in the table beside it, so this is only a shape. */
export function Spark({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1, ...values), w = 120, h = 24;
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${h - 2 - (v / max) * (h - 4)}`).join(" ");
  return <svg role="img" aria-label={label} width={w} height={h} viewBox={`0 0 ${w} ${h}`}><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
}

export function TriagePage() {
  const { path, navigate } = useRouter();
  const query = new URLSearchParams(path.split("?")[1] ?? "");
  const view = (["queue", "unrecognized", "trends", "incidents"].includes(query.get("view") ?? "") ? query.get("view") : "queue") as View;
  const [clientId, setClientId] = useState("");
  const [days, setDays] = useState("14");
  const clients = useLoad<{ id: string; name: string }[]>("/api/fleet/clients");
  const filter = `days=${days}${clientId ? `&clientId=${clientId}` : ""}`;
  return (
    <div className="page">
      <h1>Triage</h1>
      <p className="muted">What needs attention first across the fleet, grouped by likely cause, with the reasons for the order.</p>
      <div className="subtabs" role="group" aria-label="Triage views">
        {([["queue", "Needs attention"], ["incidents", "Open incidents"], ["unrecognized", "Unrecognized errors"], ["trends", "Error trends"]] as const).map(([v, label]) =>
          <button key={v} aria-pressed={view === v} onClick={() => navigate(v === "queue" ? "/triage" : `/triage?view=${v}`)}>{label}</button>)}
      </div>
      <form className="filters" onSubmit={e => e.preventDefault()} aria-label="Filter">
        <label className="field"><span>Client</span><select value={clientId} onChange={e => setClientId(e.target.value)}><option value="">All clients</option>
          {clients.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        {view !== "incidents" && <label className="field"><span>Period</span><select value={days} onChange={e => setDays(e.target.value)}><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label>}
      </form>
      {view === "incidents" ? <IncidentsView clientId={clientId} /> : view === "trends" ? <TrendsView filter={filter} clientId={clientId} days={days} /> : <QueueView filter={filter} unrecognizedOnly={view === "unrecognized"} />}
    </div>
  );
}

/** Every incident not yet closed, most recently changed first: what the diagnoses found and have not seen fixed yet (D16). */
function IncidentsView({ clientId }: { clientId: string }) {
  const { data, problem, reload } = useLoad<{ incidents: OpenIncident[] }>(`/api/incidents/open${clientId ? `?clientId=${clientId}` : ""}`);
  const paged = usePaged(data?.incidents ?? []);
  return (<>
    <p className="small muted">A diagnosis that finds a problem opens an incident on that cabinet; the next diagnosis that finds it fixed closes it. Each one opens on its cabinet's History tab with every step.</p>
    {problem && <div className="row gap wrap"><p className="error" role="alert">{problem}</p><button className="btn small" onClick={reload}>Try again</button></div>}
    {!data && !problem && <p className="muted" role="status">Loading…</p>}
    {data && data.incidents.length === 0 && <Empty>No open incidents.</Empty>}
    {data && data.incidents.length > 0 && (
      <table className="table compact"><caption className="sr-only">Open incidents, most recently changed first</caption>
        <thead><tr><th scope="col">Problem</th><th scope="col">Cabinet</th><th scope="col">Area</th><th scope="col">State</th><th scope="col">Last step</th></tr></thead>
        <tbody>{paged.rows.map(i => {
          const [label, tone] = stateOf(i.state);
          return (
            <tr key={i.id}>
              <th scope="row"><Link to={incidentHref(i)}>{i.symptom}</Link><div className="muted small">opened <span title={fullTime(i.openedAt)}>{ago(i.openedAt)}</span> · {runsText(i.runs)}</div></th>
              <td>{i.cabinet.name}<div className="muted small">{i.site.name} · {i.client.name}</div></td>
              <td>{moduleArea(i.module)}</td>
              <td><Badge tone={tone}>{label}</Badge></td>
              <td className="small"><span className="muted">{stepLabel(i.lastStep.kind)}, <span title={fullTime(i.lastStep.at)}>{ago(i.lastStep.at)}</span>:</span> {i.lastStep.summary}</td>
            </tr>);
        })}</tbody></table>)}
    <Pager {...paged} label="open incidents" />
  </>);
}

function QueueView({ filter, unrecognizedOnly }: { filter: string; unrecognizedOnly: boolean }) {
  const { data, problem } = useLoad<Triage>(`/api/triage?${filter}`);
  const itemsPaged = usePaged(data?.items ?? []);
  const unrecPaged = usePaged(data?.unrecognized ?? []);
  return (<>
    {problem && <p className="error" role="alert">{problem}</p>}
    {!data && !problem && <p className="muted" role="status">Loading…</p>}
    {data && !unrecognizedOnly && (<>
      <p className="small muted" role="status">{data.totals.alerts} active alerts on {data.totals.cabinets} cabinets in {data.totals.groups} groups; {data.totals.unclaimedMajor} major not yet claimed. New and rising marks are from {data.trendsAsOf ? `the night of ${data.trendsAsOf}` : "no night yet"}.</p>
      {data.items.length === 0 && <Empty>Nothing needs attention in this period.</Empty>}
      <ol className="alert-list">{itemsPaged.rows.map((i, n) => (
        <li key={i.key} className={`alert-row ${i.severity}`}>
          <div>
            <div className="row gap wrap">
              <span className="muted small">#{itemsPaged.page * itemsPaged.size + n + 1}</span>
              <Badge tone={i.severity === "major" ? "crit" : "info"}>{i.severity === "major" ? "Major" : "Minor"}</Badge>
              {i.mark && MARK[i.mark]}
              <Link className="title" to="/alerts">{i.title}</Link>
              <span className="muted small">{i.cabinets} {i.cabinets === 1 ? "cabinet" : "cabinets"} · {i.sites} {i.sites === 1 ? "site" : "sites"} · {i.unclaimed} unclaimed</span>
            </div>
            <p className="small muted">{i.cause}</p>
            {i.concentratedAt && <div className="notice warn small" role="status">{i.concentratedAt.cabinets} of {i.cabinets} are at <Link to={`/sites/${i.concentratedAt.siteId}`}>{i.concentratedAt.siteName}</Link>: look at the site (its network, power or switch) before working on the cabinets one by one.</div>}
            <p className="small"><span className="muted">Why here:</span> {i.why.join("; ")}.</p>
            {i.usualFix && <p className="small"><span className="muted">Usually fixed by:</span> {i.usualFix.fix} ({i.usualFix.count}×)</p>}
            <p className="small">{i.runbook ? <span><Badge tone="ok">Runbook</Badge> {i.runbook.title}, {i.runbook.steps} steps (open it from an alert)</span> : <span className="muted">No runbook yet.</span>}{i.knownFixes > 0 && <> · {i.knownFixes} known {i.knownFixes === 1 ? "fix" : "fixes"}</>}</p>
            <p className="small muted">e.g. {i.sample.map((s, k) => <span key={s.id}>{k > 0 && ", "}<Link to={`/cabinets/${s.id}/troubleshoot`}>{s.name}</Link> ({s.site})</span>)}</p>
          </div>
          <div className="actions"><span className="muted small" title="The score the order comes from">score {i.score}</span></div>
        </li>))}</ol>
      <Pager {...itemsPaged} label="triage groups" />
    </>)}
    {data && (unrecognizedOnly || data.unrecognized.length > 0) && (
      <section className="panel" aria-labelledby="unrec-heading">
        <h2 id="unrec-heading">Unrecognized errors</h2>
        <p className="small muted">The same error on many cabinets is one row. Map it to an issue once and every cabinet is classified (Tier 2 and up).</p>
        {data.unrecognized.length === 0 ? <Empty>No unrecognized errors in this period.</Empty> : (
          <table className="table compact"><caption className="sr-only">Unrecognized errors, by how many cabinets reported them</caption>
            <thead><tr><th scope="col">Error</th><th scope="col">Cabinets</th><th scope="col">Last seen</th><th scope="col">Sample message</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
            <tbody>{unrecPaged.rows.map(u => (
              <tr key={u.key}>
                <th scope="row">{u.source} <span className="muted">event {u.eventId}</span> {u.mark && MARK[u.mark]}<div className="muted small">{u.log}</div></th>
                <td>{u.cabinets} ({u.sites} {u.sites === 1 ? "site" : "sites"})</td>
                <td title={fullTime(u.lastSeen)}>{ago(u.lastSeen)}</td>
                <td className="small">{u.sample ?? <span className="muted">not kept</span>}</td>
                <td><Link className="btn small" to={`/alerts?view=unrecognized`}>Map to issue</Link></td>
              </tr>))}</tbody></table>)}
        <Pager {...unrecPaged} label="unrecognized errors" />
      </section>)}
  </>);
}

function TrendsView({ filter, clientId, days }: { filter: string; clientId: string; days: string }) {
  const { me } = useSession();
  const [mark, setMark] = useState("all");
  const [unrec, setUnrec] = useState(false);
  const { data, problem, reload } = useLoad<Trends>(`/api/trends/errors?${filter}&mark=${mark}${unrec ? "&unrecognized=true" : ""}`);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const issuesPaged = usePaged(data?.issues ?? []);
  const errorsPaged = usePaged(data?.errors ?? []);
  const refresh = async () => {
    setRefreshNote(null);
    try { const r = await api<{ started: boolean }>("POST", "/api/trends/refresh", {}); setRefreshNote(r.started ? "Started. It takes a little while; reload this page after a minute." : "It is already running."); setTimeout(reload, 5000); }
    catch (e) { setRefreshNote(describeError(e)); }
  };
  void clientId;
  return (<>
    <div className="row gap wrap">
      <label className="field"><span>Show</span><select value={mark} onChange={e => setMark(e.target.value)}><option value="all">All</option><option value="new">New (first seen in the last day)</option><option value="rising">Rising (more than double the week before)</option></select></label>
      <label className="check"><input type="checkbox" checked={unrec} onChange={e => setUnrec(e.target.checked)} /> Unrecognized errors only</label>
      {atLeast(me, "admin") && <button className="btn small" onClick={() => void refresh()}>Update the trends now</button>}
    </div>
    {refreshNote && <p className="small" role="status">{refreshNote}</p>}
    {problem && <p className="error" role="alert">{problem}</p>}
    {data && <p className="small muted">{data.computedThrough ? `Computed through ${data.computedThrough} (${data.computedAt ? ago(data.computedAt) : "never"}); the figures are per day received, updated each night. Cabinets are those on the busiest day.` : "The trends have not been computed yet; they are computed each night."}</p>}
    {data?.limits && <TrendLimits limits={data.limits} />}
    {data && data.issues.length > 0 && (
      <section className="panel" aria-labelledby="issue-trends"><h2 id="issue-trends">Issue types</h2>
        <table className="table compact"><caption className="sr-only">Issue type trends</caption>
          <thead><tr><th scope="col">Issue</th><th scope="col">Cabinets</th><th scope="col">Events</th><th scope="col">Last 7 / before</th><th scope="col">Shape</th></tr></thead>
          <tbody>{issuesPaged.rows.map(t => <tr key={t.key}><th scope="row">{t.name} {t.mark && MARK[t.mark]}</th><td>{t.cabinets}</td><td>{t.events}</td><td>{t.last7} / {t.prev7}</td><td><Spark values={t.series.events} label={`${t.name}: events per day`} /></td></tr>)}</tbody></table><Pager {...issuesPaged} label="issue types" /></section>)}
    {data && (
      <section className="panel" aria-labelledby="error-trends"><h2 id="error-trends">Errors</h2>
        {data.errors.length === 0 ? <Empty>No errors match.</Empty> : (
          <table className="table compact"><caption className="sr-only">Error trends</caption>
            <thead><tr><th scope="col">Error</th><th scope="col">Cabinets</th><th scope="col">Events</th><th scope="col">Last 7 / before</th><th scope="col">Shape</th></tr></thead>
            <tbody>{errorsPaged.rows.map(t => (
              <tr key={t.key}>
                <th scope="row">{t.source} <span className="muted">event {t.eventId}</span> {t.mark && MARK[t.mark]}
                  <div className="muted small">{t.log} · {t.unrecognized ? "not recognized" : t.issueName}{t.sample ? ` · ${t.sample}` : ""}</div></th>
                <td>{t.cabinets}</td><td>{t.events}</td><td>{t.last7} / {t.prev7}</td><td><Spark values={t.series.events} label={`${t.source} ${t.eventId}: events per day`} /></td>
              </tr>))}</tbody></table>)}
        <Pager {...errorsPaged} label="errors" />
      </section>)}
  </>);
}
