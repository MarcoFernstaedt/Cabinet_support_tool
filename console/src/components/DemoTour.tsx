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
  { title: "The fleet", body: "Every client with its sites and cabinets, how many are offline, how many have a major alert. Demo clients are tagged Demo. Alerts that belong to one cabinet (you'll see one later) aren't counted here.", path: "/" },
  { title: "Alerts", body: "What the cabinets reported on their own, worst first: blue screens, a failing drive, a firewall that no longer matches the client's policy. Nobody had to go looking.", path: "/alerts" },
  { title: "Network: check a whole site (New York)", body: "One click checks every cabinet at the site against the site's baseline: link, address, gateway, DNS, the sync cabinet, the firewall. Here the sync cabinet's firewall is blocking its satellites, and one cabinet is on a fixed address from another network. The path bar shows where in the chain each one breaks.", path: first("network", 0) },
  { title: "Fix it from the baseline", body: "Apply the client's firewall policy on the sync cabinet: one click, and if the cabinet loses contact afterwards it puts the old setting back by itself. The cabinet on the wrong address goes back to DHCP with an authenticator code. Run the check again and both are clean.", path: first("network", 0) },
  { title: "Network: no DHCP lease (Phoenix)", body: "Front Desk gave itself a 169.254 address because no DHCP server answered. The check says so and offers Renew the DHCP lease. It changes no settings, and the answer shows the new address.", path: first("network", 1) },
  { title: "Network: one site on the old DNS (Dallas)", body: "Three of the four cabinets still point at the old DNS servers. They show up as one problem with one fix. Fix all three with your password: each is changed in turn and its settings read back to confirm.", path: first("network", 2) },
  { title: "Network: wrong gateway, bad cable", body: "Chicago uses fixed addresses and one cabinet has the wrong gateway, which goes back to the baseline's. Denver is running at 100 Mbps. That one says to swap the patch cable, because nothing sent remotely will fix a cable.", path: first("network", 3) },
  { title: "Scanner keeps dropping off (Treatment Room)", body: "The fingerprint scanner has dropped off three times in the last day and is off right now. The page lists each drop and shows the scanner's driver was installed about two hours before the first one. That is the first thing to check, and it could still be the cable. The software library is where a different driver would come from.", path: first("scanner") },
  { title: "Bulk change: three of eight at one site", body: "A bulk change covers one site and you tick the cabinets in it. Three of New York's eight are in the wrong time zone, and each cabinet's IPv4 address is on the list. Tick the three, look at what each gets, confirm with your password, and each one is checked afterwards.", path: first("time") },
  { title: "A clock that has drifted", body: "One cabinet's clock is minutes fast. Sync it with one click. The alert closes when its next report shows the clock in step.", path: first("time", 2) },
  { title: "The fingerprint service is off", body: "BioScanSvc is on the watch list. The agent restarted it three times and it would not stay up, so it's a major alert. Start it from here and the alert closes once it's running.", path: first("service") },
  { title: "A cabinet alert: USB device missing", body: "Three USB ports, a scanner expected on one, and Windows sees nothing on any of them. This is an alert on the cabinet only, for whoever is at the cabinet: check the cable and the port. It isn't on the fleet dashboard.", path: first("usb") },
  { title: "Event logs, sorted into issues", body: "Billing's event logs have errors from five places. Three matched an issue type on their own. The other two are new and wait for a Tier 2 to map them; after that the same error on any cabinet is recognized.", path: first("events") },
  { title: "What the errors turned into", body: "Each alert says which issue it is, how many times it happened and when. Errors nothing recognises yet are listed fleet-wide so none get lost.", path: first("events", 1) },
  { title: "Storage: a failing drive, and a full one", body: "Bad blocks, retried reads and a failure warning from the drive, all collected before it dies. A nearly full drive raises a minor alert before updates and the app start failing.", path: first("storage") },
  { title: "The overnight blue screens", body: "Most of one client's cabinets crashed after a Windows update and a storage driver update, and some are still restarting. Incidents shows who, when it started, the stop code, and what the crashed cabinets share that the others don't. The driver stands out. The update doesn't.", path: first("bsod") },
  { title: "One crashed cabinet", body: "The update, the driver, the restart, then the blue screen, in order, from the 72 hours before. It was sent as it happened, so it's here even if the cabinet won't boot now. Copy case notes gives you the issue, findings and next steps to paste into a ticket.", path: first("bsod", 1) },
  { title: "Changes", body: "Every change is one of a fixed list of operations. The server and the cabinet both check the role. You confirm with a click, a password for bulk changes, or an authenticator code for the risky ones, and everything goes in the audit log.", path: "/admin/audit" },
  { title: "That's the tour", body: "Check without remote desktop, catch problems before the customer calls, fix what can be fixed in a click, and look into fleet-wide incidents with the evidence in front of you. Stop here, or reset the demo from Admin, then Settings.", path: "/" },
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
