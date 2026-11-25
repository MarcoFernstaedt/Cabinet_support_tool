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
import { appLevels, discardPendingApps, listToSign, readLevel, readLevelState, setApprovedApps, signApprovedApps, type AppLevel, type AppList, type PendingList } from "../services/approved-apps.js";
import { serviceEntryChecks } from "../services/approved-apps-match.js";
import { ListSigningKeys } from "../services/approved-list-signing.js";
import { clientScanner, setClientScanner } from "../services/client-scanner.js";
import { setWatched, watchLevels, type WatchLevel } from "../services/watched-services.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

/**
 * What the person confirmed for an approved-applications write: the body as sent, without its token. A body naming another level or
 * scope than the address is refused, so a token bought for one level is never spent on a write the address aims elsewhere.
 */
function appsConfirmed(b: { level: string; id?: string | null; entries?: unknown; stepUpToken: string }, level: string, scope: string | null): unknown {
  if (b.level !== level) throw new Refused("invalid_request", 400, "the body names another level than the address");
  const sent = typeof b.id === "string" ? b.id.toLowerCase() : null;
  if (sent !== scope) throw new Refused("invalid_request", 400, "the body names another scope than the address");
  const { stepUpToken: _token, ...confirmed } = b;
  return confirmed;
}

export async function serviceRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  app.get("/api/cabinets/:id/watched-services", async request => {
    await o.guards.role(request, "tier1");
    return watchLevels(o.pool, id(request));
  });

  /**
   * One client's or site's own list, the levels above it, and the role lists its cabinets fall back to (F7.R4, D34): for each role an
   * active cabinet there has, the services that role's baseline requires running. The editor shows them, and starts a new list from what it
   * would replace, so a list made here never drops a role's services unseen.
   */
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
      const roleRows = (await o.pool.query<{ role: string; names: string | null }>(
        `SELECT r.role, (SELECT TOP (1) [value] FROM settings WHERE [key] = CONCAT('services.watched.role.', r.role)) AS names
           FROM (SELECT DISTINCT k.role FROM cabinets k JOIN sites s ON s.id = k.site_id
                  WHERE k.status = 'active' AND ${level === "client" ? "s.client_id" : "s.id"} = $1) r ORDER BY r.role`, [id(request)])).rows;
      const roles: Record<string, string[]> = {};
      for (const r of roleRows) { const names = parseJson<unknown>(r.names); if (Array.isArray(names)) roles[r.role] = names as string[]; }
      return { own: parseJson<string[]>(row.own), client: level === "site" ? parseJson<string[]>(row.parent) : null, fleet, roles };
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

  // With an Admin list-signing key set up, a saved list waits for its signature; the console says so and offers it for signing.
  const signing = o.listKeys ?? ListSigningKeys.fromFolder();
  const signingState = { signing: { enabled: signing.count > 0 } };
  // Whether each service entry the editor shows (the change waiting for a signature, else the list in force) matches any cabinet
  // of the level: its key name and the program it runs, as the agent checks them (D149).
  const checks = (level: AppLevel, scope: string | null, state: { list: AppList | null; pending: PendingList | null }) =>
    serviceEntryChecks(o.pool, level, scope, (state.pending ?? state.list)?.entries ?? []);

  // Whether a client uses a fingerprint scanner (Admin, code bound to the exact choice). Switching it on adds the scanner's service to the
  // client's approved list (waiting for a signature when signing is on) and to its watched services.
  app.put("/api/clients/:id/fingerprint-scanner", async request => {
    const u = await o.guards.role(request, "admin");
    const b = consoleBodies.clientScanner.parse(request.body);
    const clientId = id(request);
    return setClientScanner(o.pool, u, clientId, b.scanner, b.stepUpToken, signing).then(async r => ({ ...r, state: await clientScanner(o.pool, clientId) }));
  });

  for (const [level, table] of [["client", "clients"], ["site", "sites"]] as const) {
    /** One client's or site's own list, its change waiting for a signature, and the fleet default (for the editor's "inherited" line). */
    app.get(`/api/${table}/:id/approved-apps`, async request => {
      await o.guards.role(request, "tier1");
      const scope = id(request);
      const own = await readLevelState(o.pool, level, scope);
      return { own: own.list, ownRejected: own.rejected, ownPending: own.pending, fleet: await readLevel(o.pool, "fleet", null), checks: await checks(level, scope, own), ...signingState };
    });
    app.put(`/api/${table}/:id/approved-apps`, async request => {
      const u = await o.guards.role(request, "admin");
      const b = consoleBodies.approvedApps.parse(request.body);
      const scope = id(request);
      await setApprovedApps(o.pool, u, level, scope, b.entries ?? null, b.stepUpToken, appsConfirmed(b, level, scope), signing);
      const own = await readLevelState(o.pool, level, scope);
      return { own: own.list, ownRejected: own.rejected, ownPending: own.pending, fleet: await readLevel(o.pool, "fleet", null), checks: await checks(level, scope, own), ...signingState };
    });
  }

  app.get("/api/admin/approved-apps", async request => {
    await o.guards.role(request, "tier1");
    const fleet = await readLevelState(o.pool, "fleet", null);
    return { fleet: fleet.list, fleetRejected: fleet.rejected, fleetPending: fleet.pending, checks: await checks("fleet", null, fleet), ...signingState };
  });

  app.put("/api/admin/approved-apps", async request => {
    const u = await o.guards.role(request, "admin");
    const b = consoleBodies.approvedApps.parse(request.body);
    await setApprovedApps(o.pool, u, "fleet", null, b.entries ?? null, b.stepUpToken, appsConfirmed(b, "fleet", null), signing);
    const fleet = await readLevelState(o.pool, "fleet", null);
    return { fleet: fleet.list, fleetRejected: fleet.rejected, fleetPending: fleet.pending, checks: await checks("fleet", null, fleet), ...signingState };
  });

  // Signing, for every level: the document to sign, the signature upload, and dropping a change that waits for one. Admin only.
  const levelPaths: [AppLevel, string][] = [["fleet", "/api/admin/approved-apps"], ["client", "/api/clients/:id/approved-apps"],
    ["site", "/api/sites/:id/approved-apps"], ["cabinet", "/api/cabinets/:id/approved-apps"]];
  for (const [level, path] of levelPaths) {
    const scopeOf = (request: Parameters<typeof id>[0]) => (level === "fleet" ? null : id(request));
    app.get(`${path}/to-sign`, async request => {
      await o.guards.role(request, "admin");
      const doc = await listToSign(o.pool, level, scopeOf(request));
      if (!doc) throw new Refused("not_found", 404, "nothing here is waiting for a signature");
      return doc;
    });
    app.post(`${path}/signature`, async request => {
      const u = await o.guards.role(request, "admin");
      const b = consoleBodies.approvedListSign.parse(request.body);
      const scope = scopeOf(request);
      appsConfirmed({ ...b, stepUpToken: "" }, level, scope);
      return { list: await signApprovedApps(o.pool, u, level, scope, b.version, b.signature, signing) };
    });
    app.post(`${path}/pending/discard`, async request => {
      const u = await o.guards.role(request, "admin");
      await discardPendingApps(o.pool, u, level, scopeOf(request));
      return { ok: true };
    });
  }

  // A cabinet's levels (what the cabinet page reads) plus its own list in the editor's shape: a replacement copies the old cabinet's own
  // list here, and that list wins over every level above, so an Admin has to be able to see, replace or remove it.
  const cabinetApps = async (cabinetId: string) => {
    const own = await readLevelState(o.pool, "cabinet", cabinetId);
    return { ...(await appLevels(o.pool, cabinetId)), own: own.list, ownRejected: own.rejected, ownPending: own.pending, checks: await checks("cabinet", cabinetId, own), ...signingState };
  };
  app.get("/api/cabinets/:id/approved-apps", async request => {
    await o.guards.role(request, "tier1");
    return cabinetApps(id(request));
  });

  app.put("/api/cabinets/:id/approved-apps", async request => {
    const u = await o.guards.role(request, "admin");
    const b = consoleBodies.approvedApps.parse(request.body);
    const scope = id(request);
    await setApprovedApps(o.pool, u, "cabinet", scope, b.entries ?? null, b.stepUpToken, appsConfirmed(b, "cabinet", scope), signing);
    return cabinetApps(scope);
  });
}
