import type { FastifyInstance } from "fastify";
import type { Guards } from "./server.js";
import { consoleBodies } from "../contracts.js";
import { id } from "./fleet-routes.js";
import { Refused } from "../services/errors.js";
import type { SshTransport } from "../services/ssh-transport.js";

export function sshTransportRoutes(app: FastifyInstance, guards: Guards, transport: SshTransport): void {
  const endpoint = "/api/cabinets/:id/ssh-transport";
  app.post(endpoint, async request => {
    const user = await guards.role(request, "tier1");
    const cabinetId = id(request);
    const { stepUpToken } = consoleBodies.stepUpOnly.parse(request.body);
    return transport.open(user.userId, cabinetId, stepUpToken);
  });
  app.delete<{ Params: { id: string; transportId: string } }>(endpoint + "/:transportId", async request => {
    const user = await guards.session(request);
    if (user.stage !== "complete") throw new Refused("sign_in_incomplete", 401, "finish signing in first");
    await transport.end(user.userId, id(request), request.params.transportId);
    return { ok: true };
  });
}
