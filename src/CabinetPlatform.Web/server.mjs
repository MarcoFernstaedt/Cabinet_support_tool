import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/bootstrap.mjs", ["bootstrap.mjs", "text/javascript; charset=utf-8"]],
  ["/login.css", ["login.css", "text/css; charset=utf-8"]],
]);
const escapeHtml = text => String(text).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const page = error => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in | Mashura Support</title><link rel="stylesheet" href="/login.css"></head><body><main class="login"><div class="brand">Mashura <span>Support workspace</span></div><p class="tag">LOCAL DEVELOPMENT BUILD</p><h1>Sign in</h1><p>Use a test support account. This browser build is local only and does not enforce MFA.</p>${error ? '<p class="error" role="alert">Sign-in failed. Check your account or contact an administrator.</p>' : ''}<form method="post" action="/signin"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required maxlength="128"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"><button>Sign in</button></form><small>This build shows synthetic event records only. It does not connect to a cabinet.</small></main></body></html>`;

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
  const sessions = new Map();
  const cookieName = "cabinet_local_dev";
  const api = (path, options) => upstreamFetch(new URL(path, upstream), { ...options, redirect: "manual", signal: AbortSignal.timeout(5000), cache: "no-store" });
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
    if (req.method !== "GET" || !files.has(req.url)) { respond(404, "Not found"); return; }
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
