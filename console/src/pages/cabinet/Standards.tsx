// A cabinet's standards: every setting that says what "right" looks like for it (firewall policy, network baseline, time zone, sync cabinet, scanner,
// watched services), with what it is meant to be, where that comes from (cabinet, site, client or the fleet default) and what the cabinet reports.
// Click a line to open it: the standard at every level, the cabinet's own value, and the editor for each level the signed-in person may change.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLoad } from "../../lib/useLoad";
import { atLeast, useSession } from "../../lib/session";
import { Badge } from "../../components/ui";
import { describePolicy, type Policy } from "../../components/FirewallPolicy";
import { ScannerIdsEditor } from "../../components/DeviceSettings";
import { ClientFirewallPolicy, SiteNetwork, SiteTimeZone, SyncSettings, WatchedServices, type SiteDetail } from "../Fleet";
import { zoneName, type CabinetTime } from "./Time";
import { Link } from "../../lib/router";
import type { CabinetDetail } from "./CabinetPage";

interface CabinetPolicy { policy: Policy; source: "client" | "fleet"; reported: Record<"domain" | "private" | "public", boolean> | null; differs: boolean | null; readOnly: boolean | null }
interface WatchLevels { cabinet: string[] | null; site: string[] | null; client: string[] | null; fleet: string[] | null; effective: string[]; source: string }
interface Reading { adapters: { connected: boolean; ipv4: { dhcp: boolean; addresses: { address: string; prefixLength: number }[]; gateways: string[] }; dns: { servers: string[] } }[] }
type State = "matches" | "differs" | "unknown" | "unset";
interface Line { key: string; label: string; standard: ReactNode; source: string; actual: ReactNode; state: State; detail: ReactNode }

const SOURCE: Record<string, string> = { cabinet: "This cabinet", site: "The site", client: "The client", fleet: "Fleet default", automatic: "Automatic", none: "Not set" };
const STATE: Record<State, { text: string; tone: "ok" | "warn" | "off" | "info" }> = {
  matches: { text: "Matches", tone: "ok" }, differs: { text: "Differs", tone: "warn" }, unknown: { text: "Not read", tone: "info" }, unset: { text: "Not set", tone: "off" } };

const profiles = (r: Record<string, boolean>) => (["domain", "private", "public"] as const).map(k => `${k[0]!.toUpperCase()}${k.slice(1)} ${r[k] ? "on" : "off"}`).join(", ");

