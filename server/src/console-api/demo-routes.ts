// Demo mode (docs/platform/demo.md): everyone signed in can see whether it is on (the console shows a banner); only an
// Admin turns it on, off or resets it, confirmed with an authenticator code bound to the exact change. Every body is checked against the demo-mode contract first.
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { boundTo, consumeStepUpToken } from "../auth/stepup.js";
import { transaction } from "../db/db.js";
import { demoStatus, disableDemo, enableDemo } from "../demo/demo.js";
import { demoScenarios } from "../demo/scenarios.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

export async function demoRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  app.get("/api/demo", async request => {
    await o.guards.role(request, "tier1");
    return demoStatus(o.pool);
  });

  app.put("/api/admin/demo", async request => {
    const u = await o.guards.role(request, "admin");
    const b = consoleBodies.demoMode.parse(request.body);
    await transaction(o.pool, c => consumeStepUpToken(c, boundTo(b.stepUpToken, b), u.userId, "demo.change", "fleet"));
    if (b.reset) { await disableDemo(o.pool, u.userId); await enableDemo(o.pool, u.userId); }
    else if (b.enabled) await enableDemo(o.pool, u.userId);
    else await disableDemo(o.pool, u.userId);
    return demoStatus(o.pool);
  });

  app.get("/api/demo/scenarios", async request => {
    await o.guards.role(request, "tier1");
    return { scenarios: await demoScenarios(o.pool) };
  });
}
