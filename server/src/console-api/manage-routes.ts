// Milestone 6 admin screens (docs/spec/06-console-spec.md "Admin screens"): users, online now,
// activity, the audit log, clients and sites, issue types and suppressions, fleet safety,
// settings and security alerts. Admin only; every change needs a step-up token for that exact
// action and target, and every body and query is checked against its contract first.
import { allSignIns } from "../services/sign-ins.js";
import { boundTo } from "../auth/stepup.js";
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";

import * as admin from "../services/admin.js";
import { Refused } from "../services/errors.js";
import { importClientsAndSites, previewImport } from "../services/fleet-import.js";
import * as users from "../services/users.js";
import { listSecurityAlerts, openSecurityAlertCount, resolveSecurityAlert } from "../services/security.js";
import { createSuppression, listSuppressions, renewSuppression } from "../services/rules.js";
import { platformSettings, updatePlatformSettings } from "../services/settings.js";
import { setSyncAddress, setSyncCabinet } from "../services/sync-cabinets.js";
import { healthSummary } from "../services/ops-health.js";
import { verifyChainAndAlert } from "../services/maintenance.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";
import { HEAVY_LIMIT_MS, HeavyQuery } from "./heavy.js";

const auditSearches = new HeavyQuery("audit search", HEAVY_LIMIT_MS);

