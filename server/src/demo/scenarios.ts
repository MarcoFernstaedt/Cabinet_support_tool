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
  const service = find(r => r.scenario === "service_failing");
  const usb = find(r => r.scenario === "usb_missing");
  const lowSpace = find(r => r.scenario === "disk_space_low");
  const mixed = find(r => r.scenario === "mixed_errors");
  const satellite = at("Riverside Veterinary Group", "New York", "Surgery");
  const disk = find(r => r.scenario === "disk_failing");
  const update = find(r => r.scenario === "update_failure");
  const crash = find(r => r.scenario === "incident_crash");
  const offline = find(r => r.scenario === "offline");
  const wrongZone = find(r => r.scenario === "time_zone_wrong");
  const drift = find(r => r.scenario === "clock_drift");
  const ny = rows.find(r => r.client.includes("Riverside") && r.site.startsWith("New York"));
  const incidentClient = rows.find(r => r.scenario.startsWith("incident_"))?.client_id;
  const zoneClient = (wrongZone ?? drift)?.client_id;
  const list: DemoScenario[] = [
    { id: "healthy", title: "A healthy cabinet", story: "What every cabinet shows: its system, event logs, services and processes, drivers, drive health and network, read live from the cabinet in about a second each.",
      steps: [...step("Overview", healthy, "overview"), ...step("Event logs", healthy, "events"), ...step("Services", healthy, "services"), ...step("Network", healthy, "network")] },
    { id: "network", title: "A: Network troubleshooting, from one cabinet to a whole site", story: "Each site has a baseline (its gateway, DNS servers and how cabinets get their address). Diagnose a whole site and the platform checks every layer on every cabinet (link, address, gateway, DNS, platform, sync cabinet, firewall), compares each with the baseline and with the others, and says where the problem is. New York: a sync cabinet whose firewall blocks its satellites (one click) and a cabinet with a fixed address from another network. Phoenix: a cabinet with no DHCP lease (renew it). Dallas: three cabinets still pointing at the old DNS servers (one bulk fix). Chicago: a fixed-address cabinet with the wrong gateway. Denver: a cable that negotiated only 100 Mbps. Each fix is read back to check it worked.",
      steps: [...siteStep("Diagnose New York (firewall, wrong network)", "Riverside", "New York"), ...siteStep("Diagnose Phoenix (no DHCP lease)", "Riverside", "Phoenix"),
        ...siteStep("Diagnose the Dallas site (old DNS servers)", "Summit", "Dallas"), ...siteStep("Diagnose Chicago (wrong gateway)", "Lakeside", "Chicago"), ...siteStep("Diagnose Denver (slow cable)", "Lakeside", "Denver"),
        ...step("One cabinet: Surgery", satellite, "network")] },
    { id: "time", title: "B: Bulk changes: three of eight cabinets at one site", story: "A bulk change covers one site. At New York, three of the eight cabinets are set to the wrong time zone, and the list shows every cabinet's IPv4 address. Tick the three, preview what each gets, confirm with your password, and watch each one verified; the same page syncs clocks.",
      steps: [...(ny ? [{ label: "Fleet operations at New York (3 of 8 wrong)", path: `/fleet-operations?site=${ny.site_id}&problem=time_zone_wrong` }] : []), ...step("Time on a wrong cabinet", wrongZone, "time"), ...step("Clock drift", drift, "time")].filter(() => !!zoneClient) },
    { id: "service", title: "C: The fingerprint service is off: one click turns it back on", story: "BioScanSvc is watched: the agent restarted it three times, it would not stay running, and the platform raised a major alert. Open the cabinet's services and start it; the alert closes when it runs.",
      steps: [...step("Services: BioScanSvc", service, "services"), ...step("Alerts on the cabinet", service, "alerts")] },
    { id: "usb", title: "D: A USB device that should be there is not (a cabinet alert)", story: "The cabinet has three USB ports and a fingerprint scanner is expected on one of them, but Windows sees nothing on any port. The platform raises a cabinet alert with the logs that go with it. It shows on this cabinet only, not on the fleet dashboard, because it is for whoever is at the cabinet: check the cable and the port.",
      steps: [...step("The cabinet's alerts", usb, "alerts"), ...step("Event logs", usb, "events"), ...step("Scanner checklist", usb, "scanner"), { label: "The fleet alert list (it is not here)", path: "/alerts" }] },
    { id: "events", title: "E: Event log errors, collected and mapped to issues", story: "Billing's event logs hold errors from five sources. The platform collected them as they happened and mapped three to issue types by itself (network, drive, Windows update); two it has never seen (an export job and an application crash) wait to be mapped to an issue type by a Tier 2 technician, after which the same error on any cabinet is recognized.",
      steps: [...step("The raw event logs", mixed, "events"), ...step("What they became: alerts, mapped to issues", mixed, "alerts"), { label: "Unrecognized errors across the fleet", path: "/alerts" }] },
    { id: "storage", title: "F: Storage: a failing drive and a nearly full one", story: "San Diego's pharmacy cabinet has retried reads, a bad block, and a drive that now predicts failure: replace the drive before it fails. Denver's charting cabinet is nearly full: a minor alert before updates and the application start failing.",
      steps: [...step("Drive health", disk, "drives"), ...step("Crashes and restarts (storage errors)", disk, "crashes"), ...step("Low disk space", lowSpace, "alerts")] },
    ...(incidentClient ? [{ id: "bsod", title: "G: Mass blue screen and reboot loops", story: "Overnight, most of Harbor Pet Hospitals' cabinets blue-screened with 0xD1 after a Windows update and a storage driver update; some are stuck restarting. Incidents compares the crashed cabinets with the others: the driver stands out, the update does not.",
      steps: [{ label: "Incidents", path: `/incidents?client=${incidentClient}` }, ...step("One crashed cabinet", crash, "crashes"), { label: "Alerts", path: "/alerts" }] }] : []),
    { id: "other", title: "More: updates and an offline cabinet", story: "A Windows update that keeps failing, and a cabinet offline for 6 days.",
      steps: [...step("Failing update", update, "updates"), ...step("Offline cabinet", offline, "overview")] },
  ];
  return list.filter(s => s.steps.length > 0);
}
