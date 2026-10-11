// The guided demo tour (docs/platform/demo.md): a small panel at the side of the page, not a popup, that walks a presenter
// through the platform while they use the real console. Each step says what to show and opens the right page; the
// presenter can skip, go back, stop or start again at any time. Its position is kept for this browser tab only.
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useRouter } from "../lib/router";

interface Step { title: string; body: string; path: string | ((s: Scenarios) => string | null) }
type Scenarios = Record<string, { label: string; path: string }[]>;

/** The scenario's page whose label starts with this text. */
const page = (id: string, label: string) => (s: Scenarios) => s[id]?.find(x => x.label.startsWith(label))?.path ?? null;
export const TOURS: Record<string, { name: string; steps: Step[] }> = {
  network: { name: "Monday morning at Midtown Manhattan", steps: [
    { title: "Monday morning at Midtown Manhattan", body: "The exam rooms at this site are saying they can't sync. Seven cabinets, one sync cabinet. Nothing has been touched yet. We'll look at one cabinet first, then the whole site.", path: page("midtown", "The site") },
    { title: "One cabinet first", body: "This is Exam Room 1. Click Diagnose network: it checks the link, the address, the gateway, DNS, the sync cabinet and the firewall, and says which layer is broken. Here everything up to the sync cabinet is fine and the sync cabinet doesn't answer.", path: page("midtown", "One cabinet") },
    { title: "Now the whole site", body: "One click checks every cabinet here and groups what it finds. Click Diagnose network.", path: page("midtown", "The whole site") },
    { title: "What the check found", body: "Link through DNS are fine on all seven, so it isn't the cable or the network. Every satellite fails at the sync cabinet step, and Midtown Sync's firewall is on when the client's policy says off. (Nothing here yet? Go back and click Diagnose network.)", path: "" },
    { title: "Fix it", body: "Click \"Apply the policy on Midtown Sync\" and confirm. The cabinet applies the client's firewall policy. If it loses contact with the platform afterwards it puts the old setting back by itself. The site is checked again as soon as it's done, and it should come back clean.", path: "" },
    { title: "Matching the baseline isn't the same as fine", body: "Operating Room matches its baseline but still loses packets to the gateway, and the card counts errors. That only shows in the full read. Click Diagnose network, open Everything that was read, and look at the ping loss, the card errors and the path. Once someone fixes the cable, Save what fixed this keeps the answer with the cabinet's setup, and the next cabinet that shows it comes up with it.", path: page("midtown", "Operating Room") },
    { title: "Also at this site: the scanner", body: "Procedure Room's fingerprint scanner has dropped off three times in the last day and is off now. The page lists each drop and shows its driver was installed about two hours before the first one. That is the first thing to check, and it could still be the cable.", path: page("midtown", "Procedure Room") },
    { title: "Now your own cabinet: install the agent", body: "Create a one-time install token, copy the install commands onto the computer and run them in an elevated PowerShell. The computer connects out to the server. Nothing connects in to it.", path: "/admin/setup" },
    { title: "Approve it", body: "Within a minute of installing, the computer shows up here asking to join. Check its host name and serial number, then file it under a client and site.", path: "/admin/pending" },
    { title: "Read its network", body: "Open the new cabinet's Network page and click Diagnose network. If the site has no baseline yet, nothing is compared. You get the readings straight from the machine: link, address, DHCP or fixed, gateway, DNS, the lease, the routes and the path to the platform. On the site page, Standards can then set the baseline from this cabinet's own network.", path: page("real", "") },
    { title: "That's it", body: "Check without remote desktop, find the layer that's broken, fix it in a click, and watch it come back clean. Stop here, or reset the demo from Admin, then Settings.", path: "/" },
  ] },
  mapping: { name: "Errors nobody has named yet", steps: [
    { title: "Errors with no name", body: "These alerts come from event log errors that no rule knows, so they aren't tied to any issue. Check-in Desk and Waiting Room both have one from the fingerprint reader's driver.", path: page("mapping", "Unrecognized") },
    { title: "Look at the error itself", body: "This is the cabinet's event log. The errors from the biometric service and the driver host are all about the same reader. Open one: it says how many other cabinets logged the same error in the last 30 days.", path: page("mapping", "Check-in Desk: event") },
    { title: "Map it to an issue", body: "Open an alert, click Map to issue, and choose Fingerprint scanner. The preview shows which stored events the rule would catch before anything changes. A Tier 2 person confirms it with the authenticator.", path: page("mapping", "Check-in Desk: alerts") },
    { title: "Every cabinet is grouped", body: "From now on, any cabinet that logs that error raises the scanner issue instead of an unrecognized one, and the alerts already open are moved across. Issues lists the rule and how many cabinets it touched. Rules never use patterns, only the log, the source and the event number.", path: page("mapping", "Issues") },
    { title: "Keep what fixed it", body: "Claim the alert, fix the cause, and click Save what fixed this. The platform keeps your note with the cabinet's setup. The next time the same problem comes up, on any cabinet, its fix is shown next to it, and what differs from the cabinet it was fixed on.", path: page("mapping", "Check-in Desk: alerts") },
  ] },
};

