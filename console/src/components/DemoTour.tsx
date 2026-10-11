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
  { title: "Monday morning at Midtown Manhattan", body: "The exam rooms at this site are saying they can't sync. Seven cabinets, one sync cabinet. Nothing has been touched yet. Click Diagnose network.", path: first("midtown", 0) },
  { title: "What the check found", body: "Every cabinet is checked layer by layer: link, address, gateway, DNS, then the sync cabinet and the firewall. Link through DNS are fine on all seven, so it isn't the cable or the network. Every satellite fails at the sync cabinet step, and Midtown Sync's firewall is on when the client's policy says off. (Nothing here yet? Go back and click Diagnose network.)", path: "" },
  { title: "Fix it", body: "Click \"Apply the policy on Midtown Sync\" and confirm. The cabinet applies the client's firewall policy. If it loses contact with the platform afterwards it puts the old setting back by itself. The site is checked again as soon as it's done, and it should come back clean.", path: "" },
  { title: "Also at this site: the scanner", body: "Procedure Room's fingerprint scanner has dropped off three times in the last day and is off now. The page lists each drop and shows its driver was installed about two hours before the first one. That is the first thing to check, and it could still be the cable.", path: first("midtown", 2) },
  { title: "Now your own cabinet: install the agent", body: "Create a one-time install token, copy the install commands onto the computer and run them in an elevated PowerShell. The computer connects out to the server. Nothing connects in to it.", path: "/admin/setup" },
  { title: "Approve it", body: "Within a minute of installing, the computer shows up here asking to join. Check its host name and serial number, then file it under a client and site.", path: "/admin/pending" },
  { title: "Read its network", body: "Open the new cabinet's Network page and click Diagnose network. There is no baseline for this site yet, so nothing is compared. You get the readings straight from the machine: link, address, DHCP or fixed, gateway, DNS, and whether it can reach the platform. Once a site has a baseline, the same check compares against it.", path: first("real", 0) },
  { title: "That's it", body: "Check without remote desktop, find the layer that's broken, fix it in a click, and watch it come back clean. Stop here, or reset the demo from Admin, then Settings.", path: "/" },
];

const KEY = "demo-tour-step";
const read = (): number | null => { try { const v = sessionStorage.getItem(KEY); return v === null ? null : Number(v); } catch { return null; } };
const write = (n: number | null) => { try { if (n === null) sessionStorage.removeItem(KEY); else sessionStorage.setItem(KEY, String(n)); } catch { /* storage unavailable */ } };

/** Starts the tour from anywhere (Settings, the demo guide, the banner). */
export function startDemoTour() { write(0); window.dispatchEvent(new Event("demo-tour")); }

export function DemoTour() {
  const { navigate, path } = useRouter();
  const [step, setStep] = useState<number | null>(read);
  const [scenarios, setScenarios] = useState<Scenarios>({});
  const [opening, setOpening] = useState<string | null>(null);
  const [left, setLeft] = useState(false);
  useEffect(() => {
    const on = () => { setStep(read()); setOpening(window.location.pathname + window.location.search); };
    window.addEventListener("demo-tour", on);
    return () => window.removeEventListener("demo-tour", on);
  }, []);
  useEffect(() => {
    if (step === null) return;
    api<{ scenarios: { id: string; steps: { label: string; path: string }[] }[] }>("GET", "/api/demo/scenarios")
      .then(r => setScenarios(Object.fromEntries(r.scenarios.map(s => [s.id, s.steps]))), () => undefined);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps
  const steps = TOUR.filter(s => typeof s.path === "string" || Object.keys(scenarios).length === 0 || s.path(scenarios) !== null);
  const go = useCallback((n: number | null) => {
    write(n); setStep(n);
    const s = n === null ? undefined : steps[n];
    if (!s) return;
    const path = typeof s.path === "string" ? s.path : s.path(scenarios);
    if (path) navigate(path);
  }, [steps, scenarios, navigate]);
  // Starting the tour takes you to its first page, once the scenario's pages are known.
  useEffect(() => {
    if (opening === null || step === null || Object.keys(scenarios).length === 0) return;
    setOpening(null);
    // Only if you are still where you started: if you have already clicked on, leave the page alone.
    if (path === opening || window.location.pathname + window.location.search === opening) go(step);
  }, [opening, step, scenarios, go, path]);
  if (step === null || !steps[step]) return null;
  const s = steps[step];
  return (
    <aside className={`demo-tour${left ? " left" : ""}`} aria-labelledby="demo-tour-title" aria-live="polite">
      <p className="muted small">Guided demo · step {step + 1} of {steps.length}</p>
      <h2 id="demo-tour-title">{s.title}</h2>
      <p>{s.body}</p>
      <div className="row gap wrap">
        <button className="btn small" disabled={step === 0} onClick={() => go(step - 1)}>Back</button>
        {step < steps.length - 1 ? <button className="btn small primary" onClick={() => go(step + 1)}>Next</button>
          : <button className="btn small primary" onClick={() => go(null)}>Finish</button>}
        <button className="btn small ghost" onClick={() => go(step)}>Show me</button>
        <button className="btn small ghost" onClick={() => setLeft(l => !l)} aria-label="Move this panel to the other side of the screen">{left ? "Move right" : "Move left"}</button>
        <button className="btn small ghost" onClick={() => go(null)} aria-label="Stop the guided demo">Stop</button>
      </div>
    </aside>
  );
}
