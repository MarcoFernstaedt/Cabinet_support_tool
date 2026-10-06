// platform-admin: operator commands for milestone 2, before the console exists.
// Approval and command issuing move to the console with sign-in and step-up in
// milestone 3; this tool still names the person acting (--as) and audits it all.
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "./auth/passwords.js";
import { parseArgs } from "node:util";
import pg from "pg";
import { loadConfig } from "./config.js";
import { audit, createPool, transaction, verifyAuditChain } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { listCabinets, revokeCabinet } from "./services/cabinets.js";
import { commandRecord, issueCommand } from "./services/commands.js";
import { approveEnrollment, createBootstrapToken, pendingRequests, rejectEnrollment } from "./services/enrollment.js";
import { Refused } from "./services/errors.js";
import { issuingKey } from "./runtime.js";

const USAGE = `platform-admin <command> [options]

  migrate                                   apply migrations (uses DATABASE_OWNER_URL)
  user add --username u --name "N" --role tier1|tier2|admin   prints a one-time temporary password
  user reset-password --username u --as <admin>             new temporary password; ends the user's sessions
  token create --as <admin>                 one-time bootstrap token for one cabinet (valid 7 days)
  pending                                   enrollment requests waiting for approval
  approve <requestId> --as <admin> --client C --site S --cabinet N --role sync|satellite|standalone
  reject <requestId> --as <admin>
  cabinets                                  every cabinet, with online status
  revoke <cabinetId> --as <admin>
  issue <cabinetId> <operation> [paramsJson] --as <user>    a read operation
  command <commandId>                       a command's status and result
  audit-verify                              recompute the audit hash chain`;

const ROLE_RANK: Record<string, number> = { tier1: 1, tier2: 2, admin: 3 };

