// The cabinet view (docs/spec/06-console-spec.md "Cabinet view"): the name stays visible at
// the top with its client, site and role beneath; a sidebar switches to the site's other
// cabinets; each section runs read diagnostics on demand.
import { useEffect, useRef, type ReactNode } from "react";
import { Link, useRouter } from "../../lib/router";
import { ago, duration, fullTime } from "../../lib/time";
import { useLoad, roleLabel, type CabinetRow } from "../Fleet";
import { Badge, KeyValues, OnlineBadge } from "../../components/ui";
import { EventLogs } from "./EventLogs";
import { DevicesDrivers, DriveHealth, Firewall, Files, Network, Updates } from "./Sections";
import { Scanner } from "./Scanner";
import { History } from "./History";
import { CabinetAlerts, MonitorEvents } from "./CabinetAlerts";
import { Software } from "./Software";
import { WritePauseBanner } from "../../lib/writes";

export interface CabinetDetail extends CabinetRow {
  serialNumber: string | null; uptimeSeconds: number | null; clockSkewSeconds: number | null;
  site: { id: string; name: string }; client: { id: string; name: string };
  scanner: { cabinetHardwareIds: string[] | null; fleetHardwareIds: string[] | null; effective: string[] | null };
  siblings: CabinetRow[];
}

export const SECTIONS = [
  ["overview", "Overview"], ["alerts", "Alerts"], ["events", "Event logs"], ["scanner", "Fingerprint scanner"], ["devices", "Devices and drivers"],
  ["updates", "Windows updates"], ["drives", "Drive health"], ["network", "Network"], ["firewall", "Firewall"], ["software", "Software"], ["files", "Files"], ["history", "Command history"],
] as const;
export type SectionId = (typeof SECTIONS)[number][0];

export function CabinetPage({ id, section }: { id: string; section: string }) {
  const { data: cabinet, problem, reload } = useLoad<CabinetDetail>(`/api/fleet/cabinets/${id}`);
  const heading = useRef<HTMLHeadingElement>(null);
  const current = (SECTIONS.find(([k]) => k === section)?.[0] ?? "overview") as SectionId;
  useEffect(() => { if (cabinet) document.title = `${cabinet.name} · Cabinet Diagnostics`; }, [cabinet]);
  if (problem) return <div className="page"><p className="error" role="alert">{problem}</p></div>;
  if (!cabinet || cabinet.id !== id) return <div className="page"><p className="muted" role="status">Loading cabinet…</p></div>;

  return (
    <div className="cabinet-layout">
      <aside className="sidebar" aria-label={`Cabinets at ${cabinet.site.name}`}>
        <h2 className="sidebar-title">{cabinet.site.name}</h2>
        <ul>{cabinet.siblings.map(s => (
          <li key={s.id}>
            <Link to={`/cabinets/${s.id}/${current}`} aria-current={s.id === cabinet.id ? "page" : undefined} className={s.id === cabinet.id ? "current" : ""}>
              <span className="name">{s.name}</span>
              <span className="meta">{roleLabel(s.role)} · <OnlineBadge online={s.online} />{s.openAlerts > 0 && <> · {s.openAlerts} {s.openAlerts === 1 ? "alert" : "alerts"}</>}</span>
            </Link>
          </li>))}
        </ul>
      </aside>
      <div className="cabinet-main">
        <header className="cabinet-header">
          <h1 ref={heading}>{cabinet.name}</h1>
          <p className="cabinet-context">
            <Link to={`/clients/${cabinet.client.id}`}>{cabinet.client.name}</Link> · <Link to={`/sites/${cabinet.site.id}`}>{cabinet.site.name}</Link> · {roleLabel(cabinet.role)}
            {" "}<OnlineBadge online={cabinet.online} />
            {cabinet.readOnly && <> <Badge tone="info">Read-only cabinet</Badge></>}
          </p>
          <nav aria-label="Cabinet sections" className="tabs">
            {SECTIONS.map(([key, label]) => (
              <Link key={key} to={`/cabinets/${cabinet.id}/${key}`} aria-current={key === current ? "page" : undefined}>{label}</Link>
            ))}
          </nav>
        </header>
        <WritePauseBanner clientId={cabinet.client.id} clientOnly />
        {!cabinet.online && <div className="notice warn" role="status">This cabinet has not been heard from {ago(cabinet.lastHeartbeatAt)}. Diagnostics will wait for it to come back, and expire if it does not.</div>}
        <Section current={current} cabinet={cabinet} reload={reload} />
      </div>
    </div>
  );
}

function Section({ current, cabinet, reload }: { current: SectionId; cabinet: CabinetDetail; reload: () => void }): ReactNode {
  switch (current) {
    case "alerts": return <><CabinetAlerts cabinetId={cabinet.id} /><MonitorEvents cabinetId={cabinet.id} /></>;
    case "events": return <EventLogs cabinetId={cabinet.id} />;
    case "scanner": return <Scanner cabinet={cabinet} onSettingsChanged={reload} />;
    case "devices": return <DevicesDrivers cabinet={cabinet} />;
    case "updates": return <Updates cabinetId={cabinet.id} />;
    case "drives": return <DriveHealth cabinetId={cabinet.id} />;
    case "network": return <Network cabinet={cabinet} />;
    case "firewall": return <Firewall cabinet={cabinet} />;
    case "software": return <Software cabinet={cabinet} />;
    case "files": return <Files cabinetId={cabinet.id} />;
    case "history": return <History cabinetId={cabinet.id} />;
    default: return <Overview cabinet={cabinet} />;
  }
}

function Overview({ cabinet }: { cabinet: CabinetDetail }) {
  const { navigate } = useRouter();
  return (
    <section className="panel" aria-labelledby="overview-heading">
      <h2 id="overview-heading">Overview</h2>
      <KeyValues rows={[
        ["Status", <OnlineBadge online={cabinet.online} />],
        ["Open alerts", cabinet.openAlerts > 0 ? <Link to={`/cabinets/${cabinet.id}/alerts`}>{cabinet.openAlerts} open</Link> : "None"],
        ["Last heard from", <>{fullTime(cabinet.lastHeartbeatAt)} <span className="muted">({ago(cabinet.lastHeartbeatAt)})</span></>],
        ["Windows host name", cabinet.hostname],
        ["Serial number", cabinet.serialNumber],
        ["Uptime", duration(cabinet.uptimeSeconds)],
        ["Agent version", cabinet.agentVersion],
        ["Read-only mode", cabinet.readOnly === null ? null : cabinet.readOnly ? "On: the agent refuses every change" : "Off"],
        ["Clock difference", cabinet.clockSkewSeconds === null ? null : `${cabinet.clockSkewSeconds} s from the server`],
      ]} />
      <div className="row gap wrap">
        <button className="btn" onClick={() => navigate(`/cabinets/${cabinet.id}/scanner`)}>Check the fingerprint scanner</button>
        <button className="btn" onClick={() => navigate(`/cabinets/${cabinet.id}/events`)}>Browse event logs</button>
        <button className="btn" onClick={() => navigate(`/cabinets/${cabinet.id}/drives`)}>Check drive health</button>
      </div>
    </section>
  );
}
