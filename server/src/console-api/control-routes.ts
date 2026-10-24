// The control request for the approved-applications list (docs/spec/13-roadmap.md milestone 10): a Tier 2 asks a cabinet to
// start, stop or restart a service, or to end a process, by naming one approved entry and an action.
//
// The cabinet is the route's own id and the target is looked up from the entry (and, for an end, from the process the cabinet
// itself reported), so this body has no field for a service name, an image path or a command line. The decision itself - which
// entry, which action, which program - lives in services/app-control.ts, which tests can exercise without a database; this file
// only checks the contract and hands the request over. Tier 2 and up, and every action needs a step-up token bound to this
// exact entry, action and cabinet, not to the route.
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { controlApproved, controlEffects } from "../services/app-control.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

export async function controlRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  app.post("/api/cabinets/:id/app-control", async (request, reply) => {
    const u = await o.guards.role(request, "tier2");
    const b = consoleBodies.appControl.parse(request.body);
    const outcome = await controlApproved(o.pool, u, { cabinetId: id(request), entryKey: b.entryKey, action: b.action, stepUpToken: b.stepUpToken,
      ...(b.processId === undefined ? {} : { processId: b.processId }) }, controlEffects(o.pool));
    // 202: the command is recorded and waiting for the cabinet's next heartbeat, exactly like every other console command.
    return reply.code(202).send(outcome);
  });
}