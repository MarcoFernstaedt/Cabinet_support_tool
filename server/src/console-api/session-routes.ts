import { openSession } from "../services/session-opening.js";
import { boundTo, consumeStepUpToken } from "../auth/stepup.js";
import { transaction } from "../db/db.js";
import { grantPermission, revokePermission } from "../services/user-permissions.js";
// Session transitions use authenticated identity; permission is independent of rank.
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { Refused } from "../services/errors.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

export async function sessionRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  app.post("/api/cabinets/:id/sessions", async request => {
    const user = await o.guards.session(request);
    if (user.stage !== "complete") throw new Refused("sign_in_incomplete", 401, "finish signing in first");
    const cabinetId = id(request);
    const body = consoleBodies.sessionOpen.parse(request.body);
    return openSession(o.pool, user.userId, cabinetId, { ...body, stepUpToken: boundTo(body.stepUpToken, body) });
  });
  app.post("/api/admin/permissions", async request => {
    const user = await o.guards.role(request, "admin");
    const body = consoleBodies.permissionGrant.parse(request.body);
    const permissionId = await transaction(o.pool, async tx => {
      await consumeStepUpToken(tx, boundTo(body.stepUpToken, body), user.userId, "permission.grant", body.userId);
      return grantPermission(tx, user.userId, body.userId, body.permission, body.scopeKind, body.scopeId);
    });
    return { permissionId };
  });
  app.post("/api/admin/permissions/:id/revoke", async request => {
    const user = await o.guards.role(request, "admin");
    const permissionId = id(request);
    const body = consoleBodies.stepUpOnly.parse(request.body);
    return transaction(o.pool, async tx => {
      await consumeStepUpToken(tx, body.stepUpToken, user.userId, "permission.revoke", permissionId);
      return { changed: await revokePermission(tx, user.userId, permissionId) };
    });
  });
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
