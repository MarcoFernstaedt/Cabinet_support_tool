// The guided demo tour (docs/platform/demo.md): a small panel at the side of the page, not a popup, that walks a presenter
// through the platform while they use the real console. Each step says what to show and opens the right page; the
// presenter can skip, go back, stop or start again at any time. Its position is kept for this browser tab only.
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, describeError } from "../lib/api";
import { useSession } from "../lib/session";
import { StepUpDialog } from "./ui";
import { useRouter } from "../lib/router";

/** The control the step is about: a CSS selector, and optionally text the element must contain. */
interface Target { selector: string; text?: string }
interface Step {
  title: string; body: string; path: string | ((s: Scenarios) => string | null); target?: Target;
  /** What to say when the control never shows up (nothing has happened yet that would put it there). */
  missing?: string;
  /** Gets the page ready when the step is reached by Next or Show me without the person having done the earlier click. */
  ensure?: (ctx: { navigate: (to: string) => void; scenarios: Scenarios }) => Promise<void>;
}
type Scenarios = Record<string, { label: string; path: string }[]>;

/** The whole-site check results: if the person skipped the click, run the check for them and open its page. */
const siteCheck: Step["ensure"] = async ({ navigate, scenarios }) => {
  if (window.location.pathname.startsWith("/network/diagnosis/")) return;
  const siteId = scenarios.midtown?.[0]?.path.split("/")[2];
  if (!siteId) return;
  for (let tries = 0; tries < 30; tries++) {
    try { const r = await api<{ batchId: string }>("POST", "/api/diagnose/network", { siteId }); navigate(`/network/diagnosis/${r.batchId}`); return; }
    catch (e) { if (!(e instanceof ApiError) || e.status !== 429) return; await new Promise(r => setTimeout(r, 2000)); }
  }
};

