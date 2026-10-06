import { get, post, request, setCsrf, onSessionExpired } from "./api.js";
import { h, clear, toast, roleLabel, loading, errorBox } from "./ui.js";
import { dashboardView, cabinetsView, cabinetView, sitesView, siteView, alertsView, activityView, auditView } from "./views-support.js";
import { enrollmentView, staffView } from "./views-admin.js";
import { settingsView } from "./views-settings.js";
import { startTour, tourDone } from "./tour.js";

const app = document.getElementById("app");
const ctx = {
  session: null,
  get isAdmin() { return ctx.session?.user.role === "Supervisor"; },
  get isDemo() { return ctx.session?.mode === "demo"; },
};

// --- Theme ---------------------------------------------------------------------
// "dark", "light" or "system" (follow the operating system).
function applyTheme(choice, persist = true) {
  const resolved = choice === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : choice;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeChoice = choice;
  if (persist) try { localStorage.setItem("console-theme", choice); } catch { /* storage unavailable */ }
}
let savedTheme = null;
try { savedTheme = localStorage.getItem("console-theme"); } catch { /* storage unavailable */ }
applyTheme(["dark", "light", "system"].includes(savedTheme) ? savedTheme : "dark", false);
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (document.documentElement.dataset.themeChoice === "system") applyTheme("system", false);
});
ctx.applyTheme = applyTheme;

// --- Routing --------------------------------------------------------------------
const routes = [
  { re: /^\/$/, view: dashboardView, nav: "dashboard", title: "Dashboard" },
  { re: /^\/cabinets$/, view: cabinetsView, nav: "cabinets", title: "Cabinets" },
  { re: /^\/cabinets\/([0-9a-f-]{36})(?:\/([a-z]+))?$/i, view: cabinetView, nav: "cabinets", title: "Cabinet" },
  { re: /^\/sites$/, view: sitesView, nav: "sites", title: "Sites" },
  { re: /^\/sites\/([0-9a-f-]{36})$/i, view: siteView, nav: "sites", title: "Site" },
  { re: /^\/alerts$/, view: alertsView, nav: "alerts", title: "Connectivity alerts" },
  { re: /^\/activity$/, view: activityView, nav: "activity", title: "Diagnostics activity" },
  { re: /^\/audit$/, view: auditView, nav: "audit", title: "Audit log" },
  { re: /^\/admin\/enrollment$/, view: enrollmentView, nav: "enrollment", title: "Cabinet enrollment", admin: true },
  { re: /^\/admin\/staff$/, view: staffView, nav: "staff", title: "Staff accounts", admin: true },
  { re: /^\/account$/, view: accountView, nav: "account", title: "My account" },
  { re: /^\/settings$/, view: settingsView, nav: "settings", title: "Settings" },
];

export function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, query = ""] = raw.split("?");
  return { path, query: Object.fromEntries(new URLSearchParams(query)) };
}
ctx.currentPath = () => parseHash().path;
ctx.startTour = () => startTour(ctx);
ctx.navigate = (path, query) => {
  const q = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== "" && v != null)).toString() : "";
  location.hash = `#${path}${q ? `?${q}` : ""}`;
};

let renderToken = 0;
async function render() {
  if (!ctx.session) return;
  if (ctx.session.user.mustChangePassword) return renderForcedPasswordChange();
  const { path, query } = parseHash();
  const route = routes.find(r => r.re.test(path));
  ensureShell();
  const main = document.getElementById("main");
  const token = ++renderToken;
  if (!route) { clear(main).append(h("div", { class: "empty" }, h("h1", null, "Page not found"), h("a", { href: "#/" }, "Go to dashboard"))); return; }
  if (route.admin && !ctx.isAdmin) { clear(main).append(errorBox({ title: "Administrator access is required for this page." })); return; }
  highlightNav(route.nav);
  document.title = `${route.title} · Cabinet Support`;
  clear(main).append(loading());
  const params = path.match(route.re).slice(1);
  try {
    const node = await route.view({ params, query, ctx });
    if (token !== renderToken) return; // a newer navigation won
    clear(main).append(node);
    main.focus({ preventScroll: true });
  } catch (err) {
    if (token !== renderToken) return;
    if (err?.status === 401) return;
    clear(main).append(errorBox(err, render));
  }
}
ctx.rerender = render;
window.addEventListener("hashchange", render);

