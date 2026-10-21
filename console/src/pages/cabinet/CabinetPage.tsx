// The cabinet view (docs/spec/06-console-spec.md "Cabinet view"): the name stays visible at
// the top with its client, site and role beneath; a sidebar switches to the site's other
// cabinets; each section runs read diagnostics on demand.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { atLeast, useSession } from "../../lib/session";
import { useStepUp } from "../../components/StepUp";
import { Link, useRouter } from "../../lib/router";
import { ago, duration, fullTime } from "../../lib/time";
import { roleLabel, type CabinetRow } from "../Fleet";
import { useLoad } from "../../lib/useLoad";
import { Badge, KeyValues, OnlineBadge } from "../../components/ui";
import { Processes, Services } from "./Services";
import { DemoTag } from "../../components/DemoBanner";
import { CabinetCrashes } from "../Crashes";
import { EventLogs } from "./EventLogs";
import { Changes } from "./Changes";
import { Compare } from "./Compare";
import { Baseline, ConfigHealth } from "./Baseline";
import { Troubleshoot } from "./Troubleshoot";
import { DiagnoseCabinet } from "./DiagnoseCabinet";
import { CabinetNotes } from "../../components/CabinetNotes";
import { CaseNotes } from "../../components/CaseNotes";
import { LiveCheck } from "../../components/LiveCheck";
import { Time } from "./Time";
import { DevicesDrivers, DriveHealth, Firewall, Files, Network, Updates } from "./Sections";
import { Scanner } from "./Scanner";
import { Standards } from "./Standards";
import { History } from "./History";
import { CabinetAlerts, MonitorEvents } from "./CabinetAlerts";
import { Software } from "./Software";
import { WindowsInfo } from "./WindowsInfo";
import { TrendCharts } from "../../components/TrendChart";
import { WritePauseBanner } from "../../lib/writes";
import { SECTIONS, groupedSections, type SectionId } from "../../lib/sections";

export interface CabinetDetail extends CabinetRow { lastHealthyAt: string | null;
  serialNumber: string | null; manufacturer?: string | null; model?: string | null; uptimeSeconds: number | null; clockSkewSeconds: number | null;
  site: { id: string; name: string }; client: { id: string; name: string };
  scanner: { cabinetHardwareIds: string[] | null; siteHardwareIds: string[] | null; clientHardwareIds: string[] | null; fleetHardwareIds: string[] | null;
    effective: string[] | null; source: "cabinet" | "site" | "client" | "fleet" | "automatic" };
  siblings: CabinetRow[];
}


export function CabinetPage({ id, section }: { id: string; section: string }) {
  const { me } = useSession();
  const { data: cabinet, problem, reload } = useLoad<CabinetDetail>(`/api/fleet/cabinets/${id}`);
  const heading = useRef<HTMLHeadingElement>(null);
  const current = (SECTIONS.find(([k]) => k === section)?.[0] ?? "overview") as SectionId;
  useEffect(() => { if (cabinet) document.title = `${cabinet.name} · Mashura Support Console`; }, [cabinet]);
  if (problem) return <div className="page"><h1>Cabinet not available</h1><p className="error" role="alert">{problem}</p><p><Link to="/">Back to the fleet</Link></p></div>;
  if (!cabinet || cabinet.id !== id) return <div className="page"><p className="muted" role="status">Loading cabinet…</p></div>;

  return (
    <div className="cabinet-layout">
      <aside className="sidebar">
        <nav aria-label="Cabinet sections" className="section-nav">
          {groupedSections().map(g => (
            <div key={g.title ?? "main"}>
              {g.title && <h2 className="sidebar-title">{g.title}</h2>}
              <ul>{g.items.map(([key, label]) => (
                <li key={key}><Link to={`/cabinets/${cabinet.id}/${key}`} aria-current={key === current ? "page" : undefined}>{label}</Link></li>))}
              </ul>
            </div>))}
        </nav>
        <nav aria-label={`Cabinets at ${cabinet.site.name}`}>
          <h2 className="sidebar-title">At {cabinet.site.name}</h2>
          <ul>{cabinet.siblings.map(s => (
            <li key={s.id}>
              <Link to={`/cabinets/${s.id}/${current}`} aria-current={s.id === cabinet.id ? "location" : undefined} className={s.id === cabinet.id ? "current" : ""}>
                <span className="name">{s.name}</span>
                <span className="meta">
                  {s.online ? <span className="sr-only">Online</span> : <Badge tone="off">Offline</Badge>}
                  {s.openAlerts > 0 && <> {s.openAlerts} {s.openAlerts === 1 ? "alert" : "alerts"}</>}
                </span>
              </Link>
            </li>))}
          </ul>
        </nav>
      </aside>
      <div className="cabinet-main">
        <header className="cabinet-header">
          <h1 ref={heading}>{cabinet.name}</h1>
          <p className="cabinet-context">
            <Link to={`/clients/${cabinet.client.id}`}>{cabinet.client.name}</Link> · <Link to={`/sites/${cabinet.site.id}`}>{cabinet.site.name}</Link> · {roleLabel(cabinet.role)}
            {" "}<OnlineBadge online={cabinet.online} />
            {cabinet.readOnly && <> <Badge tone="info">Read-only cabinet</Badge></>}
            {cabinet.demo ? <> <DemoTag long /></> : <> <Badge tone="ok">Live agent</Badge></>}
            {atLeast(me, "admin") && <> · <Link to={`/admin/audit?cabinet=${cabinet.id}&action=cabinet.view`}>Access history</Link></>}
          </p>
        </header>
        <WritePauseBanner clientId={cabinet.client.id} clientOnly />
        {!cabinet.online && <div className="notice warn" role="status">{cabinet.lastHeartbeatAt ? <>This cabinet has not been heard from since {ago(cabinet.lastHeartbeatAt)}.</> : "This cabinet has not connected yet."} Diagnostics will wait for it to come back, and expire if it does not.</div>}
        <Section current={current} cabinet={cabinet} reload={reload} />
      </div>
    </div>
  );
}

