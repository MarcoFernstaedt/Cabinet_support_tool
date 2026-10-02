import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readBoundedJson, renderCabinet, renderFleet, renderSiteIncidents, validGuid } from "./read-only-pages.mjs";
import { renderEventResult } from "./event-result-page.mjs";
import { renderCrashInvestigation } from "./crash-investigation-page.mjs";
import { renderProcessDiagnostics } from "./process-diagnostics-page.mjs";
import { renderFleetHealth } from "./fleet-health-page.mjs";
import { renderIncidentCorrelation } from "./incident-correlation-page.mjs";
import { renderNetworkHistory } from "./network-history-page.mjs";
import { renderStorageInvestigation } from "./storage-investigation-page.mjs";
import { renderDisplayDiagnosis } from "./display-diagnosis-page.mjs";
import { renderQueue, pendingTarget, cabinetTarget, renderDecision, decisionValues } from "./enrollment-retirement-page.mjs";

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

async function form(req, maxBytes = 4096) {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/x-www-form-urlencoded")) throw Error("Invalid form");
  let size = 0, content = "";
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Error("Form too large");
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
    const enrollmentRoute = route.pathname === "/enrollment";
    const enrollmentDecision = /^\/enrollment\/([^/]+)\/(approve|reject)$/.exec(route.pathname);
    const retirementRoute = /^\/cabinet\/([^/]+)\/retire$/.exec(route.pathname);
    if (enrollmentRoute || enrollmentDecision || retirementRoute) {
      if ((req.method !== "GET" && req.method !== "POST") || route.searchParams.size > (enrollmentRoute || enrollmentDecision ? 1 : 0) ||
          [...route.searchParams.keys()].some(key => key !== "page" || route.searchParams.getAll(key).length !== 1)) { respond(400, "Invalid request"); return; }
      const rawPage = route.searchParams.get("page") ?? "1";
      if (!/^[1-9][0-9]{0,3}$/.test(rawPage)) { respond(400, "Invalid page"); return; }
      const pageNumber = Number(rawPage);
      const targetId = (enrollmentDecision?.[1] ?? retirementRoute?.[1])?.toLowerCase();
      if (targetId && !validGuid(targetId)) { respond(404, "Target not found"); return; }
      if (enrollmentRoute && req.method !== "GET") { respond(404, "Not found"); return; }
      if (req.method === "POST" && !sameOrigin()) { respond(403, "Invalid origin"); return; }
      if (!session) { respond(401, "Sign in required"); return; }
      let values;
      if (req.method === "POST") {
        try { values = await form(req, 32768); } catch { respond(400, "Invalid form"); return; }
        if (values.getAll("csrf").length !== 1 || values.get("csrf") !== session.csrf) { respond(403, "Invalid request token"); return; }
        if (!values.get("machineId") || values.getAll("machineId").length !== 1) { respond(400, "Invalid target"); return; }
        if (!decisionValues(values, enrollmentDecision?.[2] ?? "retire")) { respond(400, "Invalid decision"); return; }
      }
      try {
        const headers = { Authorization: `Bearer ${session.token}` };
        const me = await api("api/auth/me", { headers });
        if (me.status === 401) { sessions.delete(id); res.setHeader("Set-Cookie", clearCookie); respond(401, "Session expired"); return; }
        if (me.status === 403) { respond(403, "Access denied"); return; }
        if (!me.ok) { respond(502, "Support server unavailable"); return; }
        const actor = await readBoundedJson(me, 4096);
        if (!actor.isActive || actor.mustChangePassword || actor.role !== "Supervisor") { respond(403, "Supervisor required"); return; }
        const kind = enrollmentDecision?.[2] ?? "retire";
        let row;
        if (!retirementRoute) {
          const queueResponse = await api(`api/registrations/pending?Page=${pageNumber}&PageSize=20`, { headers });
          if (queueResponse.status === 401 || queueResponse.status === 403) { respond(queueResponse.status, "Enrollment access denied"); return; }
          if (!queueResponse.ok) { respond(502, "Enrollment unavailable"); return; }
          const queue = await readBoundedJson(queueResponse, 16384);
          if (enrollmentRoute) { respond(200, renderQueue(queue, pageNumber), "text/html; charset=utf-8"); return; }
          row = pendingTarget(queue, pageNumber, targetId);
          if (!row) { respond(404, "Pending registration not found"); return; }
        } else {
          const detailResponse = await api(`api/cabinets/${targetId}`, { headers });
          if ([401, 403, 404].includes(detailResponse.status)) { respond(detailResponse.status, "Cabinet unavailable"); return; }
          if (!detailResponse.ok) { respond(502, "Cabinet unavailable"); return; }
          row = cabinetTarget(await readBoundedJson(detailResponse, 16384), targetId);
          if (!row.isActive) { respond(409, "Cabinet already inactive; refresh detail"); return; }
        }
        const confirmationKey = `${kind}:${targetId}:${pageNumber}`;
        if (req.method === "GET") {
          session.confirmations ??= new Map();
          session.confirmations.set(confirmationKey, { machineId: row.machineId, hostname: row.hostname, ...(retirementRoute ? { siteId: row.siteId.toLowerCase(), clientName: row.clientName, siteName: row.siteName, role: row.role } : {}) });
          if (session.confirmations.size > 32) session.confirmations.delete(session.confirmations.keys().next().value);
          respond(200, renderDecision(kind, row, session.csrf, pageNumber), "text/html; charset=utf-8"); return;
        }
        const confirmed = session.confirmations?.get(confirmationKey);
        if (confirmed?.machineId !== row.machineId || confirmed?.hostname !== row.hostname || values.get("machineId") !== row.machineId ||
            (retirementRoute && (confirmed.siteId !== row.siteId.toLowerCase() || confirmed.clientName !== row.clientName || confirmed.siteName !== row.siteName || confirmed.role !== row.role))) {
          session.confirmations?.delete(confirmationKey); respond(409, "Target changed; review again"); return;
        }
        const payload = decisionValues(values, kind);
        const path = retirementRoute ? `api/cabinets/${targetId}/retire` : `api/registrations/${targetId}/${kind}`;
        const result = await api(path, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if ([401, 403, 404, 409].includes(result.status)) { session.confirmations.delete(confirmationKey); respond(result.status, "Decision refused; refresh before retrying"); return; }
        if (kind === "approve" && result.status === 200) {
          const approved = await readBoundedJson(result, 8192);
          if (approved?.id?.toLowerCase() !== targetId || approved.machineId !== row.machineId || approved.status !== "Approved") { session.confirmations.delete(confirmationKey); respond(502, "Decision outcome unverified; refresh before retrying"); return; }
        } else if (result.status !== 204) { session.confirmations.delete(confirmationKey); respond(502, "Decision outcome unknown; refresh before retrying"); return; }
        session.confirmations.delete(confirmationKey);
        redirect(kind === "retire" ? `/cabinet/${targetId}` : "/enrollment");
      } catch { if (req.method === "POST") session.confirmations?.delete(`${enrollmentDecision?.[2] ?? "retire"}:${targetId}:${pageNumber}`); respond(502, "Support server unavailable; decision outcome may be unknown, refresh before retrying"); }
      return;
    }
    const fleetRoute = route.pathname === "/fleet";
    const fleetHealthRoute = route.pathname === "/fleet/health";
    const cabinetRoute = /^\/cabinet\/([^/]+)$/.exec(route.pathname);
    const eventRoute = /^\/cabinet\/([^/]+)\/events$/.exec(route.pathname);
    const pinnedEventRoute = /^\/cabinet\/([^/]+)\/events\/([^/]+)$/.exec(route.pathname);
    const crashRoute = /^\/cabinet\/([^/]+)\/crashes$/.exec(route.pathname);
    const processRoute = /^\/cabinet\/([^/]+)\/processes$/.exec(route.pathname);
    const pinnedProcessRoute = /^\/cabinet\/([^/]+)\/processes\/([^/]+)$/.exec(route.pathname);
    const incidentRoute = /^\/site\/([^/]+)\/incidents$/.exec(route.pathname);
    const correlationRoute = /^\/incident\/([^/]+)\/correlation$/.exec(route.pathname);
    const networkHistoryRoute = /^\/cabinet\/([^/]+)\/network-history$/.exec(route.pathname);
    const storageRoute = /^\/cabinet\/([^/]+)\/storage$/.exec(route.pathname);
    const displayRoute = /^\/cabinet\/([^/]+)\/display$/.exec(route.pathname);
    const pinnedDisplayRoute = /^\/cabinet\/([^/]+)\/display\/([^/]+)$/.exec(route.pathname);
    if (req.method !== "GET" || (!files.has(req.url) && !fleetRoute && !fleetHealthRoute && !cabinetRoute && !eventRoute && !pinnedEventRoute && !crashRoute && !processRoute && !pinnedProcessRoute && !incidentRoute && !correlationRoute && !networkHistoryRoute && !storageRoute && !displayRoute && !pinnedDisplayRoute)) { respond(404, "Not found"); return; }
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
    if (fleetHealthRoute) {
      const pages = [route.searchParams.get("cabinetPage") ?? "1", route.searchParams.get("sitePage") ?? "1"];
      if ([...route.searchParams.keys()].some(key => !["cabinetPage", "sitePage"].includes(key) || route.searchParams.getAll(key).length !== 1) ||
          pages.some(page => !/^[1-9][0-9]{0,3}$/.test(page))) { respond(400, "Invalid health page"); return; }
      const [cabinetPage, sitePage] = pages.map(Number);
      try {
        const headers = { Authorization: `Bearer ${session.token}` };
        const healthResponse = await api("api/fleet/health", { headers });
        if (healthResponse.status === 403) { respond(403, "Fleet health access denied"); return; }
        if (healthResponse.status === 401) { sessions.delete(id); res.setHeader("Set-Cookie", clearCookie); redirect("/signin"); return; }
        const health = await readBoundedJson(healthResponse);
        const cabinetsResponse = await api(`api/cabinets?${new URLSearchParams({ IsActive: "true", Page: String(cabinetPage), PageSize: "20" })}`, { headers });
        if (cabinetsResponse.status === 403) { respond(403, "Fleet health access denied"); return; }
        if (cabinetsResponse.status === 401) { sessions.delete(id); res.setHeader("Set-Cookie", clearCookie); redirect("/signin"); return; }
        const cabinets = await readBoundedJson(cabinetsResponse);
        const sitesResponse = await api(`api/fleet/sites?${new URLSearchParams({ Page: String(sitePage), PageSize: "20" })}`, { headers });
        if (sitesResponse.status === 403) { respond(403, "Fleet health access denied"); return; }
        if (sitesResponse.status === 401) { sessions.delete(id); res.setHeader("Set-Cookie", clearCookie); redirect("/signin"); return; }
        const sites = await readBoundedJson(sitesResponse);
        respond(200, renderFleetHealth(health, cabinets, sites, cabinetPage, sitePage), "text/html; charset=utf-8");
      } catch (error) {
        if (error.message === "Fleet snapshot changed") {
          respond(409, '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fleet changed | Mashura Support</title><link rel="stylesheet" href="/styles.css"></head><body><main class="fleet-page"><h1>Fleet changed while loading</h1><p role="status">The summary and cabinet page were read at different moments. No combined count is shown. Refresh to try again.</p><a href="/fleet/health">Retry fleet health</a></main></body></html>', "text/html; charset=utf-8");
        } else respond(502, "Fleet health unavailable");
      }
      return;
    }
    if (displayRoute || pinnedDisplayRoute) {
      const cabinetId = (displayRoute ?? pinnedDisplayRoute)[1].toLowerCase();
      const actionId = pinnedDisplayRoute?.[2].toLowerCase();
      if (!validGuid(cabinetId)) { respond(404, "Cabinet not found"); return; }
      if (actionId && !validGuid(actionId)) { respond(404, "Saved display result not found"); return; }
      if (route.search) { respond(400, "Invalid display query"); return; }
      try {
        const result = await api(`api/cabinets/${cabinetId}/display-results/${actionId ?? "latest"}`, { headers: { Authorization: `Bearer ${session.token}` } });
        if (result.status === 403) { respond(403, "Display result access denied"); return; }
        if (result.status === 401) { sessions.delete(id); res.setHeader("Set-Cookie", clearCookie); redirect("/signin"); return; }
        if (actionId && result.status === 404) { respond(404, "Saved display result not found"); return; }
        const saved = result.status === 404 ? null : await readBoundedJson(result, 16384);
        if (actionId && saved?.actionId?.toLowerCase() !== actionId) { respond(502, "Display result identity mismatch"); return; }
        respond(200, renderDisplayDiagnosis(cabinetId, saved), "text/html; charset=utf-8");
      } catch { respond(502, "Display observations unavailable"); }
      return;
    }
    if (storageRoute) {
      const cabinetId = storageRoute[1].toLowerCase();
      if (!validGuid(cabinetId)) { respond(404, "Cabinet not found"); return; }
      if (route.search) { respond(400, "Invalid storage query"); return; }
      try {
        const result = await api(`api/cabinets/${cabinetId}/storage`, { headers: { Authorization: `Bearer ${session.token}` } });
        if (result.status === 404) { respond(404, "Cabinet not found"); return; }
        if (result.status === 403) { respond(403, "Storage access denied"); return; }
        if (result.status === 401) { sessions.delete(id); res.setHeader("Set-Cookie", clearCookie); redirect("/signin"); return; }
        respond(200, renderStorageInvestigation(cabinetId, await readBoundedJson(result, 32768)), "text/html; charset=utf-8");
      } catch { respond(502, "Storage observations unavailable"); }
      return;
    }
    if (networkHistoryRoute) {
      const sourceId = networkHistoryRoute[1].toLowerCase();
      if (!validGuid(sourceId)) { respond(404, "Cabinet not found"); return; }
      const query = route.searchParams;
      if ([...query.keys()].some(key => !["target", "from", "to", "cursor"].includes(key) || query.getAll(key).length !== 1)) { respond(400, "Invalid history filter"); return; }
      const target = query.get("target")?.toLowerCase() ?? null;
      const from = query.get("from"), to = query.get("to"), cursor = query.get("cursor");
      const utc = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)$/.test(value) && Number.isFinite(Date.parse(value));
      if ((target !== null && !validGuid(target)) || (from === null) !== (to === null) ||
          (from !== null && (!utc(from) || !utc(to) || Date.parse(from) >= Date.parse(to) || Date.parse(to) - Date.parse(from) > 30 * 86400000)) ||
          (cursor !== null && (!/^[A-Za-z0-9_-]{1,2048}$/.test(cursor) || from === null))) { respond(400, "Invalid history filter"); return; }
      try {
        const upstreamQuery = new URLSearchParams({ ...(target ? { targetId: target } : {}), ...(from ? { from, to } : {}), ...(cursor ? { nextCursor: cursor } : {}), pageSize: "20" });
        const result = await api(`api/connectivity/cabinets/${sourceId}/history?${upstreamQuery}`, { headers: { Authorization: `Bearer ${session.token}` } });
        if (result.status === 404) { respond(404, "Cabinet history not found"); return; }
        if (result.status === 403) { respond(403, "Network history access denied"); return; }
        if (result.status === 401) { sessions.delete(id); res.setHeader("Set-Cookie", clearCookie); redirect("/signin"); return; }
        if (result.status === 400) { respond(400, "Invalid history cursor or bounds"); return; }
        respond(200, renderNetworkHistory(sourceId, target, await readBoundedJson(result), { from, to }), "text/html; charset=utf-8");
      } catch { respond(502, "Network history unavailable"); }
      return;
    }
    if (correlationRoute) {
      const alertId = correlationRoute[1].toLowerCase();
      if (!validGuid(alertId)) { respond(404, "Incident not found"); return; }
      if (route.search) { respond(400, "Invalid incident query"); return; }
      try {
        const result = await api(`api/connectivity-alerts/${alertId}/correlation`, { headers: { Authorization: `Bearer ${session.token}` } });
        if (result.status === 404) { respond(404, "Incident not found"); return; }
        if (result.status === 403) { respond(403, "Incident access denied"); return; }
        if (result.status === 401) { sessions.delete(id); res.setHeader("Set-Cookie", clearCookie); redirect("/signin"); return; }
        respond(200, renderIncidentCorrelation(alertId, await readBoundedJson(result, 32768)), "text/html; charset=utf-8");
      } catch { respond(502, "Incident evidence unavailable"); }
      return;
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
    if (processRoute || pinnedProcessRoute) {
      const cabinetId = (processRoute ?? pinnedProcessRoute)[1].toLowerCase();
      const actionId = pinnedProcessRoute?.[2].toLowerCase();
      if (!validGuid(cabinetId)) { respond(404, "Cabinet not found"); return; }
      if (actionId && !validGuid(actionId)) { respond(404, "Saved process result not found"); return; }
      if (route.search) { respond(400, "Invalid process query"); return; }
      try {
        const headers = { Authorization: `Bearer ${session.token}` };
        const cabinetResponse = await api(`api/cabinets/${cabinetId}`, { headers });
        if (cabinetResponse.status === 404) { respond(404, "Cabinet not found"); return; }
        if (cabinetResponse.status === 403) { respond(403, "Cabinet access denied"); return; }
        if (cabinetResponse.status === 401) { sessions.delete(id); res.setHeader("Set-Cookie", clearCookie); redirect("/signin"); return; }
        const cabinet = await readBoundedJson(cabinetResponse);
        const processResponse = await api(`api/cabinets/${cabinetId}/process-results/${actionId ?? "latest"}`, { headers });
        if (processResponse.status === 403) { respond(403, "Process result access denied"); return; }
        if (processResponse.status === 401) { sessions.delete(id); res.setHeader("Set-Cookie", clearCookie); redirect("/signin"); return; }
        if (actionId && processResponse.status === 404) { respond(404, "Saved process result not found"); return; }
        const process = processResponse.status === 404 ? null : await readBoundedJson(processResponse);
        if (actionId && process?.actionId?.toLowerCase() !== actionId) { respond(502, "Saved process result identity mismatch"); return; }
        respond(200, renderProcessDiagnostics(cabinetId, process, cabinet), "text/html; charset=utf-8");
      } catch { respond(502, "Process and service observations unavailable"); }
      return;
    }
    if (eventRoute || pinnedEventRoute || crashRoute) {
      const cabinetId = (eventRoute ?? pinnedEventRoute ?? crashRoute)[1].toLowerCase();
      if (!validGuid(cabinetId)) { respond(404, "Cabinet not found"); return; }
      const actionId = pinnedEventRoute?.[2].toLowerCase();
      if (actionId && !validGuid(actionId)) { respond(404, "Saved event result not found"); return; }
      if (crashRoute && route.search) { respond(400, "Invalid crash query"); return; }
      if ((eventRoute || pinnedEventRoute) && ([...route.searchParams.keys()].some(key => !["channel", "provider", "entry"].includes(key)) ||
          [...route.searchParams.keys()].some(key => route.searchParams.getAll(key).length !== 1))) { respond(400, "Invalid event filter"); return; }
      try {
        const result = await api(`api/cabinets/${cabinetId}/event-log-results/${actionId ?? "latest"}`, { headers: { Authorization: `Bearer ${session.token}` } });
        if (result.status === 404) { respond(404, "No saved event result for this cabinet"); return; }
        if (result.status === 403) { respond(403, "Event result access denied"); return; }
        if (result.status === 401) { sessions.delete(id); res.setHeader("Set-Cookie", clearCookie); redirect("/signin"); return; }
        const data = await readBoundedJson(result);
        if (actionId && data?.actionId?.toLowerCase() !== actionId) { respond(502, "Saved event result identity mismatch"); return; }
        respond(200, (eventRoute || pinnedEventRoute) ? renderEventResult(cabinetId, data, route.searchParams) : renderCrashInvestigation(cabinetId, data), "text/html; charset=utf-8");
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
