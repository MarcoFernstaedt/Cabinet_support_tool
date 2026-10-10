// The Admin's setup page (docs/platform/demo.md): what is done so far, where cabinets reach the agent API, and the agent
// package to download. The package is one fixed file in AGENT_DOWNLOAD_DIR; no request can name another path.
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Refused } from "../services/errors.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

export const AGENT_PACKAGE = "CabinetAgent-win-x64.zip";

export async function setupRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  let hashed: { mtimeMs: number; size: number; sha256: string } | null = null;
  const packageInfo = async () => {
    if (!o.agentSetup?.downloadDir) return null;
    const path = join(o.agentSetup.downloadDir, AGENT_PACKAGE);
    let st;
    try { st = statSync(path); } catch { return null; }
    if (!st.isFile()) return null;
    if (!hashed || hashed.mtimeMs !== st.mtimeMs || hashed.size !== st.size)
      hashed = { mtimeMs: st.mtimeMs, size: st.size, sha256: createHash("sha256").update(await readFile(path)).digest("hex") };
    return { path, name: AGENT_PACKAGE, bytes: st.size, sha256: hashed.sha256 };
  };

  app.get("/api/admin/setup", async request => {
    const u = await o.guards.role(request, "admin");
    const r = (await o.pool.query<{ others: string; cabinets: string; pending: string; newest: string | null }>(
      `SELECT (SELECT count(*) FROM users WHERE status = 'active' AND id <> $1) AS others,
              (SELECT count(*) FROM cabinets WHERE status = 'active' AND demo_scenario IS NULL) AS cabinets,
              (SELECT count(*) FROM enrollment_requests WHERE status = 'pending') AS pending,
              (SELECT id::text FROM cabinets WHERE status = 'active' AND demo_scenario IS NULL ORDER BY created_at DESC LIMIT 1) AS newest`, [u.userId])).rows[0]!;
    const pkg = await packageInfo();
    return { otherUsers: Number(r.others), realCabinets: Number(r.cabinets), pendingCabinets: Number(r.pending), newestCabinetId: r.newest,
      agent: { host: o.agentSetup?.host ?? null, port: o.agentSetup?.port ?? null, package: pkg && { name: pkg.name, bytes: pkg.bytes, sha256: pkg.sha256 } } };
  });

  app.get("/api/admin/agent-package", async (request, reply) => {
    await o.guards.role(request, "admin");
    const pkg = await packageInfo();
    if (!pkg) throw new Refused("not_found", 404, "no agent package is available on this server");
    return reply.header("Content-Type", "application/zip").header("Content-Disposition", `attachment; filename="${AGENT_PACKAGE}"`)
      .header("Content-Length", String(pkg.bytes)).header("Cache-Control", "no-store").send(createReadStream(pkg.path));
  });
}
