// Baselines: what a cabinet, a site, a client, a model or the whole fleet should look like (docs/spec/15-baselines-and-config.md).
// A version is written as a draft, proposed, and approved by an Admin with an authenticator code; only an approved version is compared with.
// Nothing on these pages changes a cabinet.
import { useState } from "react";
import { api, describeError } from "../../lib/api";
import { Link, useRouter } from "../../lib/router";
import { useLoad } from "../../lib/useLoad";
import { atLeast, useSession } from "../../lib/session";
import { fullTime } from "../../lib/time";
import { Breadcrumbs } from "../../components/Layout";
import { Badge, Empty } from "../../components/ui";
import { Pager, usePaged } from "../../components/Pager";
import { useStepUp } from "../../components/StepUp";
import { categoryName, show } from "../../components/ConfigParts";
import { processExpects, processItem, processProblem, type ProcessLimits } from "../../lib/drift-text";

type Kind = "global" | "role" | "model" | "client" | "site" | "cabinet";
interface Scope { kind: Kind; id: string | null }
const KIND_NAME: Record<Kind, string> = { global: "All cabinets", role: "Every cabinet of a role", model: "A cabinet model", client: "A client", site: "A site", cabinet: "One cabinet" };
/** The three cabinet roles a role baseline can apply to (decision-log D33). */
const ROLES: [string, string][] = [["sync", "Sync cabinets"], ["satellite", "Satellite cabinets"], ["standalone", "Standalone cabinets"]];
const STATUS: Record<string, [string, "ok" | "warn" | "crit" | "info" | "off"]> = { draft: ["Draft", "off"], pending: ["Waiting for an Admin", "warn"], approved: ["In force", "ok"], rejected: ["Rejected", "crit"], superseded: ["Replaced", "off"] };

interface Row { id: string; scope: Scope; name: string; createdAt: string; approvedVersion: number | null; approvedAt: string | null; pendingVersionId: string | null; drafts: number }

export function Baselines() {
  const { me } = useSession();
  const { data, problem, reload } = useLoad<{ baselines: Row[] }>("/api/baselines");
  const paged = usePaged(data?.baselines ?? []);
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Baselines" }]} />
      <h1>Baselines</h1>
      <p className="muted">A baseline says how cabinets should be configured. A narrower one (a site, one cabinet) replaces a wider one (a client, all cabinets) item by item. Only an approved version is compared with, and comparing never changes a cabinet.</p>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && data.baselines.length === 0 && <Empty>No baseline exists yet. Open a cabinet's Baseline tab and capture one from a cabinet that is known to work.</Empty>}
      {data && data.baselines.length > 0 && (<>
        <div className="table-wrap"><table className="table">
          <caption className="sr-only">Baselines</caption>
          <thead><tr><th scope="col">Applies to</th><th scope="col">In force</th><th scope="col">Waiting</th></tr></thead>
          <tbody>{paged.rows.map(b => (
            <tr key={b.id}><th scope="row"><Link to={`/admin/baselines/${b.id}`}>{b.name}</Link> <span className="muted">{KIND_NAME[b.scope.kind]}</span></th>
              <td>{b.approvedVersion ? <>Version {b.approvedVersion}{b.approvedAt && <span className="muted"> · {fullTime(b.approvedAt)}</span>}</> : <span className="muted">none yet</span>}</td>
              <td>{b.pendingVersionId ? <Link to={`/admin/baselines/versions/${b.pendingVersionId}`}>A version waits for approval</Link> : b.drafts > 0 ? `${b.drafts} ${b.drafts === 1 ? "draft" : "drafts"}` : "-"}</td></tr>))}</tbody>
        </table></div>
        <Pager {...paged} label="baselines" />
      </>)}
      {atLeast(me, "tier2") && <ImportPanel rows={data?.baselines ?? []} onDone={reload} />}
    </div>
  );
}

const scopeValue = (s: Scope) => `${s.kind}:${s.id ?? ""}`;
const parseScope = (v: string): Scope => { const at = v.indexOf(":"); const kind = v.slice(0, at) as Kind; const id = v.slice(at + 1); return { kind, id: kind === "global" ? null : id }; };

