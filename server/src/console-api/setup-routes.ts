// The Admin's setup page (docs/platform/demo.md): what is done so far, where cabinets reach the agent API, and the agent
// package to download. The package is one fixed file in AGENT_DOWNLOAD_DIR; no request can name another path.
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Refused } from "../services/errors.js";
import { LAUNCHER_NAME, launcherScript } from "./installer-launcher.js";
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

  // The CA file the operator downloads and the value the installer checks it against are the same bytes, so both
  // routes read them from one place.
  const caSha256 = () => createHash("sha256").update(o.issuingKey.certificatePem, "utf8").digest("hex").toUpperCase();

  app.get("/api/admin/setup", async request => {
    const u = await o.guards.role(request, "admin");
    const r = (await o.pool.query<{ others: string; cabinets: string; pending: string; newest: string | null; newest_name: string | null }>(
      `SELECT (SELECT COUNT(*) FROM users WHERE status = 'active' AND id <> $1) AS others,
              (SELECT COUNT(*) FROM cabinets WHERE status = 'active' AND demo_scenario IS NULL) AS cabinets,
              (SELECT COUNT(*) FROM enrollment_requests WHERE status = 'pending') AS pending,
              (SELECT TOP (1) id FROM cabinets WHERE status = 'active' AND demo_scenario IS NULL ORDER BY created_at DESC) AS newest,
              (SELECT TOP (1) name FROM cabinets WHERE status = 'active' AND demo_scenario IS NULL ORDER BY created_at DESC) AS newest_name`, [u.userId])).rows[0]!;
    const pkg = await packageInfo();
    return { otherUsers: Number(r.others), realCabinets: Number(r.cabinets), pendingCabinets: Number(r.pending), newestCabinetId: r.newest, newestCabinetName: r.newest_name,
      agent: { host: o.agentSetup?.host ?? null, port: o.agentSetup?.port ?? null, package: pkg && { name: pkg.name, bytes: pkg.bytes, sha256: pkg.sha256 },
        // The installer checks the CA file it is given against this (Get-FileHash), so a swapped CA file is refused.
        caSha256: caSha256() } };
  });

  // The launcher the operator saves and double-clicks: it finds the package they downloaded, proves its hash, unpacks
  // it and runs the installer. Generated per request so the host, the port, the CA hash and the package hash always
  // match what this server is serving right now; it never contains a token (see installer-launcher.ts).
  app.get("/api/admin/installer", async (request, reply) => {
    await o.guards.role(request, "admin");
    const pkg = await packageInfo();
    if (!pkg) throw new Refused("not_found", 404, "no agent package is available on this server");
    const script = launcherScript({
      packageName: pkg.name, packageSha256: pkg.sha256,
      host: o.agentSetup?.host ?? null, port: o.agentSetup?.port ?? null,
      caSha256: caSha256(),
      unsigned: (request.query as { unsigned?: string } | undefined)?.unsigned === "1",
    });
    return reply.header("Content-Type", "text/plain; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${LAUNCHER_NAME}"`)
      .header("Content-Length", String(Buffer.byteLength(script, "utf8")))
      .header("Cache-Control", "no-store").send(script);
  });

  app.get("/api/admin/agent-package", async (request, reply) => {
    await o.guards.role(request, "admin");
    const pkg = await packageInfo();
    if (!pkg) throw new Refused("not_found", 404, "no agent package is available on this server");
    return reply.header("Content-Type", "application/zip").header("Content-Disposition", `attachment; filename="${AGENT_PACKAGE}"`)
      .header("Content-Length", String(pkg.bytes)).header("Cache-Control", "no-store").send(createReadStream(pkg.path));
  });
}
