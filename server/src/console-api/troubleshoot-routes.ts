// The troubleshooting workflow's API: the cabinet diagnosis, runbooks, case notes, resolution statistics, the triage queue and error trends.
// Every query and body is checked against its contract; every role check is here, on the server. Tier 1 reads and writes notes, Tier 2
// proposes runbooks, an Admin decides them (with an authenticator code) and removes the text of a note.
import type { FastifyInstance } from "fastify";
import { boundTo } from "../auth/stepup.js";
import { consoleBodies } from "../contracts.js";
import { audit } from "../db/db.js";
import { cabinetDiagnosis, latestCabinetDiagnosis, startCabinetDiagnosis } from "../diagnose/cabinet.js";
import { Refused } from "../services/errors.js";
import { addNote, listNotes, redactNote } from "../services/case-notes.js";
import { decideRunbook, effectiveRunbook, listRunbooks, proposeRunbook, retireRunbook, runbookOverview } from "../services/runbooks.js";
import { issueResolutions } from "../services/resolutions.js";
import { triage } from "../services/triage.js";
import { errorTrends, runErrorTrends, trendsRunning } from "../services/error-trends.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

const MANUAL_REFRESH_GAP_MS = 10 * 60_000;

/** A route that takes no body accepts none, or an empty object. */
function noBody(body: unknown): void {
  if (body !== undefined && body !== null && !(typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0))
    throw new Refused("invalid_request", 400, "this request takes no body");
}

export async function troubleshootRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  // ---- Diagnose this cabinet ----
  app.post("/api/cabinets/:id/diagnose", async (request, reply) => {
    const u = await o.guards.role(request, "tier1");
    noBody(request.body);
    return reply.code(202).send({ diagnosisId: await startCabinetDiagnosis(o.pool, u, id(request), m => request.log.error(m)) });
  });
  app.get("/api/cabinets/:id/diagnose", async request => { await o.guards.role(request, "tier1"); return { latest: await latestCabinetDiagnosis(o.pool, id(request)) }; });
  app.get("/api/cabinet-diagnoses/:id", async request => {
    await o.guards.role(request, "tier1");
    return (await cabinetDiagnosis(o.pool, id(request))) ?? Promise.reject(new Refused("not_found", 404, "no such diagnosis"));
  });

  // ---- Runbooks ----
  app.get("/api/runbooks", async request => {
    const u = await o.guards.role(request, "tier1");
    const q = consoleBodies.runbookQuery.parse(request.query);
    if (q.issueTypeId || q.findingKey) return { runbook: await effectiveRunbook(o.pool, q.issueTypeId ? { kind: "issue", issueTypeId: q.issueTypeId } : { kind: "finding", key: q.findingKey! }) };
    // Proposals and past versions are for those who write runbooks.
    if (q.state !== undefined && q.state !== "approved" && u.role === "tier1") throw new Refused("forbidden", 403, "your role cannot see runbooks that are not in force");
    return { runbooks: await listRunbooks(o.pool, { state: q.state ?? "approved" }) };
  });
  app.get("/api/runbooks/overview", async request => { await o.guards.role(request, "tier1"); return { issues: await runbookOverview(o.pool) }; });
  app.post("/api/runbooks", async (request, reply) => {
    const u = await o.guards.role(request, "tier2");
    return reply.code(201).send(await proposeRunbook(o.pool, u.userId, consoleBodies.runbookPropose.parse(request.body)));
  });
  for (const how of ["approve", "reject", "retire"] as const)
    app.post(`/api/runbooks/:id/${how}`, async request => {
      const u = await o.guards.role(request, "admin");
      const body = consoleBodies.stepUpOnly.parse(request.body);
      const token = boundTo(body.stepUpToken, body), rid = id(request);
      if (how === "retire") { await retireRunbook(o.pool, u.userId, rid, token); return { ok: true }; }
      return decideRunbook(o.pool, u.userId, rid, how === "approve", token);
    });

  // ---- Case notes ----
  app.get("/api/cabinets/:id/notes", async request => {
    await o.guards.role(request, "tier1");
    const q = consoleBodies.caseNoteQuery.parse(request.query);
    return { notes: await listNotes(o.pool, id(request), q.alertId) };
  });
  app.post("/api/cabinets/:id/notes", async (request, reply) => {
    const u = await o.guards.role(request, "tier1");
    return reply.code(201).send(await addNote(o.pool, u.userId, id(request), consoleBodies.caseNoteCreate.parse(request.body)));
  });
  app.post("/api/notes/:id/redact", async request => {
    const u = await o.guards.role(request, "admin");
    return redactNote(o.pool, u.userId, id(request), consoleBodies.caseNoteRedact.parse(request.body).reason);
  });

  // ---- What usually fixed an issue ----
  app.get("/api/issues/:id/resolutions", async request => { await o.guards.role(request, "tier1"); return issueResolutions(o.pool, id(request)); });

  // ---- Triage and trends ----
  app.get("/api/triage", async request => { await o.guards.role(request, "tier1"); return triage(o.pool, consoleBodies.triageQuery.parse(request.query)); });
  app.get("/api/trends/errors", async request => {
    await o.guards.role(request, "tier1");
    return { ...(await errorTrends(o.pool, consoleBodies.errorTrendQuery.parse(request.query))), running: trendsRunning() };
  });
  // An Admin may bring the trends up to date now; at most once in ten minutes, one at a time, started in the background.
  app.post("/api/trends/refresh", async (request, reply) => {
    const u = await o.guards.role(request, "admin");
    noBody(request.body);
    if (trendsRunning()) return reply.code(202).send({ started: false, running: true });
    const last = (await o.pool.query<{ at: Date | null }>("SELECT computed_at AS at FROM trend_state WHERE id = 1")).rows[0]?.at;
    if (last && Date.now() - last.getTime() < MANUAL_REFRESH_GAP_MS) throw new Refused("rate_limited", 429, "the trends were brought up to date a few minutes ago");
    await audit(o.pool, { actorKind: "user", actorId: u.userId, action: "trends.refresh", outcome: "succeeded" });
    void runErrorTrends(o.pool, { actor: { userId: u.userId } }).catch(e => request.log.error({ err: String(e) }, "error trends failed"));
    return reply.code(202).send({ started: true, running: true });
  });
}
