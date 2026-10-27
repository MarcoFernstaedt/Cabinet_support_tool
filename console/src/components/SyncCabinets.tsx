// Sync cabinets and satellites (docs/spec/05-server-spec.md "Sync cabinets and satellites"). A site may have several sync cabinets;
// each satellite reaches the one it is linked to. A sync cabinet's address comes from its own report unless an Admin set one.
// The server checks every assignment and address; these controls only collect what an Admin chose.
import { useState } from "react";
import { api } from "../lib/api";
import { Link } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { PORTS_SOURCE, PortsEditor } from "./DeviceSettings";
import { useStepUp } from "./StepUp";
import { Badge } from "./ui";

export type AddressSource = "reported" | "admin" | null;
export interface SyncCabinetRef { id: string; name: string; address: string | null; addressSource: AddressSource }
export type CabinetSync =
  | { role: "satellite"; state: "linked" | "unassigned" | "address_needed"; syncCabinet: SyncCabinetRef | null }
  | { role: "sync"; address: string | null; addressSource: AddressSource; satellites: number }
  | { role: "standalone" };
export interface SiteSyncInfo {
  ports: number[] | null; effectivePorts: number[]; portsSource: string;
  syncCabinets: (SyncCabinetRef & { satellites: number })[]; unassignedSatellites: number;
}

const SOURCE_TEXT: Record<string, string> = { reported: "reported by the cabinet", admin: "set by an Admin" };
const PRIVATE = ["10.", "192.168."];
/** The client-side shape check, so an obvious typo is caught before the code is asked for. The server decides. */
const looksPrivate = (a: string) => {
  const parts = a.split(".");
  if (parts.length !== 4 || parts.some(p => p === "" || String(Number(p)) !== p || Number(p) > 255)) return false;
  const second = Number(parts[1]);
  return PRIVATE.some(p => a.startsWith(p)) || (a.startsWith("172.") && second >= 16 && second <= 31);
};

export function addressText(address: string | null, source: AddressSource) {
  return address ? <><code>{address}</code> <span className="muted small">({SOURCE_TEXT[source ?? ""] ?? "unknown source"})</span></> : <span className="muted">Not reported yet</span>;
}

/** The site's sync cabinets, how many satellites wait for one, and the site's ports (Admin, with a code). */
export function SiteSync({ siteId, name, sync, editable, onSaved }: { siteId: string; name: string; sync: SiteSyncInfo; editable: boolean; onSaved: () => void }) {
  return (
    <section className="panel" aria-labelledby="site-sync-heading">
      <h2 id="site-sync-heading">Sync cabinets at {name}</h2>
      {sync.syncCabinets.length === 0 ? <p className="muted">No sync cabinet. Satellites here stay incomplete until one is approved or assigned.</p> : (
        <div className="table-wrap"><table className="table">
          <caption className="sr-only">Sync cabinets at {name}</caption>
          <thead><tr><th scope="col">Sync cabinet</th><th scope="col">Address</th><th scope="col">Satellites</th></tr></thead>
          <tbody>{sync.syncCabinets.map(c => (
            <tr key={c.id}><th scope="row"><Link to={`/cabinets/${c.id}`}>{c.name}</Link></th><td>{addressText(c.address, c.addressSource)}</td><td>{c.satellites}</td></tr>))}
          </tbody>
        </table></div>)}
      {sync.unassignedSatellites > 0 && <p><Badge tone="warn">Enrollment incomplete</Badge> {sync.unassignedSatellites === 1 ? "1 satellite has" : `${sync.unassignedSatellites} satellites have`} no sync cabinet assigned.</p>}
      <h3>Ports</h3>
      <p className="muted small">In use: <strong>{sync.effectivePorts.length ? sync.effectivePorts.join(", ") : "none"}</strong> (from {PORTS_SOURCE[sync.portsSource] ?? sync.portsSource}).</p>
      <PortsEditor key={siteId} current={sync.ports} inherited="the client's ports apply, else the fleet default."
        endpoint={`/api/sites/${siteId}/sync`} action="site.sync" target={siteId} what={`every satellite at ${name}`} editable={editable} onSaved={onSaved} />
    </section>
  );
}

/** One line for the cabinet's details: what it reaches (a satellite) or what its satellites reach (a sync cabinet), with the Admin's controls. */
export function CabinetSyncLine({ cabinet, sync, admin, onChanged }: {
  cabinet: { id: string; name: string; site: { id: string } }; sync: CabinetSync | null; admin: boolean; onChanged: () => void;
}) {
  if (!sync || sync.role === "standalone") return <span className="muted">Not used by a standalone cabinet</span>;
  if (sync.role === "sync") return <SyncAddress cabinet={cabinet} sync={sync} admin={admin} onChanged={onChanged} />;
  return <SatelliteLink cabinet={cabinet} sync={sync} admin={admin} onChanged={onChanged} />;
}