async function userId(pool: pg.Pool, username: string | undefined, minimumRole: "tier1" | "admin"): Promise<string> {
  if (!username) throw new Refused("usage", 2, "--as <username> is required");
  const row = (await pool.query<{ id: string; role: string }>("SELECT id, role FROM users WHERE username = $1 AND status = 'active'", [username])).rows[0];
  if (!row) throw new Refused("usage", 2, `no active user ${username}`);
  if ((ROLE_RANK[row.role] ?? 0) < ROLE_RANK[minimumRole]!) throw new Refused("forbidden", 2, `${username} is ${row.role}; this needs ${minimumRole}`);
  return row.id;
}

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: { as: { type: "string" }, username: { type: "string" }, name: { type: "string" }, role: { type: "string" },
      client: { type: "string" }, site: { type: "string" }, cabinet: { type: "string" } },
  });
  const [command, ...rest] = positionals;
  if (!command) { console.log(USAGE); return; }

  if (command === "migrate") {
    const url = process.env.DATABASE_OWNER_URL;
    if (!url) throw new Error("DATABASE_OWNER_URL must be set for migrations.");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try { const ran = await migrate(client); console.log(ran.length ? `Applied ${ran.join(", ")}` : "Up to date."); }
    finally { await client.end(); }
    return;
  }

  const config = loadConfig();
  const pool = createPool(config.databaseUrl, 2);
  try {
    switch (command === "user" || command === "token" ? `${command} ${rest.shift()}` : command) {
      case "user add": {
        if (!values.username || !values.name || !values.role || !(values.role in ROLE_RANK)) throw new Refused("usage", 2, USAGE);
        const id = randomUUID();
        const temporary = randomBytes(12).toString("base64url");
        const hash = await hashPassword(temporary);
        await transaction(pool, async c => {
          await c.query("INSERT INTO users (id, username, name, role, password_hash, must_change_password) VALUES ($1, $2, $3, $4, $5, true)",
            [id, values.username, values.name, values.role, hash]);
          await audit(c, { actorKind: "system", actorId: "platform-admin", action: "user.create", targetKind: "user", targetId: id, outcome: "succeeded",
            details: { username: values.username, role: values.role } });
        });
        console.log(`User ${values.username} (${values.role}) created: ${id}`);
        console.log(`Temporary password (shown once; must be changed at first sign-in): ${temporary}`);
        return;
      }
      case "user reset-password": {
        if (!values.username) throw new Refused("usage", 2, USAGE);
        const adminId = await userId(pool, values.as, "admin");
        const temporary = randomBytes(12).toString("base64url");
        const hash = await hashPassword(temporary);
        await transaction(pool, async c => {
          const r = await c.query<{ id: string }>("UPDATE users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL WHERE username = $1 RETURNING id",
            [values.username, hash]);
          const target = r.rows[0];
          if (!target) throw new Refused("not_found", 1, "no such user");
          await c.query("DELETE FROM sessions WHERE user_id = $1", [target.id]);
          await audit(c, { actorKind: "user", actorId: adminId, action: "user.password.reset", targetKind: "user", targetId: target.id, outcome: "succeeded" });
        });
        console.log(`Temporary password for ${values.username} (shown once): ${temporary}`);
        return;
      }
      case "token create": {
        const { token, expiresAt } = await createBootstrapToken(pool, await userId(pool, values.as, "admin"));
        console.log(`Bootstrap token (shown once, valid until ${expiresAt.toISOString()}):\n${token}`);
        return;
      }
      case "pending":
        for (const p of await pendingRequests(pool))
          console.log(`${p.id}  ${p.createdAt.toISOString()}  ${p.fingerprints.hostname}  serial ${p.fingerprints.serialNumber ?? "-"}  from ${p.sourceAddress ?? "-"}  agent ${p.fingerprints.agentVersion}`);
        return;
      case "approve": {
        const role = values.role;
        if (!rest[0] || !values.client || !values.site || !values.cabinet || !(role === "sync" || role === "satellite" || role === "standalone"))
          throw new Refused("usage", 2, USAGE);
        const r = await approveEnrollment(pool, await issuingKey(config), rest[0],
          { clientName: values.client, siteName: values.site, cabinetName: values.cabinet, role }, await userId(pool, values.as, "admin"));
        console.log(`Approved. Cabinet ${r.cabinetId}, certificate ${r.serial}. The agent picks it up on its next enrollment poll.`);
        return;
      }
      case "reject":
        if (!rest[0]) throw new Refused("usage", 2, USAGE);
        await rejectEnrollment(pool, rest[0], await userId(pool, values.as, "admin"));
        console.log("Rejected.");
        return;
      case "cabinets":
        for (const c of await listCabinets(pool))
          console.log(`${c.id}  ${c.online ? "online " : "offline"}  ${c.client} / ${c.site} / ${c.name} (${c.role})  ${c.status}  ${c.hostname ?? ""}  agent ${c.agentVersion ?? "-"}  last ${c.lastHeartbeatAt?.toISOString() ?? "never"}`);
        return;
      case "revoke":
        if (!rest[0]) throw new Refused("usage", 2, USAGE);
        await revokeCabinet(pool, rest[0], await userId(pool, values.as, "admin"));
        console.log("Revoked. The cabinet's next connection will be refused.");
        return;
      case "issue": {
        const [cabinetId, operation, params] = rest;
        if (!cabinetId || !operation) throw new Refused("usage", 2, USAGE);
        let parsed: unknown;
        try { parsed = JSON.parse(params ?? "{}"); } catch { throw new Refused("usage", 2, "paramsJson is not JSON"); }
        const command = await issueCommand(pool, await userId(pool, values.as, "tier1"), cabinetId, operation, parsed);
        console.log(command.commandId);
        return;
      }
      case "command": {
        if (!rest[0]) throw new Refused("usage", 2, USAGE);
        const record = await commandRecord(pool, rest[0]);
        if (!record) throw new Refused("not_found", 1, "no such command");
        console.log(JSON.stringify(record, null, 2));
        return;
      }
      case "audit-verify": {
        const check = await verifyAuditChain(pool);
        console.log(check.ok ? `Audit chain intact: ${check.entries} entries.` : `AUDIT CHAIN BROKEN at entry ${check.firstBadSeq}.`);
        if (!check.ok) process.exitCode = 1;
        return;
      }
      default:
        throw new Refused("usage", 2, USAGE);
    }
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Refused || e instanceof Error ? e.message : String(e));
  process.exitCode = e instanceof Refused ? e.status : 1;
});