/** Copy the approved content of one baseline into a draft for another place. */
function ImportPanel({ rows, onDone }: { rows: Row[]; onDone: () => void }) {
  const { me } = useSession();
  const { navigate } = useRouter();
  const sources = rows.filter(r => r.approvedVersion);
  const clients = useLoad<{ id: string; name: string; sites: { id: string; name: string }[] }[]>("/api/admin/clients");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [description, setDescription] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const targets: [string, string][] = [
    ...(atLeast(me, "admin") ? [["global:", "All cabinets"] as [string, string], ...ROLES.map(([r, n]) => [`role:${r}`, n] as [string, string])] : []),
    ...(clients.data ?? []).flatMap(c => [[`client:${c.id}`, `Client ${c.name}`] as [string, string], ...c.sites.map(s => [`site:${s.id}`, `Site ${c.name} / ${s.name}`] as [string, string])]),
  ];
  if (sources.length === 0) return null;
  return (
    <section className="panel" aria-labelledby="import-heading">
      <h2 id="import-heading">Start from another baseline</h2>
      <p className="muted">Copies what is in force for one place into a draft for another, to review and change before it is proposed.</p>
      <form className="stack" onSubmit={async e => {
        e.preventDefault(); setProblem(null);
        try { const r = await api<{ id: string }>("POST", "/api/baselines/import", { from: parseScope(from), to: parseScope(to), description: description.trim() }); onDone(); navigate(`/admin/baselines/versions/${r.id}`); }
        catch (x) { setProblem(describeError(x)); }
      }}>
        <label className="field"><span>Copy from</span><select required value={from} onChange={e => setFrom(e.target.value)}><option value="">Choose…</option>{sources.map(s => <option key={s.id} value={scopeValue(s.scope)}>{s.name}</option>)}</select></label>
        <label className="field"><span>Copy to</span><select required value={to} onChange={e => setTo(e.target.value)}><option value="">Choose…</option>{targets.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="field"><span>What this version is for</span><input required minLength={3} maxLength={500} value={description} onChange={e => setDescription(e.target.value)} /></label>
        {problem && <p className="error" role="alert">{problem}</p>}
        <button className="btn" type="submit" disabled={!from || !to}>Make a draft</button>
      </form>
    </section>
  );
}

interface VersionSummary { id: string; version: number; status: string; description: string; createdBy: { name: string }; createdAt: string; decidedBy: { name: string } | null; decidedAt: string | null; decisionNote: string | null }

export function BaselineDetail({ id }: { id: string }) {
  const { data, problem } = useLoad<{ id: string; name: string; scope: Scope; versions: VersionSummary[] }>(`/api/baselines/${id}`);
  const paged = usePaged(data?.versions ?? []);
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Baselines", to: "/admin/baselines" }, { label: data?.name ?? "Baseline" }]} />
      <h1>{data?.name ?? "Baseline"}</h1>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && (<>
        <p className="muted">{KIND_NAME[data.scope.kind]}. Every version is kept, with who wrote it, who decided it and why.</p>
        <div className="table-wrap"><table className="table">
          <caption className="sr-only">Versions</caption>
          <thead><tr><th scope="col">Version</th><th scope="col">State</th><th scope="col">Written</th><th scope="col">Decision</th></tr></thead>
          <tbody>{paged.rows.map(v => (
            <tr key={v.id}><th scope="row"><Link to={`/admin/baselines/versions/${v.id}`}>Version {v.version}</Link><div className="muted small">{v.description}</div></th>
              <td><Badge tone={STATUS[v.status]?.[1] ?? "off"}>{STATUS[v.status]?.[0] ?? v.status}</Badge></td>
              <td>{v.createdBy.name}<div className="muted small">{fullTime(v.createdAt)}</div></td>
              <td>{v.decidedBy ? <>{v.decidedBy.name}<div className="muted small">{v.decidedAt && fullTime(v.decidedAt)}{v.decisionNote && <> · {v.decisionNote}</>}</div></> : "-"}</td></tr>))}</tbody>
        </table></div>
        <Pager {...paged} label="versions" />
      </>)}
    </div>
  );
}

