// Admin: the pending queue, bootstrap tokens and revoking cabinets (the other admin screens are in manage-routes.ts).
// Every change needs a step-up token for that exact action and target.
import { boundTo } from "../auth/stepup.js";
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { transaction } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { revokeCabinet } from "../services/cabinets.js";
import { ListSigningKeys } from "../services/approved-list-signing.js";
import { approvalBaselinePreview, approvalSitePreview, approveEnrollment, createBootstrapToken, pendingRequests, rejectEnrollment, revokeBootstrapToken, siteTokens } from "../services/enrollment.js";
import { cabinetsInScope, evaluateBaselineDrift } from "../services/baseline-drift.js";
import { evaluateHealth } from "../services/cabinet-health.js";
import { reevaluations } from "./baseline-routes.js";
import type { TimeZoneId } from "../services/time.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

export async function adminRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  /** Consumes the step-up token in its own transaction just before the action, which runs in the next. */
  const stepUp = (userId: string, token: string, action: string, target: string) =>
    transaction(o.pool, c => consumeStepUpToken(c, token, userId, action, target));

  app.get("/api/admin/enrollments", async request => {
    await o.guards.role(request, "admin");
    return pendingRequests(o.pool);
  });

  /** Which approved baseline an approval with this client and site would use, and the ones that could be attached. Reads only. */
  app.get("/api/admin/enrollments/:id/baseline", async request => {
    await o.guards.role(request, "admin");
    const requestId = id(request);
    return approvalBaselinePreview(o.pool, requestId, consoleBodies.approveBaseline.parse(request.query));
  });

  /** What a new site would inherit (firewall policy and time zone), for the approval to pre-fill. Reads only. */
  app.get("/api/admin/enrollments/:id/site-policies", async request => {
    await o.guards.role(request, "admin");
    const requestId = id(request);
    return approvalSitePreview(o.pool, requestId, consoleBodies.approveBaseline.parse(request.query));
  });

  app.post("/api/admin/enrollments/:id/approve", async request => {
    const u = await o.guards.role(request, "admin");
    const requestId = id(request);
    // The contract requires the baseline decision: an approval without one is refused here, before anything else runs.
    const body = consoleBodies.approve.parse(request.body);
    await stepUp(u.userId, boundTo(body.stepUpToken, body), "enrollment.approve", requestId);
    // A satellite may name its sync cabinet; the server checks it is an active sync cabinet at the same site.
    const result = await approveEnrollment(o.pool, o.issuingKey, requestId, { clientName: body.client, siteName: body.site, cabinetName: body.cabinet, role: body.role,
      ...(body.syncCabinetId ? { syncCabinetId: body.syncCabinetId.toLowerCase() } : {}), ...(body.scanner ? { scanner: body.scanner } : {}),
      ...(body.replacesCabinetId ? { replacesCabinetId: body.replacesCabinetId.toLowerCase() } : {}),
      ...(body.sitePolicies ? { sitePolicies: { firewall: body.sitePolicies.firewall ?? null, timeZone: (body.sitePolicies.timeZone ?? null) as TimeZoneId | null } } : {}), baseline: body.baseline }, u.userId,
      o.listKeys ?? ListSigningKeys.fromFolder());
    // An attached baseline changes what every cabinet at the site is compared with: bring them up to date in the background, one at a time.
    if (body.baseline.use === "attach") {
      const run = (async () => { for (const c of await cabinetsInScope(o.pool, { kind: "site", id: result.siteId.toLowerCase() })) { await evaluateBaselineDrift(o.pool, c); await evaluateHealth(o.pool, c); } })()
        .catch(e => app.log.error({ err: { type: (e as Error).name } }, "re-evaluating after a baseline was attached failed"))
        .finally(() => reevaluations.delete(run));
      reevaluations.add(run);
    }
    return result;
  });

  app.post("/api/admin/enrollments/:id/reject", async request => {
    const u = await o.guards.role(request, "admin");
    const requestId = id(request);
    const body = consoleBodies.stepUpOnly.parse(request.body);
    await stepUp(u.userId, boundTo(body.stepUpToken, body), "enrollment.reject", requestId);
    await rejectEnrollment(o.pool, requestId, u.userId);
    return { status: "rejected" };
  });

  /**
   * A token for installing one cabinet, or with `site` a site installer's token for up to `cabinets` cabinets of that site (F6.R1), with
   * the CA file the installer needs. Shown once. The confirmation is bound to the site and its limits.
   */
  app.post("/api/admin/bootstrap-tokens", async request => {
    const u = await o.guards.role(request, "admin");
    const body = consoleBodies.installerRequest.parse(request.body);
    await stepUp(u.userId, boundTo(body.stepUpToken, body), "token.create", "fleet");
    const { token, expiresAt, id, cabinets } = await createBootstrapToken(o.pool, u.userId, undefined, body.site);
    return { token, expiresAt: expiresAt.toISOString(), platformCaPem: o.issuingKey.certificatePem, ...(body.site ? { id, cabinets } : {}) };
  });

  /** The site installers of the last 30 days: where, for how many cabinets, how many have used them, and whether one was stopped. */
  app.get("/api/admin/bootstrap-tokens", async request => {
    await o.guards.role(request, "admin");
    return { tokens: await siteTokens(o.pool) };
  });

  /** Stops a site installer early: no cabinet enrolls with it after this. Confirmed with a code, as every Admin action is. */
  app.post("/api/admin/bootstrap-tokens/:id/revoke", async request => {
    const u = await o.guards.role(request, "admin");
    const tokenId = id(request);
    const body = consoleBodies.stepUpOnly.parse(request.body);
    await stepUp(u.userId, boundTo(body.stepUpToken, body), "token.revoke", tokenId);
    await revokeBootstrapToken(o.pool, u.userId, tokenId);
    return { status: "revoked" };
  });

  app.post("/api/admin/cabinets/:id/revoke", async request => {
    const u = await o.guards.role(request, "admin");
    const cabinetId = id(request);
    const body = consoleBodies.stepUpOnly.parse(request.body);
    await stepUp(u.userId, boundTo(body.stepUpToken, body), "cabinet.revoke", cabinetId);
    await revokeCabinet(o.pool, cabinetId, u.userId);
    return { status: "removed" };
  });
}
