// A cabinet's configuration against its approved baseline (docs/spec/15-baselines-and-config.md). Four things are kept apart on purpose: the baseline
// (what it should be), the drift (where it is not), the changes (what changed, and when it is known to have) and the last healthy state (what it was
// when it worked). The wording never says one thing caused another, and nothing here changes the cabinet: a comparison only reports.
import { useState } from "react";
import { api, describeError } from "../../lib/api";
import { Link, useRouter } from "../../lib/router";
import { useLoad } from "../../lib/useLoad";
import { useOperation } from "../../lib/commands";
import { atLeast, useSession } from "../../lib/session";
import { ago, fullTime } from "../../lib/time";
import { Badge, Empty } from "../../components/ui";
import { Pager, usePaged } from "../../components/Pager";
import { CATEGORIES, categoryName, FieldChange, HEALTH_LABEL, HEALTH_TONE, Origin, show, WhenKnown, type FieldChanges, type Health } from "../../components/ConfigParts";
import type { CabinetDetail } from "./CabinetPage";

interface Reason { code: string; text: string }
interface Condition { state: Health; evaluatedAt: string; since: string; reasons: Reason[]; lastHealthyAt: string | null; degradedSince: string | null; changesSinceHealthy: number | null }

function next(h: Condition): string {
  if (h.state === "healthy") return "Nothing to do: this cabinet meets its baseline.";
  if (h.state === "offline") return "Check whether the cabinet has power and a network link; its recent history is under History.";
  if (h.state === "unknown") return h.reasons[0]?.code === "no_baseline" ? "Capture a baseline from a known-working cabinet so there is something to judge against." : "Wait for the cabinet's first configuration report, or read it now.";
  return h.changesSinceHealthy ? "Look at what changed since the last healthy state, and at where it differs from the baseline." : "Look at where it differs from the baseline.";
}

/** On the Overview: how the cabinet's configuration is, since when, and where to look next. */
export function ConfigHealth({ cabinet }: { cabinet: CabinetDetail }) {
  const { navigate } = useRouter();
  const { data, problem } = useLoad<Condition>(`/api/cabinets/${cabinet.id}/condition`);
  if (problem) return <p className="error" role="alert">{problem}</p>;
  if (!data) return null;
  return (
    <section className={`panel health ${data.state}`} aria-labelledby="config-health-heading">
      <h2 id="config-health-heading">Configuration <Badge tone={HEALTH_TONE[data.state]}>{HEALTH_LABEL[data.state]}</Badge></h2>
      <dl className="kv">
        <div><dt>Last known healthy configuration</dt><dd>{data.lastHealthyAt ? <>{fullTime(data.lastHealthyAt)} <span className="muted">({ago(data.lastHealthyAt)})</span></> : <span className="muted">not recorded yet</span>}</dd></div>
        {data.state !== "healthy" && data.degradedSince && <div><dt>Problem first observed</dt><dd>{fullTime(data.degradedSince)}{data.lastHealthyAt && <span className="muted"> (it was last seen healthy at {fullTime(data.lastHealthyAt)}, so it began in between)</span>}</dd></div>}
        {data.changesSinceHealthy !== null && data.state !== "healthy" && <div><dt>Changes since the healthy state</dt><dd>{data.changesSinceHealthy}</dd></div>}
        <div><dt>Next step</dt><dd>{next(data)}</dd></div>
      </dl>
      {data.reasons.length > 0 && data.state !== "healthy" && <ul className="plain">{data.reasons.slice(0, 5).map((r, i) => <li key={i}>{r.text}</li>)}</ul>}
      <div className="row gap wrap">
        <button className="btn primary" onClick={() => navigate(`/cabinets/${cabinet.id}/baseline`)}>Open baseline and drift</button>
        <button className="btn" onClick={() => navigate(`/cabinets/${cabinet.id}/changes`)}>See what changed</button>
      </div>
    </section>
  );
}

type Tab = "drift" | "compare" | "history" | "baseline";
const TABS: [Tab, string][] = [["drift", "Differs from baseline"], ["compare", "Since last healthy"], ["history", "History"], ["baseline", "Baseline in force"]];

