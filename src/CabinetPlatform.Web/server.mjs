import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readBoundedJson, renderCabinet, renderFleet, renderSiteIncidents, validGuid } from "./read-only-pages.mjs";
import { renderEventResult } from "./event-result-page.mjs";

const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/bootstrap.mjs", ["bootstrap.mjs", "text/javascript; charset=utf-8"]],
  ["/login.css", ["login.css", "text/css; charset=utf-8"]],
]);
const escapeHtml = text => String(text).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const page = error => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in | Mashura Support</title><link rel="stylesheet" href="/login.css"></head><body><main class="login"><div class="brand">Mashura <span>Support workspace</span></div><p class="tag">LOCAL DEVELOPMENT BUILD</p><h1>Sign in</h1><p>Use a test support account. This browser build is local only and does not enforce MFA.</p>${error ? '<p class="error" role="alert">Sign-in failed. Check your account or contact an administrator.</p>' : ''}<form method="post" action="/signin"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required maxlength="128"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"><button>Sign in</button></form><small>The Event Viewer shows synthetic records. Read-only fleet and incident pages connect only to the configured local test server; use disposable synthetic data.</small></main></body></html>`;

async function form(req) {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/x-www-form-urlencoded")) throw Error("Invalid form");
  let size = 0, content = "";
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw Error("Form too large");
    content += chunk.toString("utf8");
  }
  return new URLSearchParams(content);
}

