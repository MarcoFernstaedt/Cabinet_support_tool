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
  overview: { quick: true, body: ["Status, last contact, uptime, agent version and recent load. Case notes for the ticket are kept here."] },
  standards: { quick: true, body: ["The settings this cabinet is held to (firewall policy, network baseline, time zone, sync cabinet, scanner IDs, watched services) and the level each is inherited from."], needs: "Firewall policy and sync cabinet: Admin, with an authenticator code." },
  troubleshoot: { quick: true, body: ["Symptom-driven checks: scanner, network, performance, restarts, updates, storage, services. Each runs in order and stops at the first fault. Previously approved fixes for the same fault are offered."] },
  changes: { body: ["Configuration, firewall, service, software and driver changes, in time order."] },
  compare: { body: ["Side-by-side comparison with another cabinet at the site or an earlier snapshot: system, adapters, firewall, services, drivers and updates."] },
  baseline: { body: ["Drift from the approved baseline for the site, client or model, the last known healthy configuration and the change history. Read-only."], needs: "Read: Tier 1. Capture: Tier 2. Approve: Admin, with an authenticator code." },
  alerts: { quick: true, body: ["Open alerts and unmapped events. Map an unrecognised event to an issue type so later occurrences raise an alert."] },
  events: { body: ["Windows event logs read on the cabinet, filtered by level, time, source and event ID, with the full message and XML. The Security log is excluded."] },
  services: { body: ["Service state and start type. Start, stop, restart and start-type changes apply to approved services only. Watched services are restarted automatically and alert after three failures."], needs: "Start type: Tier 1. Start, stop, restart: Tier 2, approved services only. Remote-access services are refused." },
  processes: { body: ["Running processes with CPU, memory, handles and owner."], needs: "End process: Tier 2, approved programs only, with an authenticator code. System processes are refused." },
  files: { body: ["Folder listings on C: with sizes and dates. No file contents are read or transferred."] },
  devices: { body: ["Devices with their problem codes and the driver bound to each (version, date, provider, signer). Drivers come only from the approved software library."], needs: "Uninstall a driver: Tier 2, with an authenticator code." },
  updates: { body: ["Update history and pending updates with decoded error codes and pending restarts."], needs: "Uninstall an update: Tier 2, with an authenticator code." },
  time: { body: ["Time zone and clock offset against the site and the server. Set the zone and resynchronise the clock."], needs: "Tier 1." },
  network: { quick: true, body: ["Adapters, addresses, routes, ARP, loss, jitter and path to the gateway, DNS, sync cabinet and server. Diagnose network checks each layer in order and stops at the first fault. Includes the drawer check."], needs: "Renew lease: Tier 1. Address or DNS change: Tier 2, with a code; reverted automatically if the cabinet loses contact." },
  firewall: { body: ["Profiles and rules, change history, and apply the firewall policy. A change is reverted automatically if the cabinet cannot reach the server afterwards."], needs: "Profiles and policy: Tier 1. Rules: Tier 2." },
  scanner: { quick: true, body: ["Fingerprint scanner presence, device status, driver and signature, USB selective suspend, disconnects in the last 24 hours and the USB port in use."] },
  crashes: { body: ["Bug checks, unexpected restarts and reboot loops over 30 days, each with the changes that preceded it. Exportable as an evidence package."] },
  windows: { body: ["Security state (pending restart, Defender, BitLocker, activation, certificates), reliability history, installed software, startup items, sessions, shares, power, DNS cache and folder sizes. The last reading stays available while the cabinet is offline."], needs: "Restart: anyone, with an authenticator code. Shut down: Admin, with an authenticator code; the cabinet stays off until someone switches it on." },
  software: { body: ["Library packages that match this cabinet's hardware. The cabinet verifies hash, signature and publisher before it installs."], needs: "Install: Tier 2, with an authenticator code." },
  history: { body: ["Every command sent to this cabinet, with who sent it, when and the outcome."] },
};

