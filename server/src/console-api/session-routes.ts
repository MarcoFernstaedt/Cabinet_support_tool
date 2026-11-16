// Only termination is connected here. Opening remains unavailable until grants and agent policy are implemented.
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { Refused } from "../services/errors.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

export async function sessionRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  for (const [path, end] of [["end", "explicit"], ["kill", "killed"]] as const) {
    app.post(`/api/sessions/:id/${path}`, async request => {
      const user = await o.guards.session(request);
      if (user.stage !== "complete") throw new Refused("sign_in_incomplete", 401, "finish signing in first");
      const sessionId = id(request);
      const body = consoleBodies.sessionEnd.parse(request.body);
      if (!o.sessionLifecycle) throw new Refused("not_found", 404, "no such session");
      const changed = await o.sessionLifecycle.endByOperator(sessionId, user.userId, end, body.reason);
      return { changed };
    });
  }
}
