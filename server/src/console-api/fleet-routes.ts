// Fleet views, cabinet commands and the console-managed settings.
import { boundTo } from "../auth/stepup.js";
import { cabinetTime, fleetTimeZone, setClientTimeZone, setFleetTimeZone, setSiteTimeZone, type TimeZoneId } from "../services/time.js";
import { applySiteStandards, siteStandards, type StandardPart } from "../services/site-standards.js";
import { settingOrigins } from "../services/setting-origins.js";
import { setNetworkBaseline } from "../services/network-baseline.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { consoleBodies } from "../contracts.js";
import { audit, transaction } from "../db/db.js";
import { setCurrentCabinet } from "../auth/sessions.js";
import { commandRecord } from "../services/commands.js";
import { issueFromConsole } from "../services/console-commands.js";
import { Refused } from "../services/errors.js";
import * as fleet from "../services/fleet.js";
import { setCabinetScanner, setFleetScanner, setSitePorts } from "../services/settings.js";
import { setClientSyncPorts, setFleetSyncPorts, setScanner } from "../services/device-settings.js";
import type { ConsoleApiOptions, Guards } from "./server.js";
import { compatibilityReport } from "../services/compatibility.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function id(request: FastifyRequest, name = "id"): string {
  const value = (request.params as Record<string, string>)[name]?.toLowerCase() ?? "";
  if (!UUID.test(value)) throw new Refused("not_found", 404, "not a valid ID");
  return value;
}

