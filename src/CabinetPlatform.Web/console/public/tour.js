// Getting-started wizard. A short guided tour that spotlights each part of the
// Console and explains it. Shown once to each person after their first sign-in
// (remembered per user in this browser) and available again from Settings.
import { h } from "./ui.js";

const key = userId => `cabinet-tour-done:${userId}`;
export function tourDone(userId) {
  try { return localStorage.getItem(key(userId)) === "1"; } catch { return false; }
}
function markDone(userId) {
  try { localStorage.setItem(key(userId), "1"); } catch { /* storage unavailable: the tour may show again */ }
}

function steps(ctx) {
  const admin = ctx.isAdmin;
  const list = [
    {
      title: `Welcome to Cabinet Support, ${ctx.session.user.displayName.split(" ")[0]}`,
      body: [
        "This Console lets you check on CUBEX and Zimbis cabinets without remoting into them. Each cabinet runs a small Windows Agent that reports its health and answers read-only diagnostics.",
        admin
          ? "You are an Administrator: you can do everything support staff can, plus approve new cabinets and manage staff accounts."
          : "You are on the support team: you can view every cabinet, run read-only diagnostics and work alerts.",
        "This tour takes about a minute. You can leave at any time and take it again from Settings.",
      ],
    },
    { target: "[data-nav=dashboard]", route: "/", title: "Dashboard", body: ["Your starting point: how many cabinets are healthy, need attention or are offline, plus open alerts and the latest diagnostics. Click any number to see those cabinets."] },
    { target: "#global-search", title: "Search", body: ["Find a cabinet by its name, hostname, client or site from any page. Press Enter to search."] },
    {
      target: "[data-nav=cabinets]", route: "/cabinets", title: "Cabinets",
      body: [
        "Every cabinet with its health, CPU, memory, disk and last check-in. Open one to see its tabs: overview, performance, processes, services, storage, network, updates, events and system.",
        "Each cabinet has a role. Sync holds the site's database, Satellite syncs to it, and Standalone is the only cabinet at its site.",
      ],
    },
    { target: "[data-nav=sites]", route: "/sites", title: "Clients and sites", body: ["Clients contain sites, and sites contain cabinets. A site page shows all of its cabinets together, which helps when a problem affects a whole location."] },
    {
      target: "[data-nav=activity]", route: "/activity", title: "Diagnostics",
      body: [
        "Inside a cabinet, use Run diagnostic to ask the Agent for something live, such as the process list or an event log view. “Recent errors and warnings” is the best first look on any machine.",
        "Diagnostics only read; they never change the cabinet. Results usually arrive within a minute. This page lists everything the team has requested.",
      ],
    },
    { target: "[data-nav=alerts]", route: "/alerts", title: "Alerts", body: ["Connectivity alerts appear here when a cabinet repeatedly cannot reach its site's sync cabinet. Acknowledge one to tell the team you are on it, and resolve it with a note when you are done."] },
    { target: "[data-nav=audit]", route: "/audit", title: "Audit log", body: ["Every sign-in, cabinet view, diagnostic and decision is recorded with who did it and when. It cannot be edited from the Console."] },
  ];
  if (admin) list.push(
    {
      target: "[data-nav=enrollment]", route: "/admin/enrollment", title: "Onboarding a new cabinet",
      body: [
        "1. Install the Windows Agent on the cabinet PC (see Settings → Connect a real cabinet).",
        "2. It registers itself and waits here. Nothing reaches the fleet until you approve it.",
        "3. Check the machine ID matches the installer's output, then approve it and choose its client, site and role. It appears under Cabinets within a minute.",
      ],
    },
    { target: "[data-nav=staff]", route: "/admin/staff", title: "Staff accounts", body: ["Add support staff and administrators with a generated temporary password. Each person sets their own password at first sign-in. You can also unlock, deactivate or sign people out everywhere."] },
  );
  list.push(
    {
      target: "[data-nav=settings]", route: "/settings", title: "Settings: Live and Demo",
      body: [
        "Live shows only real cabinets. Demo adds a sample fleet for training and sales demos; your real cabinets stay in the list, marked ● LIVE, with real data.",
        "You can also change the theme and take this tour again here.",
      ],
    },
    { title: "You're ready", body: ["Start on the dashboard, or try Demo mode to explore a full sample fleet first."], final: true },
  );
  return list;
}

