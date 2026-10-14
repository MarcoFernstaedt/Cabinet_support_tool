// Case notes: what the signed-in person did, as text for a ticket. Always their own activity, never anyone else's; the query is checked against its contract first.
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { activityReport } from "../services/activity-report.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

export async function reportRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  app.get("/api/reports/activity", async request => {
    const u = await o.guards.role(request, "tier1");
    const q = consoleBodies.activityReportQuery.parse(request.query);
    return activityReport(o.pool, u, { ...(q.cabinetId ? { cabinetId: q.cabinetId } : {}), hours: Number(q.hours ?? "8") });
  });
}
