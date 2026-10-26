// Approved programs: the applications and services a cabinet may be asked to start, stop, restart or end (docs/spec/13-roadmap.md).
// One list per level: the fleet default, a client, a site. The most specific level with a list wins whole for a cabinet. Only an Admin
// changes a list, with an authenticator code bound to the exact entries; the server and the cabinet check every request against it.
import { useEffect, useMemo, useState } from "react";
import { api, describeError } from "../../lib/api";
import { Breadcrumbs } from "../../components/Layout";
import { Badge, StepUpDialog } from "../../components/ui";
import { useLoad } from "../../lib/useLoad";
import { fullTime } from "../../lib/time";
import type { KnownClient } from "./Admin";
import { entryKey, entryProblem, toEntry, type AppEntry, type AppList } from "../../lib/approved-apps";
type Level = "fleet" | "client" | "site";

export function ApprovedApps() {
  const clients = useLoad<KnownClient[]>("/api/admin/clients");
  const [level, setLevel] = useState<Level>("fleet");
  const [clientId, setClientId] = useState("");
  const [siteId, setSiteId] = useState("");
  const client = clients.data?.find(c => c.id === clientId) ?? null;
  const scopeId = level === "client" ? clientId : level === "site" ? siteId : null;
  const endpoint = level === "fleet" ? "/api/admin/approved-apps" : scopeId ? `/api/${level === "client" ? "clients" : "sites"}/${scopeId}/approved-apps` : null;
  return (
    <div className="page narrow">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Approved programs" }]} />
      <h1>Approved programs</h1>
      <p className="muted">The programs and services the platform may start, stop, restart or end on a cabinet. Anything not on the list is refused, by the server and by the cabinet. The most specific list wins: a site's list replaces its client's, and a client's replaces the fleet default.</p>
      <section className="panel">
        <div className="row gap wrap">
          <label className="field"><span>Set the list for</span>
            <select aria-label="Set the list for" value={level} onChange={e => { setLevel(e.target.value as Level); setSiteId(""); }}>
              <option value="fleet">The whole fleet (default)</option>
              <option value="client">One client</option>
              <option value="site">One site</option>
            </select></label>
          {level !== "fleet" && (
            <label className="field"><span>Client</span>
              <select aria-label="Client" value={clientId} onChange={e => { setClientId(e.target.value); setSiteId(""); }}>
                <option value="">Choose a client</option>
                {clients.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>)}
          {level === "site" && client && (
            <label className="field"><span>Site</span>
              <select aria-label="Site" value={siteId} onChange={e => setSiteId(e.target.value)}>
                <option value="">Choose a site</option>
                {client.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select></label>)}
        </div>
      </section>
      {endpoint ? <ListEditor key={endpoint} endpoint={endpoint} level={level} scopeId={scopeId} /> : <p className="muted">Choose {level === "client" ? "a client" : "a client and a site"} to see its list.</p>}
    </div>
  );
}

function ListEditor({ endpoint, level, scopeId }: { endpoint: string; level: Level; scopeId: string | null }) {
  const data = useLoad<{ own?: AppList | null; ownRejected?: boolean; fleet: AppList | null; fleetRejected?: boolean }>(endpoint);
  const own = level === "fleet" ? data.data?.fleet ?? null : data.data?.own ?? null;
  const rejected = (level === "fleet" ? data.data?.fleetRejected : data.data?.ownRejected) === true;
  const loaded = data.data !== undefined && data.data !== null;
  const [entries, setEntries] = useState<AppEntry[] | null>(null);
  const [draft, setDraft] = useState<AppEntry>({ key: "", kind: "application", name: "", path: "" });
  const [pending, setPending] = useState<AppEntry[] | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => { if (loaded) setEntries(own ? own.entries.map(toEntry) : null); }, [loaded, own?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const candidate: AppEntry = useMemo(() => ({ ...draft, key: entryKey(draft.name), ...(draft.kind === "service" ? { serviceName: draft.serviceName ?? "" } : { serviceName: undefined }) }), [draft]);
  const list = entries ?? [];
  const draftProblem = draft.name || draft.path ? entryProblem(candidate, list) : null;
  const changed = JSON.stringify(entries) !== JSON.stringify(own ? own.entries.map(toEntry) : null);
  const action = level === "fleet" ? "settings.apps" : `${level}.apps`;
  const body = (e: AppEntry[] | null) => ({ level, id: scopeId, entries: e === null ? null : e.map(x => x.kind === "service" ? x : { key: x.key, kind: x.kind, name: x.name, path: x.path }) });
  if (data.problem) return <p className="error" role="alert">{data.problem}</p>;
  if (!loaded) return <p className="muted">Loading…</p>;
  return (
    <section className="panel stack" aria-labelledby="apps-list">
      <h2 id="apps-list">{level === "fleet" ? "Fleet default" : level === "client" ? "This client's list" : "This site's list"}{" "}
        {entries === null ? <Badge tone="off">Not set</Badge> : <Badge tone="ok">{list.length} {list.length === 1 ? "program" : "programs"}</Badge>}</h2>
      {own && <p className="muted small">Version {own.version}, saved {fullTime(own.setAt)}.</p>}
      {rejected && <p className="notice warn" role="alert">The list stored here is damaged, so this level approves nothing until it is replaced. Add the programs again and save, or {level === "fleet" ? "approve nothing here" : "use the level above"}.</p>}
      {entries === null && !rejected && <p>{level === "fleet" ? "No fleet default: cabinets without a client or site list may not control any program." : <>Nothing set here, so the level above applies{data.data?.fleet && level === "client" ? <> (the fleet default: {data.data.fleet.entries.length} programs)</> : ""}.</>}</p>}
      {entries !== null && list.length === 0 && <p><strong>Approves nothing</strong> at this level, even if the level above has programs.</p>}
      {list.length > 0 && (
        <div className="table-wrap"><table>
          <caption className="sr-only">Approved programs</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Program</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
          <tbody>{list.map(e => (
            <tr key={e.key}><th scope="row">{e.name}</th><td>{e.kind === "service" ? <>Service <code>{e.serviceName}</code></> : "Application"}</td>
              <td><code className="wrap">{e.path}</code></td>
              <td><button className="btn small ghost" onClick={() => setEntries(list.filter(x => x.key !== e.key))}>Remove</button></td></tr>))}
          </tbody></table></div>)}
      <form className="stack" onSubmit={ev => { ev.preventDefault(); if (draftProblem === null && draft.name) { setEntries([...list, candidate]); setDraft({ key: "", kind: "application", name: "", path: "" }); } }}>
        <h3>Add a program</h3>
        <div className="row gap wrap">
          <label className="field"><span>Name</span><input value={draft.name} maxLength={59} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Scanner service" /></label>
          <label className="field"><span>Kind</span>
            <select aria-label="Kind" value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as AppEntry["kind"] })}>
              <option value="application">Application</option><option value="service">Windows service</option></select></label>
          {draft.kind === "service" && <label className="field"><span>Service key name</span><input value={draft.serviceName ?? ""} maxLength={80} onChange={e => setDraft({ ...draft, serviceName: e.target.value })} placeholder="BioScanSvc" /></label>}
        </div>
        <label className="field"><span>Full path to the program (.exe)</span><input value={draft.path} maxLength={260} onChange={e => setDraft({ ...draft, path: e.target.value })} placeholder="C:\Program Files\Vendor\scanner.exe" /></label>
        <div className="row gap wrap"><button className="btn" disabled={!draft.name || draftProblem !== null}>Add to the list</button>
          {draftProblem && <span className="error">{draftProblem}</span>}</div>
      </form>
      <div className="row gap wrap">
        <button className="btn primary" disabled={!changed} onClick={() => { setProblem(null); setSaved(null); setPending(entries); }}>Save</button>
        {entries === null && <button className="btn" onClick={() => setEntries([])}>Approve nothing here</button>}
        {(own !== null || rejected) && level !== "fleet" && <button className="btn ghost" onClick={() => { setProblem(null); setSaved(null); setPending(null); }}>Use the level above</button>}
        {changed && <button className="btn ghost" onClick={() => setEntries(own ? own.entries.map(toEntry) : null)}>Discard changes</button>}
        {saved && <span className="ok" role="status">{saved}</span>}
      </div>
      {problem && <p className="error" role="alert">{problem}</p>}
      <StepUpDialog open={pending !== undefined} action={action} target={level === "fleet" ? "fleet" : scopeId!} params={pending === undefined ? undefined : body(pending)}
        onClose={() => setPending(undefined)}
        description={<p>{pending === null ? "Remove this level's list, so the level above applies." : pending && pending.length === 0 ? "Approve no programs at this level." : `Approve exactly these ${pending?.length ?? 0} programs at this level. Cabinets use the list from their next heartbeat.`}</p>}
        onToken={async token => {
          try {
            await api("PUT", endpoint, { ...body(pending ?? null), stepUpToken: token });
            setSaved("Saved. Cabinets use it from their next heartbeat.");
            data.reload();
          } catch (e) { setProblem(describeError(e)); throw e; }
        }} />
    </section>
  );
}
