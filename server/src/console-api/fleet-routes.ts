// Fleet views, cabinet commands and the console-managed settings.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { consoleBodies } from "../contracts.js";
import { audit, transaction } from "../db/db.js";
import { commandRecord } from "../services/commands.js";
import { issueFromConsole } from "../services/console-commands.js";
import { Refused } from "../services/errors.js";
import * as fleet from "../services/fleet.js";
import { setCabinetScanner, setFleetScanner, setSiteSync } from "../services/settings.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function id(request: FastifyRequest, name = "id"): string {
  const value = (request.params as Record<string, string>)[name]?.toLowerCase() ?? "";
  if (!UUID.test(value)) throw new Refused("not_found", 404, "not a valid ID");
  return value;
}

export async function fleetRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  app.get("/api/fleet/clients", async request => { await o.guards.role(request, "tier1"); return fleet.clients(o.pool); });

  app.get("/api/fleet/clients/:id", async request => {
    await o.guards.role(request, "tier1");
    return (await fleet.client(o.pool, id(request))) ?? Promise.reject(new Refused("not_found", 404, "no such client"));
  });

  app.get("/api/fleet/sites/:id", async request => {
    await o.guards.role(request, "tier1");
    return (await fleet.site(o.pool, id(request))) ?? Promise.reject(new Refused("not_found", 404, "no such site"));
  });

  /** Opening a cabinet view is recorded in the audit log (docs/spec/06-console-spec.md). */
  app.get("/api/fleet/cabinets/:id", async request => {
    const u = await o.guards.role(request, "tier1");
    const cabinetId = id(request);
    const detail = await fleet.cabinet(o.pool, cabinetId);
    if (!detail) throw new Refused("not_found", 404, "no such cabinet");
    await transaction(o.pool, async c => {
      await c.query("UPDATE sessions SET current_cabinet = $2 WHERE id_hash = $1", [u.sessionHash, cabinetId]);
      await audit(c, { actorKind: "user", actorId: u.userId, action: "cabinet.view", targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded" });
    });
    return detail;
  });

  app.get("/api/fleet/search", async request => {
    await o.guards.role(request, "tier1");
    const q = String((request.query as Record<string, unknown>).q ?? "").trim();
    if (q.length < 1 || q.length > 64 || /[\u0000-\u001f]/.test(q)) return [];
    return fleet.search(o.pool, q);
  });

  app.post("/api/cabinets/:id/commands", async (request, reply) => {
    const u = await o.guards.role(request, "tier1");
    const body = consoleBodies.command.parse(request.body);
    const command = await issueFromConsole(o.pool, u, id(request), body.operation, body.params, body.stepUpToken);
    return reply.code(202).send({ commandId: command.commandId, expiresAt: command.expiresAt });
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
    await setFleetScanner(o.pool, u.userId, body.hardwareIds, body.stepUpToken);
    return { hardwareIds: body.hardwareIds };
  });

  app.put("/api/cabinets/:id/scanner", async request => {
    const u = await o.guards.role(request, "tier2");
    const body = consoleBodies.scanner.parse(request.body);
    await setCabinetScanner(o.pool, u.userId, id(request), body.hardwareIds, body.stepUpToken);
    return { hardwareIds: body.hardwareIds };
  });

  app.put("/api/sites/:id/sync", async request => {
    const u = await o.guards.role(request, "admin");
    const body = consoleBodies.sync.parse(request.body);
    await setSiteSync(o.pool, u.userId, id(request), body.address, body.ports, body.stepUpToken);
    return { address: body.address, ports: body.ports };
  });
}