const KEY = "demo-tour";
type Place = { tour: string; step: number };
const read = (): Place | null => {
  try {
    const v = sessionStorage.getItem(KEY)?.split(":");
    return v && v[0] && v[0] in TOURS && Number.isInteger(Number(v[1])) ? { tour: v[0], step: Number(v[1]) } : null;
  } catch { return null; }
};
const write = (p: Place | null) => { try { if (p === null) sessionStorage.removeItem(KEY); else sessionStorage.setItem(KEY, `${p.tour}:${p.step}`); } catch { /* storage unavailable */ } };

/** Starts the tour from anywhere (Settings, the demo guide, the banner). */
export function startDemoTour(tour = "network") { write({ tour, step: 0 }); window.dispatchEvent(new Event("demo-tour")); }

export function DemoTour() {
  const { navigate, path } = useRouter();
  const [place, setPlace] = useState<Place | null>(read);
  const [scenarios, setScenarios] = useState<Scenarios>({});
  const [opening, setOpening] = useState<string | null>(null);
  const [left, setLeft] = useState(false);
  useEffect(() => {
    const on = () => { setPlace(read()); setOpening(window.location.pathname + window.location.search); };
    window.addEventListener("demo-tour", on);
    return () => window.removeEventListener("demo-tour", on);
  }, []);
  useEffect(() => {
    if (place === null) return;
    api<{ scenarios: { id: string; steps: { label: string; path: string }[] }[] }>("GET", "/api/demo/scenarios")
      .then(r => setScenarios(Object.fromEntries(r.scenarios.map(s => [s.id, s.steps]))), () => undefined);
  }, [place?.tour]); // eslint-disable-line react-hooks/exhaustive-deps
  // Steps whose page is not available in this demo (no real cabinet yet, say) are left out.
  const steps = place ? TOURS[place.tour]!.steps.filter(s => typeof s.path === "string" || Object.keys(scenarios).length === 0 || s.path(scenarios) !== null) : [];
  const go = useCallback((n: number | null) => {
    if (n === null || !place) { write(null); setPlace(null); return; }
    const next = { tour: place.tour, step: n };
    write(next); setPlace(next);
    const s = steps[n];
    if (!s) return;
    const path = typeof s.path === "string" ? s.path : s.path(scenarios);
    if (path) navigate(path);
  }, [steps, scenarios, navigate, place]);
  // Starting the tour takes you to its first page, once the scenario's pages are known.
  useEffect(() => {
    if (opening === null || place === null || Object.keys(scenarios).length === 0) return;
    setOpening(null);
    // Only if you are still where you started: if you have already clicked on, leave the page alone.
    if (path === opening || window.location.pathname + window.location.search === opening) go(place.step);
  }, [opening, place, scenarios, go, path]);
  const step = place?.step ?? null;
  if (place === null || step === null || !steps[step]) return null;
  const s = steps[step];
  return (
    <aside className={`demo-tour${left ? " left" : ""}`} aria-labelledby="demo-tour-title" aria-live="polite">
      <p className="muted small">Guided demo · {TOURS[place.tour]!.name} · step {step + 1} of {steps.length}</p>
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