export function Baseline({ cabinet }: { cabinet: CabinetDetail }) {
  const [tab, setTab] = useState<Tab>("drift");
  const refresh = useOperation<unknown>(cabinet.id, "config.snapshot");
  const [version, setVersion] = useState(0);
  const { me } = useSession();
  return (<>
    <ConfigHealth key={version} cabinet={cabinet} />
    <section className="panel" aria-labelledby="baseline-heading">
      <div className="panel-head">
        <h2 id="baseline-heading">Baseline and drift</h2>
        <button className="btn small" disabled={refresh.state === "running"} onClick={async () => { await refresh.start({}); setVersion(v => v + 1); }}>
          {refresh.state === "running" ? "Reading…" : "Read its configuration now"}</button>
      </div>
      {refresh.problem && <p className="error" role="alert">{refresh.problem}</p>}
      {refresh.state === "done" && refresh.result && refresh.result.status !== "succeeded" && <p className="error" role="alert">The cabinet did not answer: {refresh.result.error?.message ?? refresh.result.status}.</p>}
      <p className="muted small">Nothing here changes the cabinet: it only compares what it reports with what the approved baseline says. Putting a setting back is done from the cabinet's own tabs, with the usual confirmation.</p>
      <div className="subtabs" role="group" aria-label="Views">
        {TABS.map(([k, l]) => <button key={k} aria-pressed={k === tab} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "drift" && <Drift key={version} cabinet={cabinet} />}
      {tab === "compare" && <SinceHealthy key={version} cabinetId={cabinet.id} />}
      {tab === "history" && <HistoryView key={version} cabinetId={cabinet.id} />}
      {tab === "baseline" && <InForce key={version} cabinetId={cabinet.id} />}
    </section>
    {atLeast(me, "tier2") && <CaptureBaseline cabinet={cabinet} />}
  </>);
}

interface DriftRow { category: string; itemKey: string; field: string; mode: string; expected: unknown; actual: unknown; origin: { kind: string; name: string; version: number }; severity: string; required: boolean; firstSeen: string }

function Drift({ cabinet }: { cabinet: CabinetDetail }) {
  const { data, problem } = useLoad<{ drift: DriftRow[] }>(`/api/cabinets/${cabinet.id}/drift`);
  const paged = usePaged(data?.drift ?? []);
  if (problem) return <p className="error" role="alert">{problem}</p>;
  if (!data) return <p className="muted" role="status">Loading…</p>;
  if (data.drift.length === 0) return <Empty>Nothing differs from the approved baseline (or no baseline applies yet).</Empty>;
  return (<>
    <p className="muted small">{data.drift.length} {data.drift.length === 1 ? "difference" : "differences"}, most serious first. The same comparison is on the Compare tab, next to the other ways of comparing.</p>
    <div className="table-wrap"><table className="table">
      <caption className="sr-only">Where this cabinet differs from its baseline</caption>
      <thead><tr><th scope="col">Item</th><th scope="col">Should be</th><th scope="col">Is</th><th scope="col">Since</th></tr></thead>
      <tbody>{paged.rows.map((d, i) => (
        <tr key={`${d.category}|${d.itemKey}|${d.field}|${paged.page}|${i}`}>
          <th scope="row"><Badge tone={d.severity === "major" ? "crit" : "warn"}>{d.severity === "major" ? "Major" : "Minor"}</Badge> {categoryName(d.category)}: {d.itemKey}{d.field && <> · {d.field}</>}
            {d.required && <> <Badge tone="info">Required</Badge></>}<div><Origin o={d.origin} /></div></th>
          <td>{d.mode === "present" ? "Present" : d.mode === "absent" ? "Not present" : d.field ? show(d.expected) : "Present, as the baseline says"}</td>
          <td>{d.mode === "present" ? "Missing" : d.mode === "absent" ? "Present" : d.field ? show(d.actual) : "Missing"}</td>
          <td title={fullTime(d.firstSeen)}>{ago(d.firstSeen)}</td>
        </tr>))}</tbody>
    </table></div>
    <Pager {...paged} label="differences" />
  </>);
}

interface Since { markId: number | null; markedAt: string | null; changes: { category: string; key: string; change: string; fields: FieldChanges }[]; unavailable: string[] }

function SinceHealthy({ cabinetId }: { cabinetId: string }) {
  const { data, problem } = useLoad<Since>(`/api/cabinets/${cabinetId}/compare-healthy`);
  const paged = usePaged(data?.changes ?? []);
  if (problem) return <p className="error" role="alert">{problem}</p>;
  if (!data) return <p className="muted" role="status">Loading…</p>;
  if (!data.markId) return <Empty>This cabinet has not been seen healthy, so there is nothing to compare with yet.</Empty>;
  return (<>
    <p className="muted">Compared with the configuration the cabinet had when it was last recorded healthy, {fullTime(data.markedAt)} ({ago(data.markedAt)}). A difference is a candidate to look at, not a proven cause.</p>
    {data.unavailable.length > 0 && <p className="notice warn">The older configuration of {data.unavailable.map(categoryName).join(", ")} is no longer kept, so it cannot be compared.</p>}
    {data.changes.length === 0 ? <Empty>Nothing differs from the last healthy state.</Empty> : (<>
      <div className="table-wrap"><table className="table compact">
        <caption className="sr-only">Differences from the last healthy state</caption>
        <thead><tr><th scope="col">Item</th><th scope="col">Then → now</th></tr></thead>
        <tbody>{paged.rows.map((c, i) => <tr key={`${c.category}|${c.key}|${i}`}><th scope="row">{categoryName(c.category)}: {c.key} <span className="muted">{c.change}</span></th><td><FieldChange fields={c.fields} /></td></tr>)}</tbody>
      </table></div>
      <Pager {...paged} label="differences" />
    </>)}
  </>);
}

interface Entry { at: string; kind: string; title: string; detail: string | null; window: { notBefore: string | null; observedAt: string } | null; exactAt: string | null; viaPlatform?: boolean; violatesBaseline?: boolean; nearProblem: boolean }

function HistoryView({ cabinetId }: { cabinetId: string }) {
  const [q, setQ] = useState("");
  const { data, problem } = useLoad<{ problemStartedBetween: { from: string | null; to: string } | null; entries: Entry[] }>(`/api/cabinets/${cabinetId}/config-history?days=14${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`);
  const paged = usePaged(data?.entries ?? []);
  return (<>
    <label className="field inline"><span>Search the history</span><input type="search" value={q} maxLength={100} onChange={e => setQ(e.target.value)} /></label>
    {problem && <p className="error" role="alert">{problem}</p>}
    {data?.problemStartedBetween && <p className="notice warn" role="status">The problem was first observed {fullTime(data.problemStartedBetween.to)}{data.problemStartedBetween.from && <>; the cabinet was last seen healthy {fullTime(data.problemStartedBetween.from)}</>}. Entries marked "shortly before" happened within an hour before then; that is when they occurred, not a finding about why.</p>}
    {data && (data.entries.length === 0 ? <Empty>Nothing in this period.</Empty> : (<>
      <ol className="timeline">{paged.rows.map((e, i) => (
        <li key={`${e.at}|${e.title}|${i}`} className={`${e.kind} ${e.nearProblem ? "near" : ""}`}>
          <span className="when" title={fullTime(e.at)}>{fullTime(e.at)}</span>
          <span className="what"><strong>{e.title}</strong>{e.nearProblem && <> <Badge tone="warn">Shortly before the problem was first observed</Badge></>}
            {e.violatesBaseline && <> <Badge tone="crit">Goes against the baseline</Badge></>}{e.viaPlatform && <> <Badge tone="info">Made through the platform</Badge></>}
            {e.detail && <div className="muted small">{e.detail}</div>}
            {e.window && !e.exactAt && <div className="muted small">Known only to have changed <WhenKnown c={{ ...e.window, exactAt: null }} /></div>}</span>
        </li>))}</ol>
      <Pager {...paged} label="history entries" />
    </>))}
  </>);
}

interface Resolved { items: { category: string; key: string; mode: string; expect: Record<string, unknown> | null; required: boolean; severity: string; note: string | null; origin: { kind: string; name: string; version: number; baselineId: string } }[];
  health: Record<string, unknown>; scopes: { kind: string; name: string; version: number; baselineId: string }[] }

function InForce({ cabinetId }: { cabinetId: string }) {
  const { data, problem } = useLoad<Resolved>(`/api/cabinets/${cabinetId}/baseline`);
  const { me } = useSession();
  const paged = usePaged(data?.items ?? []);
  if (problem) return <p className="error" role="alert">{problem}</p>;
  if (!data) return <p className="muted" role="status">Loading…</p>;
  if (data.scopes.length === 0) return <Empty>No approved baseline applies to this cabinet. {atLeast(me, "tier2") ? "Capture one below, from this cabinet or another known-working one." : "A Tier 2 technician or an Admin can create one."}</Empty>;
  return (<>
    <p className="muted">Applied widest to narrowest, a narrower baseline replacing a wider one item by item: {data.scopes.map((s, i) => <span key={i}>{i > 0 && " → "}<Link to={`/admin/baselines/${s.baselineId}`}>{s.kind === "global" ? "All cabinets" : s.name}</Link> (version {s.version})</span>)}.</p>
    <div className="table-wrap"><table className="table compact">
      <caption className="sr-only">The baseline in force, by item</caption>
      <thead><tr><th scope="col">Item</th><th scope="col">Expects</th><th scope="col">From</th></tr></thead>
      <tbody>{paged.rows.map((i, n) => (
        <tr key={`${i.category}|${i.key}|${n}`}><th scope="row">{categoryName(i.category)}: {i.key} {i.required && <Badge tone="info">Required</Badge>}{i.note && <div className="muted small">{i.note}</div>}</th>
          <td>{i.mode === "present" ? "Present" : i.mode === "absent" ? "Not present" : Object.entries(i.expect ?? {}).map(([f, v]) => <div key={f}><strong>{f}</strong>: {show(v)}</div>)}</td>
          <td><Origin o={i.origin} /></td></tr>))}</tbody>
    </table></div>
    <Pager {...paged} label="items" />
  </>);
}

/** Capture what this cabinet reports now as a draft baseline: nothing is approved by doing it. */
function CaptureBaseline({ cabinet }: { cabinet: CabinetDetail }) {
  const { me } = useSession();
  const { navigate } = useRouter();
  const [scope, setScope] = useState(`site:${cabinet.site.id}`);
  const [description, setDescription] = useState(`Captured from ${cabinet.name}, known to be working.`);
  const [categories, setCategories] = useState<string[]>(["network", "services", "firewall", "time", "drivers", "hosts"]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scopes: [string, string][] = [[`cabinet:${cabinet.id}`, `This cabinet only (${cabinet.name})`], [`site:${cabinet.site.id}`, `The site (${cabinet.site.name})`], [`client:${cabinet.client.id}`, `The client (${cabinet.client.name})`],
    ...(atLeast(me, "admin") ? [["global:", "All cabinets"] as [string, string], ...(cabinet.model ? [[`model:${cabinet.model}`, `Cabinets of this model (${cabinet.model})`] as [string, string]] : [])] : [])];
  const go = async () => {
    setBusy(true); setProblem(null);
    const at = scope.indexOf(":");
    const kind = scope.slice(0, at), id = scope.slice(at + 1);
    try {
      const r = await api<{ id: string }>("POST", "/api/baselines/capture", { cabinetId: cabinet.id, scope: { kind, id: id || null }, description: description.trim(), categories });
      navigate(`/admin/baselines/versions/${r.id}`);
    } catch (e) { setProblem(describeError(e)); setBusy(false); }
  };
  return (
    <section className="panel" aria-labelledby="capture-heading">
      <h2 id="capture-heading">Capture a baseline from this cabinet</h2>
      <p className="muted">Records what this cabinet reports now as a draft. Review and trim it, then propose it; an Admin approves it before it is used for anything. Values that differ from cabinet to cabinet (its own address, its update dates) are left out of a baseline that covers more than this cabinet.</p>
      <form className="stack" onSubmit={e => { e.preventDefault(); void go(); }}>
        <label className="field"><span>Applies to</span><select value={scope} onChange={e => setScope(e.target.value)}>{scopes.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="field"><span>What this version is for</span><input required minLength={3} maxLength={500} value={description} onChange={e => setDescription(e.target.value)} /></label>
        <fieldset><legend>Include</legend><div className="row gap wrap">{CATEGORIES.filter(([k]) => k !== "devices" || scope.startsWith("cabinet:")).map(([k, n]) => (
          <label key={k} className="check"><input type="checkbox" checked={categories.includes(k)} onChange={e => setCategories(c => e.target.checked ? [...c, k] : c.filter(x => x !== k))} /> {n}</label>))}</div></fieldset>
        {problem && <p className="error" role="alert">{problem}</p>}
        <button className="btn" type="submit" disabled={busy || categories.length === 0}>{busy ? "Capturing…" : "Capture as a draft"}</button>
      </form>
    </section>
  );
}
