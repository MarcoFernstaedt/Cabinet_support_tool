// The audit log, searchable by person, cabinet, action and date range, with the chain check;
// and who is online now (docs/spec/06-console-spec.md "Admin screens", 05-server-spec.md "Presence").
import { useEffect, useState } from "react";
import { api, describeError } from "../../lib/api";
import { Link, useRouter } from "../../lib/router";
import { roleName, type Role } from "../../lib/session";
import { ago, fullTime } from "../../lib/time";
import { Breadcrumbs } from "../../components/Layout";
import { Badge, Empty } from "../../components/ui";
import { useLoad } from "../../lib/useLoad";
import type { UserRow } from "./Users";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuditRow {
  seq: number; at: string; actor: { kind: string; id: string; name: string | null; username?: string | null }; action: string;
  target: { kind: string; id: string | null; name: string | null } | null; outcome: string; details: Record<string, unknown>;
}

/** Plain words for the actions people search for most; anything else shows its code. */
export const ACTIONS: [string, string][] = [
  ["cabinet.view", "Opened a cabinet"], ["eventlog.entry.open", "Opened an event log entry"], ["eventlog.browse", "Browsed an event log"], ["command.issue", "Ran a diagnostic"], ["command.write", "Changed a cabinet"],
  ["command.result", "A cabinet answered"], ["auth.", "Sign-in and confirmations"], ["user.", "Account changes"], ["alert.", "Alerts claimed or resolved"],
  ["rule.", "Symptom rule changes"], ["package.", "Software library"], ["writes.", "Write pauses"], ["settings.", "Settings"], ["security.", "Security alerts raised"],
  ["enrollment.", "Cabinet approvals"], ["client.", "Client changes"], ["site.", "Site changes"],
];
const actionLabel = (a: string) => ACTIONS.find(([k]) => k === a)?.[1];

export function AuditTable({ rows, onMore }: { rows: AuditRow[]; onMore?: () => void }) {
  if (rows.length === 0) return <Empty>No entries match.</Empty>;
  return (<>
    <table className="table compact">
      <caption className="sr-only">Audit entries, newest first</caption>
      <thead><tr><th scope="col">Time</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">On</th><th scope="col">Outcome</th><th scope="col">Details</th></tr></thead>
      <tbody>{rows.map(r => (
        <tr key={r.seq}>
          <td>{fullTime(r.at)}<div className="muted small">#{r.seq}</div></td>
          <td>{r.actor.kind === "user" ? (r.actor.name ? <><Link to={`/admin/users/${r.actor.id}`}>{r.actor.name}</Link>{r.actor.username && <span className="muted"> ({r.actor.username})</span>}</> : <code>{r.actor.id.slice(0, 8)}</code>)
            : <span className="muted">{r.actor.kind === "agent" ? "Cabinet agent" : "Platform"} <code>{(r.actor.name ?? r.actor.id).slice(0, 24)}</code></span>}</td>
          <td>{actionLabel(r.action) ?? ""} <code>{r.action}</code></td>
          <td>{r.target ? (r.target.kind === "cabinet" && r.target.id ? <Link to={`/cabinets/${r.target.id}`}>{r.target.name ?? r.target.id.slice(0, 8)}</Link>
            : r.target.kind === "user" && r.target.id ? <Link to={`/admin/users/${r.target.id}`}>{r.target.name ?? r.target.id.slice(0, 8)}</Link>
            : <>{r.target.kind} {r.target.name ?? <code>{r.target.id?.slice(0, 8)}</code>}</>) : "—"}</td>
          <td><Badge tone={r.outcome === "succeeded" ? "ok" : r.outcome === "failed" ? "crit" : "warn"}>{r.outcome}</Badge></td>
          <td className="wrap small">{Object.keys(r.details).length > 0 && <details><summary>Show</summary><pre>{JSON.stringify(r.details, null, 2)}</pre></details>}</td>
        </tr>))}
      </tbody>
    </table>
    {onMore && rows.length >= 100 && <button className="btn" onClick={onMore}>Older entries</button>}
  </>);
}

interface CabinetHit { kind: string; id: string; name: string; context: string; }

/** Pick a cabinet by name. */
function CabinetPicker({ value, onChange }: { value: { id: string; name: string | null } | null; onChange: (v: { id: string; name: string | null } | null) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CabinetHit[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => api<CabinetHit[]>("GET", `/api/fleet/search?q=${encodeURIComponent(q.trim())}`).then(h => setHits(h.filter(x => x.kind === "cabinet")), () => setHits([])), 200);
    return () => clearTimeout(t);
  }, [q]);
  if (value) return <span className="field inline"><span>Cabinet</span><span><strong>{value.name ?? `cabinet ${value.id.slice(0, 8)}…`}</strong> <button type="button" className="btn small" onClick={() => onChange(null)}>Clear</button></span></span>;
  return (
    <div className="field inline picker">
      <label htmlFor="audit-cabinet">Cabinet</label>
      <input id="audit-cabinet" placeholder="Any cabinet" value={q} onChange={e => setQ(e.target.value)} autoComplete="off" />
      {hits.length > 0 && <ul className="jump-results" role="listbox" aria-label="Matching cabinets">{hits.map(h => (
        <li key={h.id} role="option" aria-selected={false}><button type="button" className="linkish" onClick={() => { onChange({ id: h.id, name: h.name }); setQ(""); }}>{h.name} <span className="muted">· {h.context}</span></button></li>))}</ul>}
    </div>
  );
}

