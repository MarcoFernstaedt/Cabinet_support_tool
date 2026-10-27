// Admin home, pending cabinets, installing a cabinet and the scanner default. The other admin screens are in their own files.
import { PolicyEditor, type Policy } from "../../components/FirewallPolicy";
import { useEffect, useMemo, useState } from "react";
import { PortsEditor, ScannerIdsEditor } from "../../components/DeviceSettings";
import { api, describeError } from "../../lib/api";
import { Link } from "../../lib/router";
import { fullTime } from "../../lib/time";
import { Breadcrumbs } from "../../components/Layout";
import { Empty, KeyValues, StepUpDialog } from "../../components/ui";
import { useLoad } from "../../lib/useLoad";
import { WatchListEditor } from "../cabinet/Services";
import { TimeZoneEditor } from "../Fleet";
import { InstallAgent, type SetupState } from "./Setup";
import type { SyncCabinetRef } from "../../components/SyncCabinets";
import { choiceFrom, EMPTY_FIELDS, ScannerServiceFields, type ScannerFields } from "../../components/ClientScanner";
import { BaselineFields, useBaselinePreview } from "../../components/ApprovalBaseline";
import { decisionFrom, inForceText, type BaselineChoice } from "../../lib/approval-baseline";
import { SitePolicyFieldset, useSitePolicyPreview } from "../../components/ApprovalSitePolicies";
import { sitePoliciesFrom, type SitePolicyFields } from "../../lib/site-policies";
import { describePolicy } from "../../components/FirewallPolicy";
import { zoneName } from "../cabinet/Time";
import { replaceable, replacementSentence, replacesFrom, type SiteCabinet } from "../../lib/replacement";

export function AdminHome() {
  const { data } = useLoad<unknown[]>("/api/admin/enrollments");
  return (
    <div className="page">
      <h1>Admin</h1>
      <ul className="tiles">
        <li><Link to="/admin/setup"><strong>Setup</strong><span>Team, agent, install</span></Link></li>
        <li><Link to="/fixes"><strong>Known fixes</strong><span>Review saved fixes</span></Link></li>
        <li><Link to="/admin/security"><strong>Security alerts</strong><span>Security events</span></Link></li>
        <li><Link to="/admin/users"><strong>Users</strong><span>Accounts and roles</span></Link></li>
        <li><Link to="/admin/online"><strong>Online now</strong><span>Active sessions</span></Link></li>
        <li><Link to="/admin/audit"><strong>Audit log</strong><span>Search and verify</span></Link></li>
        <li><Link to="/admin/safety"><strong>Fleet safety</strong><span>Pause and resume changes</span></Link></li>
        <li><Link to="/admin/pending"><strong>Pending cabinets</strong><span>{data ? `${data.length} waiting` : "Approve or reject"}</span></Link></li>
        <li><Link to="/admin/tokens"><strong>Install a cabinet</strong><span>Agent packages and installers</span></Link></li>
        <li><Link to="/admin/clients"><strong>Clients and sites</strong><span>Clients and sites</span></Link></li>
        <li><Link to="/admin/issues"><strong>Issue types and suppressions</strong><span>Types and suppressions</span></Link></li>
        <li><Link to="/admin/baselines"><strong>Baselines</strong><span>How cabinets should be set up</span></Link></li>
        <li><Link to="/admin/software"><strong>Software library</strong><span>Packages</span></Link></li>
        <li><Link to="/admin/upgrades"><strong>Agent upgrades</strong><span>Releases and rollouts</span></Link></li>
        <li><Link to="/admin/scanner"><strong>Device defaults</strong><span>Scanner IDs, sync ports</span></Link></li>
        <li><Link to="/admin/approved-apps"><strong>Approved programs</strong><span>What may be started or stopped</span></Link></li>
        <li><Link to="/admin/health"><strong>System health</strong><span>Database, disk, backup, counters</span></Link></li>
        <li><Link to="/admin/settings"><strong>Settings</strong><span>Timeouts, retention, 2FA</span></Link></li>
      </ul>
    </div>
  );
}

export interface Pending { id: string; createdAt: string; sourceAddress: string | null;
  fingerprints: { hostname: string; serialNumber: string | null; macAddresses: string[]; osVersion: string; agentVersion: string; onlineSince: string }; }