interface Item { category: string; key: string; mode: string; expect?: Record<string, unknown>; limits?: ProcessLimits; required?: boolean; severity?: "minor" | "major"; note?: string }
interface Content { items: Item[]; health?: Record<string, unknown> }
interface VersionFull extends VersionSummary { baselineId: string; scope: Scope; content: Content; proposedAt: string | null; previousVersionId: string | null;
  diff: { added: Item[]; removed: Item[]; changed: { before: Item; after: Item }[]; healthChanged: boolean }; origin: { kind?: string; cabinetName?: string; enrollment?: boolean } | null }

const MODE: Record<string, string> = { match: "Must be", present: "Must exist", absent: "Must not exist", ignore: "Not required here" };

export function VersionReview({ id }: { id: string }) {
  const { me } = useSession();
  const { navigate } = useRouter();
  const { data, problem, reload } = useLoad<VersionFull>(`/api/baselines/versions/${id}`);
  const step = useStepUp();
  const [items, setItems] = useState<Item[] | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const working = items ?? data?.content.items ?? [];
  const paged = usePaged(working);
  const editable = !!data && data.status === "draft" && atLeast(me, "tier2");
  const [filter, setFilter] = useState("");
  const shown = filter.trim() ? working.filter(i => `${i.category} ${i.key}`.toLowerCase().includes(filter.trim().toLowerCase())) : working;
  const view = usePaged(shown);
  void paged;
  const change = (item: Item, patch: Partial<Item>) => setItems(working.map(i => i === item ? { ...i, ...patch } : i));
  const run = async (what: () => Promise<unknown>, message: string) => {
    setErr(null); setDone(null);
    try { await what(); setDone(message); setItems(null); setDescription(null); reload(); } catch (e) { setErr(describeError(e)); }
  };
  const save = () => run(() => api("PUT", `/api/baselines/versions/${id}`, { ...(description !== null ? { description: description.trim() } : {}), ...(items ? { content: { ...data!.content, items } } : {}) }), "Saved.");
  const decide = (approve: boolean) => {
    const body = { note: note.trim() };
    step.ask(approve ? "baseline.approve" : "baseline.reject", id,
      <><p>{approve ? "Approve" : "Reject"} version {data!.version} of this baseline.</p>{approve && <p className="muted">Every cabinet it applies to is compared with it from now on. No cabinet is changed.</p>}<p className="muted">Reason: {body.note}</p></>,
      async token => { await api("POST", `/api/baselines/versions/${id}/${approve ? "approve" : "reject"}`, { ...body, stepUpToken: token }); setNote(""); setDone(approve ? "Approved. Cabinets are being compared with it." : "Rejected."); reload(); },
      body);
  };
  const dirty = items !== null || (description !== null && description !== data?.description);
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Baselines", to: "/admin/baselines" }, ...(data ? [{ label: "Versions", to: `/admin/baselines/${data.baselineId}` }] : []), { label: data ? `Version ${data.version}` : "Version" }]} />
      <h1>{data ? `Version ${data.version}` : "Baseline version"} {data && <Badge tone={STATUS[data.status]?.[1] ?? "off"}>{STATUS[data.status]?.[0] ?? data.status}</Badge>}</h1>
      {problem && <p className="error" role="alert">{problem}</p>}
      {err && <p className="error" role="alert">{err}</p>}
      {done && <p className="notice ok" role="status">{done}</p>}
      {data && (<>
        <section className="panel">
          <dl className="kv">
            <div><dt>Applies to</dt><dd>{KIND_NAME[data.scope.kind]}</dd></div>
            <div><dt>Written by</dt><dd>{data.createdBy.name}, {fullTime(data.createdAt)}{data.origin?.cabinetName && <> · captured from {data.origin.cabinetName}</>}{data.origin?.enrollment && <> · captured from the cabinet's first report, as asked when it was approved</>}{data.origin?.kind === "attach" && <> · attached to this site when a cabinet was approved</>}</dd></div>
            {data.decidedBy && <div><dt>Decided by</dt><dd>{data.decidedBy.name}, {data.decidedAt && fullTime(data.decidedAt)}{data.decisionNote && <> · {data.decisionNote}</>}</dd></div>}
            <div><dt>Purpose</dt><dd>{editable ? <input aria-label="What this version is for" value={description ?? data.description} minLength={3} maxLength={500} onChange={e => setDescription(e.target.value)} /> : data.description}</dd></div>
          </dl>
        </section>

        <section className="panel" aria-labelledby="diff-heading">
          <h2 id="diff-heading">What this version changes</h2>
          {data.diff.added.length + data.diff.removed.length + data.diff.changed.length === 0 && !data.diff.healthChanged
            ? <p className="muted">{data.previousVersionId ? "Nothing differs from the version it was made from." : "This is the first version."}</p>
            : <ul className="plain">
              {data.diff.added.map(i => <li key={`a|${i.category}|${i.key}`}><Badge tone="ok">Added</Badge> {categoryName(i.category)}: {i.key}</li>)}
              {data.diff.removed.map(i => <li key={`r|${i.category}|${i.key}`}><Badge tone="warn">Removed</Badge> {categoryName(i.category)}: {i.key}</li>)}
              {data.diff.changed.map(c => <li key={`c|${c.after.category}|${c.after.key}`}><Badge tone="info">Changed</Badge> {categoryName(c.after.category)}: {c.after.key}</li>)}
              {data.diff.healthChanged && <li><Badge tone="info">Changed</Badge> What counts as healthy</li>}
            </ul>}
        </section>

        <section className="panel" aria-labelledby="items-heading">
          <h2 id="items-heading">What it expects ({working.length} {working.length === 1 ? "item" : "items"})</h2>
          {editable && <p className="muted">Remove what should not be judged, mark what health depends on, and say how serious a difference is. Save before proposing.</p>}
          <label className="field inline"><span>Find an item</span><input type="search" maxLength={100} value={filter} onChange={e => setFilter(e.target.value)} /></label>
          {working.length === 0 ? <Empty>This version expects nothing.</Empty> : (<>
            <div className="table-wrap"><table className="table compact">
              <caption className="sr-only">Items in this version</caption>
              <thead><tr><th scope="col">Item</th><th scope="col">Expects</th><th scope="col">Required</th><th scope="col">If it differs</th>{editable && <th scope="col"><span className="sr-only">Remove</span></th>}</tr></thead>
              <tbody>{view.rows.map(i => (
                <tr key={`${i.category}|${i.key}`}><th scope="row">{categoryName(i.category)}: {i.key}{i.note && <div className="muted small">{i.note}</div>}</th>
                  <td><strong>{i.category === "processes" ? processExpects(i.mode, i.limits) : MODE[i.mode] ?? i.mode}</strong>{i.mode === "match" && Object.entries(i.expect ?? {}).map(([f, v]) => <div key={f} className="small">{f}: {show(v)}</div>)}</td>
                  <td>{editable ? <input type="checkbox" aria-label={`${i.key} is required`} checked={!!i.required} onChange={e => change(i, { required: e.target.checked })} /> : i.required ? "Yes" : "No"}</td>
                  <td>{editable ? <select aria-label={`Severity of ${i.key}`} value={i.severity ?? "minor"} onChange={e => change(i, { severity: e.target.value as "minor" | "major" })}><option value="minor">Minor</option><option value="major">Major</option></select> : (i.severity ?? "minor") === "major" ? "Major" : "Minor"}</td>
                  {editable && <td><button className="btn small" onClick={() => setItems(working.filter(x => x !== i))} aria-label={`Remove ${i.key}`}>Remove</button></td>}</tr>))}</tbody>
            </table></div>
            <Pager {...view} label="items" />
          </>)}
          {editable && <AddProcess items={working} onAdd={item => setItems([...working, item])} />}
          {editable && <div className="row gap wrap"><button className="btn primary" disabled={!dirty} onClick={() => void save()}>Save the draft</button></div>}
        </section>

        {data.status === "draft" && atLeast(me, "tier2") && (
          <section className="panel"><h2>Send for approval</h2>
            <p className="muted">An Admin reads it and approves or rejects it. {dirty && "Save your changes first."}</p>
            <button className="btn" disabled={dirty} onClick={() => void run(() => api("POST", `/api/baselines/versions/${id}/propose`, {}), "Proposed. An Admin has to approve it before it is used.")}>Propose this version</button></section>)}
        {data.status === "pending" && (
          <section className="panel"><h2>Waiting for an Admin</h2>
            {atLeast(me, "tier2") && <p><button className="btn" onClick={() => void run(() => api("POST", `/api/baselines/versions/${id}/withdraw`, {}), "Withdrawn: it is a draft again.")}>Withdraw it</button></p>}
            {atLeast(me, "admin") ? (
              <form className="stack" onSubmit={e => e.preventDefault()}>
                <label className="field"><span>Reason for the decision (kept with it)</span><input required minLength={3} maxLength={500} value={note} onChange={e => setNote(e.target.value)} /></label>
                <div className="row gap wrap">
                  <button className="btn primary" disabled={note.trim().length < 3} onClick={() => decide(true)}>Approve…</button>
                  <button className="btn" disabled={note.trim().length < 3} onClick={() => decide(false)}>Reject…</button>
                </div>
              </form>) : <p className="muted">Only an Admin can approve or reject it.</p>}
          </section>)}
        <p><button className="btn small" onClick={() => navigate(`/admin/baselines/${data.baselineId}`)}>All versions of this baseline</button></p>
      </>)}
      {step.dialog}
    </div>
  );
}

