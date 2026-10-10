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
  { title: "The fleet at a glance", body: "Every client, its sites and cabinets, how many are offline and how many have major alerts. Simulated clients are tagged Demo; your real cabinets are not.", path: "/" },
  { title: "Alerts, without anyone searching", body: "Problems the cabinets reported on their own, worst first: crashes, a failing drive, a scanner that went away, a firewall that drifted from the policy.", path: "/alerts" },
  { title: "A healthy cabinet", body: "Open any cabinet: its system, event logs, services, processes, drivers, drive health and network, each read from the cabinet in about a second. Nothing connects in to the cabinet.", path: first("healthy") },
  { title: "Event logs", body: "Browse System and Application, filter by level and source, open any entry in full. The Security log is never readable.", path: first("healthy", 1) },
  { title: "Scenario A: the fingerprint scanner", body: "Run the scanner checklist: it is not connected, it reconnected 7 times before it went, and USB power saving is on. Each check says what to try next.", path: first("scanner") },
  { title: "A scanner service that keeps stopping", body: "BioScanSvc is watched: the agent restarts it when it stops and raised a major alert after 3 failed restarts. Restart it here; the alert closes when it runs.", path: first("scanner", 2) },
  { title: "Scenario B: diagnose the network", body: "Click Diagnose network. It checks the cable link, address, gateway, DNS, the sync cabinet and its port, and the firewall, then names the problem: the sync cabinet's firewall is blocking port 1433. Use the button to apply the policy there, then run it again.", path: first("network") },
  { title: "Scenario C: time zones and clocks", body: "Select cabinets in Arizona, California, Texas and New York, preview the change (each site's own zone), correct the time zones and sync the clocks; every cabinet is verified afterwards.", path: first("time") },
  { title: "Scenario D: a drive about to fail", body: "Bad blocks, retried reads and a drive that predicts failure: the evidence is collected as it happens, before the drive dies.", path: first("storage") },
  { title: "Scenario E: the overnight blue screen incident", body: "Most of one client's cabinets crashed after a Windows update and a storage driver update; some are still restarting. See who, when it began, the stop code, and what the crashed cabinets have in common: the driver stands out, the update does not.", path: first("bsod") },
  { title: "What happened before a crash", body: "On one crashed cabinet: the update, the driver, the restart, then the blue screen, in order, from the 72 hours before. It was sent as it happened, so it is here even when the cabinet cannot boot.", path: first("bsod", 1) },
  { title: "Case notes", body: "On Incidents, Copy case notes gives the issue, findings, pending and next steps, ready to paste into Salesforce. Findings are labelled as evidence, not proof.", path: first("bsod") },
  { title: "Safe changes", body: "Every change is a fixed operation with a role check on the server and on the cabinet, a confirmation (one click, a password for bulk changes, an authenticator code for risky ones), limits, and a tamper-evident audit log.", path: "/admin/audit" },
  { title: "That is the platform", body: "Diagnose without remote desktop, find problems before customers call, and investigate fleet-wide incidents with evidence. Stop the tour, or reset the demo from Admin → Settings.", path: "/" },
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
