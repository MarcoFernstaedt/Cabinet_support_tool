// The guided demo tour (docs/platform/demo.md): a small panel at the side of the page, not a popup, that walks a presenter
// through the platform while they use the real console. Each step says what to show and opens the right page; the
// presenter can skip, go back, stop or start again at any time. Its position is kept for this browser tab only.
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useRouter } from "../lib/router";

interface Step { title: string; body: string; path: string | ((s: Scenarios) => string | null) }
type Scenarios = Record<string, { label: string; path: string }[]>;

const first = (id: string, i = 0) => (s: Scenarios) => s[id]?.[i]?.path ?? null;
export const TOUR: Step[] = [
  { title: "The fleet at a glance", body: "Every client, its sites and cabinets, how many are offline and how many have major alerts. Simulated clients are tagged Demo; your real cabinets are not. Alerts that belong to one cabinet (you will see one later) are not counted here.", path: "/" },
  { title: "Alerts, without anyone searching", body: "Problems the cabinets reported on their own, worst first: crashes, a failing drive, a firewall that drifted from the policy. Nobody searched for these, and no one connected in to a cabinet.", path: "/alerts" },
  { title: "Network: diagnose a whole site (New York)", body: "One click checks every cabinet at the site: link, address, gateway, DNS, the platform, the sync cabinet and the firewall, each compared with the site's baseline. The sync cabinet's firewall blocks its satellites; one cabinet has a fixed address from another network. The path bar shows where in the chain each problem is.", path: first("network", 0) },
  { title: "Fix it in one click", body: "Apply the client's firewall policy on the sync cabinet: a click, and the safety net puts it back if the cabinet loses the platform. Switch the other cabinet back to DHCP with an authenticator code. Run the diagnosis again: both are clean.", path: first("network", 0) },
  { title: "Network: no DHCP lease (Phoenix)", body: "Front Desk gave itself a 169.254 address because no DHCP server answered. The diagnosis says so and offers Renew the DHCP lease: no setting changes, one click, and the answer shows the new address.", path: first("network", 1) },
  { title: "Network: a whole site with the wrong DNS (Dallas)", body: "Three of four cabinets still point at the old DNS servers. The platform groups them as one problem with one fix. Fix all three with your password: each is changed in turn, then its settings are read back to confirm.", path: first("network", 2) },
  { title: "Network: wrong gateway, and a slow cable", body: "Chicago uses fixed addresses and one cabinet has the wrong gateway: fixed from the baseline. Denver negotiated 100 Mbps: the platform says to swap the patch cable, because no remote change can fix a cable.", path: first("network", 3) },
  { title: "Bulk changes: three of eight at one site", body: "A bulk change covers one site, and you tick the cabinets in it. Three of New York's eight cabinets are in the wrong time zone, and every cabinet's IPv4 address is listed. Tick the three, preview what each gets, confirm with your password, and watch each one verified.", path: first("time") },
  { title: "A clock drifting off", body: "One cabinet's clock is minutes fast. Sync it with one click; the alert closes when the next report shows the clock in step.", path: first("time", 2) },
  { title: "The fingerprint service is off", body: "BioScanSvc is watched: the agent restarted it three times and it would not stay running, so the platform raised a major alert. Start it here with one click; the alert closes when it runs.", path: first("service") },
  { title: "A cabinet alert: a USB device that should be there is not", body: "Three USB ports, a scanner expected on one, and Windows sees nothing on any. The cabinet's own alert and its logs say so. It is not on the fleet dashboard: it is for whoever is at the cabinet. Check the cable and the port.", path: first("usb") },
  { title: "Event logs, collected and mapped to issues", body: "Billing's event logs hold errors from five sources. The platform collected them as they happened and mapped three to issue types by itself. Two it has never seen are waiting to be mapped; once a Tier 2 technician maps one, the same error on any cabinet is recognized.", path: first("events") },
  { title: "What the errors became", body: "Each alert says which issue it is, how many times it happened and when. The unrecognized ones are listed fleet-wide so nothing new is lost.", path: first("events", 1) },
  { title: "Storage: a drive about to fail, and one nearly full", body: "Bad blocks, retried reads and a drive that predicts failure: the evidence is collected before the drive dies. A nearly full drive raises a minor alert before updates and the application start failing.", path: first("storage") },
  { title: "The overnight blue screen incident", body: "Most of one client's cabinets crashed after a Windows update and a storage driver update; some are still restarting. See who, when it began, the stop code, and what the crashed cabinets have in common: the driver stands out, the update does not.", path: first("bsod") },
  { title: "What happened before a crash", body: "On one crashed cabinet: the update, the driver, the restart, then the blue screen, in order, from the 72 hours before. It was sent as it happened, so it is here even when the cabinet cannot boot. Copy case notes gives the issue, findings and next steps, ready to paste.", path: first("bsod", 1) },
  { title: "Safe changes", body: "Every change is a fixed operation with a role check on the server and on the cabinet, a confirmation (one click, a password for bulk changes, an authenticator code for risky ones), limits, and a tamper-evident audit log.", path: "/admin/audit" },
  { title: "That is the platform", body: "Diagnose without remote desktop, find problems before customers call, fix what can be fixed in a click, and investigate fleet-wide incidents with evidence. Stop the tour, or reset the demo from Admin → Settings.", path: "/" },
];

