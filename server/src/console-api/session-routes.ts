import { SessionShell } from "../services/session-shell.js";
import { sessionRecord } from "../services/session-records.js";
import { requireCabinetPermission } from "../services/user-permissions.js";
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
    // A shell must have the lifecycle installed so its end/kill path can enforce closure.
    if (body.kind === "shell" && !o.sessionLifecycle) throw new Refused("shell_unavailable", 400, "shell lifecycle is not installed");
    return openSession(o.pool, user.userId, cabinetId, { ...body, stepUpToken: boundTo(body.stepUpToken, body) });
  });
  app.get("/api/cabinets/:id/sessions", async request => {
    const user = await o.guards.session(request);
    if (user.stage !== "complete") throw new Refused("sign_in_incomplete", 401, "finish signing in first");
    const cabinetId = id(request);
    // Discovery runs on every cabinet view, including for people without session access.
    // Reveal neither capability nor session records without a current scoped grant.
    try { await requireCabinetPermission(o.pool, user.userId, cabinetId, "session.open"); }
    catch (error) {
      if (error instanceof Refused && error.code === "permission_required") return { developmentShell: false, sessions: [] };
      throw error;
    }
    const capable = (await o.pool.query("SELECT id FROM cabinets WHERE id = $1 AND development_shell = 1 AND read_only = 0 AND last_heartbeat_at > DATEADD(minute, -10, SYSUTCDATETIME())", [cabinetId])).rows.length > 0;
    return { developmentShell: capable, sessions: (await o.pool.query("SELECT * FROM remote_sessions WHERE cabinet_id = $1 AND operator_id = $2 ORDER BY opened_at DESC", [cabinetId, user.userId])).rows };
  });
  app.get("/api/sessions/:id/record", async request => {
    const user = await o.guards.session(request);
    if (user.stage !== "complete") throw new Refused("sign_in_incomplete", 401, "finish signing in first");
    const sessionId = id(request), row = await sessionRecord(o.pool, sessionId);
    if (!row || row.operator_id !== user.userId) throw new Refused("not_found", 404, "no such session");
    await requireCabinetPermission(o.pool, user.userId, row.cabinet_id, "session.open");
    return { session: row, commands: (await o.pool.query("SELECT seq, input_data, complete, recorded_at FROM session_shell_commands WHERE session_id = $1 ORDER BY seq", [sessionId])).rows, frames: (await o.pool.query("SELECT seq, direction, frame, recorded_at FROM session_shell_frames WHERE session_id = $1 ORDER BY seq", [sessionId])).rows };
  });
  app.post("/api/sessions/:id/frames", async request => {
    const user = await o.guards.session(request);
    if (user.stage !== "complete") throw new Refused("sign_in_incomplete", 401, "finish signing in first");
    const sessionId = id(request), row = await sessionRecord(o.pool, sessionId);
    if (!row || row.operator_id !== user.userId) throw new Refused("not_found", 404, "no such session");
    // This is the console end of the session transport, not an agent execution API.
    return { frame: await new SessionShell(o.pool).exchange(row.cabinet_id, sessionId, "console", request.body, user.userId) };
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
