// Clients and sites (create, rename, remove), issue types (create, edit) and suppressions
// (create with a reason, renew, disable) — docs/spec/06-console-spec.md "Admin screens".
import { useState } from "react";
import { api } from "../../lib/api";
import { Link } from "../../lib/router";
import { fullTime } from "../../lib/time";
import { Breadcrumbs } from "../../components/Layout";
import { Badge, Empty } from "../../components/ui";
import { useStepUp } from "../../components/StepUp";
import { useLoad } from "../../lib/useLoad";
import { SEVERITY_LABEL } from "../../components/MapToIssue";

interface ClientAdmin { id: string; name: string; writePaused: boolean; writePauseReason: string | null; sites: { id: string; name: string; cabinets: number }[]; }

/** A name shown as text with Rename, which turns into a small form. */
function Rename({ label, value, onSave }: { label: string; value: string; onSave: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(value);
  if (!editing) return <><strong>{value}</strong> <button className="btn small" onClick={() => { setName(value); setEditing(true); }} aria-label={`Rename ${label} ${value}`}>Rename</button></>;
  return (
    <form className="row gap inline-form" onSubmit={e => { e.preventDefault(); if (name.trim() && name.trim() !== value) onSave(name.trim()); setEditing(false); }}>
      <label className="sr-only" htmlFor={`rename-${value}`}>New name for {label} {value}</label>
      <input id={`rename-${value}`} autoFocus required maxLength={128} value={name} onChange={e => setName(e.target.value)} />
      <button className="btn small primary" type="submit">Save</button>
      <button className="btn small" type="button" onClick={() => setEditing(false)}>Cancel</button>
    </form>
  );
}

export function ClientsAndSites() {
  const { data, problem, reload } = useLoad<ClientAdmin[]>("/api/admin/clients");
  const step = useStepUp();
  const [newClient, setNewClient] = useState("");
  const [newSite, setNewSite] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  // The code confirms exactly this body; the server refuses the token for any other.
  const run = (action: string, target: string, description: string, method: "POST" | "PUT", path: string, body: Record<string, unknown>, after: string, then?: () => void) =>
    step.ask(action, target, <p>{description}</p>, async token => { await api(method, path, { ...body, stepUpToken: token }); then?.(); setDone(after); reload(); }, body);
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Clients and sites" }]} />
      <h1>Clients and sites</h1>
      <p className="muted">Cabinets join a client and site when they are approved. A client or site can be removed once it has no active or pending cabinets; its history stays.</p>
      {done && <p className="notice ok" role="status">{done}</p>}
      <form className="row gap wrap" onSubmit={e => { e.preventDefault(); const name = newClient.trim();
        // The name is cleared only once the client exists, so cancelling the confirmation keeps what was typed.
        run("client.create", "fleet", `Create the client ${name}.`, "POST", "/api/admin/clients", { name }, `Client ${name} created.`, () => setNewClient("")); }}>
        <label className="field inline"><span>New client</span><input required maxLength={128} value={newClient} onChange={e => setNewClient(e.target.value)} /></label>
        <button className="btn primary" type="submit">Create client</button>
      </form>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && (data.length === 0 ? <Empty>No clients yet.</Empty> : data.map(c => (
        <section key={c.id} className="panel" aria-label={`Client ${c.name}`}>
          <div className="panel-head">
            <h2><Rename label="client" value={c.name} onSave={name => run("client.rename", c.id, `Rename the client ${c.name} to ${name}.`,
              "PUT", `/api/admin/clients/${c.id}`, { name }, `Client renamed to ${name}.`)} /></h2>
            <div className="row gap">
              {c.writePaused && <Badge tone="warn">Changes paused</Badge>}
              <Link to={`/clients/${c.id}`} className="btn small">Open</Link>
              <button className="btn small danger" onClick={() => run("client.remove", c.id, `Remove the client ${c.name} and its sites. Allowed only when none of its cabinets is active or pending.`,
                "POST", `/api/admin/clients/${c.id}/remove`, {}, `Client ${c.name} removed.`)}>Remove client</button>
            </div>
          </div>
          {c.sites.length === 0 ? <Empty>No sites.</Empty> : (
            <ul className="plain">{c.sites.map(s => (
              <li key={s.id} className="row gap wrap">
                <Rename label="site" value={s.name} onSave={name => run("site.rename", s.id, `Rename the site ${s.name} to ${name}.`,
                  "PUT", `/api/admin/sites/${s.id}`, { name }, `Site renamed to ${name}.`)} />
                <span className="muted">{s.cabinets} {s.cabinets === 1 ? "cabinet" : "cabinets"}</span>
                <Link to={`/sites/${s.id}`} className="btn small">Open</Link>
                <button className="btn small danger" disabled={s.cabinets > 0} title={s.cabinets > 0 ? "Move or remove its cabinets first" : undefined}
                  onClick={() => run("site.remove", s.id, `Remove the site ${s.name}.`, "POST", `/api/admin/sites/${s.id}/remove`, {}, `Site ${s.name} removed.`)}>Remove site</button>
              </li>))}
            </ul>)}
          <form className="row gap wrap" onSubmit={e => { e.preventDefault(); const name = (newSite[c.id] ?? "").trim();
            run("site.create", c.id, `Create the site ${name} for ${c.name}.`, "POST", "/api/admin/sites", { clientId: c.id, name }, `Site ${name} created.`,
              () => setNewSite(m => ({ ...m, [c.id]: "" }))); }}>
            <label className="field inline"><span>New site for {c.name}</span><input required maxLength={128} value={newSite[c.id] ?? ""} onChange={e => setNewSite(m => ({ ...m, [c.id]: e.target.value }))} /></label>
            <button className="btn" type="submit">Add site</button>
          </form>
        </section>)))}
      {step.dialog}
    </div>
  );
}

