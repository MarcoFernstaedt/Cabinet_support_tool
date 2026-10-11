// The simulated fleet demo mode adds (docs/platform/demo.md). Every client is named "Demo · …" and marked demo in the
// database, so nobody mistakes it for a real customer. Each cabinet has one scenario: the problem it shows.

export type Scenario =
  | "healthy" | "firewall_drift" | "scanner_disconnected" | "scanner_flapping" | "service_failing" | "disk_failing"
  | "bsod" | "offline" | "dns_errors" | "update_failure" | "unknown_errors"
  /** The overnight crash incident: blue screens after a storage driver update; some stuck restarting; the rest fine. */
  | "incident_crash" | "incident_loop" | "incident_ok"
  /** Module 21: a cabinet set to the wrong time zone (Arizona set to Mountain, with daylight saving), and a clock drifting off. */
  | "time_zone_wrong" | "clock_drift"
  /** Scenario B: every cabinet at one site stopped reporting within the same minutes (the site's network went down). */
  | "site_outage"
  /** Network faults a diagnosis finds by comparing the cabinet with its site's baseline, each with a fix the platform can make. */
  | "net_dns_wrong" | "net_static_wrong" | "net_dhcp_failed" | "net_gateway_wrong" | "net_link_slow"
  /** Nothing is plugged into any USB port although a fingerprint scanner is expected: a cabinet alert, not a fleet one. */
  | "net_flaky"
  | "usb_missing"
  /** A drive nearly full: Windows warns, and updates and the application start failing. */
  | "disk_space_low"
  /** Errors from several sources in the event logs: some match an issue type, two are new and wait to be mapped. */
  | "mixed_errors"
  /** Fingerprint scanner errors in the event logs that no rule names yet: the demo for mapping an error to an issue. */
  | "scanner_errors";

export interface DemoCabinet { name: string; role: "sync" | "satellite" | "standalone"; scenario: Scenario; }
export interface DemoSite { name: string; timeZone: string; subnet: string; cabinets: DemoCabinet[]; /** How this site addresses its cabinets (its network baseline); DHCP unless said. */ addressing?: "dhcp" | "static"; }
export interface DemoClient { name: string; sites: DemoSite[]; }

/** The overnight incident at Harbor Pet Hospitals: 80 cabinets in four large sites of 20, 60 crashed (12 still restarting), 20 did not. g numbers them 0-79. */
export const HARBOR_SITES = ["Boston Harbor", "Portland East", "Providence", "Hartford"];
export const HARBOR_SITE_SIZE = 20;
export const harborAffected = (g: number) => g % 4 !== 3;
/** Never a site's sync cabinet (the first of each site), so no Harbor site loses its sync cabinet to the crash loop. */
export const harborScenario = (g: number): Scenario => !harborAffected(g) ? "incident_ok" : g % 10 === 4 || g % 10 === 7 ? "incident_loop" : "incident_crash";
/** Storage errors before the crash on a few crashed cabinets; the driver on two that did not crash. */
export const harborStorageErrors = (g: number) => harborAffected(g) && g % 9 === 0;
export const harborDriverWithoutCrash = (g: number) => g === 3 || g === 43;

const c = (name: string, role: DemoCabinet["role"], scenario: Scenario = "healthy"): DemoCabinet => ({ name, role, scenario });

