// The runbooks that ship with the platform: what a support person does for the issues the platform raises most, in order, with the safe checks
// and one-click fixes inline. They are plain data, checked by the same rules as a proposed runbook (runbooks.ts, and a test), and an Admin can
// replace any of them by approving a runbook of their own for the same issue type or finding; retiring that one brings this one back.
// Nothing here is a script: a check is a read-only catalog operation, a fix is a catalog write confirmed by a click, and the person's role,
// the write pause and the cabinet's own rules still decide whether it runs.
import { ISSUE_IDS } from "../diagnose/cabinet-findings.js";

export interface RunbookStep {
  title: string;
  detail?: string;
  check?: { operation: string; params: Record<string, unknown> };
  fix?: { operation: string; params: Record<string, unknown>; label: string };
}
export interface RunbookLink { label: string; url: string }
export interface RunbookBody { title: string; steps: RunbookStep[]; links: RunbookLink[] }
export type RunbookTarget = { kind: "issue"; issueTypeId: string } | { kind: "finding"; key: string };

const SCM = { operation: "eventlog.query", params: { log: "System", levels: ["error", "warning"], source: "Service Control Manager" } };

const scanner: RunbookBody = { title: "Fingerprint scanner problem", links: [], steps: [
  { title: "See what Windows sees", detail: "A scanner that is not connected, or connected with a problem code, tells you which of the next steps to take.", check: { operation: "peripheral.status", params: {} } },
  { title: "Look at the USB ports", detail: "Which hub and port the scanner was last on, and any port that reports a problem.", check: { operation: "usb.ports", params: {} } },
  { title: "Reseat the cable and try another port", detail: "At the cabinet (or ask the site): unplug the scanner, wait ten seconds, plug it into a rear USB port. If it works there, the first port or its cable is the fault. Try a different cable before replacing the scanner." },
  { title: "Stop Windows switching the port off", detail: "USB power saving can drop a scanner after a quiet period. Turning it off is safe and easy to undo.", fix: { operation: "power.set", params: { setting: "usb_selective_suspend", enabled: false }, label: "Turn off USB power saving" } },
  { title: "Reinstall the driver", detail: "If a driver was installed or updated just before it started dropping, roll it back or reinstall the approved one from the software library (Devices and drivers)." },
] };

const drive: RunbookBody = { title: "Drive failing", links: [], steps: [
  { title: "Read the drive's health", detail: "Failing, pending or uncorrectable sectors and a prediction of failure all mean the drive is on its way out. A healthy reading is not a guarantee.", check: { operation: "disk.smart", params: {} } },
  { title: "Back up what matters", detail: "Before anything else: make sure the cabinet's data is safe. Do not run disk repairs on a drive that is failing; they stress it." },
  { title: "Look for the disk errors", detail: "Disk errors in the System log, close together, confirm the drive or its cable.", check: { operation: "eventlog.query", params: { log: "System", levels: ["error", "critical"], source: "disk" } } },
  { title: "Plan the replacement", detail: "Book the swap with the site now and note it on the cabinet. Do not wait for the drive to fail completely." },
] };

const diskSpace: RunbookBody = { title: "Low disk space", links: [], steps: [
  { title: "See which drive is full and what is running", check: { operation: "system.performance", params: {} } },
  { title: "Free some space", detail: "Empty the recycle bin and the temp folders, remove old installers and programs nobody uses. Do not delete files the cabinet application uses; if unsure, ask." },
  { title: "Make sure updates are not stuck", detail: "Windows Update fails when the system drive is short of space; once there is room, check the update history.", check: { operation: "updates.status", params: {} } },
] };

const clock: RunbookBody = { title: "Clock is off", links: [], steps: [
  { title: "Check the clock and its source", check: { operation: "time.status", params: {} } },
  { title: "Sync the clock", detail: "Asks Windows Time to sync now; it never changes the time source.", fix: { operation: "time.sync", params: {}, label: "Sync the clock now" } },
  { title: "If it drifts again", detail: "Check that the Windows Time service is running and that the cabinet can reach its source (DNS and the firewall). A clock that keeps drifting on its own can mean a failing motherboard battery." },
] };

