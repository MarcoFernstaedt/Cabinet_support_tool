// Upgrades (docs/spec/06-console-spec.md "Admin screens": start, pause and roll back staged rollouts, and see
// per-cabinet results). Admin only; every change needs a step-up token for that exact action and target, and every
// body is checked against its contract first. A rollback is a new signed release with a higher version, started as
// its own rollout (docs/spec/07-upgrade-channel.md "Downgrades").
import { boundTo } from "../auth/stepup.js";
import type { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { consoleBodies } from "../contracts.js";
import { Refused } from "../services/errors.js";
import { addRelease, isVersion, listReleases, receiveReleasePackage } from "../services/releases.js";
import { changeRollout, listRollouts, rolloutTargets, setInOffice, startRollout, upgradeCandidates } from "../services/rollouts.js";
import { id } from "./fleet-routes.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

export async function upgradeRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  const asAdmin = (request: Parameters<Guards["role"]>[0]) => o.guards.role(request, "admin");
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  const version = (request: { params: unknown }): string => {
    const v = (request.params as { version?: unknown }).version;
    if (!isVersion(v)) throw new Refused("not_found", 404, "no such release");
    return v;
  };

  app.get("/api/admin/releases", async request => { await asAdmin(request); return listReleases(o.pool); });

  app.post("/api/admin/releases", async (request, reply) => {
    const u = await asAdmin(request);
    if (!o.releases) throw new Refused("unavailable", 503, "no update store is configured");
    const b = consoleBodies.releaseCreate.parse(request.body);
    return reply.code(201).send({ version: await addRelease(o.pool, o.releases.keys, u.userId, b.manifest, b.signature, boundTo(b.stepUpToken, b)) });
  });

  // The package zip for a release just added: no second step-up, but only the release's own Admin, only once, and only the exact bytes the signed manifest names.
  app.put("/api/admin/releases/:version/package", async request => {
    const u = await asAdmin(request);
    if (!o.releases) throw new Refused("unavailable", 503, "no update store is configured");
    if (request.headers["content-type"] !== "application/octet-stream") throw new Refused("invalid_request", 415, "send the file as application/octet-stream");
    const v = version(request);
    const owner = (await o.pool.query<{ added_by: string }>("SELECT added_by FROM agent_releases WHERE version = $1", [v])).rows[0];
    if (owner && owner.added_by !== u.userId) throw new Refused("not_yours", 403, "only the Admin who added this release can upload its package");
    if (Number(request.headers["content-length"] ?? "0") > o.releases.maxBytes) throw new Refused("too_large", 413, "the package is larger than any release may be");
    return receiveReleasePackage(o.pool, o.releases, u.userId, v, request.body as Readable);
  });

  app.get("/api/admin/rollouts", async request => { await asAdmin(request); return listRollouts(o.pool); });

  app.get("/api/admin/rollouts/:id", async request => {
    await asAdmin(request);
    const rollout = (await listRollouts(o.pool)).find(r => r.id === id(request));
    if (!rollout) throw new Refused("not_found", 404, "no such rollout");
    return { ...rollout, targets: await rolloutTargets(o.pool, rollout.id) };
  });

  app.post("/api/admin/rollouts", async (request, reply) => {
    const u = await asAdmin(request);
    const b = consoleBodies.rolloutStart.parse(request.body);
    const rolloutId = await startRollout(o.pool, u.userId, { version: b.version, pilotCabinetId: b.pilotCabinetId.toLowerCase(),
      successRatePercent: b.successRatePercent, failureLimitPercent: b.failureLimitPercent }, boundTo(b.stepUpToken, b));
    return reply.code(201).send({ rolloutId });
  });

  for (const action of ["pause", "resume", "stop"] as const)
    app.post(`/api/admin/rollouts/:id/${action}`, async request => {
      const u = await asAdmin(request);
      await changeRollout(o.pool, u.userId, id(request), action, consoleBodies.stepUpOnly.parse(request.body).stepUpToken);
      return { ok: true };
    });

  app.get("/api/admin/upgrade-candidates", async request => { await asAdmin(request); return upgradeCandidates(o.pool); });

  app.put("/api/admin/cabinets/:id/in-office", async request => {
    const u = await asAdmin(request);
    const b = consoleBodies.cabinetInOffice.parse(request.body);
    await setInOffice(o.pool, u.userId, id(request), b.inOffice, boundTo(b.stepUpToken, b));
    return { ok: true };
  });
}