// --- Shell ------------------------------------------------------------------------
function navItem(id, href, label, icon, badgeId) {
  return h("a", { class: "nav-item", href, dataset: { nav: id } },
    h("span", { class: "nav-icon", "aria-hidden": "true" }, icon), h("span", { class: "nav-text" }, label),
    badgeId ? h("span", { class: "nav-badge", id: badgeId, hidden: true }) : null);
}

function ensureShell() {
  if (document.getElementById("main")) return;
  const user = ctx.session.user;
  const search = h("input", { type: "search", id: "global-search", placeholder: "Search cabinets, hostnames, sites…", "aria-label": "Search cabinets", maxlength: 100, autocomplete: "off" });
  const shell = h("div", { class: "shell" },
    h("a", { class: "skip", href: "#main", onclick: e => { e.preventDefault(); document.getElementById("main").focus(); } }, "Skip to content"),
    h("aside", { class: "sidebar", "aria-label": "Primary" },
      h("a", { class: "brand", href: "#/" }, h("span", { class: "brand-mark", "aria-hidden": "true" }, "M"), h("span", null, h("strong", null, "Mashura"), h("small", null, "Cabinet Support"))),
      h("nav", { "aria-label": "Workspace" },
        h("div", { class: "nav-label" }, "Workspace"),
        navItem("dashboard", "#/", "Dashboard", "◧"),
        navItem("cabinets", "#/cabinets", "Cabinets", "▤"),
        navItem("sites", "#/sites", "Sites", "⌂"),
        navItem("alerts", "#/alerts", "Alerts", "⚑", "badge-alerts"),
        navItem("activity", "#/activity", "Diagnostics", "⟳"),
        navItem("audit", "#/audit", "Audit log", "☰")),
      ctx.isAdmin ? h("nav", { "aria-label": "Administration" },
        h("div", { class: "nav-label" }, "Administration"),
        navItem("enrollment", "#/admin/enrollment", "Enrollment", "＋", "badge-enrollment"),
        navItem("staff", "#/admin/staff", "Staff accounts", "☺")) : null,
      h("nav", { "aria-label": "Preferences" },
        navItem("settings", "#/settings", "Settings", "⚙")),
      h("div", { class: "sidebar-foot" },
        h("a", { class: "user-card", href: "#/account", dataset: { nav: "account" } },
          h("span", { class: "avatar", "aria-hidden": "true" }, initials(user.displayName)),
          h("span", null, h("strong", null, user.displayName), h("small", null, roleLabel(user.role)))))),
    h("div", { class: "workspace" },
      h("header", { class: "topbar" },
        h("button", { class: "btn ghost menu-toggle", "aria-label": "Toggle navigation", onclick: () => document.body.classList.toggle("nav-open") }, "☰"),
        h("form", { class: "search", role: "search", onsubmit: e => { e.preventDefault(); ctx.navigate("/cabinets", { search: search.value.trim() }); } }, search),
        h("div", { class: "top-actions" },
          h("button", { class: "btn ghost", title: "Toggle light/dark theme", "aria-label": "Toggle theme", onclick: () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark") }, "◐"),
          ctx.isDemo ? h("a", { class: "mode-pill", href: "#/settings", title: "Demo mode: sample data. Click to change." }, "Demo data") : null,
          h("span", { class: `role-pill ${ctx.isAdmin ? "admin" : ""}` }, roleLabel(user.role)),
          h("button", { class: "btn ghost", onclick: signOut }, "Sign out"))),
      ctx.isDemo ? h("div", { class: "demo-banner", role: "note" },
        h("strong", null, "Demo mode"),
        h("span", null, " — sample cabinets are shown alongside your real ones (marked ● LIVE). Changes to sample cabinets stay in this session; diagnostics and decisions on LIVE items are real."),
        h("button", { class: "btn small", onclick: () => ctx.setMode("live") }, "Switch to live data")) : null,
      h("main", { id: "main", tabindex: "-1" })));
  clear(app).append(shell);
  document.addEventListener("click", e => { if (e.target.closest(".sidebar a")) document.body.classList.remove("nav-open"); });
  refreshBadges();
}

function highlightNav(id) {
  for (const a of document.querySelectorAll("[data-nav]")) {
    const on = a.dataset.nav === id;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
}

const initials = name => String(name).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";

function setBadge(id, n) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = !n;
  el.textContent = n > 99 ? "99+" : String(n);
}
let badgeTimer = null;
async function refreshBadges() {
  clearTimeout(badgeTimer);
  if (!ctx.session || ctx.session.user.mustChangePassword) return;
  try {
    const [health, alerts] = await Promise.all([get("/api/fleet/health"), get("/api/connectivity-alerts", { pageSize: 1 })]);
    setBadge("badge-enrollment", health.pendingRegistrations);
    setBadge("badge-alerts", alerts.totalCount);
  } catch { /* badges are best effort */ }
  badgeTimer = setTimeout(refreshBadges, 30_000);
}
ctx.refreshBadges = refreshBadges;

// Switching data source rebuilds the shell so every view, badge and banner
// reflects the new source; nothing from the previous mode is reused.
ctx.setMode = async mode => {
  const session = await post("/auth/mode", { mode });
  setSession(session);
  clear(app);
  toast(mode === "demo" ? "Demo mode on. You are viewing sample data." : "Live mode on. You are viewing real cabinets.", "success");
  if (location.hash === "#/" || location.hash === "") render(); else location.hash = "#/";
};

// --- Authentication ----------------------------------------------------------------
async function signOut() {
  try { await post("/auth/logout"); } catch { /* already gone */ }
  ctx.session = null;
  setCsrf(null);
  renderLogin("You have signed out.");
}

onSessionExpired(() => {
  if (!ctx.session) return;
  ctx.session = null;
  renderLogin("Your session ended. Sign in again to continue.");
});

function authFrame(...content) {
  return h("div", { class: "auth" },
    h("div", { class: "auth-card" },
      h("div", { class: "brand big" }, h("span", { class: "brand-mark", "aria-hidden": "true" }, "M"), h("span", null, h("strong", null, "Mashura"), h("small", null, "Cabinet Support Console"))),
      ...content),
    h("p", { class: "auth-foot" }, "Authorized support staff only. Activity is audited."));
}

function renderLogin(message) {
  document.title = "Sign in · Cabinet Support";
  const errorEl = h("p", { class: "form-error", role: "alert", hidden: true });
  const user = h("input", { id: "username", name: "username", autocomplete: "username", required: true, maxlength: 64, autofocus: true });
  const pass = h("input", { id: "password", name: "password", type: "password", autocomplete: "current-password", required: true, maxlength: 256 });
  const button = h("button", { class: "btn primary block", type: "submit" }, "Sign in");
  const form = h("form", { class: "auth-form", onsubmit: async e => {
    e.preventDefault();
    errorEl.hidden = true;
    button.disabled = true;
    button.textContent = "Signing in…";
    try {
      const session = await request("POST", "/auth/login", { username: user.value.trim(), password: pass.value });
      start(session);
    } catch (err) {
      errorEl.hidden = false;
      errorEl.textContent = err.title ?? "Sign-in failed.";
      pass.value = "";
      button.disabled = false;
      button.textContent = "Sign in";
      pass.focus();
    }
  } },
  h("h1", null, "Sign in"),
  h("p", { class: "muted" }, "Use the account your administrator created for you."),
  message ? h("p", { class: "notice" }, message) : null,
  h("div", { class: "field" }, h("label", { for: "username" }, "Username"), user),
  h("div", { class: "field" }, h("label", { for: "password" }, "Password"), pass),
  errorEl, button,
  h("p", { class: "hint auth-help" }, "Forgot your password or locked out? Ask a Cabinet Support administrator to unlock your account."));
  clear(app).append(authFrame(form));
  user.focus();
}

function passwordForm({ heading, intro, onDone, cancel }) {
  const errorEl = h("p", { class: "form-error", role: "alert", hidden: true });
  const current = h("input", { id: "pw-current", type: "password", autocomplete: "current-password", required: true, maxlength: 256 });
  const next = h("input", { id: "pw-new", type: "password", autocomplete: "new-password", required: true, maxlength: 256 });
  const again = h("input", { id: "pw-again", type: "password", autocomplete: "new-password", required: true, maxlength: 256 });
  const button = h("button", { class: "btn primary", type: "submit" }, "Change password");
  return h("form", { class: "auth-form", onsubmit: async e => {
    e.preventDefault();
    errorEl.hidden = true;
    if (next.value !== again.value) { errorEl.hidden = false; errorEl.textContent = "The new passwords do not match."; return; }
    if (next.value === current.value) { errorEl.hidden = false; errorEl.textContent = "Choose a password different from the current one."; return; }
    button.disabled = true;
    try {
      const session = await post("/auth/change-password", { currentPassword: current.value, newPassword: next.value });
      onDone(session);
    } catch (err) {
      errorEl.hidden = false;
      errorEl.textContent = err.detail || err.title || "The password could not be changed.";
      button.disabled = false;
      if (err.status === 401) { ctx.session = null; renderLogin(err.title); }
    }
  } },
  heading ? h("h1", null, heading) : null,
  intro ? h("p", { class: "muted" }, intro) : null,
  h("div", { class: "field" }, h("label", { for: "pw-current" }, "Current password"), current),
  h("div", { class: "field" }, h("label", { for: "pw-new" }, "New password"), next, h("small", { class: "hint" }, "At least 12 characters, mixing upper and lower case, digits and symbols.")),
  h("div", { class: "field" }, h("label", { for: "pw-again" }, "Confirm new password"), again),
  errorEl,
  h("div", { class: "row gap" }, button, cancel ?? null));
}

function renderForcedPasswordChange() {
  document.title = "Set your password · Cabinet Support";
  const { user } = ctx.session;
  clear(app).append(authFrame(
    passwordForm({
      heading: `Welcome, ${user.displayName}`,
      intro: user.role === "Supervisor"
        ? "This administrator account was created with a one-time password. Set your own password to finish onboarding. Nothing else is available until you do."
        : "Your account was created with a temporary password. Set your own password to continue.",
      onDone: session => { toast("Password changed. You're all set.", "success"); start(session); },
      cancel: h("button", { type: "button", class: "btn ghost", onclick: signOut }, "Sign out"),
    })));
}

async function accountView() {
  const u = ctx.session.user;
  return h("div", { class: "page narrow" },
    h("header", { class: "page-head" }, h("div", null, h("p", { class: "eyebrow" }, "Account"), h("h1", null, u.displayName), h("p", { class: "muted" }, `${u.username} · ${roleLabel(u.role)}`))),
    h("section", { class: "card" }, h("header", { class: "card-head" }, h("h2", null, "Change password")),
      h("div", { class: "card-body" }, passwordForm({ onDone: session => { toast("Password changed.", "success"); setSession(session); render(); } }))));
}

function setSession(session) {
  ctx.session = session;
  setCsrf(session.csrfToken);
}

function start(session) {
  setSession(session);
  clear(app);
  if (!location.hash || location.hash === "#") location.hash = "#/";
  render();
  // First sign-in (after any required password change): show the getting-started tour once.
  if (!session.user.mustChangePassword && !tourDone(session.user.id)) setTimeout(() => ctx.session && startTour(ctx), 700);
}

// --- Boot -------------------------------------------------------------------------------
(async () => {
  try { start(await get("/auth/session")); }
  catch { renderLogin(); }
})();