const timeZone: RunbookBody = { title: "Wrong time zone", links: [], steps: [
  { title: "Compare the cabinet's zone with the site's", check: { operation: "time.status", params: {} } },
  { title: "Set the site's zone", detail: "Open the cabinet's Time section: it offers the site's zone with one click. For many cabinets at once, use Fleet operations." },
] };

const firewallPolicy: RunbookBody = { title: "Firewall differs from client policy", links: [], steps: [
  { title: "See which profiles differ", check: { operation: "firewall.state", params: {} } },
  { title: "Apply the policy", detail: "Sets the three profiles the way the cabinet's firewall policy says (its site's, else its client's, else the fleet default). It goes through the safety net and is undone by itself if the cabinet stops reporting.", fix: { operation: "firewall.applyPolicy", params: {}, label: "Apply the policy" } },
  { title: "Check it held", detail: "The alert closes by itself once the cabinet reports the profiles matching. If it differs again, something on the cabinet is changing it: check Group Policy and who has access." },
] };

const network: RunbookBody = { title: "Network connectivity", links: [], steps: [
  { title: "Run Diagnose network", detail: "The Network page runs every layer from the link to the firewall and says where it breaks." },
  { title: "Is the gateway reachable?", detail: "Four pings to the gateway. No answer points at the cable, the switch port or the gateway itself.", check: { operation: "network.test", params: { target: "gateway", method: "ping", count: 4 } } },
  { title: "Clear the DNS cache", detail: "Harmless and often enough when names resolve to an old address.", fix: { operation: "network.flushDns", params: {}, label: "Flush the DNS cache" } },
  { title: "If it is physical", detail: "Check the cable at both ends and the switch port's link light; try another port, then another cable." },
] };

const dnsAll: RunbookBody = { title: "No DNS server answers", links: [], steps: [
  { title: "Test the platform server's name", check: { operation: "network.test", params: { target: "platform_server", method: "dns" } } },
  { title: "Check the DNS servers the adapter uses", detail: "On the Network page: the servers must be the site's (the diagnosis compares them with the site baseline). Ask the site whether the router or DNS server was restarted." },
  { title: "Clear the DNS cache", fix: { operation: "network.flushDns", params: {}, label: "Flush the DNS cache" } },
] };

const gateway: RunbookBody = { title: "The gateway does not answer", links: [], steps: [
  { title: "Ping the gateway again", check: { operation: "network.test", params: { target: "gateway", method: "ping", count: 10 } } },
  { title: "Check the physical link", detail: "Cable at both ends, link light on the switch, another switch port, another cable. If several cabinets at the site are affected, it is the switch or the router: call the site." },
  { title: "Check the gateway address", detail: "A wrong gateway in the IP settings looks exactly like a dead one. The diagnosis compares it with the site baseline." },
] };

const serviceFailing: RunbookBody = { title: "Service will not stay running", links: [], steps: [
  { title: "See the service and its watch status", check: { operation: "services.list", params: {} } },
  { title: "Read why Windows stopped it", detail: "A dependency that did not start, a timeout, a wrong account or a crash; the event says which.", check: SCM },
  { title: "Look at the application's own errors", check: { operation: "eventlog.query", params: { log: "Application", levels: ["error", "critical"] } } },
  { title: "Reinstall if it is broken", detail: "A service that dies right after starting, with a file or account error, usually needs the software reinstalled from the library." },
] };

const crash: RunbookBody = { title: "System crash (blue screen)", links: [], steps: [
  { title: "Open Crashes and restarts", detail: "It names the stop code, what changed in the three days before the first crash (updates, drivers, software) and puts them on a timeline." },
  { title: "Check for critical events", check: { operation: "eventlog.query", params: { log: "System", levels: ["critical"] } } },
  { title: "Is it one cabinet or many?", detail: "Open Incidents: if cabinets with the same update or driver are crashing and the others are not, that change is the suspect." },
  { title: "Check the drive", check: { operation: "disk.smart", params: {} } },
] };