export function Standards({ cabinet, onChanged }: { cabinet: CabinetDetail; onChanged: () => void }) {
  const { me } = useSession();
  const site = useLoad<SiteDetail>(`/api/fleet/sites/${cabinet.site.id}`);
  const fw = useLoad<CabinetPolicy>(`/api/cabinets/${cabinet.id}/firewall-policy`);
  const time = useLoad<CabinetTime>(`/api/cabinets/${cabinet.id}/time`);
  const watched = useLoad<WatchLevels>(`/api/cabinets/${cabinet.id}/watched-services`);
  const base = useLoad<{ scopes: { kind: string; name: string; version: number; baselineId: string }[] }>(`/api/cabinets/${cabinet.id}/baseline`);
  const cond = useLoad<{ state: string; reasons: { text: string }[] }>(`/api/cabinets/${cabinet.id}/condition`);
  const diagnosis = useLoad<{ latest: { readings?: Reading } | null }>(`/api/cabinets/${cabinet.id}/diagnose/network`);
  const [open, setOpen] = useState<string | null>(null);
  const reloadAll = () => { site.reload(); fw.reload(); time.reload(); watched.reload(); diagnosis.reload(); base.reload(); cond.reload(); onChanged(); };
  const s = site.data;

  const lines: Line[] = [];
  if (fw.data) lines.push({
    key: "firewall", label: "Firewall policy", standard: describePolicy(fw.data.policy), source: SOURCE[fw.data.source]!,
    actual: fw.data.reported ? profiles(fw.data.reported) : "Not reported yet", state: fw.data.differs === null ? "unknown" : fw.data.differs ? "differs" : "matches",
    detail: <>
      <p>Windows Firewall profiles on this cabinet are meant to be: <strong>{describePolicy(fw.data.policy)}</strong> ({SOURCE[fw.data.source]!.toLowerCase()}).</p>
      {fw.data.reported && <p>It reports: <strong>{profiles(fw.data.reported)}</strong>.</p>}
      <p className="muted small">Editing the policy changes no cabinet; apply it from the Firewall tab or from a diagnosis. Requires an authenticator code.</p>
      <ClientFirewallPolicy clientId={cabinet.client.id} name={cabinet.client.name} editable={atLeast(me, "admin")} />
      <p><Link to={`/cabinets/${cabinet.id}/firewall`}>Open this cabinet's firewall</Link></p></>,
  });
  if (s) {
    const b = s.networkBaseline;
    const adapter = diagnosis.data?.latest?.readings?.adapters.find(a => a.connected);
    const a4 = adapter?.ipv4;
    const differs = !!(b && a4 && ((a4.dhcp ? "dhcp" : "static") !== b.addressing || (a4.gateways[0] ?? "") !== b.gateway));
    lines.push({
      key: "network", label: "Network baseline", source: b ? SOURCE.site! : SOURCE.none!,
      standard: b ? `${b.addressing === "dhcp" ? "DHCP" : "Fixed"}, gateway ${b.gateway}/${b.prefixLength}, DNS ${b.dnsServers.join(", ")}` : "Not set",
      actual: a4 ? `${a4.dhcp ? "DHCP" : "Fixed"}, ${a4.addresses[0]?.address ?? "no address"}, gateway ${a4.gateways[0] ?? "none"}, DNS ${adapter!.dns.servers.join(", ") || "none"}` : "Not read; run Diagnose network",
      state: !b ? "unset" : !a4 ? "unknown" : differs ? "differs" : "matches",
      detail: <>
        <p>The expected network for this site's cabinets. Network diagnosis compares against it; it changes no cabinet.</p>
        <SiteNetwork siteId={s.id} name={s.name} baseline={b} cabinets={s.cabinets.length} editable={atLeast(me, "tier2")} onSaved={reloadAll} />
        <p><Link to={`/cabinets/${cabinet.id}/network`}>Open this cabinet's network</Link></p></>,
    });
    const zone = time.data;
    lines.push({
      key: "timezone", label: "Time zone", source: s.timeZone ? SOURCE.site! : SOURCE.none!, standard: s.timeZone ? zoneName(s.timeZone) : "Not set",
      actual: zone ? zoneName(zone.timeZoneId) : "Not reported yet", state: !s.timeZone ? "unset" : !zone ? "unknown" : zone.zoneWrong ? "differs" : "matches",
      detail: <><SiteTimeZone siteId={s.id} name={s.name} current={s.timeZone} editable={atLeast(me, "tier2")} onSaved={reloadAll} />
        <p><Link to={`/cabinets/${cabinet.id}/time`}>Open this cabinet's time</Link></p></>,
    });
    lines.push({
      key: "sync", label: "Sync cabinet", source: s.sync.address ? SOURCE.site! : SOURCE.none!,
      standard: s.sync.address ? `${s.sync.address}, ports ${s.sync.effectivePorts.join(", ") || "none"}` : "Not set",
      actual: "Tested from Network", state: s.sync.address ? "unknown" : "unset",
      detail: <>
        <p>Where this site's satellites reach the sync cabinet, and the ports the connection test uses. Ports not set here come from the client, then the fleet default ({s.sync.portsSource}).</p>
        <p className="muted small">Requires an authenticator code: it sets the address the cabinets' connection tests target.</p>
        <SyncSettings siteId={s.id} sync={s.sync} editable={atLeast(me, "admin")} onSaved={reloadAll} />
        <p><Link to={`/cabinets/${cabinet.id}/network`}>Test it from this cabinet's network</Link></p></>,
    });
  }
  if (base.data) {
    const sc0 = base.data.scopes;
    lines.push({
      key: "baseline", label: "Configuration baseline", source: sc0.length ? sc0.map(x => x.kind === "global" ? "All cabinets" : x.name).join(" → ") : SOURCE.none!,
      standard: sc0.length ? `Approved, ${sc0.length === 1 ? "version " + sc0[0]!.version : sc0.length + " levels"}` : "No approved baseline",
      actual: cond.data ? ({ healthy: "Meets it", degraded: "Differs from it", offline: "Out of contact", unknown: "Not judged yet" } as Record<string, string>)[cond.data.state] ?? "Not judged yet" : "Not read",
      state: !sc0.length ? "unset" : cond.data?.state === "healthy" ? "matches" : cond.data?.state === "degraded" ? "differs" : "unknown",
      detail: <>
        <p>The approved baseline this cabinet is compared with. Managed under Admin → Baselines.</p>
        {cond.data && cond.data.state === "degraded" && <ul className="plain">{cond.data.reasons.slice(0, 5).map((r, i) => <li key={i}>{r.text}</li>)}</ul>}
        <p><Link to={`/cabinets/${cabinet.id}/baseline`}>Open this cabinet's baseline and drift</Link></p></>,
    });
  }
  const sc = cabinet.scanner;
  const above = sc.siteHardwareIds ?? sc.clientHardwareIds ?? sc.fleetHardwareIds;
  lines.push({
    key: "scanner", label: "Fingerprint scanner IDs", source: SOURCE[sc.source]!, standard: sc.effective?.length ? sc.effective.join(", ") : "Found automatically (the Biometric device class)",
    actual: "Checked on the Fingerprint scanner tab", state: sc.effective?.length ? "unknown" : "unset",
    detail: <>
      <p>Hardware IDs the scanner checks look for, most specific first: cabinet, site, client, fleet, then automatic detection.</p>
      <ScannerIdsEditor key={`sc-c-${cabinet.id}`} label="This cabinet's own scanner IDs" current={sc.cabinetHardwareIds}
        inherited={above ? <>the level above applies (<code>{above.join(", ")}</code>).</> : "cabinets find the scanner automatically."}
        endpoint={`/api/cabinets/${cabinet.id}/scanner`} action="cabinet.scanner" target={cabinet.id} what={cabinet.name} editable={atLeast(me, "tier2")} onSaved={reloadAll} />
      {s && <ScannerIdsEditor key={`sc-s-${s.id}`} label={`${s.name}'s scanner IDs (every cabinet at the site)`} current={s.scanner.hardwareIds}
        inherited={s.scanner.clientHardwareIds ? <>the client's setting applies (<code>{s.scanner.clientHardwareIds.join(", ")}</code>).</> : s.scanner.fleetHardwareIds ? <>the fleet default applies (<code>{s.scanner.fleetHardwareIds.join(", ")}</code>).</> : "cabinets find the scanner automatically."}
        endpoint={`/api/sites/${s.id}/scanner`} action="site.scanner" target={s.id} what={`every cabinet at ${s.name}`} editable={atLeast(me, "tier2")} onSaved={reloadAll} />}
      <p><Link to={`/cabinets/${cabinet.id}/scanner`}>Open this cabinet's scanner</Link></p></>,
  });
  if (watched.data) {
    const w = watched.data;
    lines.push({
      key: "services", label: "Watched services", source: SOURCE[w.source] ?? w.source, standard: w.effective.length ? w.effective.join(", ") : "None",
      actual: "State on the Services tab", state: w.effective.length ? "unknown" : "unset",
      detail: <>
        <p>Restarted automatically when stopped; alert after 3 failed restarts. The most specific list applies.</p>
        {s && <WatchedServices level="sites" id={s.id} name={s.name} editable={atLeast(me, "tier2")} />}
        <p><Link to={`/cabinets/${cabinet.id}/services`}>Open this cabinet's services (a list of its own is set there)</Link></p></>,
    });
  }
  const current = lines.find(l => l.key === open) ?? null;
  return (
    <section className="panel" aria-labelledby="standards-heading">
      <h2 id="standards-heading">Standards for {cabinet.name}</h2>
      <table className="table clickable">
        <caption className="sr-only">Expected and reported value for each standard. Select a line to see every level.</caption>
        <thead><tr><th scope="col">Setting</th><th scope="col">Standard</th><th scope="col">Comes from</th><th scope="col">This cabinet</th><th scope="col">Status</th></tr></thead>
        <tbody>{lines.map(l => (
          <tr key={l.key}>
            <th scope="row"><button className="linkish" onClick={() => setOpen(l.key)} aria-haspopup="dialog">{l.label}</button></th>
            <td className="small wrap">{l.standard}</td><td className="small">{l.source}</td><td className="small wrap">{l.actual}</td>
            <td><Badge tone={STATE[l.state].tone}>{STATE[l.state].text}</Badge></td>
          </tr>))}</tbody>
      </table>
      {(site.problem || fw.problem) && <p className="error" role="alert">{site.problem ?? fw.problem}</p>}
      <StandardDialog line={current} onClose={() => { setOpen(null); reloadAll(); }} />
    </section>
  );
}

function StandardDialog({ line, onClose }: { line: Line | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (line && !d.open) d.showModal();
    if (!line && d.open) d.close();
  }, [line]);
  return (
    <dialog ref={ref} className="dialog wide" aria-labelledby="standard-title" onClose={e => { if (e.target === e.currentTarget) onClose(); }}>
      {line && (<>
        <h2 id="standard-title">{line.label}</h2>
        <p className="row gap wrap small"><span>Standard: <strong>{line.standard}</strong> ({line.source.toLowerCase()})</span><span>This cabinet: <strong>{line.actual}</strong></span></p>
        <div className="dialog-body stack">{line.detail}</div>
        <div className="row gap"><button className="btn" onClick={() => ref.current?.close()}>Close</button></div>
      </>)}
    </dialog>
  );
}
