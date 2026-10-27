// Commands from people (the console, and platform-admin on the server host): the role check, the
// Admin-only and approved-package rules, then the values the server itself controls (scanner IDs,
// a satellite's sync cabinet and its site's ports) put into the parameters. Both paths go through here, so neither can skip a rule.
import type { Pool } from "../db/db.js";
import { catalog, isOperationName, operations, type Command } from "../contracts.js";
import { issueCommand } from "./commands.js";
import { Refused } from "./errors.js";
import { scannerIdsFor } from "./fleet.js";
import { syncForCabinet } from "./device-settings.js";
import { cabinetPolicy, switchesFor } from "./firewall-policy.js";
import { assertApprovedTarget, CONTROLLED_OPERATIONS } from "./controlled-targets.js";
import { ROLE_RANK, type Role } from "./roles.js";

export { ROLE_RANK, type Role };

const AUDIT_ACTION: Record<string, string> = {
  "eventlog.get": "eventlog.entry.open",   // docs/spec/05-server-spec.md: opening an event log entry is logged
  "eventlog.query": "eventlog.browse",
};

export async function issueFromConsole(pool: Pool, user: { userId: string; role: Role }, cabinetId: string, operation: string, params: Record<string, unknown>,
  stepUpToken?: string, viaCli = false, confirmedParams?: unknown): Promise<Command> {
  if (!isOperationName(operation)) throw new Refused("unknown_operation", 400, "not a catalog operation");
  const entry = catalog.get(operation)!;
  if (ROLE_RANK[user.role] < ROLE_RANK[entry.minimumRole as Role]) throw new Refused("forbidden", 403, "your role cannot run this operation");

  if (operation === "system.restart" && params.mode === "shutdown" && ROLE_RANK[user.role] < ROLE_RANK.admin)
    throw new Refused("forbidden", 403, "only an Admin can shut a cabinet down: it stays off until someone switches it on");

  // service.control and process.end aim only at what the cabinet's approved-applications list names, whichever route asked: an
  // older agent enforces no list of its own (controlled-targets.ts). Checked against the schema first, so the check reads valid fields.
  if (CONTROLLED_OPERATIONS.has(operation)) {
    if (!operations[operation].params.is(params)) throw new Refused("invalid_params", 400, "parameters do not match the operation's schema");
    await assertApprovedTarget(pool, cabinetId, operation, params);
  }

  if (operation === "firewall.setRule") {
    // Checked against its schema first, so the rule checks below read only a valid rule.
    if (!operations[operation].params.is(params)) throw new Refused("invalid_params", 400, "parameters do not match the operation's schema");
    checkFirewallRule(user.role, params);
  }

  const filled: Record<string, unknown> = { ...params };
  if (operation === "package.install") {
    // The browser names the package; its type and hash come from the library, and only an approved, unretired package can be installed.
    const id = typeof params.packageId === "string" ? params.packageId : "";
    const p = (await pool.query<{ type: string; sha256: string; state: string }>("SELECT type, sha256, state FROM packages WHERE id = $1", [id])).rows[0];
    if (!p || p.state !== "approved") throw new Refused("package_not_approved", 409, "that package is not approved, or was retired");
    filled.packageType = p.type;
    filled.sha256 = p.sha256;
  }
  if (operation === "firewall.applyPolicy") {
    // The browser names only the cabinet; the profiles come from its policy (the site's, else the client's, else the fleet default).
    if (Object.keys(params).length > 0) throw new Refused("invalid_params", 400, "the policy is filled in by the server; send no parameters");
    filled.profiles = switchesFor((await cabinetPolicy(pool, cabinetId)).policy);
  }
  if (operation === "peripheral.status" && filled.hardwareIds === undefined) {
    const ids = await scannerIdsFor(pool, cabinetId);
    if (ids) filled.hardwareIds = ids;
  }
  if (operation === "network.test") {
    // Only the console's settings may name the sync cabinet (the site's address; the site's, else the client's, else the fleet's ports);
    // anything the browser sent is replaced.
    delete filled.syncAddress;
    delete filled.syncPorts;
    if (filled.target === "sync_cabinet") {
      const s = await syncForCabinet(pool, cabinetId);
      if (s?.address) filled.syncAddress = s.address;
      if (s && s.effective.length > 0) filled.syncPorts = s.effective;
    }
  }
  return issueCommand(pool, user.userId, cabinetId, operation, filled, AUDIT_ACTION[operation] ?? "command.issue",
    viaCli ? (entry.kind === "write" ? { viaCli: true } : undefined)
      // The token is bound to what the person confirmed: the control route passes the request it confirmed (entry, action, cabinet),
      // every other route the parameters as sent, before the server filled in its own values.
      : entry.kind === "write" ? { ...(stepUpToken ? { stepUpToken } : {}), confirmedParams: confirmedParams ?? params } : stepUpToken ? { stepUpToken } : undefined);
}

/** Firewall rules people may write: an update keeps the rule's name (the agent refuses a rename too). */
function checkFirewallRule(_role: Role, params: Record<string, unknown>): void {
  const rule = params.rule as { name?: string } | undefined;
  if (rule && params.change === "update" && rule.name !== params.ruleName) throw new Refused("rename_not_allowed", 400, "an update cannot rename a rule");
}