let active = null;

export function startTour(ctx, { onFinish } = {}) {
  if (active) active.close(false);
  const all = steps(ctx);
  let index = 0;
  const previousFocus = document.activeElement;
  const narrow = () => matchMedia("(max-width: 900px)").matches;

  const spotlight = h("div", { class: "tour-spotlight", "aria-hidden": "true" });
  const card = h("div", { class: "tour-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "tour-title", tabindex: "-1" });
  const layer = h("div", { class: "tour-layer" }, spotlight, card);
  document.body.append(layer);

  const close = finished => {
    window.removeEventListener("resize", place);
    window.removeEventListener("keydown", onKey, true);
    document.body.classList.remove("nav-open", "touring");
    layer.remove();
    active = null;
    markDone(ctx.session.user.id);
    previousFocus?.focus?.();
    onFinish?.(finished);
  };

  function place() {
    const step = all[index];
    const target = step.target ? document.querySelector(step.target) : null;
    const rect = target?.getBoundingClientRect();
    if (!rect || rect.width === 0) {
      spotlight.hidden = true;
      card.classList.add("centered");
      card.style.top = card.style.left = "";
      return;
    }
    const pad = 6;
    spotlight.hidden = false;
    Object.assign(spotlight.style, { top: `${rect.top - pad}px`, left: `${rect.left - pad}px`, width: `${rect.width + pad * 2}px`, height: `${rect.height + pad * 2}px` });
    card.classList.remove("centered");
    const cw = card.offsetWidth, ch = card.offsetHeight, gap = 16;
    let left = rect.right + gap, top = rect.top - 8;
    if (left + cw > window.innerWidth - 12) { left = Math.max(12, Math.min(rect.left, window.innerWidth - cw - 12)); top = rect.bottom + gap; }
    top = Math.max(12, Math.min(top, window.innerHeight - ch - 12));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function render() {
    const step = all[index];
    if (step.route && ctx.currentPath() !== step.route) ctx.navigate(step.route);
    document.body.classList.toggle("nav-open", narrow() && Boolean(step.target) && step.target !== "#global-search");
    const last = index === all.length - 1;
    card.replaceChildren(
      h("div", { class: "tour-progress", "aria-hidden": "true" }, all.map((_, i) => h("span", { class: i === index ? "on" : i < index ? "done" : "" }))),
      h("p", { class: "eyebrow" }, `Step ${index + 1} of ${all.length}`),
      h("h2", { id: "tour-title" }, step.title),
      ...step.body.map(text => h("p", null, text)),
      h("div", { class: "tour-actions" },
        last ? null : h("button", { class: "btn ghost", onclick: () => close(false) }, "Skip tour"),
        h("span", { class: "spacer" }),
        index > 0 ? h("button", { class: "btn", onclick: () => go(index - 1) }, "Back") : null,
        step.final && !ctx.isDemo && ctx.session.demoAvailable
          ? h("button", { class: "btn", onclick: () => { close(true); ctx.setMode("demo").catch(() => {}); } }, "Try Demo mode")
          : null,
        h("button", { class: "btn primary", onclick: () => (last ? close(true) : go(index + 1)) }, last ? "Finish" : "Next")));
    // Let the route render and layout settle before measuring the target.
    requestAnimationFrame(() => requestAnimationFrame(() => { place(); card.focus({ preventScroll: true }); }));
  }
  const go = i => { index = Math.max(0, Math.min(all.length - 1, i)); render(); };

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(false); }
    else if (e.key === "ArrowRight" && !e.target.closest?.("input,textarea,select")) go(index + 1);
    else if (e.key === "ArrowLeft" && !e.target.closest?.("input,textarea,select")) go(index - 1);
    else if (e.key === "Tab") {
      // Keep keyboard focus inside the tour card while it is open.
      const focusable = [...card.querySelectorAll("button")];
      if (!focusable.length) return;
      const first = focusable[0], lastEl = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
      else if (!card.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    }
  }

  window.addEventListener("resize", place);
  window.addEventListener("keydown", onKey, true);
  document.body.classList.add("touring");
  active = { close };
  render();
}
