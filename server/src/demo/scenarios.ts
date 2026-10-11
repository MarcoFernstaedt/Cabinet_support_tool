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
  const flapping = find(r => r.scenario === "scanner_flapping");
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
    { id: "healthy", title: "A healthy cabinet", story: "A normal cabinet. The overview, event logs, services and network all load straight from the cabinet in a second or so.",
      steps: [...step("Overview", healthy, "overview"), ...step("Event logs", healthy, "events"), ...step("Services", healthy, "services"), ...step("Network", healthy, "network")] },
    { id: "network", title: "A: Network troubleshooting, from one cabinet to a whole site", story: "Every site has a baseline: its gateway, its DNS servers, and whether cabinets use DHCP or fixed addresses. One click on the site page checks every cabinet against it (link, address, gateway, DNS, the sync cabinet, the firewall) and puts the fix next to anything that doesn't match. New York: a sync cabinet whose firewall is blocking its satellites, and a cabinet on a fixed address from another network. Phoenix: no DHCP lease. Dallas: three cabinets still on the old DNS servers. Chicago: wrong gateway on a fixed address. Denver: a bad patch cable, 100 Mbps. Every fix is read back afterwards.",
      steps: [...siteStep("Diagnose New York (firewall, wrong network)", "Riverside", "New York"), ...siteStep("Diagnose Phoenix (no DHCP lease)", "Riverside", "Phoenix"),
        ...siteStep("Diagnose the Dallas site (old DNS servers)", "Summit", "Dallas"), ...siteStep("Diagnose Chicago (wrong gateway)", "Lakeside", "Chicago"), ...siteStep("Diagnose Denver (slow cable)", "Lakeside", "Denver"),
        ...step("One cabinet: Surgery", satellite, "network")] },
    { id: "scanner", title: "B: Scanner keeps dropping off after a driver install", story: "Treatment Room's fingerprint scanner has dropped off three times in the last day and is off right now. The scanner page lists each drop and shows that its driver was installed about two hours before the first one, which is the first thing to look at. It could still be the cable. The checklist, the device list and the software library are a click away.",
      steps: [...step("Scanner page", flapping, "scanner"), ...step("Devices and drivers", flapping, "devices"), ...step("Event logs", flapping, "events"), ...step("Its alerts", flapping, "alerts"), { label: "Software library", path: "/admin/software" }] },
    { id: "time", title: "C: Bulk changes: three of eight cabinets at one site", story: "A bulk change covers one site. New York has three cabinets in the wrong time zone out of eight, and the list shows each cabinet's IPv4 address. Tick the three, look at what each will get, confirm with your password, and each one is checked afterwards. Syncing clocks works the same way.",
      steps: [...(ny ? [{ label: "Fleet operations at New York (3 of 8 wrong)", path: `/fleet-operations?site=${ny.site_id}&problem=time_zone_wrong` }] : []), ...step("Time on a wrong cabinet", wrongZone, "time"), ...step("Clock drift", drift, "time")].filter(() => !!zoneClient) },
    { id: "service", title: "D: The fingerprint service is off: one click turns it back on", story: "BioScanSvc is on the watch list. The agent restarted it three times and it would not stay up, so it is a major alert. Start it from the cabinet's Services page and the alert closes once it is running.",
      steps: [...step("Services: BioScanSvc", service, "services"), ...step("Alerts on the cabinet", service, "alerts")] },
    { id: "usb", title: "E: A USB device that should be there is not (a cabinet alert)", story: "Three USB ports and a scanner that should be on one of them, but Windows sees nothing on any of them. This is an alert on the cabinet only, because it is for whoever is standing at the cabinet: check the cable and the port. It does not show on the fleet dashboard.",
      steps: [...step("The cabinet's alerts", usb, "alerts"), ...step("Event logs", usb, "events"), ...step("Scanner checklist", usb, "scanner"), { label: "The fleet alert list (it is not here)", path: "/alerts" }] },
    { id: "events", title: "F: Event log errors, collected and mapped to issues", story: "Billing's event logs have errors from five places. Three matched an issue type on their own (network, drive, Windows update). The other two, an export job and an application crash, are new. A Tier 2 can map them to an issue, and from then on the same error on any cabinet is recognized.",
      steps: [...step("The raw event logs", mixed, "events"), ...step("What they became: alerts, mapped to issues", mixed, "alerts"), { label: "Unrecognized errors across the fleet", path: "/alerts" }] },
    { id: "storage", title: "G: Storage: a failing drive and a nearly full one", story: "San Diego's pharmacy cabinet has had retried reads, a bad block and a drive failure warning. Replace the drive before it goes. Denver's charting cabinet is nearly full, which raises a minor alert before updates and the application start failing.",
      steps: [...step("Drive health", disk, "drives"), ...step("Crashes and restarts (storage errors)", disk, "crashes"), ...step("Low disk space", lowSpace, "alerts")] },
    ...(incidentClient ? [{ id: "bsod", title: "H: Mass blue screen and reboot loops", story: "Overnight most of Harbor Pet Hospitals' cabinets blue-screened (0xD1) after a Windows update and a storage driver update, and some are stuck restarting. Incidents compares the cabinets that crashed with the ones that did not. The driver is what stands out, not the update.",
      steps: [{ label: "Incidents", path: `/incidents?client=${incidentClient}` }, ...step("One crashed cabinet", crash, "crashes"), { label: "Alerts", path: "/alerts" }] }] : []),
    { id: "other", title: "More: updates and an offline cabinet", story: "A Windows update that keeps failing, and a cabinet that has been offline for six days.",
      steps: [...step("Failing update", update, "updates"), ...step("Offline cabinet", offline, "overview")] },
  ];
  return list.filter(s => s.steps.length > 0);
}
