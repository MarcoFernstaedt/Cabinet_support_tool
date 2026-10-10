// The simulated fleet demo mode adds (docs/platform/demo.md). Every client is named "Demo · …" and marked demo in the
// database, so nobody mistakes it for a real customer. Each cabinet has one scenario: the problem it shows.

export type Scenario =
  | "healthy" | "firewall_drift" | "scanner_disconnected" | "service_failing" | "disk_failing"
  | "bsod" | "offline" | "dns_errors" | "update_failure" | "unknown_errors"
  /** The overnight crash incident: blue screens after a storage driver update; some stuck restarting; the rest fine. */
  | "incident_crash" | "incident_loop" | "incident_ok";

export interface DemoCabinet { name: string; role: "sync" | "satellite" | "standalone"; scenario: Scenario; }
export interface DemoSite { name: string; timeZone: string; subnet: string; cabinets: DemoCabinet[]; }
export interface DemoClient { name: string; sites: DemoSite[]; }

const c = (name: string, role: DemoCabinet["role"], scenario: Scenario = "healthy"): DemoCabinet => ({ name, role, scenario });

export const DEMO_FLEET: DemoClient[] = [
  { name: "Demo · Riverside Veterinary Group", sites: [
    { name: "New York – Upper East Side", timeZone: "Eastern Standard Time", subnet: "10.21.4", cabinets: [
      c("Pharmacy Sync", "sync", "firewall_drift"), c("Surgery", "satellite"), c("ICU", "satellite"), c("Treatment Room", "satellite", "scanner_disconnected")] },
    { name: "Phoenix Clinic", timeZone: "US Mountain Standard Time", subnet: "10.33.8", cabinets: [
      c("Main Sync", "sync", "bsod"), c("Exam Wing", "satellite"), c("Boarding", "satellite", "service_failing")] },
    { name: "San Diego Bay", timeZone: "Pacific Standard Time", subnet: "10.45.2", cabinets: [
      c("Pharmacy", "standalone", "disk_failing")] },
  ] },
  { name: "Demo · Lakeside Health", sites: [
    { name: "Chicago – Main Pharmacy", timeZone: "Central Standard Time", subnet: "172.20.10", cabinets: [
      c("Central Sync", "sync"), c("ER North", "satellite", "dns_errors"), c("ER South", "satellite"), c("Oncology", "satellite", "update_failure")] },
    { name: "Denver ICU", timeZone: "Mountain Standard Time", subnet: "172.20.30", cabinets: [
      c("ICU Sync", "sync", "unknown_errors"), c("Step-down", "satellite", "offline")] },
  ] },
  { name: "Demo · Harbor Pet Hospitals", sites: ["Boston Harbor", "Portland East", "Providence", "Hartford"].map((name, s) => ({
    name, timeZone: "Eastern Standard Time", subnet: `10.6${s}.1`,
    // 15 of 24 crashed overnight (5 of them still restarting); 9 did not.
    cabinets: Array.from({ length: 6 }, (_, i) => c(i === 0 ? "Sync" : `Cabinet ${String(i + 1).padStart(2, "0")}`, i === 0 ? "sync" : "satellite",
      ([["incident_crash", "incident_loop", "incident_crash", "incident_ok", "incident_crash", "incident_ok"],
        ["incident_crash", "incident_crash", "incident_loop", "incident_ok", "incident_crash", "incident_ok"],
        ["incident_loop", "incident_crash", "incident_ok", "incident_crash", "incident_ok", "incident_loop"],
        ["incident_crash", "incident_ok", "incident_loop", "incident_ok", "incident_crash", "incident_ok"]] as const)[s]![i]!)),
  })) },
  { name: "Demo · Summit Animal Hospitals", sites: [
    { name: "Austin North", timeZone: "Central Standard Time", subnet: "192.168.40", cabinets: [
      c("Front Pharmacy", "sync"), c("Surgery Suite", "satellite"), c("Isolation", "satellite", "bsod")] },
  ] },
];

export const SCENARIO_LABEL: Record<Scenario, string> = {
  healthy: "Healthy", firewall_drift: "Sync cabinet firewall on, unlike the client policy (blocks its satellites)", scanner_disconnected: "Fingerprint scanner disconnected",
  service_failing: "Scanner service will not stay running", disk_failing: "Drive predicting failure", bsod: "Repeated blue screens",
  offline: "Offline for 6 days", dns_errors: "DNS lookups failing", update_failure: "Windows update failing", unknown_errors: "New, unrecognized errors",
  incident_crash: "Blue screen overnight after a storage driver update", incident_loop: "Blue screen after the driver update, still restarting",
  incident_ok: "Got the same Windows update, no driver change, no crash",
};

/** A stable host name per cabinet, like a real imaging naming scheme. */
export function hostnameFor(siteIndex: number, cabinetIndex: number, role: string): string {
  return `CAB-${String(siteIndex + 1).padStart(2, "0")}${role === "sync" ? "S" : "C"}${String(cabinetIndex + 1).padStart(2, "0")}`;
}