function Section({ current, cabinet, reload }: { current: SectionId; cabinet: CabinetDetail; reload: () => void }): ReactNode {
  switch (current) {
    case "alerts": return <><CabinetAlerts cabinetId={cabinet.id} /><MonitorEvents cabinetId={cabinet.id} /></>;
    case "changes": return <Changes cabinetId={cabinet.id} />;
    case "compare": return <Compare cabinet={cabinet} />;
    case "baseline": return <Baseline cabinet={cabinet} />;
    case "troubleshoot": return <><DiagnoseCabinet cabinetId={cabinet.id} cabinetName={cabinet.name} /><Troubleshoot cabinetId={cabinet.id} cabinetName={cabinet.name} /></>;
    case "events": return <EventLogs cabinetId={cabinet.id} />;
    case "standards": return <Standards cabinet={cabinet} onChanged={reload} />;
    case "scanner": return <Scanner cabinet={cabinet} onSettingsChanged={reload} />;
    case "devices": return <DevicesDrivers cabinet={cabinet} />;
    case "updates": return <Updates cabinet={cabinet} />;
    case "time": return <Time cabinet={cabinet} />;
    case "drives": return <DriveHealth cabinetId={cabinet.id} />;
    case "network": return <Network cabinet={cabinet} />;
    case "firewall": return <Firewall cabinet={cabinet} />;
    case "services": return <Services cabinet={cabinet} />;
    case "crashes": return <CabinetCrashes cabinetId={cabinet.id} />;
    case "processes": return <Processes cabinet={cabinet} />;
    case "windows": return <WindowsInfo cabinet={cabinet} />;
    case "software": return <Software cabinet={cabinet} />;
    case "files": return <Files cabinetId={cabinet.id} />;
    case "history": return <History cabinetId={cabinet.id} />;
    default: return <Overview cabinet={cabinet} onChanged={reload} />;
  }
}

interface ScannerHistory { drops24h: number; drops7d: number; offNow: boolean }