export function welcomeSteps(me: TourPerson, cabinetId: string | null): TourStep[] {
  const admin = me.role === "admin";
  const steps: TourStep[] = [
    { id: "welcome", title: "Welcome to the Mashura Support Console", path: "/", quick: true, body: [
      "Diagnose and fix cabinet computers without remoting in. Every reading comes from Windows on the cabinet.",
      "Actions come from a fixed catalog: no remote shell and no file transfer. Every change is confirmed and audited.",
      "Stop at any time; restart the tour from Account."] },
    { id: "menu", title: "The main menu", path: "/", target: { selector: ".topbar nav" }, quick: true, body: ["The main areas of the platform."] },
    { id: "fleet", title: "Fleet", path: "/", target: nav("/"), quick: true, body: [
      "Clients, sites and cabinets with offline counts and open alerts. Degrading drives are listed at the top, worst first."] },
    { id: "jump", title: "Jump to", path: null, target: { selector: ".topbar .jump" }, quick: true, body: ["Go to any client, site, cabinet or Windows host name by typing part of it."] },
    { id: "search", title: "Search", path: "/search", target: nav("/search"), quick: true, body: ["Query the fleet's last readings: installed software and updates, pending restarts, Defender state, USB power settings. Results state how many cabinets have been read."] },
    { id: "alerts", title: "Alerts", path: "/alerts", target: nav("/alerts"), quick: true, body: ["Faults reported by cabinets: drives, crashes, services, scanner, firewall drift, offline. Claim, resolve with the fix applied, or map an unrecognised event to an issue type."] },
    { id: "incidents", title: "Incidents", path: "/incidents", target: nav("/incidents"), quick: false, body: ["Crashes and restarts across many cabinets in one window, grouped, with what they have in common: driver, update, model or site."] },
    { id: "differences", title: "Differences from baselines", path: "/fleet-differences", target: nav("/fleet-differences"), quick: false, body: ["Baseline drift counted across the fleet. A difference shared by many cabinets points to a common cause."], needs: "Tier 1." },
    { id: "operations", title: "Fleet operations", path: "/fleet-operations", target: nav("/fleet-operations"), quick: false, body: ["One change across many cabinets: time zone, clock, firewall policy, DNS, addresses. Preview per cabinet, then verify each result."], needs: "Same role as the single-cabinet change; confirmed with your password." },
    { id: "issues", title: "Issues", path: "/issues", target: nav("/issues"), quick: false, body: ["Issue types and the rules that map events to them. Rules match fields and phrases, not patterns."] },
    ...(me.canApproveFixes ? [{ id: "fixes", title: "Fixes", path: "/fixes", target: nav("/fixes"), quick: false, body: ["Fixes submitted by the team. Once approved, a fix is offered wherever the same fault recurs."] } satisfies TourStep] : []),
    ...(admin ? [{ id: "admin", title: "Admin", path: "/admin", target: nav("/admin"), quick: true, body: [
      "Setup, enrollment approval, users, audit log, software library, agent upgrades, approved programs, clients and sites, and platform settings. On a new installation, start with Setup."], needs: "Admin only." } satisfies TourStep] : []),
  ];
  if (cabinetId) {
    const path = (k: SectionId) => `/cabinets/${cabinetId}/${k}`;
    steps.push({ id: "cabinet", title: "A cabinet", path: path("overview"), target: { selector: ".cabinet-header h1" }, quick: true, body: [
      "Name, client, site and role (sync, satellite or standalone) stay at the top. The left menu lists the cabinet's sections, and below it the other cabinets at the site."] });
    for (const [key, label] of SECTIONS) {
      const t = TABS[key];
      steps.push({ id: `tab-${key}`, title: label, path: path(key), target: tab(key), quick: !!t.quick, body: t.body, ...(t.needs ? { needs: t.needs } : {}) });
    }
  } else {
    steps.push({ id: "cabinet-later", title: "Cabinets", path: null, quick: true, body: [
      "No cabinet is enrolled yet. Each cabinet has sections for status, standards, troubleshooting, event logs, services, processes, drives, network, firewall, scanner, Windows details, software and command history.",
      "Take the tour again from Account once a cabinet is enrolled."] });
  }
  steps.push({ id: "account", title: "Your account", path: "/account", target: { selector: ".topbar .user a" }, quick: true, body: [
    "Sign-in history (new devices are flagged), authenticator, and this tour. Changes you confirm are recorded under your name."] });
  steps.push({ id: "done", title: "That is the tour", path: null, quick: true, body: [
    "Typical path: Jump to the cabinet, then Troubleshoot or Alerts. Every reading shows when it was taken.",
    ...(admin ? ["New installation: Admin → Setup to add the team and enroll the first cabinet."] : [])] });
  return steps;
}

/** The steps of one kind of tour: the short one has only what matters on the first day. */
export const forMode = (steps: TourStep[], mode: "full" | "quick"): TourStep[] => (mode === "full" ? steps : steps.filter(s => s.quick));