function SatelliteLink({ cabinet, sync, admin, onChanged }: {
  cabinet: { id: string; name: string; site: { id: string } }; sync: Extract<CabinetSync, { role: "satellite" }>; admin: boolean; onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const site = useLoad<{ sync: SiteSyncInfo }>(editing ? `/api/fleet/sites/${cabinet.site.id}` : null);
  const [choice, setChoice] = useState(sync.syncCabinet?.id ?? "");
  const step = useStepUp();
  const current = sync.syncCabinet;
  const options = site.data?.sync.syncCabinets ?? [];
  const label = (id: string) => options.find(o => o.id === id)?.name ?? "none";
  return (
    <span className="stack">
      {current ? <span><Link to={`/cabinets/${current.id}`}>{current.name}</Link> at {addressText(current.address, current.addressSource)}</span>
        : <span><Badge tone="warn">Enrollment incomplete</Badge> No sync cabinet assigned.</span>}
      {admin && !editing && <span><button className="btn small" onClick={() => setEditing(true)}>{current ? "Change" : "Assign"}</button></span>}
      {admin && editing && (
        <span className="row gap wrap">
          <label className="sr-only" htmlFor="sync-cabinet-choice">Sync cabinet</label>
          <select id="sync-cabinet-choice" value={choice} onChange={e => setChoice(e.target.value)}>
            <option value="">None (incomplete)</option>
            {options.map(o => <option key={o.id} value={o.id}>{o.name}{o.address ? ` (${o.address})` : ""}</option>)}
          </select>
          <button className="btn small primary" disabled={choice === (current?.id ?? "")}
            onClick={() => step.ask("cabinet.sync_cabinet", cabinet.id,
              <p>{choice ? <>Assign <strong>{cabinet.name}</strong> to <strong>{label(choice)}</strong>.</> : <>Unassign <strong>{cabinet.name}</strong>. Its enrollment stays incomplete until it is assigned again.</>}</p>,
              async t => { await api("PUT", `/api/admin/cabinets/${cabinet.id}/sync-cabinet`, { syncCabinetId: choice || null, stepUpToken: t }); setEditing(false); onChanged(); },
              { syncCabinetId: choice || null })}>Save</button>
          <button className="btn small" onClick={() => setEditing(false)}>Cancel</button>
          {options.length === 0 && site.data && <span className="muted small">This site has no sync cabinet.</span>}
        </span>)}
      {step.dialog}
    </span>
  );
}

function SyncAddress({ cabinet, sync, admin, onChanged }: {
  cabinet: { id: string; name: string }; sync: Extract<CabinetSync, { role: "sync" }>; admin: boolean; onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState(sync.addressSource === "admin" ? sync.address ?? "" : "");
  const step = useStepUp();
  const save = (next: string | null) => step.ask("cabinet.sync_address", cabinet.id,
    <p>{next ? <>Set the address satellites use to reach <strong>{cabinet.name}</strong> to <strong>{next}</strong>. Reports from the cabinet no longer change it.</>
      : <>Use the address <strong>{cabinet.name}</strong> reports, and follow it when it changes.</>}</p>,
    async t => { await api("PUT", `/api/admin/cabinets/${cabinet.id}/sync-address`, { address: next, stepUpToken: t }); setEditing(false); onChanged(); },
    { address: next });
  const valid = looksPrivate(address);
  return (
    <span className="stack">
      <span>{addressText(sync.address, sync.addressSource)} · {sync.satellites === 1 ? "1 satellite" : `${sync.satellites} satellites`}</span>
      {admin && !editing && <span className="row gap">
        <button className="btn small" onClick={() => setEditing(true)}>Set address</button>
        {sync.addressSource === "admin" && <button className="btn small" onClick={() => save(null)}>Use reported address</button>}
      </span>}
      {admin && editing && (
        <form className="row gap wrap" onSubmit={e => { e.preventDefault(); if (valid) save(address); }}>
          <label className="field inline"><span>Private IPv4 address</span>
            <input inputMode="decimal" maxLength={15} value={address} placeholder="e.g. 10.20.0.15" onChange={e => setAddress(e.target.value.trim())} /></label>
          <button className="btn small primary" disabled={!valid}>Save</button>
          <button type="button" className="btn small" onClick={() => setEditing(false)}>Cancel</button>
          {address && !valid && <span className="error">A private IPv4 address: 10.x.x.x, 172.16-31.x.x or 192.168.x.x.</span>}
        </form>)}
      {step.dialog}
    </span>
  );
}
