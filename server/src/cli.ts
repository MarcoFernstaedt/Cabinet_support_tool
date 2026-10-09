// platform-admin: operator commands on the server host. The console is the normal way to do
// all of this, with sign-in and step-up; this tool names the person acting (--as), applies the
// same checks (write pauses and limits, the two-person rule) and audits everything as "via cli".
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "./auth/passwords.js";
import { parseArgs } from "node:util";
import pg from "pg";
import { loadConfig } from "./config.js";
import { audit, createPool, transaction, verifyAuditChain } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { listCabinets, revokeCabinet } from "./services/cabinets.js";
import { commandRecord } from "./services/commands.js";
import { issueFromConsole, ROLE_RANK as RANKS, type Role } from "./services/console-commands.js";
import { approveEnrollment, createBootstrapToken, pendingRequests, rejectEnrollment } from "./services/enrollment.js";
import { Refused } from "./services/errors.js";
import { issuingKey } from "./runtime.js";
import { readFile } from "node:fs/promises";
import { createReadStream, mkdirSync } from "node:fs";
import { TrustList } from "./packages/trust.js";
import { PackageRefused, verifyPackage } from "./packages/verify.js";
import { approvePackage, receiveUpload, retirePackage, startUpload } from "./services/packages.js";
import { catalog, isOperationName, releaseFiles } from "./contracts.js";
import { addRelease, checkManifest, listReleases, receiveReleasePackage, ReleaseKeys } from "./services/releases.js";
import { changeRollout, listRollouts, rolloutTargets, setInOffice, startRollout } from "./services/rollouts.js";
import { createHash } from "node:crypto";

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
  issue <cabinetId> <operation> [paramsJson] --as <user> [--write]   --write is required for a write operation
  package verify <file> --type driver|msi   run the server's package checks on a file (no database needed)
  package upload <file> --type driver|msi --name N --version V --vendor X [--hardware-id ID] --as <admin>
  package approve <packageId> --as <admin>  a different Admin than the uploader
  package retire <packageId> --as <admin>
  writes pause|resume [--client <clientId>] [--reason R] --as <admin>
  user resume-writes --username u --as <admin>               after a user went over their write limit
  release check --manifest m.json --signature s.json --package p.zip   the server's checks of a signed release (no database needed)
  release add --manifest m.json --signature s.json --package p.zip --as <admin>   put a signed release in the update store
  release list
  rollout start <version> --pilot <cabinetId> [--success 95] [--failure 5] --as <admin>
  rollout list                              rollouts, newest first, with per-batch counts
  rollout show <rolloutId>                  per-cabinet results
  rollout pause|resume|stop <rolloutId> --as <admin>
  cabinet in-office <cabinetId> on|off --as <admin>   batch 2 of every rollout
  command <commandId>                       a command's status and result
  audit-verify                              recompute the audit hash chain`;

const ROLE_RANK: Record<string, number> = RANKS;

async function userId(pool: pg.Pool, username: string | undefined, minimumRole: "tier1" | "tier2" | "admin"): Promise<string> {
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
      client: { type: "string" }, site: { type: "string" }, cabinet: { type: "string" }, write: { type: "boolean" }, type: { type: "string" },
      version: { type: "string" }, vendor: { type: "string" }, "hardware-id": { type: "string", multiple: true }, reason: { type: "string" },
      manifest: { type: "string" }, signature: { type: "string" }, package: { type: "string" }, pilot: { type: "string" }, success: { type: "string" }, failure: { type: "string" } },
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

  if (command === "package" && rest[0] === "verify") {
    if (!rest[1] || (values.type !== "driver" && values.type !== "msi")) throw new Refused("usage", 2, USAGE);
    try {
      const v = verifyPackage(await readFile(rest[1]), values.type, TrustList.fromFolder(process.env.PACKAGE_TRUST_DIR || undefined));
      console.log(`accepted  ${v.signer}  sha256 ${v.sha256}  ${v.size} bytes  ${v.detail}`);
    } catch (e) {
      if (!(e instanceof PackageRefused)) throw e;
      console.log(`refused  ${e.code}  ${e.message}`);
      process.exitCode = 1;
    }
    return;
  }

  /** The three release files as the pipeline produced them: the manifest's exact bytes, its signature, and the package. */
  const releaseInput = async () => {
    if (!values.manifest || !values.signature || !values.package) throw new Refused("usage", 2, USAGE);
    const manifest = (await readFile(values.manifest)).toString("base64");
    const signature = releaseFiles.signature.parse(JSON.parse(await readFile(values.signature, "utf8")));
    return { manifest, signature, packagePath: values.package };
  };

  if (command === "release" && rest[0] === "check") {
    const r = await releaseInput();
    const keys = ReleaseKeys.fromFolder(process.env.UPGRADE_KEYS_DIR || undefined);
    try {
      const { manifest } = checkManifest(keys, r.manifest, r.signature);
      const zip = await readFile(r.packagePath);
      const digest = createHash("sha256").update(zip).digest("hex");
      if (digest !== manifest.sha256 || zip.length !== manifest.sizeBytes) { console.log("refused  hash_mismatch  the package does not match the signed manifest"); process.exitCode = 1; return; }
      console.log(`accepted  ${manifest.version}  from ${manifest.minimumVersion}  sha256 ${digest}  ${zip.length} bytes  key ${r.signature.keyId.slice(0, 16)}`);
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      console.log(`refused  ${e.code}  ${e.message}`);
      process.exitCode = 1;
    }
    return;
  }

  const config = loadConfig();
  const pool = createPool(config.databaseUrl, 2);
  try {
    switch (["user", "token", "package", "writes", "release", "rollout", "cabinet"].includes(command) ? `${command} ${rest.shift()}` : command) {
      case "release add": {
        const r = await releaseInput();
        const adminId = await userId(pool, values.as, "admin");
        mkdirSync(config.releases.dir, { recursive: true, mode: 0o700 });
        const store = { dir: config.releases.dir, maxBytes: config.releases.maxBytes, keys: ReleaseKeys.fromFolder(config.releases.keysDir) };
        const version = await addRelease(pool, store.keys, adminId, r.manifest, r.signature, null);
        const added = await receiveReleasePackage(pool, store, adminId, version, createReadStream(r.packagePath));
        console.log(`${added.version}  ${added.state}  sha256 ${added.sha256}`);
        return;
      }
      case "release list":
        for (const r of await listReleases(pool)) console.log(`${r.version}  ${r.state}  from ${r.minimumVersion}  ${r.sizeBytes} bytes  added ${r.addedAt} by ${r.addedBy.name}`);
        return;
      case "rollout start": {
        if (!rest[0] || !values.pilot) throw new Refused("usage", 2, USAGE);
        const id = await startRollout(pool, await userId(pool, values.as, "admin"), { version: rest[0], pilotCabinetId: values.pilot.toLowerCase(),
          successRatePercent: Number(values.success ?? "95"), failureLimitPercent: Number(values.failure ?? "5") }, null);
        console.log(id);
        return;
      }
      case "rollout list":
        for (const r of await listRollouts(pool))
          console.log(`${r.id}  ${r.version}  ${r.state}  batch ${r.currentBatch}  ${r.batches.map(b => `[${b.batch}: ${b.succeeded}/${b.total} ok, ${b.failed} failed]`).join(" ")}${r.pausedReason ? `  ${r.pausedReason}` : ""}`);
        return;
      case "rollout show": {
        if (!rest[0]) throw new Refused("usage", 2, USAGE);
        console.log(JSON.stringify({ rollout: (await listRollouts(pool)).find(r => r.id === rest[0]) ?? null, targets: await rolloutTargets(pool, rest[0]) }, null, 2));
        return;
      }
      case "rollout pause":
      case "rollout resume":
      case "rollout stop": {
        if (!rest[0]) throw new Refused("usage", 2, USAGE);
        const action = positionals[1] as "pause" | "resume" | "stop";
        await changeRollout(pool, await userId(pool, values.as, "admin"), rest[0], action, null);
        console.log(`Rollout ${action === "stop" ? "stopped" : action + "d"}.`);
        return;
      }
      case "cabinet in-office": {
        if (!rest[0] || (rest[1] !== "on" && rest[1] !== "off")) throw new Refused("usage", 2, USAGE);
        await setInOffice(pool, await userId(pool, values.as, "admin"), rest[0], rest[1] === "on", null);
        console.log(rest[1] === "on" ? "In office." : "Not in office.");
        return;
      }
      case "package upload": {
        if (!rest[0] || !values.name || !values.version || !values.vendor || (values.type !== "driver" && values.type !== "msi")) throw new Refused("usage", 2, USAGE);
        const adminId = await userId(pool, values.as, "admin");
        mkdirSync(config.packages.dir, { recursive: true, mode: 0o700 });
        const store = { dir: config.packages.dir, maxBytes: config.packages.maxBytes, trust: TrustList.fromFolder(config.packages.trustDir) };
        const id = await startUpload(pool, adminId, { name: values.name, version: values.version, vendor: values.vendor, packageType: values.type,
          hardwareIds: values["hardware-id"] ?? [] }, null);
        const p = await receiveUpload(pool, store, adminId, id, createReadStream(rest[0]));
        console.log(`${p.id}  ${p.state}  ${p.signer}  sha256 ${p.sha256}`);
        return;
      }
      case "package approve":
        if (!rest[0]) throw new Refused("usage", 2, USAGE);
        await approvePackage(pool, await userId(pool, values.as, "admin"), rest[0], null);
        console.log("Approved.");
        return;
      case "package retire":
        if (!rest[0]) throw new Refused("usage", 2, USAGE);
        await retirePackage(pool, await userId(pool, values.as, "admin"), rest[0], null);
        console.log("Retired.");
        return;
      case "writes pause":
      case "writes resume": {
        const adminId = await userId(pool, values.as, "admin");
        const paused = command === "writes" && positionals[1] === "pause";
        await transaction(pool, async c => {
          if (values.client) {
            const r = await c.query("UPDATE clients SET write_paused = $2, write_pause_reason = $3 WHERE id = $1", [values.client, paused, paused ? values.reason ?? null : null]);
            if (r.rowCount !== 1) throw new Refused("not_found", 1, "no such client");
          } else {
            await c.query(`INSERT INTO settings (key, value, changed_by) VALUES ('writes.paused', $1, $2)
                           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, changed_by = EXCLUDED.changed_by, changed_at = now()`,
              [JSON.stringify({ paused, reason: values.reason ?? null, by: adminId, at: new Date().toISOString() }), adminId]);
          }
          await audit(c, { actorKind: "user", actorId: adminId, action: paused ? "writes.pause" : "writes.resume", outcome: "succeeded",
            details: { scope: values.client ? "client" : "fleet", clientId: values.client ?? null, reason: values.reason ?? null, via: "cli" } });
        });
        console.log(paused ? "Writes paused." : "Writes resumed.");
        return;
      }
      case "user resume-writes": {
        if (!values.username) throw new Refused("usage", 2, USAGE);
        const adminId = await userId(pool, values.as, "admin");
        await transaction(pool, async c => {
          const r = await c.query<{ id: string }>("UPDATE users SET writes_paused = false, writes_paused_reason = NULL WHERE username = $1 RETURNING id", [values.username]);
          if (!r.rows[0]) throw new Refused("not_found", 1, "no such user");
          await audit(c, { actorKind: "user", actorId: adminId, action: "writes.user_resumed", targetKind: "user", targetId: r.rows[0].id, outcome: "succeeded", details: { via: "cli" } });
        });
        console.log(`Writes resumed for ${values.username}.`);
        return;
      }
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
        const isWrite = isOperationName(operation) && catalog.get(operation)!.kind === "write";
        if (isWrite && !values.write) throw new Refused("usage", 2, `${operation} changes the cabinet; add --write to confirm`);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Refused("usage", 2, "paramsJson must be a JSON object");
        const as = await userId(pool, values.as, isWrite ? "tier2" : "tier1");
        const role = (await pool.query<{ role: Role }>("SELECT role FROM users WHERE id = $1", [as])).rows[0]!.role;
        const command = await issueFromConsole(pool, { userId: as, role }, cabinetId, operation, parsed as Record<string, unknown>, undefined, true);
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