export const DEMO_FLEET: DemoClient[] = [
  { name: "Demo · Riverside Veterinary Group", sites: [
    { name: "New York – Upper East Side", timeZone: "Eastern Standard Time", subnet: "10.21.4", cabinets: [
      c("Pharmacy Sync", "sync", "firewall_drift"), c("Surgery", "satellite"), c("ICU", "satellite", "clock_drift"), c("Treatment Room", "satellite", "scanner_disconnected"), c("Lab", "satellite", "net_static_wrong"),
      c("Exam 1", "satellite", "time_zone_wrong"), c("Exam 2", "satellite", "time_zone_wrong"), c("Exam 3", "satellite", "time_zone_wrong")] },
    // The demo's one story: the sync cabinet's firewall blocks the satellites, and the scanner in Procedure Room has been dropping off since a driver install.
    { name: "Midtown Manhattan", timeZone: "Eastern Standard Time", subnet: "10.21.9", cabinets: [
      c("Midtown Sync", "sync", "firewall_drift"), c("Exam Room 1", "satellite"), c("Exam Room 2", "satellite"), c("Exam Room 3", "satellite"), c("Procedure Room", "satellite", "scanner_flapping"), c("Check-in", "satellite"), c("Operating Room", "satellite", "net_flaky"),
      c("Reception", "satellite", "scanner_errors"), c("Waiting Room", "satellite", "scanner_errors")] },
    { name: "Phoenix Clinic", timeZone: "US Mountain Standard Time", subnet: "10.33.8", cabinets: [
      c("Main Sync", "sync", "bsod"), c("Exam Wing", "satellite", "time_zone_wrong"), c("Boarding", "satellite", "service_failing"), c("Front Desk", "satellite", "net_dhcp_failed")] },
    // Sole sites: one standalone cabinet each, with no sync cabinet.
    { name: "San Diego Bay", timeZone: "Pacific Standard Time", subnet: "10.45.2", cabinets: [c("Pharmacy", "standalone", "disk_failing")] },
    { name: "San Diego Recovery Center", timeZone: "Pacific Standard Time", subnet: "10.45.7", cabinets: [c("Recovery", "standalone", "time_zone_wrong")] },
    { name: "Tucson Walk-in", timeZone: "US Mountain Standard Time", subnet: "10.46.3", cabinets: [c("Intake", "standalone", "usb_missing")] },
  ] },
  { name: "Demo · Lakeside Health", sites: [
    { name: "Chicago – Main Pharmacy", timeZone: "Central Standard Time", subnet: "172.20.10", addressing: "static", cabinets: [
      c("Central Sync", "sync"), c("ER North", "satellite", "dns_errors"), c("ER South", "satellite"), c("Oncology", "satellite", "update_failure"),
      c("Triage", "satellite", "net_gateway_wrong")] },
    { name: "Denver ICU", timeZone: "Mountain Standard Time", subnet: "172.20.30", cabinets: [
      c("ICU Sync", "sync", "unknown_errors"), c("Step-down", "satellite", "offline"), c("Rounds", "satellite", "net_link_slow"), c("Charting", "satellite", "disk_space_low")] },
  ] },
  { name: "Demo · Harbor Pet Hospitals", sites: HARBOR_SITES.map((name, s) => ({
    name, timeZone: "Eastern Standard Time", subnet: `10.6${s}.1`,
    cabinets: Array.from({ length: HARBOR_SITE_SIZE }, (_, i) => c(i === 0 ? "Sync" : `Cabinet ${String(i + 1).padStart(2, "0")}`, i === 0 ? "sync" : "satellite", harborScenario(s * HARBOR_SITE_SIZE + i))),
  })) },
  { name: "Demo · Summit Animal Hospitals", sites: [
    { name: "Austin North", timeZone: "Central Standard Time", subnet: "192.168.40", cabinets: [
      c("Front Pharmacy", "sync"), c("Surgery Suite", "satellite", "time_zone_wrong"), c("Isolation", "satellite", "bsod"), c("Billing", "satellite", "mixed_errors")] },
    // Site-wide DNS drift: three of the four still point at the old DNS servers. One site diagnosis shows it; one bulk fix repairs it.
    { name: "Dallas Uptown", timeZone: "Central Standard Time", subnet: "192.168.60", cabinets: [
      c("Uptown Sync", "sync", "net_dns_wrong"), c("Uptown Exam 1", "satellite", "net_dns_wrong"), c("Uptown Exam 2", "satellite", "net_dns_wrong"), c("Uptown Exam 3", "satellite")] },
  ] },
];

/** The wrong zone a time_zone_wrong cabinet was set to: the classic mistakes (Arizona set to Mountain, which observes daylight saving). */
export function wrongZoneFor(siteZone: string): string {
  return ({ "US Mountain Standard Time": "Mountain Standard Time", "Pacific Standard Time": "US Mountain Standard Time",
    "Central Standard Time": "Eastern Standard Time", "Eastern Standard Time": "Central Standard Time", "Mountain Standard Time": "US Mountain Standard Time" } as Record<string, string>)[siteZone] ?? "Eastern Standard Time";
}
/** How far a clock_drift cabinet's clock is off, in seconds; a healthy cabinet's is within a second. */
export const DRIFT_SECONDS = 437;

/** A stable host name per cabinet, like a real imaging naming scheme. */
export function hostnameFor(siteIndex: number, cabinetIndex: number, role: string): string {
  return `CAB-${String(siteIndex + 1).padStart(2, "0")}${role === "sync" ? "S" : "C"}${String(cabinetIndex + 1).padStart(2, "0")}`;
}