/** The scenario's page whose label starts with this text. */
const page = (id: string, label: string) => (s: Scenarios) => s[id]?.find(x => x.label.startsWith(label))?.path ?? null;
export const TOURS: Record<string, { name: string; steps: Step[] }> = {
  network: { name: "Midtown Manhattan", steps: [
    { title: "Site overview", body: "Site page: every cabinet at the site with role, status and open alerts, and the site's baseline and standards. Used to scope a problem before opening a machine. Midtown has nine cabinets and one sync cabinet, and the exam rooms report sync failures.", path: page("midtown", "The site") },
    { title: "Single-cabinet network diagnosis", body: "Diagnose network checks link, address, gateway, DNS, the sync cabinet and the firewall in order and reports the first broken layer with the readings behind it. On Exam Room 1 everything through DNS passes and the sync cabinet does not answer.", path: page("midtown", "One cabinet"), target: { selector: '[data-tour="diagnose"]' } },
    { title: "Site-wide network diagnosis", body: "The same diagnosis for every cabinet at the site in one run, with results grouped by cause. This replaces opening each cabinet in turn.", path: page("midtown", "The site"), target: { selector: '[data-tour="site-diagnose"]' } },
    { title: "Diagnosis results", body: "Link through DNS pass everywhere, so the cable and the network are not the cause. Every satellite fails at the sync cabinet step, and Midtown Sync has its firewall on where the client's policy says off. Results are grouped by cause, each with the evidence. If the list is empty, go back and run the diagnosis.", path: "", target: { selector: '[data-tour="group-sync-firewall"]' }, ensure: siteCheck },
    { title: "Remediation", body: "Apply the client's firewall policy to the sync cabinet. The change is confirmed first, is recorded in the audit log, and the cabinet restores the previous setting itself if it loses contact with the platform. The site is checked again when it completes.", path: "", target: { selector: '[data-tour="fix-apply_policy"]' }, ensure: siteCheck },
    { title: "Full network reading", body: "A cabinet that matches its baseline can still be unhealthy. Operating Room loses packets to the gateway and its adapter counts errors. The full reading lists loss, jitter, adapter errors, lease, routes, ARP and the path. After a physical repair, Save what fixed this stores the cause, the fix and the cabinet's configuration.", path: page("midtown", "Operating Room"), target: { selector: '[data-tour="full-read"]' } },
    { title: "Fingerprint scanner history", body: "Scanner page: each disconnect with its time and port, the installed driver and its install time, USB hub and controller state, and the biometric service. Procedure Room dropped three times, starting about two hours after a driver install.", path: page("midtown", "Procedure Room"), target: { selector: '[data-tour="scanner-drops"]' } },
    { title: "Unrecognized alerts", body: "Events that match no rule are listed as unrecognized alerts instead of being discarded. Reception and Waiting Room both log errors from the fingerprint reader's driver.", path: page("midtown", "Unrecognized"), target: { selector: '[data-cabinet="Reception"]' } },
    { title: "Event log inspection", body: "Event logs: filter by level, time, source and event ID, and open an entry in full. Each entry shows how many other cabinets logged the same event in the last 30 days, which separates a local fault from a fleet-wide one.", path: page("midtown", "Reception: event"), target: { selector: '[data-tour="event-entry"]', text: "Biometrics" } },
    { title: "Event-to-issue mapping", body: "Map to issue ties an event (log, source and event ID, no patterns) to an issue type. The preview lists the stored events the rule would match before anything changes, and a Tier 2 confirms with the authenticator. Afterwards the same event on any cabinet is grouped under the issue.", path: page("midtown", "Reception: alerts"), target: { selector: '[data-tour="map-to-issue"]' } },
    { title: "Fix approval", body: "Fixes: what the team learned, applied fleet-wide. A fix saved by a Tier 1 stays private until an Admin, or a Tier 2 with the permission, approves it. Review the solution and the configuration it was recorded on, then approve.", path: page("midtown", "Known fixes"), target: { selector: '[data-tour="fix-approve"]' }, missing: "Nothing is waiting. If you've already approved it, the demo can be reset from Admin, Set up and demo." },
    { title: "Learned fixes on the alert", body: "Approved fixes are shown on the alert beside the problem, with the differences from the cabinet they were recorded on. Alerts with a known fix carry a marker in every list, so the next occurrence starts from the answer.", path: page("midtown", "Reception: alerts"), target: { selector: ".known-fixes" }, missing: "The fix shows here once the error is mapped to the Fingerprint scanner issue (two steps back) and the teammate's fix is approved." },
    { title: "Enrollment: install the agent", body: "Admin, Set up: create a one-time token and run the install commands in an elevated PowerShell on the cabinet. The agent connects out to the server over mutual TLS; nothing connects in.", path: "/admin/setup", target: { selector: '[data-tour="create-token"]' } },
    { title: "Enrollment: approve the cabinet", body: "Pending cabinets: check the host name and serial number, then assign a client, site, name and role. Nothing is accepted until an Admin approves it.", path: "/admin/pending", target: { selector: '[data-tour="approve-cabinet"]' }, missing: "Nothing is waiting yet. The computer shows up here within a minute of running the install commands, and this list refreshes by itself." },
    { title: "Live verification", body: "Runs the read-only checks against the real machine: system information, event logs, services, firewall, time, network, packet loss, path, performance and listening ports. Each reports what it read or why it could not.", path: "/admin/setup#live-check", target: { selector: '[data-tour="live-run"]' } },
    { title: "Network reading from a live cabinet", body: "Network, Diagnose network on the enrolled cabinet: link, address, DHCP or fixed, gateway, DNS, lease, routes and path, straight from the machine. If the site has no baseline, the site page can set one from this cabinet's configuration.", path: page("real", ""), target: { selector: '[data-tour="diagnose"]' } },
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
export function startDemoTour(tour = "network") { window.dispatchEvent(new CustomEvent("demo-tour", { detail: tour })); }

export function DemoTour() {
  const { navigate, path } = useRouter();
  const [place, setPlace] = useState<Place | null>(read);
  const [scenarios, setScenarios] = useState<Scenarios>({});
  const [opening, setOpening] = useState<string | null>(null);
  const [left, setLeft] = useState(false);
  const { me } = useSession();
  // Setting the demo up: the guided demo only works from a fleet in its starting state, so an Admin confirms setting it up (or resetting it).
  const [setup, setSetup] = useState<{ tour: string; reset: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const start = useCallback((tour: string) => {
    write({ tour, step: 0 }); setPlace({ tour, step: 0 }); setOpening(window.location.pathname + window.location.search);
  }, []);
  useEffect(() => {
    const on = async (e: Event) => {
      const tour = (e as CustomEvent<string>).detail ?? "network";
      setNotice(null);
      try {
        const status = await api<{ enabled: boolean; storyReady: boolean }>("GET", "/api/demo");
        if (status.storyReady) start(tour);
        else if (me.role === "admin") setSetup({ tour, reset: status.enabled });
        else setNotice(status.enabled ? "The demo has been used already. Ask an Admin to reset it (Admin, Set up and demo), then start again." : "Demo mode is off. Ask an Admin to turn it on, then start the guided demo.");
      } catch (err) { setNotice(describeError(err)); }
    };
    window.addEventListener("demo-tour", on);
    return () => window.removeEventListener("demo-tour", on);
  }, [me.role, start]);
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
    if (s.ensure) void s.ensure({ navigate, scenarios });
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
  const body = setup ? (setup.reset ? { enabled: true as const, reset: true as const } : { enabled: true as const }) : {};
  const dialog = (
    <StepUpDialog open={setup !== null} action="demo.change" target="fleet" params={body} onClose={() => setSetup(null)}
      description={<p>{setup?.reset ? "The guided demo needs the demo fleet in its starting state, and it has been used. This deletes the simulated fleet and builds it again." : "The guided demo needs the simulated fleet. This adds it."} Real cabinets are never touched.</p>}
      onToken={async token => {
        const tour = setup!.tour;
        await api("PUT", "/api/admin/demo", { ...body, stepUpToken: token });
        window.dispatchEvent(new Event("demo-changed"));
        start(tour);
      }} />
  );
  if (place === null || step === null || !steps[step]) return (<>
    {dialog}
    {notice && <aside className="demo-tour" role="alert"><p>{notice}</p><button className="btn small" onClick={() => setNotice(null)}>Close</button></aside>}
  </>);
  const s = steps[step];
  return (<>
    {dialog}
    <aside className={`demo-tour${left ? " left" : ""}`} aria-labelledby="demo-tour-title" aria-live="polite">
      <p className="muted small">Guided demo · {TOURS[place.tour]!.name} · step {step + 1} of {steps.length}</p>
      <h2 id="demo-tour-title">{s.title}</h2>
      <p>{s.body}</p>
      {found === "looking" && <p className="muted small" role="status">Finding it on the page…</p>}
      {found === "missing" && <p className="small error" role="status">{s.missing ?? "It isn't on this page yet."} Click Show me to look again.</p>}
      <div className="row gap wrap">
        <button className="btn small" disabled={step === 0} onClick={() => go(step - 1)}>Back</button>
        {step < steps.length - 1 ? <button className="btn small primary" onClick={() => go(step + 1)}>Next</button>
          : <button className="btn small primary" onClick={() => go(null)}>Finish</button>}
        <button className="btn small ghost" onClick={() => { go(step); setLooks(n => n + 1); }}>Show me</button>
        <button className="btn small ghost" onClick={() => setLeft(l => !l)} aria-label="Move this panel to the other side of the screen" title="Move panel">{left ? "⇥" : "⇤"}</button>
        <button className="btn small ghost" onClick={() => go(null)} aria-label="Stop the guided demo">Stop</button>
      </div>
    </aside>
  </>);
}