/** The top of the Overview: how the cabinet is right now, from what the platform already holds, and the next things worth doing. */
function Summary({ cabinet }: { cabinet: CabinetDetail }) {
  const { navigate } = useRouter();
  const scanner = useLoad<ScannerHistory>(`/api/cabinets/${cabinet.id}/scanner-history`).data;
  const tone = !cabinet.online ? "crit" : cabinet.openAlerts > 0 || scanner?.offNow ? "warn" : "ok";
  const headline = !cabinet.online ? "Offline" : cabinet.openAlerts > 0 ? `Online, ${cabinet.openAlerts} open ${cabinet.openAlerts === 1 ? "alert" : "alerts"}` : "Online, no open alerts";
  const scannerText = !scanner ? "Not read yet" : scanner.offNow ? "Not detected now" : scanner.drops24h > 0 ? `${scanner.drops24h} ${scanner.drops24h === 1 ? "drop" : "drops"} in 24 hours` : "No drops in 24 hours";
  const go = (section: string) => navigate(`/cabinets/${cabinet.id}/${section}`);
  // Reads need the cabinet to answer, so an offline cabinet is offered what the platform already knows instead.
  const candidates: [string, string][] = [];
  if (scanner?.offNow || (scanner?.drops24h ?? 0) > 0) candidates.push(["scanner", "Check the fingerprint scanner"]);
  if (cabinet.openAlerts > 0) candidates.push(["alerts", `Review ${cabinet.openAlerts === 1 ? "the open alert" : `${cabinet.openAlerts} open alerts`}`]);
  if (cabinet.online) candidates.push(["troubleshoot", "Diagnose this cabinet"], ["events", "Browse event logs"], ["drives", "Check drive health"], ["scanner", "Check the fingerprint scanner"]);
  else candidates.push(["changes", "See what changed"], ["history", "Open command history"], ["troubleshoot", "Troubleshoot a problem"]);
  const actions = candidates.filter(([k], i) => candidates.findIndex(c => c[0] === k) === i).slice(0, 3);
  return (
    <section className={`panel summary ${tone}`} aria-labelledby="overview-heading">
      <h2 id="overview-heading" className="sr-only">Overview</h2>
      <div className="summary-state">
        <OnlineBadge online={cabinet.online} />
        <strong>{headline}</strong>
        {cabinet.online && cabinet.readOnly && <Badge tone="info">Read-only</Badge>}
      </div>
      <dl className="summary-grid">
        <div><dt>Last contact</dt><dd title={fullTime(cabinet.lastHeartbeatAt)}>{cabinet.lastHeartbeatAt ? ago(cabinet.lastHeartbeatAt) : "Never"}</dd></div>
        <div><dt>Agent version</dt><dd>{cabinet.agentVersion ?? <span className="muted">Unknown</span>}</dd></div>
        <div><dt>Uptime</dt><dd>{cabinet.uptimeSeconds === null ? <span className="muted">Unknown</span> : duration(cabinet.uptimeSeconds)}</dd></div>
        <div><dt>Fingerprint scanner</dt><dd>{scanner && (scanner.offNow || scanner.drops24h > 0) ? <Link to={`/cabinets/${cabinet.id}/scanner`}>{scannerText}</Link> : scannerText}</dd></div>
        <div><dt>Open alerts</dt><dd>{cabinet.openAlerts > 0 ? <Link to={`/cabinets/${cabinet.id}/alerts`}>{cabinet.openAlerts} open</Link> : "None"}</dd></div>
        <div><dt>Last known healthy</dt><dd>{cabinet.online && cabinet.openAlerts === 0 && !scanner?.offNow ? "Now" : cabinet.lastHealthyAt ? <span title={fullTime(cabinet.lastHealthyAt)}>{ago(cabinet.lastHealthyAt)}</span> : <span className="muted">Not recorded</span>}</dd></div>
      </dl>
      <div className="next-actions">
        <span className="label">Next:</span>
        {actions.map(([k, label], i) => <button key={k} className={i === 0 ? "btn primary" : "btn"} onClick={() => go(k)}>{label}</button>)}
      </div>
    </section>
  );
}

function Overview({ cabinet, onChanged }: { cabinet: CabinetDetail; onChanged: () => void }) {
  const { me } = useSession();
  return (<>
    <Summary cabinet={cabinet} />
    <section className="panel" aria-labelledby="details-heading">
      <h2 id="details-heading">Details</h2>
      <KeyValues rows={[
        ["Role", atLeast(me, "admin") ? <RoleChange cabinet={cabinet} onChanged={onChanged} /> : roleLabel(cabinet.role)],
        ["Windows host name", cabinet.hostname],
        ["Serial number", cabinet.serialNumber],
        ["Last heard from", <>{fullTime(cabinet.lastHeartbeatAt)}</>],
        ["Read-only mode", cabinet.readOnly === null ? null : cabinet.readOnly ? "On: the agent refuses every change" : "Off"],
        ["Clock difference", cabinet.clockSkewSeconds === null ? null : `${cabinet.clockSkewSeconds} s from the server`],
      ]} />
    </section>
    <ConfigHealth cabinet={cabinet} />
    <TrendCharts cabinetId={cabinet.id} />
    <section className="panel" aria-label="Notes on this cabinet"><CabinetNotes cabinetId={cabinet.id} /></section>
    <CaseNotes cabinetId={cabinet.id} title="Activity summary for this cabinet" />
    <LiveCheck cabinetId={cabinet.id} cabinetName={cabinet.name} simulated={!!cabinet.demo} />
  </>);
}

/** An Admin changes the cabinet's role at its site (sync, satellite or standalone), with step-up. */
function RoleChange({ cabinet, onChanged }: { cabinet: CabinetDetail; onChanged: () => void }) {
  const [role, setRole] = useState(cabinet.role);
  const step = useStepUp();
  return (
    <span className="row gap">
      <label className="sr-only" htmlFor="cabinet-role">Role</label>
      <select id="cabinet-role" value={role} onChange={e => setRole(e.target.value)}>
        {["sync", "satellite", "standalone"].map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
      </select>
      {role !== cabinet.role && <button className="btn small primary" onClick={() => step.ask("cabinet.role", cabinet.id,
        <p>Change <strong>{cabinet.name}</strong> from {roleLabel(cabinet.role)} to {roleLabel(role)}.</p>,
        async t => { await api("PUT", `/api/admin/cabinets/${cabinet.id}/role`, { role, stepUpToken: t }); onChanged(); }, { role })}>Save role</button>}
      {step.dialog}
    </span>
  );
}
