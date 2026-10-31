// Approved programs: the applications and services a cabinet may be asked to start, stop, restart or end (docs/spec/13-roadmap.md).
// One list per level: the fleet default, a client, a site, one cabinet. The most specific level with a list wins whole for a cabinet. Only an Admin
// changes a list, with an authenticator code bound to the exact entries; the server and the cabinet check every request against it.
import { useEffect, useMemo, useState } from "react";
import { api, ApiError, describeError } from "../../lib/api";
import { Breadcrumbs } from "../../components/Layout";
import { Badge, StepUpDialog } from "../../components/ui";
import { useLoad } from "../../lib/useLoad";
import { fullTime } from "../../lib/time";
import type { KnownClient } from "./Admin";
import { documentBytes, entryKey, entryProblem, readSignatureFile, toEntry, type AppEntry, type AppList } from "../../lib/approved-apps";
type Level = "fleet" | "client" | "site" | "cabinet";

export function ApprovedApps() {
  const clients = useLoad<KnownClient[]>("/api/admin/clients");
  const [level, setLevel] = useState<Level>("fleet");
  const [clientId, setClientId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [cabinetId, setCabinetId] = useState("");
  const client = clients.data?.find(c => c.id === clientId) ?? null;
  // A cabinet's own list exists mostly because a replacement copied it from the cabinet it replaced; it wins over every level above.
  const site = useLoad<{ cabinets: { id: string; name: string }[] }>(level === "cabinet" && siteId ? `/api/fleet/sites/${siteId}` : null);
  const scopeId = level === "client" ? clientId : level === "site" ? siteId : level === "cabinet" ? cabinetId : null;
  const table = { fleet: "", client: "clients", site: "sites", cabinet: "cabinets" }[level];
  const endpoint = level === "fleet" ? "/api/admin/approved-apps" : scopeId ? `/api/${table}/${scopeId}/approved-apps` : null;
  return (
    <div className="page narrow">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Approved programs" }]} />
      <h1>Approved programs</h1>
      <p className="muted">Programs and services the platform may start, stop, restart or end. Anything else is refused by the server and the cabinet. The most specific list applies: cabinet, then site, then client, then fleet.</p>
      <section className="panel">
        <div className="row gap wrap">
          <label className="field"><span>Set the list for</span>
            <select aria-label="Set the list for" value={level} onChange={e => { setLevel(e.target.value as Level); setSiteId(""); setCabinetId(""); }}>
              <option value="fleet">The whole fleet (default)</option>
              <option value="client">One client</option>
              <option value="site">One site</option>
              <option value="cabinet">One cabinet</option>
            </select></label>
          {level !== "fleet" && (
            <label className="field"><span>Client</span>
              <select aria-label="Client" value={clientId} onChange={e => { setClientId(e.target.value); setSiteId(""); setCabinetId(""); }}>
                <option value="">Choose a client</option>
                {clients.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>)}
          {(level === "site" || level === "cabinet") && client && (
            <label className="field"><span>Site</span>
              <select aria-label="Site" value={siteId} onChange={e => { setSiteId(e.target.value); setCabinetId(""); }}>
                <option value="">Choose a site</option>
                {client.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select></label>)}
          {level === "cabinet" && siteId && (
            <label className="field"><span>Cabinet</span>
              <select aria-label="Cabinet" value={cabinetId} onChange={e => setCabinetId(e.target.value)}>
                <option value="">Choose a cabinet</option>
                {site.data?.cabinets.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
              </select></label>)}
        </div>
        {/* The cabinet choice depends on this load, so its failure stays next to it with a way to try again. */}
        {level === "cabinet" && siteId && site.problem && (
          <div className="row gap wrap"><p className="error" role="alert">{site.problem}</p>
            <button className="btn small" onClick={site.reload}>Try again</button></div>)}
        {level === "cabinet" && site.data && site.data.cabinets.length === 0 && <p className="muted">This site has no cabinets.</p>}
      </section>
      {endpoint ? <ListEditor key={endpoint} endpoint={endpoint} level={level} scopeId={scopeId} /> : level === "cabinet" && siteId && (site.problem || site.data?.cabinets.length === 0) ? null : <p className="muted">Choose {level === "client" ? "a client" : level === "site" ? "a client and a site" : "a client, a site and a cabinet"} to see its list.</p>}
    </div>
  );
}

function ListEditor({ endpoint, level, scopeId }: { endpoint: string; level: Level; scopeId: string | null }) {
  const data = useLoad<{ own?: AppList | null; ownRejected?: boolean; ownPending?: AppList | null; fleet: AppList | null; fleetRejected?: boolean;
    fleetPending?: AppList | null; signing?: { enabled: boolean } }>(endpoint);
  const live = level === "fleet" ? data.data?.fleet ?? null : data.data?.own ?? null;
  const pendingList = (level === "fleet" ? data.data?.fleetPending : data.data?.ownPending) ?? null;
  const signingOn = data.data?.signing?.enabled === true;
  // The editor starts from the newest saved list: the change waiting for a signature when there is one, else the list in force.
  const own = pendingList ?? live;
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
      <h2 id="apps-list">{level === "fleet" ? "Fleet default" : level === "client" ? "This client's list" : level === "site" ? "This site's list" : "This cabinet's own list"}{" "}
        {entries === null ? <Badge tone="off">Not set</Badge> : <Badge tone="ok">{list.length} {list.length === 1 ? "program" : "programs"}</Badge>}</h2>
      {live && <p className="muted small">In force: version {live.version}, saved {fullTime(live.setAt)}.{signingOn && (live.signed ? " Signed." : " Not signed yet.")}</p>}
      {signingOn && <SigningPanel endpoint={endpoint} level={level} scopeId={scopeId} live={live} pending={pendingList} onChange={() => data.reload()} />}
      {level === "cabinet" && <p className="muted small">A cabinet usually has its own list only because it replaced another cabinet and took over that cabinet's list. While it has one, the site, client and fleet lists do not apply to it.</p>}
      {rejected && <p className="notice warn" role="alert">The stored list is damaged and approves nothing until replaced. Save a new list, or {level === "fleet" ? "approve nothing here" : "use the level above"}.</p>}
      {entries === null && !rejected && <p>{level === "fleet" ? "No fleet default: cabinets without a client or site list control no program." : <>Nothing set here, so the level above applies{data.data?.fleet && level === "client" ? <> (the fleet default: {data.data.fleet.entries.length} programs)</> : ""}.</>}</p>}
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
        {(live !== null || pendingList !== null || rejected) && level !== "fleet" && <button className="btn ghost" onClick={() => { setProblem(null); setSaved(null); setPending(null); }}>Use the level above</button>}
        {changed && <button className="btn ghost" onClick={() => setEntries(own ? own.entries.map(toEntry) : null)}>Discard changes</button>}
        {saved && <span className="ok" role="status">{saved}</span>}
      </div>
      {problem && <p className="error" role="alert">{problem}</p>}
      <StepUpDialog open={pending !== undefined} action={action} target={level === "fleet" ? "fleet" : scopeId!} params={pending === undefined ? undefined : body(pending)}
        onClose={() => setPending(undefined)}
        description={<p>{pending === null ? "Remove this level's list, so the level above applies." : pending && pending.length === 0 ? "Approve no programs at this level." : `Approve exactly these ${pending?.length ?? 0} programs at this level. ${signingOn ? "It goes into force once you sign it." : "Cabinets use the list from their next heartbeat."}`}</p>}
        onToken={async token => {
          try {
            await api("PUT", endpoint, { ...body(pending ?? null), stepUpToken: token });
            setSaved(signingOn && pending !== null ? "Saved. Sign it below to put it in force." : "Saved. Cabinets use it from their next heartbeat.");
            data.reload();
          } catch (e) { setProblem(describeError(e)); throw e; }
        }} />
    </section>
  );
}

/**
 * Signing (docs/spec/09-open-decisions.md "Signing the approved list"): the Admin downloads the exact document, signs it on their own
 * computer with Sign-ApprovedList.ps1, and uploads the signature file. The server checks it before the list goes into force.
 */
function SigningPanel({ endpoint, level, scopeId, live, pending, onChange }: { endpoint: string; level: Level; scopeId: string | null;
  live: AppList | null; pending: AppList | null; onChange: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = pending ?? (live && !live.signed ? live : null);
  if (!target) return live?.signed ? <p className="notice ok small">This list is signed. Cabinets that check signatures use it.</p> : null;

  async function download() {
    setProblem(null);
    try {
      const doc = await api<{ version: number; document: string; fileName: string }>("GET", `${endpoint}/to-sign`);
      const href = URL.createObjectURL(new Blob([documentBytes(doc.document)], { type: "application/octet-stream" }));
      const a = Object.assign(document.createElement("a"), { href, download: doc.fileName });
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch (e) { setProblem(describeError(e)); }
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    setProblem(null); setDone(null);
    const read = readSignatureFile(await file.text());
    if (!read.ok) { setProblem(read.problem); return; }
    setBusy(true);
    try {
      await api("POST", `${endpoint}/signature`, { level, id: scopeId, version: target!.version, signature: read.signature });
      setDone(`Signed. Version ${target!.version} is in force; cabinets use it from their next heartbeat.`);
      onChange();
    } catch (e) {
      // The two refusals an Admin can act on, said plainly; anything else is the platform's usual explanation.
      if (e instanceof ApiError && e.code === "signature_invalid")
        setProblem("The signature does not verify for this list. Sign the file you downloaded for this version, with the list-signing key, and upload what the script wrote.");
      else if (e instanceof ApiError && e.code === "conflict")
        setProblem("This version is no longer waiting for a signature (the list was changed or signed meanwhile). Download it again.");
      else setProblem(describeError(e));
      onChange();
    }
    finally { setBusy(false); }
  }
  async function discard() {
    setProblem(null);
    try { await api("POST", `${endpoint}/pending/discard`, {}); onChange(); }
    catch (e) { setProblem(describeError(e)); }
  }
  return (
    <div className="notice warn stack" role="region" aria-label="Waiting for a signature">
      <p><strong>{pending ? `Version ${target.version} is waiting for your signature.` : `Version ${target.version} is not signed.`}</strong>{" "}
        {pending ? "It is not in force until it is signed; the list above stays in force." : "Cabinets that check signatures approve nothing from it until it is signed."}</p>
      <ol className="small">
        <li><button className="btn small" onClick={download}>Download the list to sign</button></li>
        <li>On your computer, run <code>Sign-ApprovedList.ps1 -ListFile &lt;the file&gt;</code> with your list-signing key.</li>
        <li><label className="field inline"><span>Upload the signature file</span>
          <input type="file" accept=".json,application/json" disabled={busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = ""; }} /></label></li>
      </ol>
      {pending && <div><button className="btn small ghost" onClick={discard}>Discard this change</button></div>}
      {done && <p className="ok" role="status">{done}</p>}
      {problem && <p className="error" role="alert">{problem}</p>}
    </div>
  );
}
