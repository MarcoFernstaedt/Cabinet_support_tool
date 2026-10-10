// The demo scenario library (docs/platform/demo.md): each scenario's story, and where in the console to show it, resolved
// to the simulated cabinets of the current demo fleet. Read only; only simulated cabinets are ever named.
import type { Queryable } from "../db/db.js";

export interface ScenarioStep { label: string; path: string }
export interface DemoScenario { id: string; title: string; story: string; steps: ScenarioStep[] }

export async function demoScenarios(db: Queryable): Promise<DemoScenario[]> {
  const rows = (await db.query<{ id: string; name: string; scenario: string; site: string; client: string; client_id: string }>(
    `SELECT k.id, k.name, k.demo_scenario AS scenario, s.name AS site, c.name AS client, c.id AS client_id
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
      WHERE k.demo_scenario IS NOT NULL AND c.demo ORDER BY c.name, s.name, k.name`)).rows;
  if (rows.length === 0) return [];
  const find = (f: (r: (typeof rows)[number]) => boolean) => rows.find(f);
  const at = (client: string, site: string, name: string) => find(r => r.client.endsWith(client) && r.site.startsWith(site) && r.name === name);
  const step = (label: string, r: (typeof rows)[number] | undefined, section: string) => r ? [{ label, path: `/cabinets/${r.id}/${section}` }] : [];
  const healthy = at("Riverside Veterinary Group", "New York", "ICU");
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
    { id: "network", title: "B: A satellite cannot reach its sync cabinet", story: "The New York sync cabinet's firewall is on, unlike the client policy, so its satellites cannot sync. Diagnose network on a satellite names it; apply the policy on the sync cabinet and run the diagnosis again. Chicago ER North shows a DNS server that no longer answers.",
      steps: [...step("Diagnose network (Surgery)", satellite, "network"), ...step("Firewall (Pharmacy Sync)", syncDrift, "firewall"), ...step("DNS failure (ER North)", dns, "network")] },
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
