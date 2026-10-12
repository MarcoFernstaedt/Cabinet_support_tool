// The guided demo tour (docs/platform/demo.md): a small panel at the side of the page, not a popup, that walks a presenter
// through the platform while they use the real console. Each step says what to show and opens the right page; the
// presenter can skip, go back, stop or start again at any time. Its position is kept for this browser tab only.
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useRouter } from "../lib/router";

/** The control the step is about: a CSS selector, and optionally text the element must contain. */
interface Target { selector: string; text?: string }
interface Step { title: string; body: string; path: string | ((s: Scenarios) => string | null); target?: Target }
type Scenarios = Record<string, { label: string; path: string }[]>;

/** The scenario's page whose label starts with this text. */
const page = (id: string, label: string) => (s: Scenarios) => s[id]?.find(x => x.label.startsWith(label))?.path ?? null;
export const TOURS: Record<string, { name: string; steps: Step[] }> = {
  network: { name: "Monday morning at Midtown Manhattan", steps: [
    { title: "Monday morning at Midtown Manhattan", body: "The exam rooms at this site are saying they can't sync. Nine cabinets, one sync cabinet. Nothing has been touched yet. We'll look at one cabinet first, then the whole site.", path: page("midtown", "The site") },
    { title: "One cabinet first", body: "This is Exam Room 1. Click Diagnose network: it checks the link, the address, the gateway, DNS, the sync cabinet and the firewall, and says which layer is broken. Here everything up to the sync cabinet is fine and the sync cabinet doesn't answer.", path: page("midtown", "One cabinet"), target: { selector: '[data-tour="diagnose"]' } },
    { title: "Now the whole site", body: "One click checks every cabinet here and groups what it finds. Click Diagnose network.", path: page("midtown", "The site"), target: { selector: '[data-tour="site-diagnose"]' } },
    { title: "What the check found", body: "Link through DNS are fine everywhere, so it isn't the cable or the network. Every satellite fails at the sync cabinet step, and Midtown Sync's firewall is on when the client's policy says off. (Nothing here yet? Go back and click Diagnose network.)", path: "", target: { selector: '[data-tour="group-sync-firewall"]' } },
    { title: "Fix it", body: "Click \"Apply the policy on Midtown Sync\" and confirm. The cabinet applies the client's firewall policy. If it loses contact with the platform afterwards it puts the old setting back by itself. The site is checked again as soon as it's done, and it should come back clean.", path: "", target: { selector: '[data-tour="fix-apply_policy"]' } },
    { title: "Matching the baseline isn't the same as fine", body: "Operating Room matches its baseline but still loses packets to the gateway, and the card counts errors. Open Everything that was read and look at the ping loss, the card errors and the path. There is no click-to-fix for a bad cable, so once someone has swapped it, Save what fixed this keeps the answer with the cabinet's setup.", path: page("midtown", "Operating Room"), target: { selector: '[data-tour="full-read"]' } },
    { title: "The scanner", body: "Procedure Room's fingerprint scanner has dropped off three times in the last day and is off now. The page lists each drop and shows its driver was installed about two hours before the first one. That is the first thing to check, and it could still be the cable.", path: page("midtown", "Procedure Room"), target: { selector: '[data-tour="scanner-drops"]' } },
    { title: "Errors with no name", body: "Reception and Waiting Room both keep logging errors from the fingerprint reader's driver. No rule knows them, so they are unrecognized alerts, not tied to any issue.", path: page("midtown", "Unrecognized"), target: { selector: '[data-cabinet="Reception"]' } },
    { title: "Look at the error itself", body: "This is Reception's event log. The errors from the biometric service and the driver host are all about the same reader. Open one: it says how many other cabinets logged the same error in the last 30 days.", path: page("midtown", "Reception: event"), target: { selector: '[data-tour="event-entry"]', text: "Biometrics" } },
    { title: "Map it to an issue", body: "Open the alert and click Map to issue, then choose Fingerprint scanner. The preview shows which stored events the rule would catch before anything changes, and a Tier 2 person confirms it with the authenticator. After that, any cabinet that logs this error is grouped under the scanner issue. Rules never use patterns, only the log, the source and the event number.", path: page("midtown", "Reception: alerts"), target: { selector: '[data-tour="map-to-issue"]' } },
    { title: "A teammate's fix, waiting for you", body: "Priya, a Tier 1 teammate, saved what fixed a scanner that kept dropping off. It stays hidden from everyone else until an Admin, or a Tier 2 who has been granted it, approves it. Read it, look at the setup it was fixed on, then click Approve.", path: page("midtown", "Known fixes"), target: { selector: '[data-tour="fix-approve"]' } },
    { title: "It shows up where the problem is", body: "Back on Reception's alert, the approved fix now sits beside the problem as a possible fix, with what differs from the cabinet it was fixed on. A fix applies to every cabinet in the fleet, at any client or site, and the alert carries a \"possible fix\" mark in every list, so the next person to see this error starts from the answer.", path: page("midtown", "Reception: alerts"), target: { selector: ".known-fixes" } },
    { title: "Now your own cabinet: install the agent", body: "Create a one-time install token, copy the install commands onto a Windows computer and run them in an elevated PowerShell. The computer connects out to the server. Nothing connects in to it.", path: "/admin/setup", target: { selector: '[data-tour="create-token"]' } },
    { title: "Approve it", body: "Within a minute of installing, the computer shows up here asking to join. Check its host name and serial number, then file it under a client and site.", path: "/admin/pending", target: { selector: '[data-tour="approve-cabinet"]' } },
    { title: "Check it works", body: "On the Set up page, Test the live cabinet runs the real checks on the real machine: system information, event logs, services, firewall and the network. Each one says what it read, or why it couldn't.", path: "/admin/setup#live-check", target: { selector: '[data-tour="live-run"]' } },
    { title: "Read its network", body: "Open the new cabinet's Network page and click Diagnose network. You get the readings straight from the machine: link, address, DHCP or fixed, gateway, DNS, the lease, the routes and the path to the platform. If its site has no baseline yet, the site page can set one from this cabinet's own network, along with the time zone and the firewall policy. That is the whole loop: check without remote desktop, find the layer that's broken, fix it in a click, keep what you learn, and bring a new cabinet on.", path: page("real", ""), target: { selector: '[data-tour="diagnose"]' } },
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
  }, [place?.tour, place?.step]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // Show me: find the control the step is about, scroll it to the middle of the screen and outline it. The page may still be loading
  // (a check takes a few seconds), so it keeps looking for up to a minute and a half.
  const [looks, setLooks] = useState(0);
  const [found, setFound] = useState<"looking" | "found" | "missing" | null>(null);
  const target = place ? steps[place.step]?.target : undefined;
  const targetKey = target ? `${target.selector}|${target.text ?? ""}` : "";
  useEffect(() => {
    if (!target) { setFound(null); return; }
    let stopped = false, marked: Element | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    setFound("looking");
    const look = () => {
      if (stopped) return;
      const el = [...document.querySelectorAll<HTMLElement>(target.selector)].find(e => !target.text || (e.textContent ?? "").includes(target.text));
      if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("tour-target"); marked = el; setFound("found"); return; }
      if (Date.now() - started > 90_000) { setFound("missing"); return; }
      timer = setTimeout(look, 400);
    };
    look();
    return () => { stopped = true; if (timer) clearTimeout(timer); marked?.classList.remove("tour-target"); };
  }, [place?.tour, place?.step, path, looks, targetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const step = place?.step ?? null;
  if (place === null || step === null || !steps[step]) return null;
  const s = steps[step];
  return (
    <aside className={`demo-tour${left ? " left" : ""}`} aria-labelledby="demo-tour-title" aria-live="polite">
      <p className="muted small">Guided demo · {TOURS[place.tour]!.name} · step {step + 1} of {steps.length}</p>
      <h2 id="demo-tour-title">{s.title}</h2>
      <p>{s.body}</p>
      {found === "looking" && <p className="muted small" role="status">Finding it on the page…</p>}
      {found === "missing" && <p className="small error" role="status">It isn't on this page yet. Go back a step and try again, or click Show me.</p>}
      <div className="row gap wrap">
        <button className="btn small" disabled={step === 0} onClick={() => go(step - 1)}>Back</button>
        {step < steps.length - 1 ? <button className="btn small primary" onClick={() => go(step + 1)}>Next</button>
          : <button className="btn small primary" onClick={() => go(null)}>Finish</button>}
        <button className="btn small ghost" onClick={() => { go(step); setLooks(n => n + 1); }}>Show me</button>
        <button className="btn small ghost" onClick={() => setLeft(l => !l)} aria-label="Move this panel to the other side of the screen">{left ? "Move right" : "Move left"}</button>
        <button className="btn small ghost" onClick={() => go(null)} aria-label="Stop the guided demo">Stop</button>
      </div>
    </aside>
  );
}