export function AuditLog() {
  const { path } = useRouter();
  const initial = new URLSearchParams(path.split("?")[1] ?? "");
  const users = useLoad<UserRow[]>("/api/admin/users");
  const [filter, setFilter] = useState({ user: initial.get("user") ?? "", action: initial.get("action") ?? "", from: initial.get("from") ?? "", to: initial.get("to") ?? "" });
  // A link names the cabinet by ID only; its name comes from the server's own audit entries, never from the link,
  // so nobody can send an Admin a link that shows one cabinet's history under another cabinet's name.
  const linked = initial.get("cabinet");
  const [chosen, setCabinet] = useState<{ id: string; name: string | null } | null>(linked && UUID.test(linked) ? { id: linked, name: null } : null);
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const cabinet = chosen && chosen.name === null
    ? { id: chosen.id, name: rows?.find(r => r.target?.kind === "cabinet" && r.target.id === chosen.id)?.target?.name ?? null } : chosen;
  const [problem, setProblem] = useState<string | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; entries: number; firstBadSeq?: number } | null>(null);
  const query = (before?: number) => {
    const q = new URLSearchParams(Object.entries({ ...filter, cabinet: cabinet?.id ?? "" }).filter(([, v]) => v));
    if (before) q.set("before", String(before));
    return `/api/admin/audit${q.size ? `?${q}` : ""}`;
  };
  const search = (more = false) => {
    setProblem(null);
    api<AuditRow[]>("GET", query(more ? rows?.at(-1)?.seq : undefined)).then(r => setRows(more ? [...(rows ?? []), ...r] : r), e => setProblem(describeError(e)));
  };
  useEffect(() => { search(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const verify = () => api<{ ok: boolean; entries: number; firstBadSeq?: number }>("POST", "/api/admin/audit/verify", {}).then(setCheck, e => setProblem(describeError(e)));
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Audit log" }]} />
      <h1>Audit log</h1>
      <p className="muted">A searchable history of sign-ins, changes made to cabinets and their results, account and settings changes, and admin actions, with exact times. Entries are chained by hash, so a changed or removed entry is found.</p>
      <div className="row gap wrap">
        <button className="btn" onClick={() => void verify()}>Verify the chain</button>
        {check && (check.ok ? <Badge tone="ok">Chain intact: {check.entries.toLocaleString()} entries</Badge>
          : <Badge tone="crit">Chain broken at entry {check.firstBadSeq}. Admins have a security alert.</Badge>)}
      </div>
      <form className="row gap wrap filters" onSubmit={e => { e.preventDefault(); search(); }} aria-label="Search the audit log">
        <label className="field inline"><span>Person</span>
          <select value={filter.user} onChange={e => setFilter(f => ({ ...f, user: e.target.value }))}>
            <option value="">Anyone</option>
            {users.data?.map(u => <option key={u.id} value={u.id}>{u.name} ({u.username})</option>)}
          </select></label>
        <CabinetPicker value={cabinet} onChange={setCabinet} />
        <label className="field inline"><span>What</span>
          <select value={filter.action} onChange={e => setFilter(f => ({ ...f, action: e.target.value }))}>
            <option value="">Anything</option>
            {ACTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            {filter.action && !ACTIONS.some(([k]) => k === filter.action) && <option value={filter.action}>{filter.action}</option>}
          </select></label>
        <label className="field inline"><span>From</span><input type="date" value={filter.from} onChange={e => setFilter(f => ({ ...f, from: e.target.value }))} /></label>
        <label className="field inline"><span>To</span><input type="date" value={filter.to} onChange={e => setFilter(f => ({ ...f, to: e.target.value }))} /></label>
        <button className="btn primary" type="submit">Search</button>
      </form>
      {problem && <p className="error" role="alert">{problem}</p>}
      {rows && <AuditTable rows={rows} onMore={() => search(true)} />}
    </div>
  );
}

interface OnlineRow { id: string; name: string; username: string; role: Role; lastActivityAt: string; address: string | null; cabinet: { id: string; name: string } | null; }

export function OnlineNow() {
  const { data, problem, reload } = useLoad<OnlineRow[]>("/api/admin/online");
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Online now" }]} />
      <h1>Online now</h1>
      <p className="muted">People signed in with activity in the last 5 minutes. <button className="btn small" onClick={reload}>Refresh</button></p>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && (data.length === 0 ? <Empty>Nobody else is active right now.</Empty> : (
        <table className="table">
          <caption className="sr-only">People online now</caption>
          <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Last activity</th><th scope="col">Cabinet open</th><th scope="col">From</th></tr></thead>
          <tbody>{data.map(u => (
            <tr key={u.id}>
              <th scope="row"><Link to={`/admin/users/${u.id}`}>{u.name}</Link> <span className="muted">({u.username})</span></th>
              <td>{roleName(u.role)}</td>
              <td><span title={fullTime(u.lastActivityAt)}>{ago(u.lastActivityAt)}</span></td>
              <td>{u.cabinet ? <Link to={`/cabinets/${u.cabinet.id}`}>{u.cabinet.name}</Link> : <span className="muted">none</span>}</td>
              <td><code>{u.address ?? "—"}</code></td>
            </tr>))}
          </tbody>
        </table>))}
    </div>
  );
}
