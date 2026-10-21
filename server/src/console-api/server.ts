// The console API (docs/spec/05-server-spec.md): its own listener behind the
// internal reverse proxy, cookie sessions, server-side role checks on every
// route, Origin checks on every state change, and the built console served
// from the same origin.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ContractError } from "../contracts.js";
import { errorInfo, type Pool } from "../db/db.js";
import { loadSession, policyFrom, COOKIE, type SessionPolicy, type SessionUser } from "../auth/sessions.js";
import { clearCookie, readCookie, setCookie } from "../auth/cookies.js";
import { SettingsCache } from "../services/settings.js";
import type { SecretBox } from "../auth/secrets.js";
import type { IssuingKey } from "../pki/x509.js";
import { Refused } from "../services/errors.js";
import { ROLE_RANK, type Role } from "../services/console-commands.js";
import { authRoutes } from "./auth-routes.js";
import { fleetRoutes } from "./fleet-routes.js";
import { adminRoutes } from "./admin-routes.js";
import { alertRoutes } from "./alert-routes.js";
import { baselineRoutes } from "./baseline-routes.js";
import { writeRoutes } from "./write-routes.js";
import { firewallRoutes } from "./firewall-routes.js";
import { serviceRoutes } from "./service-routes.js";
import { demoRoutes } from "./demo-routes.js";
import { setupRoutes } from "./setup-routes.js";
import { diagnoseRoutes } from "./diagnose-routes.js";
import { knownFixRoutes } from "./known-fix-routes.js";
import { troubleshootRoutes } from "./troubleshoot-routes.js";
import { reportRoutes } from "./report-routes.js";
import { crashRoutes } from "./crash-routes.js";
import { readingRoutes } from "./reading-routes.js";
import { fleetOpsRoutes } from "./fleet-ops-routes.js";
import type { PackageStore } from "../services/packages.js";
import type { ReleaseStore } from "../services/releases.js";
import { upgradeRoutes } from "./upgrade-routes.js";
import { ResultStream } from "./stream.js";
import { manageRoutes } from "./manage-routes.js";
import { noteError, noteResponse, routeOf } from "../services/ops-meter.js";

export interface ConsoleApiOptions {
  pool: Pool;
  secrets: SecretBox;
  issuingKey: IssuingKey;
  /** The console's exact origin, e.g. https://cabinets.mashura.internal. State-changing requests must carry it. */
  origin: string;
  stream: ResultStream;
  /** The software library's store; omitted in tests that do not upload packages. */
  packages?: PackageStore;
  /** The update store for signed agent releases; omitted in tests that add none. */
  releases?: ReleaseStore;
  /** The built console (console/dist). Omitted in API-only tests. */
  staticDir?: string;
  /** Fixed session timeouts for tests; otherwise they come from the platform settings. */
  policy?: SessionPolicy;
  /** The platform settings, read through a short cache; made here when not given. */
  settings?: SettingsCache;
  trustProxy?: number | string | false;
  /** The agent API address cabinets use, and the folder with the agent package to download (docs/platform/demo.md). */
  agentSetup?: { host: string; port: number; downloadDir?: string };
  logger?: boolean;
  now?: () => number;
  /** How a fleet job polls and how long it waits to verify; shorter in tests. */
  fleetJobTiming?: { pollMs: number; verifyMs: number };
}

declare module "fastify" {
  interface FastifyRequest { user?: SessionUser }
}

