import type { FastifyInstance } from "fastify";
import { envelopes } from "../contracts.js";
import { Refused } from "../services/errors.js";
import type { SshTransport } from "../services/ssh-transport.js";

export function registerSshTransportAgentRoutes(app: FastifyInstance, transport: SshTransport): void {
  const base = "/agent/v1/ssh-transport";
  app.post(base + "/claim", async request => ({ transportId: transport.claim(request.cabinet!.id) }));

  function transportId(request: { params: { transportId: string } }): string {
    const id = request.params.transportId;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
      throw new Refused("not_found", 404, "no such SSH transport");
    return id;
  }
  app.post<{ Params: { transportId: string } }>(base + "/:transportId/receive", async request => {
    const data = await transport.receive(request.cabinet!.id, transportId(request));
    return { data: data?.toString("base64") ?? "" };
  });
  app.post<{ Params: { transportId: string } }>(base + "/:transportId/data", { bodyLimit: 24 * 1024 }, async request => {
    const id = transportId(request);
    const data = Buffer.from(envelopes.sshTransportData.parse(request.body).data, "base64");
    if (!data.length) throw new Refused("empty_frame", 400, "SSH upload must contain data");
    if (data.length > 16_384) throw new Refused("frame_too_large", 413, "SSH data exceeds the transport limit");
    await transport.send(request.cabinet!.id, id, data);
    return { serverTime: new Date().toISOString() };
  });
  app.delete<{ Params: { transportId: string } }>(base + "/:transportId", async request => {
    await transport.disconnect(request.cabinet!.id, transportId(request));
    return { serverTime: new Date().toISOString() };
  });
}