export async function manageRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  const asAdmin = (request: Parameters<Guards["role"]>[0]) => o.guards.role(request, "admin");

  // ---- Users -------------------------------------------------------------------------------
  app.get("/api/admin/users", async request => { await asAdmin(request); return users.listUsers(o.pool, consoleBodies.usersQuery.parse(request.query).deleted === "true"); });

  app.post("/api/admin/users", async (request, reply) => {
    const u = await asAdmin(request);
    const b = consoleBodies.userCreate.parse(request.body);
    const created = await users.createUser(o.pool, u.userId, { username: b.username, name: b.name, role: b.role, ...(b.writeLimit ? { writeLimit: b.writeLimit } : {}) }, boundTo(b.stepUpToken, b));
    // The temporary password is shown once, here; it is never stored or logged.
    return reply.code(201).header("Cache-Control", "no-store").send(created);
  });

  app.put("/api/admin/users/:id", async request => {
    const u = await asAdmin(request);
    const b = consoleBodies.userUpdate.parse(request.body);
    await users.updateUser(o.pool, u.userId, id(request), { ...(b.role ? { role: b.role } : {}), ...(b.writeLimit ? { writeLimit: b.writeLimit } : {}),
      ...(b.status ? { status: b.status } : {}), ...(b.canApproveFixes !== undefined ? { canApproveFixes: b.canApproveFixes } : {}) }, boundTo(b.stepUpToken, b));
    return { ok: true };
  });

  app.post("/api/admin/users/:id/delete", async request => {
    const u = await asAdmin(request);
    await users.deleteUser(o.pool, u.userId, id(request), consoleBodies.stepUpOnly.parse(request.body).stepUpToken);
    return { ok: true };
  });

  app.post("/api/admin/users/:id/reactivate", async (request, reply) => {
    const u = await asAdmin(request);
    const b = consoleBodies.userReactivate.parse(request.body);
    const r = await users.reactivateUser(o.pool, u.userId, id(request), b.reason.trim(), boundTo(b.stepUpToken, b));
    return reply.header("Cache-Control", "no-store").send(r);
  });

  app.post("/api/admin/users/:id/reset-password", async (request, reply) => {
    const u = await asAdmin(request);
    const r = await users.resetPassword(o.pool, u.userId, id(request), consoleBodies.stepUpOnly.parse(request.body).stepUpToken);
    return reply.header("Cache-Control", "no-store").send(r);
  });

  app.post("/api/admin/users/:id/reset-authenticator", async request => {
    const u = await asAdmin(request);
    await users.resetTotp(o.pool, u.userId, id(request), consoleBodies.stepUpOnly.parse(request.body).stepUpToken);
    return { ok: true };
  });

  app.post("/api/admin/users/:id/resume-writes", async request => {
    const u = await asAdmin(request);
    await users.resumeUserWrites(o.pool, u.userId, id(request), consoleBodies.stepUpOnly.parse(request.body).stepUpToken);
    return { ok: true };
  });

  // ---- Online now, activity and the audit log ------------------------------------------------
  app.get("/api/admin/online", async request => { await asAdmin(request); return admin.onlineUsers(o.pool); });

  app.get("/api/admin/users/:id/activity", async request => {
    await asAdmin(request);
    return admin.userActivity(o.pool, id(request), consoleBodies.auditFilter.parse(request.query));
  });

  app.get("/api/admin/audit", async request => {
    const u = await asAdmin(request);
    const filter = consoleBodies.auditFilter.parse(request.query);
    // The audit log is kept forever: one search at a time per person, stopped after 15 s.
    return auditSearches.run(u.userId, o.pool, db => admin.searchAudit(db, filter));
  });

  app.post("/api/admin/audit/verify", async request => {
    const u = await asAdmin(request);
    return verifyChainAndAlert(o.pool, { userId: u.userId });
  });

  // ---- Clients, sites and cabinet roles ------------------------------------------------------
  app.get("/api/admin/clients", async request => { await asAdmin(request); return admin.listClientsWithSites(o.pool); });

  app.post("/api/admin/clients", async (request, reply) => {
    const u = await asAdmin(request);
    const b = consoleBodies.nameChange.parse(request.body);
    return reply.code(201).send({ id: await admin.createClient(o.pool, u.userId, b.name, boundTo(b.stepUpToken, b)) });
  });

  app.put("/api/admin/clients/:id", async request => {
    const u = await asAdmin(request);
    const b = consoleBodies.nameChange.parse(request.body);
    await admin.renameClient(o.pool, u.userId, id(request), b.name, boundTo(b.stepUpToken, b));
    return { ok: true };
  });

  app.post("/api/admin/clients/:id/remove", async request => {
    const u = await asAdmin(request);
    await admin.removeClient(o.pool, u.userId, id(request), consoleBodies.stepUpOnly.parse(request.body).stepUpToken);
    return { ok: true };
  });

  app.post("/api/admin/sites", async (request, reply) => {
    const u = await asAdmin(request);
    const b = consoleBodies.siteCreate.parse(request.body);
    return reply.code(201).send({ id: await admin.createSite(o.pool, u.userId, b.clientId.toLowerCase(), b.name, boundTo(b.stepUpToken, b)) });
  });

  // Clients and sites in bulk (F6.R4): previewed without a code, imported with a code bound to the rows.
  app.post("/api/admin/import/preview", async request => {
    await asAdmin(request);
    return previewImport(o.pool, consoleBodies.fleetImport.parse(request.body).rows);
  });

  app.post("/api/admin/import", async request => {
    const u = await asAdmin(request);
    const b = consoleBodies.fleetImport.parse(request.body);
    if (!b.stepUpToken) throw new Refused("step_up_required", 403, "an import needs an authenticator code");
    return importClientsAndSites(o.pool, u.userId, b.rows, boundTo(b.stepUpToken, b));
  });

  app.put("/api/admin/sites/:id", async request => {
    const u = await asAdmin(request);
    const b = consoleBodies.nameChange.parse(request.body);
    await admin.renameSite(o.pool, u.userId, id(request), b.name, boundTo(b.stepUpToken, b));
    return { ok: true };
  });

  app.post("/api/admin/sites/:id/remove", async request => {
    const u = await asAdmin(request);
    await admin.removeSite(o.pool, u.userId, id(request), consoleBodies.stepUpOnly.parse(request.body).stepUpToken);
    return { ok: true };
  });

  app.put("/api/admin/cabinets/:id/role", async request => {
    const u = await asAdmin(request);
    const b = consoleBodies.cabinetRole.parse(request.body);
    await admin.setCabinetRole(o.pool, u.userId, id(request), b.role, boundTo(b.stepUpToken, b));
    return { ok: true };
  });

  app.put("/api/admin/cabinets/:id/sync-cabinet", async request => {
    const u = await asAdmin(request);
    const b = consoleBodies.cabinetSyncCabinet.parse(request.body);
    await setSyncCabinet(o.pool, u.userId, id(request), b.syncCabinetId === null ? null : b.syncCabinetId.toLowerCase(), boundTo(b.stepUpToken, b));
    return { ok: true };
  });

  app.put("/api/admin/cabinets/:id/sync-address", async request => {
    const u = await asAdmin(request);
    const b = consoleBodies.cabinetSyncAddress.parse(request.body);
    await setSyncAddress(o.pool, u.userId, id(request), b.address, boundTo(b.stepUpToken, b));
    return { ok: true };
  });

  // ---- Issue types and suppressions ----------------------------------------------------------
  app.post("/api/admin/issue-types", async (request, reply) => {
    const u = await asAdmin(request);
    const b = consoleBodies.issueType.parse(request.body);
    return reply.code(201).send({ id: await admin.createIssueType(o.pool, u.userId, { name: b.name, severity: b.severity, description: b.description }, boundTo(b.stepUpToken, b)) });
  });

  app.put("/api/admin/issue-types/:id", async request => {
    const u = await asAdmin(request);
    const b = consoleBodies.issueType.parse(request.body);
    await admin.updateIssueType(o.pool, u.userId, id(request), { name: b.name, severity: b.severity, description: b.description }, boundTo(b.stepUpToken, b));
    return { ok: true };
  });

  app.get("/api/admin/suppressions", async request => { await asAdmin(request); return listSuppressions(o.pool); });

  app.post("/api/admin/suppressions", async (request, reply) => {
    const u = await asAdmin(request);
    const b = consoleBodies.suppressionCreate.parse(request.body);
    return reply.code(201).send(await createSuppression(o.pool, { userId: u.userId, role: u.role }, b.match, b.reason, boundTo(b.stepUpToken, b)));
  });

  app.post("/api/admin/suppressions/:id/renew", async request => {
    const u = await asAdmin(request);
    return renewSuppression(o.pool, u.userId, id(request), consoleBodies.stepUpOnly.parse(request.body).stepUpToken);
  });

  // ---- Fleet safety and settings -------------------------------------------------------------
  app.get("/api/admin/fleet-safety", async request => { await asAdmin(request); return admin.fleetSafety(o.pool); });

  app.get("/api/admin/settings", async request => { await asAdmin(request); return platformSettings(o.pool); });

  app.put("/api/admin/settings", async request => {
    const u = await asAdmin(request);
    const b = consoleBodies.platformSettings.parse(request.body);
    const after = await updatePlatformSettings(o.pool, u.userId, {
      ...(b.offlineAlertDays !== undefined ? { offlineAlertDays: b.offlineAlertDays } : {}),
      ...(b.sessionIdleMinutes !== undefined ? { sessionIdleMinutes: b.sessionIdleMinutes } : {}),
      ...(b.sessionAbsoluteHours !== undefined ? { sessionAbsoluteHours: b.sessionAbsoluteHours } : {}),
      ...(b.retention ? { retention: b.retention } : {}),
      ...(b.agents ? { agents: b.agents } : {}),
      ...(b.drives ? { drives: b.drives } : {}),
    }, boundTo(b.stepUpToken, b));
    o.guards.settings.invalidate();
    return after;
  });

  // ---- System health: Admin only, counts and sizes, no secrets (docs/platform/operations.md) ----------------
  app.get("/api/admin/system-health", async (request, reply) => {
    await asAdmin(request);
    consoleBodies.systemHealthQuery.parse(request.query);
    return reply.header("Cache-Control", "no-store").send(await healthSummary(o.pool, { caCertificatePem: o.issuingKey.certificatePem }));
  });

  // ---- Security alerts -----------------------------------------------------------------------
  app.get("/api/admin/security-alerts", async request => {
    await asAdmin(request);
    return listSecurityAlerts(o.pool, consoleBodies.securityAlertFilter.parse(request.query).state ?? "open");
  });

  /** Every account's recent sign-ins; "new" shows only those from a network or device the account had not used before. */
  app.get("/api/admin/sign-ins", async request => {
    await asAdmin(request);
    return { signIns: await allSignIns(o.pool, consoleBodies.signInFilter.parse(request.query).scope ?? "all") };
  });

  app.get("/api/admin/security-alerts/summary", async request => { await asAdmin(request); return { open: await openSecurityAlertCount(o.pool) }; });

  app.post("/api/admin/security-alerts/:id/resolve", async request => {
    const u = await asAdmin(request);
    const b = consoleBodies.securityAlertResolve.parse(request.body);
    await resolveSecurityAlert(o.pool, u.userId, id(request), b.note, boundTo(b.stepUpToken, b));
    return { ok: true };
  });
}
