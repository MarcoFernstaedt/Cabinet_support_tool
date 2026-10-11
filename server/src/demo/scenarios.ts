// The demo scenario library (docs/platform/demo.md): each scenario's story, and where in the console to show it, resolved
// to the simulated cabinets of the current demo fleet. Read only; only simulated cabinets are ever named.
import type { Queryable } from "../db/db.js";

export interface ScenarioStep { label: string; path: string }
export interface DemoScenario { id: string; title: string; story: string; steps: ScenarioStep[] }

export async function demoScenarios(db: Queryable): Promise<DemoScenario[]> {
  const rows = (await db.query<{ id: string; name: string; scenario: string; site: string; site_id: string; client: string; client_id: string }>(
    `SELECT k.id, k.name, k.demo_scenario AS scenario, s.name AS site, s.id AS site_id, c.name AS client, c.id AS client_id
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
      WHERE k.demo_scenario IS NOT NULL AND c.demo ORDER BY c.name, s.name, k.name`)).rows;
  if (rows.length === 0) return [];
  const find = (f: (r: (typeof rows)[number]) => boolean) => rows.find(f);
  const at = (client: string, site: string, name: string) => find(r => r.client.endsWith(client) && r.site.startsWith(site) && r.name === name);
  const step = (label: string, r: (typeof rows)[number] | undefined, section: string) => r ? [{ label, path: `/cabinets/${r.id}/${section}` }] : [];
  /** A site's page with the network diagnosis started at once. */
  const siteStep = (label: string, client: string, site: string) => {
    const r = rows.find(x => x.client.includes(client) && x.site.startsWith(site));
    return r ? [{ label, path: `/sites/${r.site_id}?diagnose=network` }] : [];
  };
  const healthy = at("Riverside Veterinary Group", "New York", "Surgery");
  const outage = find(r => r.scenario === "site_outage");
  const scanner = find(r => r.scenario === "scanner_disconnected");
  const service = find(r => r.scenario === "service_failing");
  const syncDrift = find(r => r.scenario === "firewall_drift");
  const satellite = at("Riverside Veterinary Group", "New York", "Surgery");
  const dns = find(r => r.scenario === "dns_errors");
  const disk = find(r => r.scenario === "disk_failing");
  const update = find(r => r.scenario === "update_failure");
  const crash = find(r => r.scenario === "incident_crash");
  const offline = find(r => r.scenario === "offline");
  const wrongZone = find(r => r.scenario === "time_zone_wrong");
  const drift = find(r => r.scenario === "clock_drift");
  const incidentClient = rows.find(r => r.scenario.startsWith("incident_"))?.client_id;
  const zoneClient = (wrongZone ?? drift)?.client_id;
  const list: DemoScenario[] = [
    { id: "healthy", title: "A healthy cabinet", story: "What every cabinet shows: its system, event logs, services and processes, drivers, drive health and network, read live from the cabinet in about a second each.",
      steps: [...step("Overview", healthy, "overview"), ...step("Event logs", healthy, "events"), ...step("Services", healthy, "services"), ...step("Network", healthy, "network")] },
    { id: "scanner", title: "A: Fingerprint scanner failure", story: "Treatment Room's scanner reconnected 7 times and then disappeared; Boarding's scanner service will not stay running after 3 automatic restarts. Run the scanner checklist, then restart the service.",
      steps: [...step("Scanner checklist", scanner, "scanner"), ...step("Devices and drivers", scanner, "devices"), ...step("Scanner service", service, "services")] },
    { id: "network", title: "B: Network troubleshooting, from one cabinet to a whole site", story: "Each site has a baseline (its gateway, DNS servers and how cabinets get their address). Diagnose a whole site and the platform compares every cabinet with it and with the others: the Dallas site has three cabinets still pointing at its old DNS servers (one bulk fix); New York has a sync cabinet whose firewall blocks its satellites (one click) and a cabinet with a fixed address from another network; Phoenix has a cabinet with no DHCP lease; Chicago a fixed-address cabinet with the wrong gateway; Denver a cable that negotiated only 100 Mbps. Each problem comes with its fix, and each fix is read back to check it worked.",
      steps: [...siteStep("Diagnose the Dallas site (old DNS servers)", "Summit", "Dallas"), ...siteStep("Diagnose New York (firewall, wrong network)", "Riverside", "New York"),
        ...siteStep("Diagnose Phoenix (no DHCP lease)", "Riverside", "Phoenix"), ...siteStep("Diagnose Chicago (wrong gateway)", "Lakeside", "Chicago"), ...siteStep("Diagnose Denver (slow cable)", "Lakeside", "Denver"),
        ...step("One cabinet: Surgery", satellite, "network")] },
    ...(outage ? [{ id: "outage", title: "B: A whole site offline", story: `Every cabinet at ${outage.site} stopped reporting within the same minute, 40 minutes ago. One cabinet offline is a cabinet problem; a whole site at once points at its network or power, so the platform raises "Whole site offline" instead of chasing each cabinet. Call the site before touching any one cabinet.`,
      steps: [{ label: `The site (${outage.site})`, path: `/sites/${outage.site_id}` }, { label: "Alerts", path: "/alerts" }, ...step("One of its cabinets", outage, "alerts")] }] : []),
    ...(zoneClient ? [{ id: "time", title: "C: Wrong time zones and clocks", story: "Cabinets in Arizona, California, Texas and New York, some set to the wrong Windows time zone and one whose clock has drifted. Select them under Fleet operations, correct time zones and sync clocks, and see each one verified.",
      steps: [{ label: "Fleet operations", path: "/fleet-operations?problem=time_zone_wrong" }, ...step("Time on a wrong cabinet", wrongZone, "time"), ...step("Clock drift", drift, "time")] }] : []),
    { id: "storage", title: "D: Storage failure warning", story: "San Diego's pharmacy cabinet has retried reads, a bad block, and a drive that now predicts failure: replace the drive before it fails.",
      steps: [...step("Drive health", disk, "drives"), ...step("Crashes and restarts (storage errors)", disk, "crashes"), ...step("Alerts", disk, "alerts")] },
    ...(incidentClient ? [{ id: "bsod", title: "E: Mass blue screen and reboot loops", story: "Overnight, most of Harbor Pet Hospitals' cabinets blue-screened with 0xD1 after a Windows update and a storage driver update; some are stuck restarting. Incidents compares the crashed cabinets with the others: the driver stands out, the update does not.",
      steps: [{ label: "Incidents", path: `/incidents?client=${incidentClient}` }, ...step("One crashed cabinet", crash, "crashes"), { label: "Alerts", path: "/alerts" }] }] : []),
    { id: "other", title: "More: updates, offline, new errors", story: "A Windows update that keeps failing, a cabinet offline for 6 days, and new application errors waiting to be mapped to an issue type.",
      steps: [...step("Failing update", update, "updates"), ...step("Offline cabinet", offline, "overview"), { label: "Unrecognized errors", path: "/alerts" }] },
  ];
  return list.filter(s => s.steps.length > 0);
}