const KEY = "demo-tour-step";
const read = (): number | null => { try { const v = sessionStorage.getItem(KEY); return v === null ? null : Number(v); } catch { return null; } };
const write = (n: number | null) => { try { if (n === null) sessionStorage.removeItem(KEY); else sessionStorage.setItem(KEY, String(n)); } catch { /* storage unavailable */ } };

/** Starts the tour from anywhere (Settings, the demo guide, the banner). */
export function startDemoTour() { write(0); window.dispatchEvent(new Event("demo-tour")); }

export function DemoTour() {
  const { navigate } = useRouter();
  const [step, setStep] = useState<number | null>(read);
  const [scenarios, setScenarios] = useState<Scenarios>({});
  useEffect(() => {
    const on = () => setStep(read());
    window.addEventListener("demo-tour", on);
    return () => window.removeEventListener("demo-tour", on);
  }, []);
  useEffect(() => {
    if (step === null) return;
    api<{ scenarios: { id: string; steps: { label: string; path: string }[] }[] }>("GET", "/api/demo/scenarios")
      .then(r => setScenarios(Object.fromEntries(r.scenarios.map(s => [s.id, s.steps]))), () => undefined);
  }, [step === null]); // eslint-disable-line react-hooks/exhaustive-deps
  const steps = TOUR.filter(s => typeof s.path === "string" || Object.keys(scenarios).length === 0 || s.path(scenarios) !== null);
  const go = useCallback((n: number | null) => {
    write(n); setStep(n);
    const s = n === null ? undefined : steps[n];
    if (!s) return;
    const path = typeof s.path === "string" ? s.path : s.path(scenarios);
    if (path) navigate(path);
  }, [steps, scenarios, navigate]);
  if (step === null || !steps[step]) return null;
  const s = steps[step];
  return (
    <aside className="demo-tour" aria-labelledby="demo-tour-title" aria-live="polite">
      <p className="muted small">Guided demo · step {step + 1} of {steps.length}</p>
      <h2 id="demo-tour-title">{s.title}</h2>
      <p>{s.body}</p>
      <div className="row gap wrap">
        <button className="btn small" disabled={step === 0} onClick={() => go(step - 1)}>Back</button>
        {step < steps.length - 1 ? <button className="btn small primary" onClick={() => go(step + 1)}>Next</button>
          : <button className="btn small primary" onClick={() => go(null)}>Finish</button>}
        <button className="btn small ghost" onClick={() => go(step)}>Show me</button>
        <button className="btn small ghost" onClick={() => go(null)} aria-label="Stop the guided demo">Stop</button>
      </div>
    </aside>
  );
}
