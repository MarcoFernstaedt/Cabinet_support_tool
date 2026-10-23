// Watched services (docs/spec/12-milestones-8-to-12.md, milestone 10): each level's list, and the list a cabinet uses.
// Tier 2 and up change a client's, site's or cabinet's list with a confirmation click; the fleet default is Admin only.
// Every body is checked against the watched-services contract first.
//
// Approved applications (docs/spec/13-roadmap.md): the programs a cabinet may be asked to control, by their exact executable path.
// Admin only, with a step-up token bound to the entries, because a program the platform may start or end is an owner's decision.
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { Refused } from "../services/errors.js";
import { parseJson } from "../services/settings.js";
import { appLevels, readLevel, setApprovedApps } from "../services/approved-apps.js";
import { setWatched, watchLevels, type WatchLevel } from "../services/watched-services.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

export async function serviceRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  app.get("/api/cabinets/:id/watched-services", async request => {
    await o.guards.role(request, "tier1");
    return watchLevels(o.pool, id(request));
  });

  /** One client's or site's own list, and the fleet default (for the editor's "inherited" line). */
  for (const [level, table] of [["client", "clients"], ["site", "sites"]] as const) {
    app.get(`/api/${table}/:id/watched-services`, async request => {
      await o.guards.role(request, "tier1");
      // The lists come back as JSON text under these names (the data layer parses only the columns it knows), so they are parsed here.
      const row = (await o.pool.query<{ own: string | null; parent: string | null }>(
        level === "client"
          ? "SELECT watched_services AS own, CAST(NULL AS nvarchar(max)) AS parent FROM clients WHERE id = $1 AND removed_at IS NULL"
          : "SELECT s.watched_services AS own, c.watched_services AS parent FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = $1 AND s.removed_at IS NULL",
        [id(request)])).rows[0];
      if (!row) throw new Refused("not_found", 404, `no such ${level}`);
      const fleet = (await o.pool.query<{ value: string[] }>("SELECT [value] FROM settings WHERE [key] = 'services.watched'")).rows[0]?.value ?? null;
      return { own: parseJson<string[]>(row.own), client: level === "site" ? parseJson<string[]>(row.parent) : null, fleet };
    });
    app.put(`/api/${table}/:id/watched-services`, async request => {
      const u = await o.guards.role(request, "tier2");
      const b = consoleBodies.watchedServices.parse(request.body);
      await setWatched(o.pool, u.userId, level as WatchLevel, id(request), b.names ?? null);
      return { ok: true };
    });
  }

  app.put("/api/cabinets/:id/watched-services", async request => {
    const u = await o.guards.role(request, "tier2");
    const b = consoleBodies.watchedServices.parse(request.body);
    await setWatched(o.pool, u.userId, "cabinet", id(request), b.names ?? null);
    return watchLevels(o.pool, id(request));
  });

  app.get("/api/admin/watched-services", async request => {
    await o.guards.role(request, "tier1");
    return { names: (await o.pool.query<{ value: string[] }>("SELECT [value] FROM settings WHERE [key] = 'services.watched'")).rows[0]?.value ?? null };
  });

  app.put("/api/admin/watched-services", async request => {
    const u = await o.guards.role(request, "admin");
    const b = consoleBodies.watchedServices.parse(request.body);
    await setWatched(o.pool, u.userId, "fleet", "fleet", b.names ?? null);
    return { ok: true };
  });

  // ---- Approved applications (docs/spec/13-roadmap.md: process.end and app.restart with a per-client allowlist). -------------
  // What this cabinet may be asked to control: the programs an owner approves, with the exact executable path written by the
  // owner. Admin only, the same rule the file-facts paths follow, and the step-up token is bound to the exact entries.

  for (const [level, table] of [["client", "clients"], ["site", "sites"]] as const) {
    /** One client's or site's own list, and the fleet default (for the editor's "inherited" line). */
    app.get(`/api/${table}/:id/approved-apps`, async request => {
      await o.guards.role(request, "tier1");
      return { own: await readLevel(o.pool, level, id(request)), fleet: await readLevel(o.pool, "fleet", null) };
    });
    app.put(`/api/${table}/:id/approved-apps`, async request => {
      const u = await o.guards.role(request, "admin");
      const b = consoleBodies.approvedApps.parse(request.body);
      return { own: await setApprovedApps(o.pool, u, level, id(request), b.entries ?? null, b.stepUpToken), fleet: await readLevel(o.pool, "fleet", null) };
    });
  }

  app.get("/api/admin/approved-apps", async request => {
    await o.guards.role(request, "tier1");
    return { fleet: await readLevel(o.pool, "fleet", null) };
  });

  app.put("/api/admin/approved-apps", async request => {
    const u = await o.guards.role(request, "admin");
    const b = consoleBodies.approvedApps.parse(request.body);
    return { fleet: await setApprovedApps(o.pool, u, "fleet", null, b.entries ?? null, b.stepUpToken) };
  });

  app.get("/api/cabinets/:id/approved-apps", async request => {
    await o.guards.role(request, "tier1");
    return appLevels(o.pool, id(request));
  });

  app.put("/api/cabinets/:id/approved-apps", async request => {
    const u = await o.guards.role(request, "admin");
    const b = consoleBodies.approvedApps.parse(request.body);
    await setApprovedApps(o.pool, u, "cabinet", id(request), b.entries ?? null, b.stepUpToken);
    return appLevels(o.pool, id(request));
  });
}