export interface Guards {
  /** Any live session, at any sign-in stage. */
  session: (request: FastifyRequest) => Promise<SessionUser>;
  /** A fully signed-in user with at least this role. */
  role: (request: FastifyRequest, minimum: Role) => Promise<SessionUser>;
  /** The session timeouts in force now. */
  policy: () => Promise<SessionPolicy>;
  /** The platform settings (session timeouts, require two-factor, retention, offline threshold). */
  settings: SettingsCache;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

export async function buildConsoleApi(o: ConsoleApiOptions): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 256 * 1024,
    // A hop count becomes "trust that many proxies nearest to us", so only the address the nearest proxy saw counts.
    trustProxy: typeof o.trustProxy === "number" ? ((_address: string, hop: number) => hop < (o.trustProxy as number)) : (o.trustProxy ?? false),
    logger: o.logger === false ? false : { level: "info", redact: ["req.headers.cookie", "req.headers.authorization"] },
  });

  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try { done(null, JSON.parse(body as string)); } catch { done(new Refused("invalid_json", 400, "body is not JSON"), undefined); }
  });

  // Operations counters: requests and server errors by route pattern (counts only).
  app.addHook("onResponse", async (request, reply) => { if (request.url.startsWith("/api/")) noteResponse("console", routeOf(request), reply.statusCode); });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (request.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    return payload;
  });

  // Every state-changing request must come from the console's own origin (docs/spec/02-security-model.md control 6).
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    if (request.headers.origin !== o.origin) return reply.code(403).send({ error: "origin_refused" });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Refused) return reply.code(error.status).send({ ...error.extra, error: error.code });
    if (error instanceof ContractError) return reply.code(400).send({ error: "invalid_request", issues: error.issues });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: "invalid_request" });
    request.log.error({ err: errorInfo(error) }, "request failed");
    noteError("console", error);
    return reply.code(500).send({ error: "server_error" });
  });

  const cookie = (request: FastifyRequest): string | undefined => readCookie(request, COOKIE);

  const settings = o.settings ?? new SettingsCache(o.pool);
  const policy = async (): Promise<SessionPolicy> => o.policy ?? policyFrom(await settings.get());
  const guards: Guards = {
    policy,
    settings,
    async session(request) {
      // The console marks its background polls; they check the session without counting as the person's activity.
      const user = await loadSession(o.pool, cookie(request), await policy(), request.headers["x-background"] !== "1");
      if (!user) throw new Refused("signed_out", 401, "no live session");
      request.user = user;
      return user;
    },
    async role(request, minimum) {
      const user = await guards.session(request);
      if (user.stage !== "complete") throw new Refused("sign_in_incomplete", 401, "finish signing in first");
      if (ROLE_RANK[user.role] < ROLE_RANK[minimum]) throw new Refused("forbidden", 403, "your role cannot do this");
      return user;
    },
  };

  await app.register(authRoutes, { ...o, guards });
  await app.register(fleetRoutes, { ...o, guards });
  await app.register(adminRoutes, { ...o, guards });
  await app.register(alertRoutes, { ...o, guards });
  await app.register(writeRoutes, { ...o, guards });
  await app.register(firewallRoutes, { ...o, guards });
  await app.register(serviceRoutes, { ...o, guards });
  await app.register(demoRoutes, { ...o, guards });
  await app.register(setupRoutes, { ...o, guards });
  await app.register(diagnoseRoutes, { ...o, guards });
  await app.register(knownFixRoutes, { ...o, guards });
  await app.register(troubleshootRoutes, { ...o, guards });
  await app.register(reportRoutes, { ...o, guards });
  await app.register(crashRoutes, { ...o, guards });
  await app.register(readingRoutes, { ...o, guards });
  await app.register(fleetOpsRoutes, { ...o, guards });
  await app.register(manageRoutes, { ...o, guards });
  await app.register(baselineRoutes, { ...o, guards });
  await app.register(upgradeRoutes, { ...o, guards });
  app.get("/api/stream", async (request, reply) => {
    const user = await guards.role(request, "tier1");
    o.stream.attach(user, request, reply, async () => loadSession(o.pool, cookie(request), await policy(), false));
    return reply;
  });
  app.get("/api/health", async () => ({ status: "ok" }));
  app.all("/api/*", async (_req, reply) => reply.code(404).send({ error: "not_found" }));

  // The built console: real files by path, everything else the single-page app.
  if (o.staticDir && existsSync(o.staticDir)) {
    const root = resolve(o.staticDir);
    const index = readFileSync(join(root, "index.html"));
    app.get("/*", async (request: FastifyRequest, reply: FastifyReply) => {
      let path = "/";
      try { path = decodeURIComponent(request.url.split("?")[0] ?? "/"); } catch { /* malformed escape: serve the app */ }
      const file = normalize(join(root, path));
      if (file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile()) {
        const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
        reply.header("Cache-Control", path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
        return reply.type(type).send(readFileSync(file));
      }
      return reply.type("text/html; charset=utf-8").header("Cache-Control", "no-cache").send(index);
    });
  }
  return app;
}

export const setSessionCookie = (reply: FastifyReply, id: string, maxAgeSeconds: number): void => setCookie(reply, COOKIE, id, maxAgeSeconds);

export const clearSessionCookie = (reply: FastifyReply): void => clearCookie(reply, COOKIE);