export async function fleetRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  app.get("/api/fleet/first-cabinet", async request => { await o.guards.role(request, "tier1"); return { cabinet: await fleet.firstCabinet(o.pool) }; });
  app.get("/api/fleet/clients", async request => { await o.guards.role(request, "tier1"); return fleet.clients(o.pool); });
  // Which Windows the fleet runs: edition, build family and architecture (F20, D55).
  app.get("/api/fleet/compatibility", async request => { await o.guards.role(request, "tier1"); return compatibilityReport(o.pool); });

  app.get("/api/fleet/clients/:id", async request => {
    await o.guards.role(request, "tier1");
    return (await fleet.client(o.pool, id(request))) ?? Promise.reject(new Refused("not_found", 404, "no such client"));
  });

  /** A site and one page of its cabinets: `limit` (1 to 500, 200 if left out) from `offset` (D81). */
  app.get("/api/fleet/sites/:id", async request => {
    await o.guards.role(request, "tier1");
    const q = consoleBodies.sitePageQuery.parse(request.query);
    const page = { ...(q.limit === undefined ? {} : { limit: Number(q.limit) }), ...(q.offset === undefined ? {} : { offset: Number(q.offset) }) };
    return (await fleet.site(o.pool, id(request), page)) ?? Promise.reject(new Refused("not_found", 404, "no such site"));
  });

  /** Opening a cabinet view is recorded in the audit log (docs/spec/06-console-spec.md). */
  app.get("/api/fleet/cabinets/:id", async request => {
    const u = await o.guards.role(request, "tier1");
    const cabinetId = id(request);
    const detail = await fleet.cabinet(o.pool, cabinetId);
    if (!detail) throw new Refused("not_found", 404, "no such cabinet");
    await transaction(o.pool, async c => {
      await setCurrentCabinet(c, u.sessionHash, cabinetId);
      await audit(c, { actorKind: "user", actorId: u.userId, action: "cabinet.view", targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded" });
    });
    return detail;
  });

  app.get("/api/fleet/search", async request => {
    await o.guards.role(request, "tier1");
    const q = consoleBodies.fleetSearch.parse(request.query).q.trim();
    return q.length === 0 ? [] : fleet.search(o.pool, q);
  });

  app.post("/api/cabinets/:id/commands", async (request, reply) => {
    const u = await o.guards.role(request, "tier1");
    const body = consoleBodies.command.parse(request.body);
    const command = await issueFromConsole(o.pool, u, id(request), body.operation, body.params, body.stepUpToken);
    return reply.code(202).send({ commandId: command.commandId, issuedAt: command.issuedAt, expiresAt: command.expiresAt });
  });

  app.get("/api/cabinets/:id/commands", async request => {
    await o.guards.role(request, "tier1");
    return fleet.commandHistory(o.pool, id(request));
  });

  app.get("/api/commands/:id", async request => {
    await o.guards.role(request, "tier1");
    const record = await commandRecord(o.pool, id(request));
    if (!record) throw new Refused("not_found", 404, "no such command");
    return record;
  });

  // ---- Console-managed settings ----------------------------------------------------
  app.get("/api/settings/scanner", async request => {
    await o.guards.role(request, "tier1");
    return { hardwareIds: await fleet.fleetScannerIds(o.pool) };
  });

  app.put("/api/settings/scanner", async request => {
    const u = await o.guards.role(request, "admin");
    const body = consoleBodies.scanner.parse(request.body);
    await setFleetScanner(o.pool, u.userId, body.hardwareIds, body.stepUpToken ? boundTo(body.stepUpToken, body) : undefined);
    return { hardwareIds: body.hardwareIds };
  });

  app.put("/api/cabinets/:id/scanner", async request => {
    const u = await o.guards.role(request, "tier2");
    const body = consoleBodies.scanner.parse(request.body);
    await setCabinetScanner(o.pool, u.userId, id(request), body.hardwareIds, body.stepUpToken ? boundTo(body.stepUpToken, body) : undefined);
    return { hardwareIds: body.hardwareIds };
  });

  // A client's or a site's scanner IDs: Tier 2 and Admin, like a cabinet's (they change only what the scanner checks look at).
  for (const level of ["client", "site"] as const)
    app.put(`/api/${level}s/:id/scanner`, async request => {
      const u = await o.guards.role(request, "tier2");
      const body = consoleBodies.scanner.parse(request.body);
      await setScanner(o.pool, u.userId, level, id(request), body.hardwareIds, body.stepUpToken ? boundTo(body.stepUpToken, body) : undefined);
      return { hardwareIds: body.hardwareIds };
    });

  // Default sync ports for a client's sites, and for the fleet (Admin).
  app.put("/api/clients/:id/sync-ports", async request => {
    const u = await o.guards.role(request, "admin");
    const body = consoleBodies.syncPorts.parse(request.body);
    await setClientSyncPorts(o.pool, u.userId, id(request), body.ports, boundTo(body.stepUpToken, body));
    return { ports: body.ports };
  });

  app.get("/api/settings/sync-ports", async request => {
    await o.guards.role(request, "tier1");
    return { ports: await fleet.fleetSyncPorts(o.pool) };
  });

  app.put("/api/settings/sync-ports", async request => {
    const u = await o.guards.role(request, "admin");
    const body = consoleBodies.syncPorts.parse(request.body);
    await setFleetSyncPorts(o.pool, u.userId, body.ports, boundTo(body.stepUpToken, body));
    return { ports: body.ports };
  });

  // Time zone and clock (module 21): what the cabinet reports against its site's zone; Tier 2 sets a site's zone.
  app.get("/api/cabinets/:id/time", async request => {
    await o.guards.role(request, "tier1");
    const t = await cabinetTime(o.pool, id(request));
    if (!t) throw new Refused("not_found", 404, "no such cabinet");
    return t;
  });

  /** Where each of a cabinet's settings with a parent scope comes from (F6.R5): the level that applies and every level that sets it. */
  app.get("/api/cabinets/:id/setting-origins", async request => {
    await o.guards.role(request, "tier1");
    return { settings: await settingOrigins(o.pool, id(request)) };
  });

  /** What the site's standards could be, taken from what its cabinets report (nothing is saved). */
  app.get("/api/sites/:id/standards", async request => {
    await o.guards.role(request, "tier1");
    return (await siteStandards(o.pool, id(request))) ?? Promise.reject(new Refused("not_found", 404, "no such site"));
  });

  /** Applies the chosen standards to a site in one action (F6.R3): from its own cabinets' suggestions, or copied from another site. */
  app.post("/api/sites/:id/standards/apply", async request => {
    const u = await o.guards.role(request, "admin");
    const body = consoleBodies.siteStandardsApply.parse(request.body);
    return applySiteStandards(o.pool, u.userId, id(request), body.from, body.parts as StandardPart[], boundTo(body.stepUpToken, body));
  });

  app.put("/api/sites/:id/network-baseline", async request => {
    const u = await o.guards.role(request, "tier2");
    const body = consoleBodies.siteNetworkBaseline.parse(request.body);
    await setNetworkBaseline(o.pool, u.userId, id(request), body.baseline, body.stepUpToken ? boundTo(body.stepUpToken, body) : undefined);
    return { baseline: body.baseline };
  });

  app.put("/api/sites/:id/time-zone", async request => {
    const u = await o.guards.role(request, "tier2");
    const body = consoleBodies.siteTimeZone.parse(request.body);
    await setSiteTimeZone(o.pool, u.userId, id(request), body.timeZone as TimeZoneId | null);
    return { timeZone: body.timeZone };
  });

  /** A client's default zone for its sites (Tier 2 and up, like a site's own). */
  app.put("/api/clients/:id/time-zone", async request => {
    const u = await o.guards.role(request, "tier2");
    const body = consoleBodies.siteTimeZone.parse(request.body);
    await setClientTimeZone(o.pool, u.userId, id(request), body.timeZone as TimeZoneId | null);
    return { timeZone: body.timeZone };
  });

  /** The fleet default zone: read by anyone signed in, set by an Admin. */
  app.get("/api/settings/time-zone", async request => { await o.guards.role(request, "tier1"); return { timeZone: await fleetTimeZone(o.pool) }; });
  app.put("/api/settings/time-zone", async request => {
    const u = await o.guards.role(request, "admin");
    const body = consoleBodies.siteTimeZone.parse(request.body);
    await setFleetTimeZone(o.pool, u.userId, body.timeZone as TimeZoneId | null);
    return { timeZone: body.timeZone };
  });

  app.put("/api/sites/:id/sync", async request => {
    const u = await o.guards.role(request, "admin");
    const body = consoleBodies.syncPorts.parse(request.body);
    await setSitePorts(o.pool, u.userId, id(request), body.ports, boundTo(body.stepUpToken, body));
    return { ports: body.ports };
  });
}