export function PendingCabinets() {
  const { data, problem, reload } = useLoad<Pending[]>("/api/admin/enrollments");
  const clients = useLoad<KnownClient[]>("/api/admin/clients");
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Pending cabinets" }]} />
      <h1>Pending cabinets</h1>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && data.length === 0 && <Empty>No cabinets are waiting. A cabinet appears here after its installer has run.</Empty>}
      {data?.map(p => <PendingCard key={p.id} p={p} clients={clients.data ?? []} onDone={reload} />)}
    </div>
  );
}

export interface KnownClient { id: string; name: string; sites: { id: string; name: string }[] }

/** Whether a typed name is an existing one, the same name in other letters (likely a typo), or new. */
function known(name: string, names: string[]): { exact: boolean; near: string | null } {
  const t = name.trim();
  if (names.includes(t)) return { exact: true, near: null };
  return { exact: false, near: names.find(n => n.toLowerCase() === t.toLowerCase()) ?? null };
}


export function PendingCard({ p, clients, onDone }: { p: Pending; clients: KnownClient[]; onDone: () => void }) {
  const [form, setForm] = useState({ client: "", site: "", cabinet: p.fingerprints.hostname, role: "standalone", syncCabinetId: "", replacesCabinetId: "" });
  // Approving with a name that does not exist creates that client or site, so existing ones are offered and a new one is said out loud.
  const client = known(form.client, clients.map(c => c.name));
  const knownClient = clients.find(c => c.name === form.client.trim());
  const sites = knownClient?.sites.map(s => s.name) ?? [];
  const site = known(form.site, sites);
  const lists = `pending-${p.id}`;
  const [confirm, setConfirm] = useState<"approve" | "reject" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // A satellite reaches one of its site's sync cabinets: offer the ones the site has. With one, it is used without asking; with several,
  // the choice is required; with none, the satellite is approved as incomplete. Reading the list is not a permission check: the server
  // decides whether the approval is allowed.
  const siteId = knownClient?.sites.find(s => s.name === form.site.trim())?.id;
  const [syncCabinets, setSyncCabinets] = useState<SyncCabinetRef[] | null>(null);
  // The site's cabinets, for "this replaces": a failed drive reinstalled gets a new agent, and the approval says which cabinet it was.
  const [siteCabinets, setSiteCabinets] = useState<SiteCabinet[]>([]);
  useEffect(() => {
    setSyncCabinets(null);
    setSiteCabinets([]);
    if (!siteId) return;
    let live = true;
    void api<{ sync: { syncCabinets: SyncCabinetRef[] }; cabinets: SiteCabinet[] }>("GET", `/api/fleet/sites/${siteId}`)
      .then(r => { if (live) { setSyncCabinets(r.sync.syncCabinets); setSiteCabinets(r.cabinets); } })
      .catch(() => undefined);
    return () => { live = false; };
  }, [siteId]);
  const candidates = useMemo(() => replaceable(siteCabinets, form.role), [siteCabinets, form.role]);
  const replacing = candidates.find(c => c.id === form.replacesCabinetId) ?? null;
  // A new client chooses whether it uses a fingerprint scanner; an existing client keeps its own setting (changed on its page).
  const [scannerUse, setScannerUse] = useState<"used" | "not_used">("used");
  const [scannerFields, setScannerFields] = useState<ScannerFields>(EMPTY_FIELDS);
  const newClient = form.client.trim() !== "" && !client.exact;
  const scannerChoice = !newClient ? null : scannerUse === "not_used" ? { enabled: false } : choiceFrom(scannerFields);
  // The baseline decision every approval needs: the one in force by default, else the approver's choice.
  const [baselineChoice, setBaselineChoice] = useState<BaselineChoice>("");
  const [attachId, setAttachId] = useState("");
  const baselineState = useBaselinePreview(p.id, form.client, form.site, setBaselineChoice);
  const baselinePreview = baselineState.preview;
  const decision = baselinePreview ? decisionFrom(baselineChoice, attachId) : null;
  // A new site's policies: pre-filled from what it would inherit; the approver keeps that or sets the site's own.
  const [siteFields, setSiteFields] = useState<SitePolicyFields>({ firewallOwn: false, firewall: { domain: "off", private: "off", public: "off" }, timeZone: "" });
  const siteState = useSitePolicyPreview(p.id, form.client, form.site, setSiteFields);
  const sitePolicies = sitePoliciesFrom(siteState.preview, siteFields);
  const choices = syncCabinets ?? [];
  // A satellite that replaces another keeps the sync cabinet the old one reached, so it is not asked.
  const keepsLink = form.role === "satellite" && !!replacing;
  const chosen = keepsLink ? "" : choices.length === 1 ? choices[0]!.id : form.syncCabinetId;
  const needsChoice = form.role === "satellite" && !keepsLink && choices.length > 1 && !form.syncCabinetId;
  // Exactly what is sent, and therefore exactly what the step-up token is bound to: no extra fields the contract refuses.
  const approval = useMemo(() => ({
    client: form.client, site: form.site, cabinet: form.cabinet, role: form.role,
    ...(form.role === "satellite" && chosen ? { syncCabinetId: chosen } : {}),
    ...replacesFrom(form.replacesCabinetId, candidates),
    ...(scannerChoice ? { scanner: scannerChoice } : {}),
    ...(sitePolicies ? { sitePolicies } : {}),
    baseline: decision,
  }), [form, chosen, candidates, scannerChoice, decision, sitePolicies?.firewall?.domain, sitePolicies?.firewall?.private, sitePolicies?.firewall?.public, sitePolicies?.timeZone, !!sitePolicies]);
  const reaches = choices.find(c => c.id === chosen);
  return (
    <section className="panel" aria-label={`Request from ${p.fingerprints.hostname}`}>
      <h2>{p.fingerprints.hostname}</h2>
      <KeyValues rows={[["Requested", fullTime(p.createdAt)], ["From address", p.sourceAddress], ["Serial number", p.fingerprints.serialNumber],
        ["MAC addresses", p.fingerprints.macAddresses.join(", ") || null], ["Windows", p.fingerprints.osVersion], ["Agent version", p.fingerprints.agentVersion],
        ["Running since", fullTime(p.fingerprints.onlineSince)], ["Request ID", <code>{p.id}</code>]]} />
      {done ? <p className="ok" role="status">{done}</p> : (
        <form className="row gap wrap" onSubmit={e => { e.preventDefault(); setProblem(null); setConfirm("approve"); }}>
          <label className="field"><span>Client</span><input required maxLength={128} placeholder="e.g. Mashura Office" list={`${lists}-clients`} value={form.client} onChange={e => setForm(f => ({ ...f, client: e.target.value }))} /></label>
          <datalist id={`${lists}-clients`}>{clients.map(c => <option key={c.id} value={c.name} />)}</datalist>
          <label className="field"><span>Site</span><input required maxLength={128} placeholder="e.g. Support desk" list={`${lists}-sites`} value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} /></label>
          <datalist id={`${lists}-sites`}>{sites.map(n => <option key={n} value={n} />)}</datalist>
          <label className="field"><span>Cabinet name</span><input required maxLength={128} value={form.cabinet} onChange={e => setForm(f => ({ ...f, cabinet: e.target.value }))} /></label>
          <label className="field"><span>Role</span><select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
            <option value="sync">Sync</option><option value="satellite">Satellite</option><option value="standalone">Standalone</option></select></label>
          {candidates.length > 0 && (
            <label className="field"><span>Replaces</span>
              <select value={replacing?.id ?? ""} onChange={e => {
                const old = candidates.find(c => c.id === e.target.value);
                // Replacing usually keeps the old name: offered, and still editable.
                setForm(f => ({ ...f, replacesCabinetId: e.target.value, ...(old ? { cabinet: old.name } : {}) }));
              }}>
                <option value="">Nothing: a new cabinet</option>
                {candidates.map(c => <option key={c.id} value={c.id}>{c.name}{c.online ? "" : c.lastHeartbeatAt ? ` (not heard from since ${fullTime(c.lastHeartbeatAt)})` : " (never connected)"}</option>)}
              </select></label>
          )}
          {replacing && <span className="muted small">{replacing.name} is retired and its settings are copied to this cabinet. Its history stays on its page.</span>}
          {form.role === "satellite" && !keepsLink && choices.length > 1 && (
            <label className="field"><span>Sync cabinet</span>
              <select required value={form.syncCabinetId} onChange={e => setForm(f => ({ ...f, syncCabinetId: e.target.value }))}>
                <option value="">Choose</option>
                {choices.map(c => <option key={c.id} value={c.id}>{c.name}{c.address ? ` (${c.address})` : ""}</option>)}
              </select></label>
          )}
          {form.role === "satellite" && !keepsLink && (
            <span className="muted small">
              {choices.length === 1 ? <>Reaches <strong>{choices[0]!.name}</strong>, the site&apos;s sync cabinet.</>
                : choices.length === 0 ? <>No sync cabinet at this site yet: the satellite is approved as incomplete and linked when one is approved.</>
                : <>This site has {choices.length} sync cabinets.</>}
            </span>
          )}
          {form.role === "sync" && (
            <span className="muted small">Satellites at this site reach it at the address it reports. A site may have several sync cabinets.</span>
          )}
          {newClient && (
            <fieldset className="row gap wrap">
              <legend>Fingerprint scanner at {form.client.trim()}</legend>
              <label className="field"><span>Scanner</span>
                <select value={scannerUse} onChange={e => setScannerUse(e.target.value as "used" | "not_used")}>
                  <option value="used">Used</option><option value="not_used">Not used</option></select></label>
              {scannerUse === "used" && <ScannerServiceFields fields={scannerFields} onChange={setScannerFields} idPrefix={`pending-${p.id}-scanner`} />}
              {scannerUse === "used" && !scannerChoice && <span className="muted small">Leave the service empty to set it up later on the client&apos;s page.</span>}
            </fieldset>
          )}
          <SitePolicyFieldset name={lists} site={form.site.trim()} state={siteState} fields={siteFields} onChange={setSiteFields} />
          <BaselineFields name={lists} state={baselineState} filled={!!form.client.trim() && !!form.site.trim()} choice={baselineChoice} onChoice={setBaselineChoice} attachId={attachId} onAttach={setAttachId} />
          <button className="btn primary" data-tour="approve-cabinet" disabled={!!client.near || !!site.near || needsChoice || !decision || (!!form.site.trim() && !siteState.preview && !siteState.problem && !!form.client.trim()) || !!siteState.problem}>Approve</button>
          {baselinePreview && !decision && <span className="muted small">Choose a baseline to approve.</span>}
          {client.near && <span className="error">There is already a client named "{client.near}". Use that name, or a clearly different one.</span>}
          {site.near && <span className="error">{form.client.trim()} already has a site named "{site.near}".</span>}
          <button type="button" className="btn danger" onClick={() => { setProblem(null); setConfirm("reject"); }}>Reject</button>
        </form>)}
      {problem && <p className="error" role="alert">{problem}</p>}
      <StepUpDialog open={confirm !== null} action={confirm === "reject" ? "enrollment.reject" : "enrollment.approve"} target={p.id} onClose={() => setConfirm(null)}
        params={confirm === "reject" ? undefined : approval}
        description={confirm === "reject" ? <p>Reject the request from <strong>{p.fingerprints.hostname}</strong>. It will need a new installer to try again.</p>
          : <p>Approve <strong>{p.fingerprints.hostname}</strong> as <strong>{form.cabinet}</strong> ({form.role}) at <strong>{form.client} / {form.site}</strong>.
            {!client.exact && <> This creates the new client <strong>{form.client.trim()}</strong>.</>}
            {client.exact && !site.exact && <> This creates the new site <strong>{form.site.trim()}</strong>.</>}
            {newClient && (scannerUse === "not_used" ? <> It does not use a fingerprint scanner.</>
              : scannerChoice?.enabled ? <> Its scanner service <strong>{scannerChoice.service!.serviceName}</strong> is added to the approved programs and watched.</> : null)}
            {replacing && <> {replacementSentence(replacing, form.cabinet)}</>}
            {form.role === "satellite" && !keepsLink && (reaches ? <> It reaches <strong>{reaches.name}</strong>.</> : <> It stays incomplete until a sync cabinet is assigned.</>)}
            {sitePolicies && <> The new site uses {sitePolicies.firewall ? <>its own firewall policy (<strong>{describePolicy(sitePolicies.firewall)}</strong>)</> : <>{siteState.preview?.firewall.source === "client" ? "the client's" : "the fleet's"} firewall policy</>}
              {" "}and {sitePolicies.timeZone ? <>the time zone <strong>{zoneName(sitePolicies.timeZone)}</strong></> : siteState.preview?.timeZone.zone ? <>the inherited time zone</> : <>no time zone</>}.</>}
            {" "}Baseline: {decision?.use === "inherited" ? inForceText(baselinePreview?.inForce ?? [])
              : decision?.use === "attach" ? <>attach <strong>{baselinePreview?.choices.find(c => c.versionId === attachId)?.name ?? "the chosen baseline"}</strong> to this site</>
              : "capture this cabinet's configuration as the site baseline draft"}.
            {" "}It receives its certificate on its next check-in.</p>}
        onToken={async token => {
          try {
            if (confirm === "reject") { await api("POST", `/api/admin/enrollments/${p.id}/reject`, { stepUpToken: token }); setDone("Rejected."); }
            else { await api("POST", `/api/admin/enrollments/${p.id}/approve`, { ...approval, stepUpToken: token }); setDone(`Approved. ${form.cabinet} will come online within a minute.${replacing ? ` ${replacing.name} is retired.` : ""}${decision?.use === "capture" ? " It shows Baseline required until the site's baseline draft from it is approved." : ""}`); }
            setTimeout(onDone, 1500);
          } catch (e) { setProblem(describeError(e)); }
        }} />
    </section>
  );
}

