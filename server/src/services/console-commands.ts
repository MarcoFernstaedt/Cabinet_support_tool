// Commands from the console: the role check, then the values the server itself
// controls (scanner IDs, the site's sync cabinet) put into the parameters.
import type pg from "pg";
import { catalog, isOperationName, type Command } from "../contracts.js";
import { issueCommand } from "./commands.js";
import { Refused } from "./errors.js";
import { fleetScannerIds } from "./fleet.js";

export const ROLE_RANK = { tier1: 1, tier2: 2, admin: 3 } as const;
export type Role = keyof typeof ROLE_RANK;

const AUDIT_ACTION: Record<string, string> = {
  "eventlog.get": "eventlog.entry.open",   // docs/spec/05-server-spec.md: opening an event log entry is logged
  "eventlog.query": "eventlog.browse",
};

export async function issueFromConsole(pool: pg.Pool, user: { userId: string; role: Role }, cabinetId: string, operation: string, params: Record<string, unknown>,
  stepUpToken?: string): Promise<Command> {
  if (!isOperationName(operation)) throw new Refused("unknown_operation", 400, "not a catalog operation");
  const entry = catalog.get(operation)!;
  if (ROLE_RANK[user.role] < ROLE_RANK[entry.minimumRole as Role]) throw new Refused("forbidden", 403, "your role cannot run this operation");
  // Turning a firewall profile off with no time limit is Admin only (docs/spec/04-agent-spec.md).
  if (operation === "firewall.setProfile" && params.noTimeLimit === true && user.role !== "admin")
    throw new Refused("forbidden", 403, "only an Admin can turn a profile off with no time limit");

  const filled: Record<string, unknown> = { ...params };
  if (operation === "package.install") {
    // The browser names the package; its type and hash come from the library, and only an approved, unretired package can be installed.
    const id = typeof params.packageId === "string" ? params.packageId : "";
    const p = (await pool.query<{ type: string; sha256: string; state: string }>("SELECT type, sha256, state FROM packages WHERE id = $1", [id])).rows[0];
    if (!p || p.state !== "approved") throw new Refused("package_not_approved", 409, "that package is not approved, or was retired");
    filled.packageType = p.type;
    filled.sha256 = p.sha256;
  }
  if (operation === "peripheral.status" && filled.hardwareIds === undefined) {
    const row = (await pool.query<{ scanner_hardware_ids: string[] | null }>("SELECT scanner_hardware_ids FROM cabinets WHERE id = $1", [cabinetId])).rows[0];
    const ids = row?.scanner_hardware_ids ?? (await fleetScannerIds(pool));
    if (ids && ids.length > 0) filled.hardwareIds = ids;
  }
  if (operation === "network.test") {
    // Only the site's own setting may name the sync cabinet; anything the browser sent is replaced.
    delete filled.syncAddress;
    delete filled.syncPorts;
    if (filled.target === "sync_cabinet") {
      const s = (await pool.query<{ sync_address: string | null; sync_ports: number[] }>(
        "SELECT s.sync_address, s.sync_ports FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1", [cabinetId])).rows[0];
      if (s?.sync_address) filled.syncAddress = s.sync_address;
      if (s && s.sync_ports.length > 0) filled.syncPorts = s.sync_ports;
    }
  }
  return issueCommand(pool, user.userId, cabinetId, operation, filled, AUDIT_ACTION[operation] ?? "command.issue",
    entry.kind === "write" ? (stepUpToken ? { stepUpToken } : {}) : stepUpToken ? { stepUpToken } : undefined);
}