const shutdown: RunbookBody = { title: "Unexpected shutdown or power loss", links: [], steps: [
  { title: "Find the shutdown", check: { operation: "eventlog.query", params: { log: "System", levels: ["error", "critical"], eventIds: [41, 6008] } } },
  { title: "Ask the site about the power", detail: "A UPS that is dead, a plug pulled, a power strip that was switched off or a button held down. Several cabinets at one time points at the building." },
  { title: "If the power is steady", detail: "Look for a crash (Crashes and restarts) and check the drive and memory." },
] };

const update: RunbookBody = { title: "Windows update failure", links: [], steps: [
  { title: "Read the update history", detail: "The failed update's number and its error code.", check: { operation: "updates.status", params: {} } },
  { title: "Check the system drive has room", detail: "Under 10 GB free is the usual reason.", check: { operation: "system.performance", params: {} } },
  { title: "Check the update services", detail: "Windows Update, Background Intelligent Transfer and Cryptographic Services must be able to start.", check: { operation: "services.list", params: {} } },
] };

const offline: RunbookBody = { title: "Cabinet offline", links: [], steps: [
  { title: "Is it the whole site?", detail: "Open the site: if every cabinet is silent, the cause is the site's internet, switch, firewall or power, not this cabinet. A \"Whole site offline\" alert says so." },
  { title: "Ask the site", detail: "Is the cabinet powered on, is the network cable in, did anything change today?" },
  { title: "When it comes back", detail: "Run Diagnose this cabinet: the unexpected shutdowns and crashes in the last day say what happened." },
] };

export const BUILT_IN_RUNBOOKS: { target: RunbookTarget; body: RunbookBody }[] = [
  { target: { kind: "issue", issueTypeId: ISSUE_IDS.scanner }, body: scanner },
  { target: { kind: "finding", key: "scanner-missing" }, body: scanner },
  { target: { kind: "issue", issueTypeId: ISSUE_IDS.drive }, body: drive },
  { target: { kind: "finding", key: "drive-health" }, body: drive },
  { target: { kind: "issue", issueTypeId: ISSUE_IDS.diskSpace }, body: diskSpace },
  { target: { kind: "finding", key: "disk-space" }, body: diskSpace },
  { target: { kind: "issue", issueTypeId: ISSUE_IDS.clock }, body: clock },
  { target: { kind: "finding", key: "time-skew" }, body: clock },
  { target: { kind: "issue", issueTypeId: ISSUE_IDS.timeZone }, body: timeZone },
  { target: { kind: "finding", key: "time-zone" }, body: timeZone },
  { target: { kind: "issue", issueTypeId: ISSUE_IDS.firewallPolicy }, body: firewallPolicy },
  { target: { kind: "finding", key: "firewall" }, body: firewallPolicy },
  { target: { kind: "issue", issueTypeId: ISSUE_IDS.network }, body: network },
  { target: { kind: "finding", key: "dns-all" }, body: dnsAll },
  { target: { kind: "finding", key: "gateway" }, body: gateway },
  { target: { kind: "issue", issueTypeId: ISSUE_IDS.serviceFailing }, body: serviceFailing },
  { target: { kind: "finding", key: "service-failing" }, body: serviceFailing },
  { target: { kind: "issue", issueTypeId: ISSUE_IDS.crash }, body: crash },
  { target: { kind: "finding", key: "log-blue-screen" }, body: crash },
  { target: { kind: "issue", issueTypeId: ISSUE_IDS.shutdown }, body: shutdown },
  { target: { kind: "finding", key: "log-unexpected-shutdown" }, body: shutdown },
  { target: { kind: "issue", issueTypeId: ISSUE_IDS.update }, body: update },
  { target: { kind: "finding", key: "updates-failed" }, body: update },
  { target: { kind: "issue", issueTypeId: "00000000-0000-4000-8000-000000000108" }, body: offline },
];
