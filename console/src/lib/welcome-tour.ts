// The welcome tour: what a person sees the first time they sign in, and whenever they ask for it again (Account). It is for the people who will
// use the platform every day, so it does not tell a story: it points at the real menu and the real tabs, says what each is for and what it needs.
// The steps are plain data; a test checks that every menu item and every cabinet tab has a step, and that each step's target exists.
import type { Target } from "./spotlight.ts";
import { SECTIONS, type SectionId } from "./sections.ts";
import type { Role } from "./session.tsx";

export interface TourStep {
  id: string;
  title: string;
  /** One short paragraph each. */
  body: string[];
  /** Where to go first (a path), or null to stay on the page. */
  path: string | null;
  target?: Target;
  /** In the short tour too? Every step is in the full tour. */
  quick: boolean;
  /** A note on who may do what here, shown under the text. */
  needs?: string;
}
export interface TourPerson { role: Role; canApproveFixes: boolean }

const nav = (href: string): Target => ({ selector: `.topbar nav a[href="${href}"]` });
const tab = (key: SectionId): Target => ({ selector: `.section-nav a[href$="/${key}"]` });

/** The cabinet tabs, each with what it is for. Every key of SECTIONS must appear (checked by a test). */
const TABS: Record<SectionId, { body: string[]; needs?: string; quick?: boolean }> = {
  overview: { quick: true, body: ["The cabinet at a glance: whether it is online, when it last reported, its uptime and agent version, and how busy it has been over the last hours or days.", "Case notes live here too: write down what you found and what fixed it, and copy it into the ticket."] },
  standards: { quick: true, body: ["What this cabinet is held to: its firewall policy, network baseline, time zone, sync cabinet, scanner IDs and watched services, and which level each comes from (fleet, client, site or this cabinet).", "Click a line to see every level and change it."], needs: "Changing the firewall policy or the sync cabinet needs an Admin and an authenticator code." },
  troubleshoot: { quick: true, body: ["Start here when a user calls. Pick the symptom (scanner, no network, slow, restarts, update failure, failing drive, a service stopping) and the console runs the usual checks in order.", "What fixed it before is offered when the same problem comes back."] },
  changes: { body: ["What changed on this cabinet and when: settings, firewall, services, installed software and drivers. Useful when something worked yesterday and does not today."] },
  compare: { body: ["Compare this cabinet with another one at the same site, or with a copy taken earlier: system, network adapter, firewall profiles and rules, services, drivers and installed updates."] },
  baseline: { body: ["How this cabinet's configuration compares with the approved baseline for its site, client or model: where it differs, what changed since it was last seen healthy, and a history of changes with the time each is known to have happened.", "Nothing here changes the cabinet. Capture a baseline from a cabinet that works; an Admin approves it before anything is compared with it."], needs: "Reading needs Tier 1. Capturing a baseline needs Tier 2; an Admin approves it with an authenticator code." },
  alerts: { quick: true, body: ["The alerts open on this cabinet, and the events it reported that are not alerts yet.", "An unknown error can be mapped to an issue type here, so the next one raises an alert by itself."] },
  events: { body: ["Windows event logs, read on the cabinet itself. Filter by level, time, source and event ID, open an entry to see its full text and raw XML.", "The Windows Security log is never readable."] },
  services: { body: ["Every Windows service with its state and how it starts. Start, stop or restart one, set how it starts, or add it to the watch list so the agent restarts it and raises an alert after three failures."], needs: "Start type needs Tier 1. Start, stop and restart need Tier 2. Remote-access services are never touched." },
  processes: { body: ["Running processes with live processor, memory, handles and who owns them, like Task Manager. Filter by name or ID."], needs: "Ending a process needs Tier 2 and an authenticator code. Windows' own processes are refused." },
  files: { body: ["Browse folders on the C: drive to see names, sizes and dates. Nothing is opened or downloaded: there is no file transfer."] },
  devices: { body: ["Devices as Device Manager shows them, with problem codes and driver details. Find a device that failed to start and see which driver it uses.", "Drivers are installed from the approved software library, never uploaded from here."], needs: "Uninstalling a driver needs Tier 2 and an authenticator code." },
  drives: { quick: true, body: ["Each drive's own health report, read now, plus its history over weeks: bad sectors growing, wear, heat. A drive that is getting worse shows here, and on the Fleet page, before it fails."] },
  updates: { body: ["Windows update history and what is waiting, with error codes explained. Pending restarts show here."], needs: "Uninstalling an update needs Tier 2 and an authenticator code." },
  time: { body: ["The cabinet's time zone and clock against its site's. A wrong zone or a drifting clock breaks logins and sync; fix both from here."], needs: "Tier 1 can set the zone and sync the clock." },
  network: { quick: true, body: ["Adapters, addresses, routes and the ARP table, then packet loss, jitter and a hop-by-hop path to the gateway, DNS, the sync cabinet and the platform server.", "Diagnose network checks link, address, gateway, DNS, sync and firewall in order and stops at the first broken layer. The cash drawer check is here too."], needs: "Renewing a lease needs Tier 1. Changing an address or DNS needs Tier 2 and a code, and undoes itself if the cabinet loses contact." },
  firewall: { body: ["Windows Firewall profiles and rules, what changed and when, and a button to apply the client's policy.", "A change you make is undone by the cabinet if it cannot reach the platform afterwards."], needs: "Tier 1 can switch profiles and apply the policy. Editing rules needs Tier 2." },
  scanner: { quick: true, body: ["The fingerprint scanner: is it plugged in, does Windows see it, is its driver installed and signed, is USB power saving on, how often it dropped in 24 hours, and which USB port it is on.", "If a client says the scanner is not working, the port and the drops tell you whether to change the cable or the port."] },
  crashes: { body: ["Blue screens, unexpected restarts and reboot loops, with what changed shortly before each. It reads the last 30 days and can export the evidence as a package."] },
  windows: { body: ["What is installed and how it is set up: security (restart pending, Defender, BitLocker, activation, certificates), reliability history, installed software, startup items, signed-in users, shares, power settings, DNS cache and folder sizes.", "Each shows the last answer, even when the cabinet is offline; Run reads it again. Restart or shut down the cabinet from here."], needs: "Restart needs Tier 2 and a code. Shutting down needs an Admin." },
  software: { body: ["Approved drivers and installers from the software library that match this cabinet's hardware. The cabinet downloads the package and checks its hash, signature and publisher itself before installing."], needs: "Installing needs Tier 2 and an authenticator code." },
  history: { body: ["Every command sent to this cabinet: who sent it, when, what it was, and how it ended. This is the record to look at when asking what changed."] },
};