/**
 * A program a cabinet must be running, within limits if given, or must not be running (decision-log D155). It is judged on the
 * cabinet's latest stored process list, never by asking the cabinet; the item is saved with the draft.
 */
function AddProcess({ items, onAdd }: { items: readonly Item[]; onAdd: (item: Item) => void }) {
  const [name, setName] = useState("");
  const [mustRun, setMustRun] = useState(true);
  const [cpu, setCpu] = useState("");
  const [memory, setMemory] = useState("");
  const [required, setRequired] = useState(false);
  const [severity, setSeverity] = useState<"minor" | "major">("minor");
  const [problem, setProblem] = useState<string | null>(null);
  const add = () => {
    const p = processProblem(name, mustRun ? cpu : "", mustRun ? memory : "", items);
    setProblem(p);
    if (p) return;
    onAdd(processItem(name, mustRun, cpu, memory, required, severity));
    setName(""); setCpu(""); setMemory("");
  };
  return (
    <fieldset className="stack">
      <legend>Add a process</legend>
      <p className="muted small">Judged on the cabinet's latest process list, with the time of that list shown on any difference. A difference is never an alert.</p>
      <div className="row gap wrap">
        <label className="field"><span>Program</span><input value={name} maxLength={180} placeholder="SyncService.exe" onChange={e => setName(e.target.value)} /></label>
        <label className="field"><span>It</span><select value={mustRun ? "run" : "not"} onChange={e => setMustRun(e.target.value === "run")}>
          <option value="run">must be running</option><option value="not">must not be running</option></select></label>
        {mustRun && <label className="field"><span>At most CPU (%)</span><input inputMode="decimal" value={cpu} onChange={e => setCpu(e.target.value)} /></label>}
        {mustRun && <label className="field"><span>At most memory (MB)</span><input inputMode="numeric" value={memory} onChange={e => setMemory(e.target.value)} /></label>}
        <label className="field inline"><input type="checkbox" checked={required} onChange={e => setRequired(e.target.checked)} /><span>Health depends on it</span></label>
        <label className="field"><span>If it differs</span><select value={severity} onChange={e => setSeverity(e.target.value as "minor" | "major")}>
          <option value="minor">Minor</option><option value="major">Major</option></select></label>
      </div>
      {problem && <p className="error" role="alert">{problem}</p>}
      <div><button type="button" className="btn" onClick={add}>Add the process</button></div>
    </fieldset>
  );
}
