// The Admin's setup page (docs/platform/demo.md): what is done so far, where cabinets reach the agent API, and the agent
// packages to download. The packages are fixed file names in AGENT_DOWNLOAD_DIR, one per Windows architecture; no request
// can name another path.
//
// Two architectures exist because Windows cannot run a 64-bit program on 32-bit Windows, so the agent is built once per
// architecture (docs/platform/second-architecture.md). The operator picks the machine's own on the page, the page hands
// over the matching package, and an architecture whose package is not on this server is reported as missing rather than
// silently swapped for the other one: the other one cannot install at all.
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Refused } from "../services/errors.js";
import { LAUNCHER_NAME, launcherScript } from "./installer-launcher.js";
import type { ConsoleApiOptions, Guards } from "./server.js";

/**
 * The two architectures the agent is published for, in the order the setup page offers them. 64-bit is first because it
 * is what almost every machine is, the same reason it is the default in the console (console/src/lib/install-command.ts).
 */
export const AGENT_ARCHITECTURES = ["windows-x64", "windows-x86"] as const;
export type AgentArchitecture = (typeof AGENT_ARCHITECTURES)[number];

/**
 * The name of each architecture's package, as the operator sees it in Downloads. The file names carry the architecture
 * the same way they always have (CabinetAgent-win-x64.zip): whoever drops the build in the download directory can see
 * which one it is without opening it, and the agent's own installer refuses the other one's package by name.
 */
export const AGENT_PACKAGE_NAMES: Record<AgentArchitecture, string> = {
  "windows-x64": "CabinetAgent-win-x64.zip",
  "windows-x86": "CabinetAgent-win-x86.zip",
};

export function agentArchitecture(value: unknown): AgentArchitecture {
  if (value === undefined || value === null || value === "") return "windows-x64";
  if (value === "windows-x64" || value === "windows-x86") return value;
  throw new Refused("bad_request", 400, `the architecture must be windows-x64 or windows-x86, not ${String(value)}`);
}

export async function setupRoutes(app: FastifyInstance, o: ConsoleApiOptions & { guards: Guards }): Promise<void> {
  const hashed = new Map<AgentArchitecture, { mtimeMs: number; size: number; sha256: string }>();
  const packageInfo = async (architecture: AgentArchitecture) => {
    if (!o.agentSetup?.downloadDir) return null;
    const name = AGENT_PACKAGE_NAMES[architecture];
    const path = join(o.agentSetup.downloadDir, name);
    let st;
    try { st = statSync(path); } catch { return null; }
    if (!st.isFile()) return null;
    const known = hashed.get(architecture);
    if (!known || known.mtimeMs !== st.mtimeMs || known.size !== st.size)
      hashed.set(architecture, { mtimeMs: st.mtimeMs, size: st.size, sha256: createHash("sha256").update(await readFile(path)).digest("hex") });
    return { path, name, bytes: st.size, sha256: hashed.get(architecture)!.sha256 };
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
    // Every architecture is listed, present or not: the operator has to be able to see which one this server can hand
    // over before walking to a machine, and a 32-bit cabinet's setup fails at the download if it is the missing one.
    const packages = await Promise.all(AGENT_ARCHITECTURES.map(async architecture => {
      const pkg = await packageInfo(architecture);
      return { architecture, name: AGENT_PACKAGE_NAMES[architecture], bytes: pkg?.bytes ?? null, sha256: pkg?.sha256 ?? null };
    }));
    return { otherUsers: Number(r.others), realCabinets: Number(r.cabinets), pendingCabinets: Number(r.pending), newestCabinetId: r.newest, newestCabinetName: r.newest_name,
      agent: { host: o.agentSetup?.host ?? null, port: o.agentSetup?.port ?? null, packages,
        // The installer checks the CA file it is given against this (Get-FileHash), so a swapped CA file is refused.
        caSha256: caSha256() } };
  });

  // The launcher the operator saves and double-clicks: it finds the package they downloaded, proves its hash, unpacks
  // it and runs the installer. Generated per request so the host, the port, the CA hash and the package hash always
  // match what this server is serving right now; it never contains a token (see installer-launcher.ts).
  app.get("/api/admin/installer", async (request, reply) => {
    await o.guards.role(request, "admin");
    const architecture = agentArchitecture((request.query as { architecture?: string } | undefined)?.architecture);
    const pkg = await packageInfo(architecture);
    if (!pkg) throw new Refused("not_found", 404, `no ${architecture === "windows-x86" ? "32-bit" : "64-bit"} agent package is available on this server`);
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
    const architecture = agentArchitecture((request.query as { architecture?: string } | undefined)?.architecture);
    const pkg = await packageInfo(architecture);
    if (!pkg) throw new Refused("not_found", 404, `no ${architecture === "windows-x86" ? "32-bit" : "64-bit"} agent package is available on this server`);
    return reply.header("Content-Type", "application/zip").header("Content-Disposition", `attachment; filename="${pkg.name}"`)
      .header("Content-Length", String(pkg.bytes)).header("Cache-Control", "no-store").send(createReadStream(pkg.path));
  });
}