export function welcomeSteps(me: TourPerson, cabinetId: string | null): TourStep[] {
  const admin = me.role === "admin";
  const steps: TourStep[] = [
    { id: "welcome", title: "Welcome to the Mashura Support Console", path: "/", quick: true, body: [
      "This is where the support team reads what is wrong on a clinic's cabinet computer and fixes it, without remoting in. Everything it shows is read from Windows on the cabinet itself.",
      "It can only do a fixed list of things. There is no remote shell and no file transfer, and every change is confirmed and written to the audit log.",
      "The tour shows where everything is. You can stop at any time and start it again from your Account page."] },
    { id: "menu", title: "The main menu", path: "/", target: { selector: ".topbar nav" }, quick: true, body: ["Everything starts here. Each item opens a part of the platform; the next steps go through them."] },
    { id: "fleet", title: "Fleet", path: "/", target: nav("/"), quick: true, body: [
      "Every client, with its sites and cabinets, how many are offline and how many alerts are open. Open a client, then a site, then a cabinet.",
      "When a drive anywhere is getting worse, a \"Drives to look at\" list appears at the top, worst first."] },
    { id: "jump", title: "Jump to", path: null, target: { selector: ".topbar .jump" }, quick: true, body: ["Type part of any client, site, cabinet or Windows host name and go straight to it. This is the fastest way to a cabinet when a client calls."] },
    { id: "search", title: "Search", path: "/search", target: nav("/search"), quick: true, body: ["Ask the whole fleet a question from what each cabinet last reported: which cabinets have this program or update, a restart waiting, Defender off, USB power saving on.", "It never asks a cabinet anything, and it tells you how many cabinets have been read, so \"none found\" is never mistaken for \"none have it\"."] },
    { id: "alerts", title: "Alerts", path: "/alerts", target: nav("/alerts"), quick: true, body: ["Problems the cabinets reported themselves: failing drives, crashes, stopped services, scanner drops, firewall drift, cabinets gone offline. Major ones appear on screen as they happen.", "Claim an alert so others know you have it, resolve it with what fixed it, or map an unknown error to an issue type."] },
    { id: "incidents", title: "Incidents", path: "/incidents", target: nav("/incidents"), quick: false, body: ["When many cabinets fail at once, this shows it as one incident: which cabinets crashed or restarted in a window, and what they had in common (a driver, an update, a site)."] },
    { id: "differences", title: "Differences from baselines", path: "/fleet-differences", target: nav("/fleet-differences"), quick: false, body: ["Where cabinets differ from their approved baselines, counted across the fleet. The same difference on many cabinets points at one common cause; open one to see which cabinets have it and which do not."], needs: "Reading needs Tier 1." },
    { id: "operations", title: "Fleet operations", path: "/fleet-operations", target: nav("/fleet-operations"), quick: false, body: ["Make the same change on many cabinets: set the time zone, sync clocks, apply the firewall policy, fix DNS or addresses. You see what each cabinet would get before anything is sent, and each one is read back afterwards to confirm it worked."], needs: "Needs the same role as making the change on one cabinet; changes on many cabinets ask for your password." },
    { id: "issues", title: "Issues", path: "/issues", target: nav("/issues"), quick: false, body: ["The kinds of problem the platform recognises and the rules that match them. Rules use fields and plain phrases, never patterns. This is where an unknown error becomes a known one."] },
    ...(me.canApproveFixes ? [{ id: "fixes", title: "Fixes", path: "/fixes", target: nav("/fixes"), quick: false, body: ["Fixes a teammate saved (\"this solved it\") wait here for approval. Once approved, a fix is offered to everyone when the same problem comes back on any cabinet."] } satisfies TourStep] : []),
    ...(admin ? [{ id: "admin", title: "Admin", path: "/admin", target: nav("/admin"), quick: true, body: [
      "Setup adds the support team and installs the agent on a cabinet. Pending cabinets are approved here before they can be used. Users, the audit log, the software library, agent upgrades, clients and sites, and platform settings are all under Admin.",
      "Start with Setup if this is a new installation."], needs: "Only Admins see this menu." } satisfies TourStep] : []),
  ];
  if (cabinetId) {
    const path = (k: SectionId) => `/cabinets/${cabinetId}/${k}`;
    steps.push({ id: "cabinet", title: "A cabinet", path: path("overview"), target: { selector: ".cabinet-header h1" }, quick: true, body: [
      "This is one cabinet. Its name, client, site and role (sync cabinet, satellite or standalone) stay at the top. The menu on the left switches between the cabinet's tabs, and the list under it switches to the other cabinets at the same site.",
      "The tabs in the left menu are each a different place to look. They are the next steps."] });
    for (const [key, label] of SECTIONS) {
      const t = TABS[key];
      steps.push({ id: `tab-${key}`, title: label, path: path(key), target: tab(key), quick: !!t.quick, body: t.body, ...(t.needs ? { needs: t.needs } : {}) });
    }
  } else {
    steps.push({ id: "cabinet-later", title: "Cabinets", path: null, quick: true, body: [
      "No cabinet has been approved yet, so there is nothing to open. Once one is, each cabinet has about twenty tabs: status, standards, troubleshooting, event logs, services, processes, drives, network, firewall, the scanner, Windows details, software and the command history.",
      "Take this tour again from your Account page once there is a cabinet, and it will walk through each tab."] });
  }
  steps.push({ id: "account", title: "Your account", path: "/account", target: { selector: ".topbar .user a" }, quick: true, body: [
    "Your name, your sign-ins (a sign-in from a new device or place is marked), your authenticator, and a way to take this tour again.",
    "Every change you confirm with a code or your password is recorded under your name."] });
  steps.push({ id: "done", title: "That is the tour", path: null, quick: true, body: [
    "Next time a client calls: type their name in Jump to, open the cabinet, and use Troubleshoot or Alerts. Every reading says when it was taken.",
    ...(admin ? ["If this is a new installation, go to Admin → Setup next: add the team and install the agent on the first cabinet."] : [])] });
  return steps;
}

/** The steps of one kind of tour: the short one has only what matters on the first day. */
export const forMode = (steps: TourStep[], mode: "full" | "quick"): TourStep[] => (mode === "full" ? steps : steps.filter(s => s.quick));
