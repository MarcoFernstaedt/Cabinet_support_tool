// The getting-started tour: shown at first sign-in, and again from Account whenever wanted.
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { atLeast, useSession } from "../lib/session";

interface Step { title: string; purpose: string; benefit: string; features: string[] }

const STEPS = (admin: boolean): Step[] => [
  { title: "Mashura Support Console",
    purpose: "Remote diagnostics for cabinet computers. Every read is taken from Windows on the cabinet itself, through a fixed set of operations. There is no remote shell and no file transfer.",
    benefit: "Find and fix Windows problems without remoting in, and see the same evidence the machine would show you at the keyboard.",
    features: ["Event logs, services, processes, drives, network, firewall, updates and time on one screen", "Alerts raised from the cabinet's own events", "Fixes the team has already used, offered when the same problem returns"] },
  { title: "Fleet and cabinets",
    purpose: "Fleet lists every client, site and cabinet with its status and open alerts. The jump box at the top finds any client, site, cabinet or host name.",
    benefit: "Go from an alert to the machine in one step, and switch between cabinets at the same site from the sidebar.",
    features: ["Online state, role (sync, satellite, standalone) and open alerts per cabinet", "Fleet operations: apply one change to many cabinets, with a preview and a per-cabinet result"] },
  { title: "Troubleshoot",
    purpose: "Pick the symptom: scanner, no network, slow, restarts, update failure, failing drive, service stopping. The console runs the fixed checks for it in the order a technician would.",
    benefit: "Less time deciding what to look at. Each result is a reading from the machine, and any check that needs attention carries the fixes the team has saved for it.",
    features: ["Case notes ready to paste into a ticket", "Save what fixed it once; it is offered on every cabinet in the fleet"] },
  { title: "Windows tools in the browser",
    purpose: "Event logs, Services, Processes, Files, Devices and drivers, Windows updates and Drive health work like the tools on the machine.",
    benefit: "Task Manager, Event Viewer, Services and Device Manager views without a remote session.",
    features: ["Processes with live performance, per-volume space and disk busy time", "Event logs filtered by level, time, source and ID, with raw XML", "Update history with roll back by KB, and driver uninstall (Tier 2 and up)"] },
  { title: "Network",
    purpose: "Adapters, leases, routes and ARP; packet loss, jitter and a hop-by-hop path to the gateway, DNS servers, sync cabinet and platform server; one-click diagnosis against the site baseline.",
    benefit: "Shows where the path breaks or degrades, and what differs from the site's standard.",
    features: ["20-request ping with min, average, max and jitter", "Per-hop loss and the first hop that degrades", "Fixes for DNS, gateway, address and lease with a safety net"] },
  { title: "Alerts",
    purpose: "Alerts come from the cabinet's own monitors: failing drives, crashes, stopped services, scanner drops, firewall drift. Major alerts appear on screen as they happen.",
    benefit: "Serious problems, such as a drive predicting failure, reach you without anyone looking for them.",
    features: ["Claim, resolve and map event-log errors to an issue type", "A resolution that carries the fix text, so the next person sees it"] },
  ...(admin ? [{ title: "Admin",
    purpose: "Set up and demo is where you add the support team, install the agent on a computer, approve it, and turn on the demo fleet. Users, the audit log, the software library and agent upgrades are here too.",
    benefit: "Control who can do what, with every change confirmed and logged.",
    features: ["Roles: Tier 1 reads, Tier 2 changes, Admin manages", "Every permission is enforced by the server and the agent", "Fix approval by Admins or Tier 2 with the permission"] }] : []),
];

export function Tour({ onClose }: { onClose: () => void }) {
  const { me } = useSession();
  const steps = STEPS(atLeast(me, "admin"));
  const [i, setI] = useState(0);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const finish = () => { void api("POST", "/api/auth/tour-complete", {}).catch(() => undefined); ref.current?.close(); onClose(); };
  const step = steps[i]!;
  return (
    <dialog ref={ref} className="dialog tour" aria-labelledby="tour-title" aria-describedby="tour-body" onCancel={finish}>
      <p className="muted small">Step {i + 1} of {steps.length}</p>
      <h2 id="tour-title">{step.title}</h2>
      <div id="tour-body" className="stack">
        <p>{step.purpose}</p>
        <p><strong>Why it helps:</strong> {step.benefit}</p>
        <ul>{step.features.map(f => <li key={f}>{f}</li>)}</ul>
      </div>
      <div className="row gap between">
        <button className="btn ghost" onClick={finish}>Skip tour</button>
        <div className="row gap">
          <button className="btn" disabled={i === 0} onClick={() => setI(i - 1)}>Back</button>
          {i < steps.length - 1 ? <button className="btn primary" autoFocus onClick={() => setI(i + 1)}>Next</button>
            : <button className="btn primary" autoFocus onClick={finish}>Finish</button>}
        </div>
      </div>
    </dialog>
  );
}
