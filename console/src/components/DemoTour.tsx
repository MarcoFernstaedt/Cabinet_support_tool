// The guided demo tour (docs/platform/demo.md): a small panel at the side of the page, not a popup, that walks a presenter
// through the platform while they use the real console. Each step says what to show and opens the right page; the
// presenter can skip, go back, stop or start again at any time. Its position is kept for this browser tab only.
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, describeError } from "../lib/api";
import { useSession } from "../lib/session";
import { StepUpDialog } from "./ui";
import { useRouter } from "../lib/router";
import { useSpotlight, type Target } from "../lib/spotlight";

interface Step {
  title: string; body: string; path: string | ((s: Scenarios) => string | null); target?: Target;
  /** What to say when the control never shows up (nothing has happened yet that would put it there). */
  missing?: string;
  /** Gets the page ready when the step is reached by Next or Show me without the person having done the earlier click. */
  ensure?: (ctx: { navigate: (to: string) => void; scenarios: Scenarios }) => Promise<void>;
  /** What the person must do before Next works, and how the page shows it was done. Only asked for while the control is on the page. */
  action?: { label: string; done: () => boolean };
}
const text = (selector: string, needle: string) => [...document.querySelectorAll(selector)].some(e => (e.textContent ?? "").includes(needle));
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
    { title: "Site overview", body: "The site page lists every cabinet with its role, status and open alerts, plus the site's network baseline and standards. Use it to scope a problem across the site before opening any machine. Here, the exam rooms report sync failures.", path: page("midtown", "The site") },
    { title: "Single-cabinet network diagnosis", body: "Diagnose network checks link, address, gateway, DNS, the sync cabinet and the firewall in order, and stops at the first broken layer with the readings behind it. This replaces remoting in to run ipconfig, ping and tracert by hand.", path: page("midtown", "One cabinet"), target: { selector: '[data-tour="diagnose"]' }, action: { label: "Click Diagnose network and wait for the results.", done: () => !!document.querySelector(".finding") } },
    { title: "Site-wide network diagnosis", body: "The same diagnosis for every cabinet at the site in one run, grouped by cause. This replaces opening each cabinet in turn.", path: page("midtown", "The site"), target: { selector: '[data-tour="site-diagnose"]' }, action: { label: "Click Diagnose network for the whole site.", done: () => window.location.pathname.startsWith("/network/diagnosis/") } },
    { title: "Diagnosis results", body: "Results are grouped by cause, each with its evidence and the cabinets it affects. Here the network is fine through DNS everywhere and the satellites fail at the sync cabinet, which has its firewall on where the client's policy says off.", path: "", target: { selector: '[data-tour="group-sync-firewall"]' }, ensure: siteCheck },
    { title: "Remediation", body: "A group's fix applies from here: confirm once, and the change is recorded in the audit log. The cabinet restores its previous setting itself if it loses contact with the platform, and the site is checked again when the change completes.", path: "", target: { selector: '[data-tour="fix-apply_policy"]' }, ensure: siteCheck, action: { label: "Click Apply the policy on Midtown Sync and confirm.", done: () => text(".notice.ok", "Done:") } },
    { title: "Full network reading", body: "Matching the baseline does not mean healthy. The full reading lists packet loss, jitter, adapter errors, DHCP lease, routes, ARP and the path, so a failing cable shows up here. After a physical repair, run the diagnosis again: once the problem is gone, Save what fixed this stores the fix with the cabinet's configuration, and is offered only for fixes that are new.", path: page("midtown", "Operating Room"), target: { selector: '[data-tour="full-read"]' }, action: { label: "Open Everything that was read.", done: () => !!document.querySelector('details[data-tour="full-read"][open]') } },
    { title: "Cash drawer check", body: "A drawer that is down is checked from here: whether its link shows up as an adapter, its IPv4 settings, packet counters over a few seconds, and the firewall, which must be off for the drawer to work. This cabinet's firewall is on, so the check finds it; applying the client's policy turns it off. This replaces opening Network connections on the machine.", path: page("midtown", "Cash drawer"), target: { selector: '[data-tour="drawer-check"]' },
      action: { label: "Click Check drawer, apply the client's firewall policy, and check again until the firewall reads off.", done: () => text('[data-tour="drawer-check"]', "Off on every profile") } },
    { title: "Fingerprint scanner history", body: "The scanner page lists each disconnect with its time and USB port, the driver and when it was installed, hub and controller state, and the biometric service. A drop that follows a driver install points at the driver; a drop with no change points at the cable or port. Read the timeline, then the USB ports table below it: the scanner shows as not connected, with the hub and port it was last on, and the port with a failed device is flagged.", path: page("midtown", "Procedure Room"), target: { selector: '[data-tour="scanner-drops"]' } },
    { title: "Service start type", body: "Services lists every service with its state and start type. A service set to Disabled cannot be started, by Windows or by anyone; a Tier 1 or Tier 2 can set it back to Manual or Automatic without a remote session. The change is read back from the cabinet.", path: page("midtown", "Service start type"), target: { selector: '[data-tour="start-type"]' },
      action: { label: "Click Change… on the disabled service, choose Manual, review and confirm.", done: () => text("body", "start type changed from") } },
    { title: "Unrecognized alerts", body: "Events that match no rule are listed as unrecognized alerts instead of being discarded. Group them by source to see which error repeats across cabinets. Here two cabinets log errors from the same fingerprint reader driver.", path: page("midtown", "Unrecognized"), target: { selector: '[data-cabinet="Reception"]' } },
    { title: "Event log inspection", body: "Event logs can be filtered by level, time, source and event ID, and each entry shows how many other cabinets logged the same event in the last 30 days: a local fault or a fleet-wide one. This replaces opening Event Viewer on the machine.", path: page("midtown", "Reception: event"), target: { selector: '[data-tour="event-entry"]', text: "Biometrics" }, action: { label: "Open an entry in the log.", done: () => !!document.querySelector("#entry-heading") } },
    { title: "Event-to-issue mapping", body: "Map to issue ties an event (log, source and event ID, never a pattern) to an issue type. The preview lists the stored events the rule would match before anything changes; a Tier 2 confirms with the authenticator. After that, the same event on any cabinet is grouped under the issue.", path: page("midtown", "Reception: alerts"), target: { selector: '[data-tour="map-to-issue"]' }, action: { label: "Click Map to issue, choose the issue and save the rule.", done: () => text("body", "The rule is live") } },
    { title: "Fix approval", body: "A fix saved by a Tier 1 stays private until an Admin, or a Tier 2 with the permission, approves it. Review the solution and the configuration it was recorded on, then approve, so only reviewed fixes are offered to the whole team.", path: page("midtown", "Known fixes"), target: { selector: '[data-tour="fix-approve"]' }, missing: "Nothing is waiting. If you've already approved it, the demo can be reset from Admin, Set up and demo.", action: { label: "Review the fix and click Approve.", done: () => text("body", "Approved “") } },
    { title: "Learned fixes on the alert", body: "Approved fixes appear on the alert beside the problem, with the differences between this cabinet and the one the fix was recorded on. Alerts with a known fix carry a marker in every list, so the next occurrence starts from the answer.", path: page("midtown", "Reception: alerts"), target: { selector: ".known-fixes" }, missing: "The fix shows here once the error is mapped to the Fingerprint scanner issue (two steps back) and the teammate's fix is approved." },
    { title: "Enrollment: install the agent", body: "Admin, Set up: create a one-time token and run the install commands in an elevated PowerShell on the cabinet. The agent connects out to the server over mutual TLS; nothing connects in.", path: "/admin/setup", target: { selector: '[data-tour="create-token"]' }, action: { label: "Click Create install token.", done: () => !!document.querySelector('a[download="token.txt"]') } },
    { title: "Enrollment: approve the cabinet", body: "Pending cabinets: check the host name and serial number, then assign a client, site, name and role. Nothing is accepted until an Admin approves it.", path: "/admin/pending", target: { selector: '[data-tour="approve-cabinet"]' }, missing: "Nothing is waiting yet. The computer shows up here within a minute of running the install commands, and this list refreshes by itself.", action: { label: "Fill in the client and site and approve the cabinet.", done: () => text("body", "will come online within a minute") } },
    { title: "Live verification", body: "Runs the read-only checks against the real machine: system information, event logs, services, firewall, time, network, packet loss, path, performance and listening ports. Each reports what it read or why it could not.", path: "/admin/setup#live-check", target: { selector: '[data-tour="live-run"]' } },
    { title: "Network reading from a live cabinet", body: "On the enrolled cabinet, Network shows Packets and path (loss, jitter and a hop-by-hop table per target) and Diagnose network (link, address, DHCP or fixed, gateway, DNS, lease, routes and path), read from the machine. If the site has no baseline yet, the site page can set one from this cabinet's configuration.", path: page("real", ""), target: { selector: '[data-tour="diagnose"]' } },
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
    try { for (const k of Object.keys(sessionStorage)) if (k.startsWith("demo-step-done:")) sessionStorage.removeItem(k); } catch { /* storage unavailable */ }
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
  const step = place?.step ?? null;
  const { found, el: targetEl, spot, pos, dim, panel, lookAgain } = useSpotlight(place ? steps[place.step]?.target : undefined, `${place?.tour}:${place?.step}:${path}`);
  // "Focus" in the guide turns the dimming off.
  const [focus, setFocus] = useState(true);
  // A step that asks for something is complete once the page shows it was done; that is remembered, so going back and forward never asks twice.
  const action = place && step !== null ? steps[step]?.action : undefined;
  const [complete, setComplete] = useState(false);
  useEffect(() => {
    if (!action || !place) { setComplete(false); return; }
    const key = `demo-step-done:${place.tour}:${place.step}`;
    try { if (sessionStorage.getItem(key)) { setComplete(true); return; } } catch { /* storage unavailable */ }
    setComplete(false);
    const t = setInterval(() => {
      let ok = false;
      try { ok = action.done(); } catch { ok = false; }
      if (ok) { try { sessionStorage.setItem(key, "1"); } catch { /* storage unavailable */ } setComplete(true); clearInterval(t); }
    }, 150);
    return () => clearInterval(t);
  }, [place?.tour, place?.step]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const gated = !!action && (found === "found" || !s.target);
  return (<>
    {dialog}
    {focus && dim && spot && <div className="tour-spot" aria-hidden="true" style={spot} />}
    <aside ref={panel} className={`demo-tour${left ? " left" : ""}${pos ? " anchored" : ""}`} aria-labelledby="demo-tour-title" aria-live="polite" style={pos ? { top: pos.top, left: pos.left } : undefined}>
      <p className="muted small">Guided demo · {TOURS[place.tour]!.name} · step {step + 1} of {steps.length}</p>
      <h2 id="demo-tour-title">{s.title}</h2>
      <p>{s.body}</p>
      {found === "looking" && <p className="muted small" role="status">Finding it on the page…</p>}
      {found === "missing" && <p className="small error" role="status">{s.missing ?? "It isn't on this page yet."} Try Look again.</p>}
      {gated && <p className={`small ${complete ? "ok" : "muted"}`} role="status">{complete ? "Done." : `To continue: ${action!.label}`}</p>}
      <div className="row gap wrap">
        <button className="btn small" disabled={step === 0} onClick={() => go(step - 1)}>Back</button>
        {step < steps.length - 1 ? <button className="btn small primary" disabled={gated && !complete} onClick={() => go(step + 1)}>Next</button>
          : <button className="btn small primary" onClick={() => go(null)}>Finish</button>}
        {found === "missing" && <button className="btn small ghost" onClick={() => { go(step); lookAgain(); }}>Look again</button>}
        {targetEl && <button className="btn small ghost" aria-pressed={focus} onClick={() => setFocus(f => !f)} title="Dim everything except what this step is about">Focus {focus ? "on" : "off"}</button>}
        <button className="btn small ghost" onClick={() => setLeft(l => !l)} aria-label="Move this panel to the other side of the screen" title="Move panel">{left ? "⇥" : "⇤"}</button>
        <button className="btn small ghost" onClick={() => go(null)} aria-label="Stop the guided demo">Stop</button>
      </div>
    </aside>
  </>);
}
