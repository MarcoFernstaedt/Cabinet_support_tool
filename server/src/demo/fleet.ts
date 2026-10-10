// The simulated fleet demo mode adds (docs/platform/demo.md). Every client is named "Demo · …" and marked demo in the
// database, so nobody mistakes it for a real customer. Each cabinet has one scenario: the problem it shows.

export type Scenario =
  | "healthy" | "firewall_drift" | "scanner_disconnected" | "service_failing" | "disk_failing"
  | "bsod" | "offline" | "dns_errors" | "update_failure" | "unknown_errors"
  /** The overnight crash incident: blue screens after a storage driver update; some stuck restarting; the rest fine. */
  | "incident_crash" | "incident_loop" | "incident_ok"
  /** Module 21: a cabinet set to the wrong time zone (Arizona set to Mountain, with daylight saving), and a clock drifting off. */
  | "time_zone_wrong" | "clock_drift";

export interface DemoCabinet { name: string; role: "sync" | "satellite" | "standalone"; scenario: Scenario; }
export interface DemoSite { name: string; timeZone: string; subnet: string; cabinets: DemoCabinet[]; }
export interface DemoClient { name: string; sites: DemoSite[]; }

/** The overnight incident at Harbor Pet Hospitals: 80 cabinets, 60 crashed (12 still restarting), 20 did not. g numbers them 0-79. */
export const HARBOR_SITES = ["Boston Harbor", "Portland East", "Providence", "Hartford", "Worcester", "Manchester", "Burlington", "New Haven"];
export const harborAffected = (g: number) => g % 4 !== 3;
export const harborScenario = (g: number): Scenario => !harborAffected(g) ? "incident_ok" : g % 5 === 0 ? "incident_loop" : "incident_crash";
/** Storage errors before the crash on a few crashed cabinets; the driver on two that did not crash. */
export const harborStorageErrors = (g: number) => harborAffected(g) && g % 9 === 0;
export const harborDriverWithoutCrash = (g: number) => g === 3 || g === 43;

const c = (name: string, role: DemoCabinet["role"], scenario: Scenario = "healthy"): DemoCabinet => ({ name, role, scenario });

export const DEMO_FLEET: DemoClient[] = [
  { name: "Demo · Riverside Veterinary Group", sites: [
    { name: "New York – Upper East Side", timeZone: "Eastern Standard Time", subnet: "10.21.4", cabinets: [
      c("Pharmacy Sync", "sync", "firewall_drift"), c("Surgery", "satellite"), c("ICU", "satellite", "clock_drift"), c("Treatment Room", "satellite", "scanner_disconnected")] },
    { name: "Phoenix Clinic", timeZone: "US Mountain Standard Time", subnet: "10.33.8", cabinets: [
      c("Main Sync", "sync", "bsod"), c("Exam Wing", "satellite", "time_zone_wrong"), c("Boarding", "satellite", "service_failing")] },
    { name: "San Diego Bay", timeZone: "Pacific Standard Time", subnet: "10.45.2", cabinets: [
      c("Pharmacy", "standalone", "disk_failing"), c("Recovery", "standalone", "time_zone_wrong")] },
  ] },
  { name: "Demo · Lakeside Health", sites: [
    { name: "Chicago – Main Pharmacy", timeZone: "Central Standard Time", subnet: "172.20.10", cabinets: [
      c("Central Sync", "sync"), c("ER North", "satellite", "dns_errors"), c("ER South", "satellite"), c("Oncology", "satellite", "update_failure")] },
    { name: "Denver ICU", timeZone: "Mountain Standard Time", subnet: "172.20.30", cabinets: [
      c("ICU Sync", "sync", "unknown_errors"), c("Step-down", "satellite", "offline")] },
  ] },
  { name: "Demo · Harbor Pet Hospitals", sites: HARBOR_SITES.map((name, s) => ({
    name, timeZone: "Eastern Standard Time", subnet: `10.6${s}.1`,
    cabinets: Array.from({ length: 10 }, (_, i) => c(i === 0 ? "Sync" : `Cabinet ${String(i + 1).padStart(2, "0")}`, i === 0 ? "sync" : "satellite", harborScenario(s * 10 + i))),
  })) },
  { name: "Demo · Summit Animal Hospitals", sites: [
    { name: "Austin North", timeZone: "Central Standard Time", subnet: "192.168.40", cabinets: [
      c("Front Pharmacy", "sync"), c("Surgery Suite", "satellite", "time_zone_wrong"), c("Isolation", "satellite", "bsod")] },
  ] },
];

export const SCENARIO_LABEL: Record<Scenario, string> = {
  healthy: "Healthy", firewall_drift: "Sync cabinet firewall on, unlike the client policy (blocks its satellites)", scanner_disconnected: "Fingerprint scanner disconnected",
  service_failing: "Scanner service will not stay running", disk_failing: "Drive predicting failure", bsod: "Repeated blue screens",
  offline: "Offline for 6 days", dns_errors: "DNS lookups failing", update_failure: "Windows update failing", unknown_errors: "New, unrecognized errors",
  incident_crash: "Blue screen overnight after a storage driver update", incident_loop: "Blue screen after the driver update, still restarting",
  incident_ok: "Got the same Windows update, no driver change, no crash",
  time_zone_wrong: "Set to the wrong time zone", clock_drift: "Clock about 7 minutes fast",
};

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