export function createPreviewServer(host = "127.0.0.1", { enabled = false, upstreamUrl, upstreamFetch = fetch } = {}) {
  if (host !== "127.0.0.1" && host !== "::1") throw Error("Preview must bind to loopback only");
  if (!enabled) throw Error("Local login requires explicit opt-in");
  let upstream;
  try { upstream = new URL(upstreamUrl); } catch { throw Error("HTTPS upstream origin required"); }
  if (upstream.protocol !== "https:" || upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash)
    throw Error("HTTPS upstream origin required");
  if (upstream.hostname !== "127.0.0.1" && upstream.hostname !== "[::1]")
    throw Error("Local preview requires a loopback upstream; never point it at a staff or production server");
  const sessions = new Map();
  const cookieName = "cabinet_local_dev";
  const api = (path, options) => upstreamFetch(new URL(path, upstream), { ...options, redirect: "manual", signal: options?.signal ?? AbortSignal.timeout(5000), cache: "no-store" });
  const clearCookie = `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;
  return http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const origin = `http://${host === "::1" ? "[::1]" : host}:${req.socket.localPort}`;
    if (req.headers.host !== new URL(origin).host) { res.writeHead(421); res.end("Invalid host"); return; }
    const respond = (status, body, type = "text/plain; charset=utf-8", headers = {}) => { res.writeHead(status, { "Content-Type": type, ...headers }); res.end(body); };
    const redirect = path => respond(303, "", "text/plain; charset=utf-8", { Location: path });
    const sameOrigin = () => req.headers.origin === origin;
    const id = req.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    let session = id && sessions.get(id);
    if (session && (session.expires <= Date.now() || session.expires > Date.now() + 30 * 60 * 1000)) { sessions.delete(id); session = null; }
    if (req.method === "GET" && req.url === "/signin") { respond(200, page(false), "text/html; charset=utf-8"); return; }
    if (req.method === "POST" && req.url === "/signin") {
      if (!sameOrigin()) { respond(403, "Invalid origin"); return; }
      let values;
      try { values = await form(req); } catch { respond(400, "Invalid form"); return; }
      const username = values.get("username"), password = values.get("password");
      if (!username || !password || username.length > 128 || password.length > 1024) { respond(400, "Invalid form"); return; }
      try {
        const login = await api("api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
        if (!login.ok) { respond(403, page(true), "text/html; charset=utf-8"); return; }
        const data = await login.json();
        const expires = Date.parse(data.expiresAtUtc);
        if (!data.accessToken || !Number.isFinite(expires) || expires <= Date.now() || data.mustChangePassword) { respond(403, page(true), "text/html; charset=utf-8"); return; }
        const me = await api("api/auth/me", { headers: { Authorization: `Bearer ${data.accessToken}` } });
        if (!me.ok) { respond(403, page(true), "text/html; charset=utf-8"); return; }
        const user = await me.json();
        if (!user.isActive || user.mustChangePassword || !["Tier1", "Tier2", "Supervisor"].includes(user.role)) { respond(403, page(true), "text/html; charset=utf-8"); return; }
        if (id) sessions.delete(id);
        for (const [key, session] of sessions)
          if (session.expires <= Date.now()) sessions.delete(key);
        if (sessions.size >= 100) { respond(503, "Session capacity reached"); return; }
        const key = randomBytes(32).toString("base64url");
        sessions.set(key, { token: data.accessToken, csrf: randomBytes(32).toString("base64url"), expires: Math.min(expires, Date.now() + 30 * 60 * 1000) });
        res.setHeader("Set-Cookie", `${cookieName}=${key}; Path=/; HttpOnly; SameSite=Strict`);
        redirect("/");
      } catch { respond(502, "Support server unavailable"); }
      return;
    }
    if (req.method === "POST" && req.url === "/signout") {
      if (!sameOrigin() || !session) { respond(403, "Invalid sign-out request"); return; }
      let values;
      try { values = await form(req); } catch { respond(400, "Invalid form"); return; }
      if (values.get("csrf") !== session.csrf) { respond(403, "Invalid sign-out request"); return; }
      sessions.delete(id);
      res.setHeader("Set-Cookie", clearCookie);
      redirect("/signin"); return;
    }
    if (!req.url.startsWith("/") || req.url.startsWith("//")) { respond(404, "Not found"); return; }
    const route = new URL(req.url, origin);
    const fleetRoute = route.pathname === "/fleet";
    const cabinetRoute = /^\/cabinet\/([^/]+)$/.exec(route.pathname);
    const eventRoute = /^\/cabinet\/([^/]+)\/events$/.exec(route.pathname);
    const incidentRoute = /^\/site\/([^/]+)\/incidents$/.exec(route.pathname);
    if (req.method !== "GET" || (!files.has(req.url) && !fleetRoute && !cabinetRoute && !eventRoute && !incidentRoute)) { respond(404, "Not found"); return; }
    if (req.url !== "/login.css") {
      if (!session) { redirect("/signin"); return; }
      try {
        const me = await api("api/auth/me", { headers: { Authorization: `Bearer ${session.token}` } });
        if (!me.ok) { sessions.delete(id); res.setHeader("Set-Cookie", clearCookie); redirect("/signin"); return; }
        const user = await me.json();
        if (!user.isActive || user.mustChangePassword || !["Tier1", "Tier2", "Supervisor"].includes(user.role)) {
          sessions.delete(id); res.setHeader("Set-Cookie", clearCookie); redirect("/signin"); return;
        }
        session.name = user.displayName;
      } catch { respond(502, "Support server unavailable"); return; }
    }
    if (incidentRoute) {
      const siteId = incidentRoute[1].toLowerCase();
      const rawPage = route.searchParams.get("page") ?? "1";
      if (!validGuid(siteId)) { respond(404, "Site not found"); return; }
      if (!/^[1-9][0-9]{0,3}$/.test(rawPage)) { respond(400, "Invalid incident page"); return; }
      const pageNumber = Number(rawPage);
      try {
        const query = new URLSearchParams({ SiteId: siteId, Page: String(pageNumber), PageSize: "20", IncludeResolved: "false" });
        const result = await api(`api/connectivity-alerts?${query}`, { headers: { Authorization: `Bearer ${session.token}` } });
        if (result.status === 403) { respond(403, "Incident access denied"); return; }
        if (result.status === 401) { sessions.delete(id); res.setHeader("Set-Cookie", clearCookie); redirect("/signin"); return; }
        const queue = await readBoundedJson(result);
        let summary = null;
        try {
          const countResult = await api(`api/connectivity-alerts/site/${siteId}/summary`, { headers: { Authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(800) });
          summary = await readBoundedJson(countResult, 8192);
        } catch { /* Optional counts cannot hide an authorized incident page. */ }
        respond(200, renderSiteIncidents(siteId, queue, summary, pageNumber), "text/html; charset=utf-8");
      } catch { respond(502, "Incident page unavailable"); }
      return;
    }
    if (eventRoute) {
      const cabinetId = eventRoute[1].toLowerCase();
      if (!validGuid(cabinetId)) { respond(404, "Cabinet not found"); return; }
      if ([...route.searchParams.keys()].some(key => !["channel", "provider", "entry"].includes(key)) ||
          [...route.searchParams.keys()].some(key => route.searchParams.getAll(key).length !== 1)) { respond(400, "Invalid event filter"); return; }
      try {
        const result = await api(`api/cabinets/${cabinetId}/event-log-results/latest`, { headers: { Authorization: `Bearer ${session.token}` } });
        if (result.status === 404) { respond(404, "No saved event result for this cabinet"); return; }
        if (result.status === 403) { respond(403, "Event result access denied"); return; }
        if (result.status === 401) { sessions.delete(id); res.setHeader("Set-Cookie", clearCookie); redirect("/signin"); return; }
        const data = await readBoundedJson(result);
        respond(200, renderEventResult(cabinetId, data, route.searchParams), "text/html; charset=utf-8");
      } catch (error) { respond(error.message === "Invalid event filter" || error.message === "Invalid event selection" ? 400 : 502, "Saved event result unavailable"); }
      return;
    }
    if (cabinetRoute) {
      const cabinetId = cabinetRoute[1];
      if (!validGuid(cabinetId)) { respond(404, "Cabinet not found"); return; }
      try {
        const result = await api(`api/cabinets/${cabinetId}`, { headers: { Authorization: `Bearer ${session.token}` } });
        if (result.status === 404) { respond(404, "Cabinet not found"); return; }
        if (result.status === 403) { respond(403, "Cabinet access denied"); return; }
        if (result.status === 401) { sessions.delete(id); res.setHeader("Set-Cookie", clearCookie); redirect("/signin"); return; }
        const data = await readBoundedJson(result);
        respond(200, renderCabinet(data, cabinetId), "text/html; charset=utf-8");
      } catch { respond(502, "Cabinet detail unavailable"); }
      return;
    }
    if (fleetRoute) {
      const search = route.searchParams.get("search") ?? "";
      const rawPage = route.searchParams.get("page") ?? "1";
      if (search.length > 80 || /[\u0000-\u001f]/.test(search) || !/^[1-9][0-9]{0,3}$/.test(rawPage)) { respond(400, "Invalid fleet query"); return; }
      const pageNumber = Number(rawPage);
      try {
        const query = new URLSearchParams({ Search: search, Page: String(pageNumber), PageSize: "20", IsActive: "true" });
        const result = await api(`api/cabinets?${query}`, { headers: { Authorization: `Bearer ${session.token}` } });
        const data = await readBoundedJson(result);
        respond(200, renderFleet(data, { search, page: pageNumber }), "text/html; charset=utf-8");
      } catch { respond(502, "Cabinet finder unavailable"); }
      return;
    }
    const [name, contentType] = files.get(req.url);
    try {
      let body = await readFile(new URL(name, import.meta.url));
      if (name === "index.html") body = Buffer.from(body.toString("utf8").replace("__CSRF__", session.csrf).replace("__DISPLAY_NAME__", escapeHtml(session.name ?? "Staff member")));
      respond(200, body, contentType);
    } catch { respond(500, "Preview unavailable"); }
  });
}
if (process.argv[1] && new URL(process.argv[1], "file:").href === import.meta.url) {
  const server = createPreviewServer("127.0.0.1", {
    enabled: process.env.CABINET_WEB_LOCAL_LOGIN === "1",
    upstreamUrl: process.env.CABINET_WEB_UPSTREAM,
  });
  server.listen(4173, "127.0.0.1", () => console.log("Local-only support login preview: http://127.0.0.1:4173"));
}