interface IssueRow { id: string; name: string; severity: "major" | "minor"; description: string; builtIn: boolean; openAlerts?: number; }
interface RuleRow { id: string; match: Record<string, unknown>; reason: string | null; expiresAt: string | null; approvedBy?: { name: string } | null; proposedBy?: { name: string } | null; matchedCount: number; }

const matchText = (m: Record<string, unknown>) => Object.entries(m).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(", ");

export function IssueTypesAndSuppressions() {
  const issues = useLoad<IssueRow[]>("/api/issues");
  const suppressions = useLoad<RuleRow[]>("/api/admin/suppressions");
  const step = useStepUp();
  const [done, setDone] = useState<string | null>(null);
  const empty = { name: "", severity: "minor" as "major" | "minor", description: "" };
  const [editing, setEditing] = useState<{ id: string | null; form: typeof empty } | null>(null);
  const [supp, setSupp] = useState({ log: "", source: "", eventId: "", phrase: "", reason: "" });

  const saveIssue = () => {
    if (!editing) return;
    const { id, form } = editing;
    step.ask(id ? "issue_type.update" : "issue_type.create", id ?? "fleet", <p>{id ? "Save the changes to" : "Create"} the issue type <strong>{form.name}</strong> ({form.severity}).</p>,
      async token => { await api(id ? "PUT" : "POST", id ? `/api/admin/issue-types/${id}` : "/api/admin/issue-types", { ...form, stepUpToken: token }); setEditing(null); setDone(`Issue type ${form.name} saved.`); issues.reload(); },
      form);
  };
  const match = () => {
    const m: Record<string, unknown> = {};
    if (supp.log.trim()) m.log = supp.log.trim();
    if (supp.source.trim()) m.source = supp.source.trim();
    if (supp.eventId.trim()) m.eventId = Number(supp.eventId);
    if (supp.phrase.trim()) m.phrase = supp.phrase.trim();
    return m;
  };
  const suppress = () => {
    const body = { match: match(), reason: supp.reason.trim() };
    step.ask("rule.suppress", "fleet", <><p>Ignore events matching <code>{matchText(body.match)}</code> on every cabinet for 90 days.</p><p className="muted">Reason: {body.reason}</p></>,
      async token => { await api("POST", "/api/admin/suppressions", { ...body, stepUpToken: token }); setSupp({ log: "", source: "", eventId: "", phrase: "", reason: "" });
        setDone("Suppression created; it expires in 90 days unless renewed."); suppressions.reload(); }, body);
  };

  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Issue types and suppressions" }]} />
      <h1>Issue types and suppressions</h1>
      {done && <p className="notice ok" role="status">{done}</p>}
      <section className="panel" aria-labelledby="types">
        <div className="panel-head"><h2 id="types">Issue types</h2><button className="btn primary" onClick={() => setEditing({ id: null, form: empty })}>New issue type</button></div>
        {editing && (
          <form className="form panel" aria-label={editing.id ? "Edit issue type" : "New issue type"} onSubmit={e => { e.preventDefault(); saveIssue(); }}>
            <div className="row gap wrap">
              <label className="field inline"><span>Name</span><input required maxLength={128} value={editing.form.name} onChange={e => setEditing(x => x && { ...x, form: { ...x.form, name: e.target.value } })} /></label>
              <label className="field inline"><span>Severity</span><select value={editing.form.severity} onChange={e => setEditing(x => x && { ...x, form: { ...x.form, severity: e.target.value as "major" | "minor" } })}>
                <option value="major">{SEVERITY_LABEL.major}</option><option value="minor">{SEVERITY_LABEL.minor}</option></select></label>
            </div>
            <label className="field"><span>Description</span><textarea required maxLength={1000} rows={2} value={editing.form.description} onChange={e => setEditing(x => x && { ...x, form: { ...x.form, description: e.target.value } })} /></label>
            <div className="row gap"><button className="btn" type="button" onClick={() => setEditing(null)}>Cancel</button><button className="btn primary" type="submit">Save</button></div>
          </form>)}
        {issues.problem && <p className="error" role="alert">{issues.problem}</p>}
        {issues.data && (
          <table className="table compact">
            <caption className="sr-only">Issue types</caption>
            <thead><tr><th scope="col">Issue</th><th scope="col">Severity</th><th scope="col">Description</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{issues.data.map(i => (
              <tr key={i.id}><th scope="row">{i.name} {i.builtIn && <Badge tone="info">Built in</Badge>}</th>
                <td><Badge tone={i.severity === "major" ? "crit" : "warn"}>{i.severity}</Badge></td><td>{i.description}</td>
                <td><button className="btn small" onClick={() => setEditing({ id: i.id, form: { name: i.name, severity: i.severity, description: i.description } })} aria-label={`Edit ${i.name}`}>Edit</button></td></tr>))}
            </tbody>
          </table>)}
      </section>

      <section className="panel" aria-labelledby="supps">
        <h2 id="supps">Active suppressions</h2>
        <p className="muted">A suppression marks a known harmless event as ignore on every cabinet. It needs a written reason and expires after 90 days unless renewed.</p>
        {suppressions.problem && <p className="error" role="alert">{suppressions.problem}</p>}
        {suppressions.data && (suppressions.data.length === 0 ? <Empty>No active suppressions.</Empty> : (
          <table className="table compact">
            <caption className="sr-only">Active suppressions, soonest to expire first</caption>
            <thead><tr><th scope="col">Ignores</th><th scope="col">Reason</th><th scope="col">Expires</th><th scope="col">Matched</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{suppressions.data.map(r => {
              const days = r.expiresAt ? Math.ceil((new Date(r.expiresAt).getTime() - Date.now()) / 86_400_000) : null;
              return (
                <tr key={r.id}><th scope="row"><code>{matchText(r.match)}</code><div className="muted small">by {r.approvedBy?.name ?? r.proposedBy?.name ?? "unknown"}</div></th>
                  <td>{r.reason}</td>
                  <td>{fullTime(r.expiresAt)}{days !== null && <div className="small">{days <= 14 ? <Badge tone="warn">in {days} days</Badge> : `in ${days} days`}</div>}</td>
                  <td>{r.matchedCount}</td>
                  <td><div className="row gap">
                    <button className="btn small" onClick={() => step.ask("rule.renew", r.id, <p>Renew this suppression for another 90 days.</p>,
                      async t => { await api("POST", `/api/admin/suppressions/${r.id}/renew`, { stepUpToken: t }); setDone("Suppression renewed for 90 days."); suppressions.reload(); })}>Renew</button>
                    <button className="btn small danger" onClick={() => step.ask("rule.disable", r.id, <p>Stop ignoring these events. Matching events raise alerts again.</p>,
                      async t => { await api("POST", `/api/rules/${r.id}/disable`, { stepUpToken: t }); setDone("Suppression disabled."); suppressions.reload(); })}>Disable</button>
                  </div></td>
                </tr>);
            })}</tbody>
          </table>))}
        <form className="form" aria-label="New suppression" onSubmit={e => { e.preventDefault(); suppress(); }}>
          <h3>New suppression</h3>
          <div className="row gap wrap">
            <label className="field inline"><span>Log</span><input list="suppression-logs" value={supp.log} onChange={e => setSupp(x => ({ ...x, log: e.target.value }))} placeholder="System" /></label>
            <datalist id="suppression-logs"><option value="System" /><option value="Application" /><option value="Setup" /><option value="Microsoft-Windows-Biometrics/Operational" /><option value="Microsoft-Windows-Kernel-PnP/Configuration" /></datalist>
            <label className="field inline"><span>Source</span><input value={supp.source} onChange={e => setSupp(x => ({ ...x, source: e.target.value }))} /></label>
            <label className="field inline"><span>Event ID</span><input inputMode="numeric" size={6} value={supp.eventId} onChange={e => setSupp(x => ({ ...x, eventId: e.target.value.replace(/\D/g, "") }))} /></label>
            <label className="field inline"><span>Message phrase</span><input value={supp.phrase} onChange={e => setSupp(x => ({ ...x, phrase: e.target.value }))} /></label>
          </div>
          <label className="field"><span>Why it is harmless (required, at least 10 characters)</span><input required minLength={10} maxLength={500} value={supp.reason} onChange={e => setSupp(x => ({ ...x, reason: e.target.value }))} /></label>
          <button className="btn primary" type="submit" disabled={Object.keys(match()).length === 0 || supp.reason.trim().length < 10}>Create suppression</button>
        </form>
      </section>
      {step.dialog}
    </div>
  );
}