/** The install step of Setup on its own page, for installing more cabinets later. */
export function InstallTokens() {
  const state = useLoad<SetupState>("/api/admin/setup");
  return (
    <div className="page narrow">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Install a cabinet" }]} />
      <h1>Install a cabinet</h1>
      {state.problem && <p className="error" role="alert">{state.problem}</p>}
      {state.data && <section className="panel"><InstallAgent setup={state.data} /></section>}
      <p className="muted">New cabinets wait under <Link to="/admin/pending">Pending cabinets</Link> for approval.</p>
    </div>
  );
}

export function ScannerDefault() {
  const scanner = useLoad<{ hardwareIds: string[] | null }>("/api/settings/scanner");
  const firewall = useLoad<{ policy: Policy }>("/api/admin/firewall-policy");
  const zone = useLoad<{ timeZone: string | null }>("/api/settings/time-zone");
  const ports = useLoad<{ ports: number[] | null }>("/api/settings/sync-ports");
  const watched = useLoad<{ names: string[] | null }>("/api/admin/watched-services");
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Device defaults" }]} />
      <h1>Device defaults</h1>
      <section className="panel" aria-labelledby="fleet-scanner">
        <h2 id="fleet-scanner">Fingerprint scanner</h2>
        {scanner.data && <ScannerIdsEditor label="Fleet default scanner IDs" current={scanner.data.hardwareIds}
          inherited="cabinets find the scanner automatically (the Biometric device)." endpoint="/api/settings/scanner" action="settings.scanner" target="fleet"
          what="every cabinet without its own setting" editable onSaved={scanner.reload} />}
      </section>
      <section className="panel" aria-labelledby="fleet-ports">
        <h2 id="fleet-ports">Sync cabinet ports</h2>
        {ports.data && <PortsEditor current={ports.data.ports} inherited="no ports are set, so sync tests use ping and DNS only."
          endpoint="/api/settings/sync-ports" action="settings.sync" target="fleet" what="every site without its own or its client's ports" editable onSaved={ports.reload} />}
      </section>
      <section className="panel" aria-labelledby="fleet-firewall">
        <h2 id="fleet-firewall">Firewall policy (fleet default)</h2>
        {firewall.data && <PolicyEditor current={firewall.data.policy} inherited={null} endpoint="/api/admin/firewall-policy" action="fleet.firewall_policy" target="fleet"
          what="the fleet" editable onSaved={firewall.reload} />}
      </section>
      {zone.data && <TimeZoneEditor id="fleet-tz" heading="Time zone (fleet default)" endpoint="/api/settings/time-zone" current={zone.data.timeZone} inherited={null}
        what="sites whose client sets none either" editable onSaved={zone.reload} />}
      <section className="panel" aria-labelledby="fleet-watched">
        <h2 id="fleet-watched">Watched services (fleet default)</h2>
        {watched.data && <WatchListEditor endpoint="/api/admin/watched-services" own={watched.data.names} inherited="no services are watched."
          what="every cabinet without its own list" editable onSaved={watched.reload} />}
      </section>
    </div>
  );
}
