// Alerts, the offline filter, stored events, issue types and symptom rules
// (docs/spec/06-console-spec.md "Alerts area", "Issues area", "Mapping an error to an issue").
// Every query string and body is checked against its contract; every role check is here.
import { boundTo } from "../auth/stepup.js";
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { audit } from "../db/db.js";
import * as alerts from "../services/alerts.js";
import { Refused } from "../services/errors.js";
import * as rules from "../services/rules.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";
import { HEAVY_LIMIT_MS, HeavyQuery } from "./heavy.js";

const previews = new HeavyQuery("rule preview", HEAVY_LIMIT_MS);

/** A route that takes no body accepts none, or an empty object. */
function noBody(body: unknown): void {
  if (body !== undefined && body !== null && !(typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0))
    throw new Refused("invalid_request", 400, "this request takes no body");
}

export async function alertRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  app.get("/api/alerts", async request => {
    const u = await o.guards.role(request, "tier1");
    return alerts.listAlerts(o.pool, consoleBodies.alertFilter.parse(request.query), u.userId);
  });

  app.get("/api/alerts/summary", async request => { await o.guards.role(request, "tier1"); return alerts.summary(o.pool); });

  app.get("/api/alerts/offline", async request => {
    await o.guards.role(request, "tier1");
    const f = consoleBodies.alertFilter.parse(request.query);
    return alerts.offline(o.pool, { ...(f.clientId ? { clientId: f.clientId } : {}), ...(f.siteId ? { siteId: f.siteId } : {}) });
  });

  app.get("/api/alerts/:id", async request => {
    await o.guards.role(request, "tier1");
    return (await alerts.alertById(o.pool, id(request))) ?? Promise.reject(new Refused("not_found", 404, "no such alert"));
  });

  app.post("/api/alerts/:id/claim", async request => {
    const u = await o.guards.role(request, "tier1");
    noBody(request.body);
    return alerts.claimAlert(o.pool, u.userId, id(request));
  });

  app.post("/api/alerts/:id/resolve", async request => {
    const u = await o.guards.role(request, "tier1");
    const body = consoleBodies.alertResolve.parse(request.body ?? {});
    return alerts.resolveAlert(o.pool, u, id(request), body.note, { cause: body.cause, fix: body.fix, saveFix: body.saveFix, canApproveFixes: u.canApproveFixes });
  });

  app.get("/api/events/lookup", async request => {
    await o.guards.role(request, "tier1");
    const q = consoleBodies.eventLookup.parse(request.query);
    return alerts.sameErrorElsewhere(o.pool, q.cabinetId, q.log, q.source, Number(q.eventId));
  });

  app.get("/api/events/:id", async request => {
    const u = await o.guards.role(request, "tier1");
    const e = await alerts.eventById(o.pool, id(request));
    if (!e) throw new Refused("not_found", 404, "no such event");
    // Opening an event log entry is logged too (docs/spec/05-server-spec.md).
    await audit(o.pool, { actorKind: "user", actorId: u.userId, action: "event.open", targetKind: "cabinet", targetId: e.cabinetId, outcome: "succeeded",
      details: { eventId: e.eventId } });
    const elsewhere = e.kind === "error" && e.source ? await alerts.sameErrorElsewhere(o.pool, e.cabinetId, e.source.log, e.source.source, e.source.eventId) : null;
    return { ...e, elsewhere };
  });

  app.get("/api/cabinets/:id/events", async request => {
    await o.guards.role(request, "tier1");
    return alerts.cabinetEvents(o.pool, id(request));
  });

  // ---- Issues and rules ---------------------------------------------------------------

  app.get("/api/issues", async request => { await o.guards.role(request, "tier1"); return rules.issueTypes(o.pool); });

  app.get("/api/rules", async request => {
    await o.guards.role(request, "tier1");
    const f = consoleBodies.ruleFilter.parse(request.query);
    return rules.listRules(o.pool, { ...(f.state ? { state: f.state } : {}), ...(f.issueTypeId ? { issueTypeId: f.issueTypeId } : {}) });
  });

  app.get("/api/rules/:id/history", async request => { await o.guards.role(request, "tier1"); return rules.ruleHistory(o.pool, id(request)); });

  app.post("/api/rules/preview", async request => {
    const u = await o.guards.role(request, "tier2");
    const body = consoleBodies.rulePreview.parse(request.body);
    rules.checkUserMatch(body.match);
    // It counts matching events across the fleet: one at a time per person, stopped after 15 s.
    return previews.run(u.userId, o.pool, db => rules.preview(db, body.match));
  });

  app.post("/api/rules", async (request, reply) => {
    const u = await o.guards.role(request, "tier2");
    const body = consoleBodies.ruleProposal.parse(request.body);
    return reply.code(201).send(await rules.proposeRule(o.pool, u, body.newIssueType ?? body.issueTypeId!, body.match, body.regroup, boundTo(body.stepUpToken, body), body.severity ?? null));
  });

  for (const [path, approve] of [["approve", true], ["reject", false]] as const)
    app.post(`/api/rules/:id/${path}`, async request => {
      const u = await o.guards.role(request, "admin");
      const body = consoleBodies.stepUpOnly.parse(request.body);
      return rules.decideRule(o.pool, u.userId, id(request), approve, boundTo(body.stepUpToken, body));
    });

  app.post("/api/rules/:id/disable", async request => {
    const u = await o.guards.role(request, "admin");
    const body = consoleBodies.stepUpOnly.parse(request.body);
    await rules.disableRule(o.pool, u.userId, id(request), boundTo(body.stepUpToken, body));
    return { ok: true };
  });

  app.post("/api/rules/:id/rollback", async request => {
    const u = await o.guards.role(request, "admin");
    const body = consoleBodies.ruleRollback.parse(request.body);
    await rules.rollbackRule(o.pool, u.userId, id(request), body.version, boundTo(body.stepUpToken, body));
    return { ok: true };
  });
}
