// The console API (docs/spec/05-server-spec.md): its own listener behind the
// internal reverse proxy, cookie sessions, server-side role checks on every
// route, Origin checks on every state change, and the built console served
// from the same origin.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type pg from "pg";
import { ContractError } from "../contracts.js";
import { loadSession, policyFrom, COOKIE, type SessionPolicy, type SessionUser } from "../auth/sessions.js";
import { SettingsCache } from "../services/settings.js";
import type { SecretBox } from "../auth/secrets.js";
import type { IssuingKey } from "../pki/x509.js";
import { Refused } from "../services/errors.js";
import { ROLE_RANK, type Role } from "../services/console-commands.js";
import { authRoutes } from "./auth-routes.js";
import { fleetRoutes } from "./fleet-routes.js";
import { adminRoutes } from "./admin-routes.js";
import { alertRoutes } from "./alert-routes.js";
import { writeRoutes } from "./write-routes.js";
import { firewallRoutes } from "./firewall-routes.js";
import type { PackageStore } from "../services/packages.js";
import type { ReleaseStore } from "../services/releases.js";
import { upgradeRoutes } from "./upgrade-routes.js";
import { ResultStream } from "./stream.js";
import { manageRoutes } from "./manage-routes.js";

export interface ConsoleApiOptions {
  pool: pg.Pool;
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
  logger?: boolean;
  now?: () => number;
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
    request.log.error({ err: { type: (error as Error).name } }, "request failed");
    return reply.code(500).send({ error: "server_error" });
  });

  const cookie = (request: FastifyRequest): string | undefined => {
    for (const part of (request.headers.cookie ?? "").split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === COOKIE) return v.join("=");
    }
    return undefined;
  };

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
  await app.register(manageRoutes, { ...o, guards });
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

export const setSessionCookie = (reply: FastifyReply, id: string, maxAgeSeconds: number): void => {
  reply.header("Set-Cookie", `${COOKIE}=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`);
};

export const clearSessionCookie = (reply: FastifyReply): void => {
  reply.header("Set-Cookie", `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
};
