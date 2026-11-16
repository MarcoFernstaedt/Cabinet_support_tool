import type { FastifyInstance } from "fastify";
import { envelopes } from "../contracts.js";
import { RelayError, SessionRelay } from "./session-relay.js";

/** Registered inside the agent API's authenticated scope, after certificate authentication. */
export function registerSessionFrameRoute(app: FastifyInstance, relay: SessionRelay | undefined, retryAfter: () => number): void {
  app.post<{ Params: { sessionId: string } }>("/agent/v1/sessions/:sessionId/frames", async (request, reply) => {
    if (!relay || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.sessionId) || request.body === null)
      return reply.code(404).send({ error: "not_found" });
    // Check decoded size before schema validation so an oversized frame receives the transport's 413.
    const data = (request.body as { data?: unknown })?.data;
    if (typeof data === "string" && Buffer.byteLength(data, "base64") > SessionRelay.maxFrameBytes)
      return reply.code(413).send({ error: "frame_too_large" });
    const frame = envelopes.sessionFrame.parse(request.body);
    try {
      const received = await relay.exchange(request.cabinet!.id, request.params.sessionId.toLowerCase(), "agent", Buffer.from(frame.data, "base64"));
      if (received === null) return reply.code(404).send({ error: "not_found" });
      return envelopes.sessionControl.parse(JSON.parse(received.toString("utf8")));
    } catch (error) {
      // Use the server's randomized backoff, avoiding synchronized relay retries (F7).
      if (error instanceof RelayError) return reply.code(error.status).header("retry-after", String(retryAfter())).send({ error: error.code });
      throw error;
    }
  });
}
