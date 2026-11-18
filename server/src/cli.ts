// platform-admin: operator commands on the server host. The console is the normal way to do
// all of this, with sign-in and step-up; this tool names the person acting (--as) and proves it with
// their authenticator code (--code), applies the same checks (write pauses and limits, the two-person rule) and audits everything as "via cli".
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "./auth/passwords.js";
import { SecretBox } from "./auth/secrets.js";
import * as totp from "./auth/totp.js";
import { recordAuthFailure } from "./services/auth-failures.js";
import { endAllSessions } from "./auth/sessions.js";
import { personNamed, sessionActor, sessionFile, sessionPolicy, signIn, signOut } from "./auth/cli-session.js";
import { parseArgs } from "node:util";
import { databaseUrl, loadConfig } from "./config.js";
import { audit, createPool, transaction, verifyAuditChain, type Pool } from "./db/db.js";
import { connectOwner, migrate } from "./db/migrate.js";
import { alertMigrationFailed } from "./services/security.js";
import { upsertSetting } from "./services/settings.js";
import { setClientPauseByCli } from "./services/writes.js";
import { addUserFromCommandLine, resumeWritesByUsername, setTemporaryPasswordByUsername, spendCodeStep } from "./services/users.js";
import { formatHealth, healthSummary } from "./services/ops-health.js";
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
import { catalog, consoleBodies, isOperationName, releaseFiles } from "./contracts.js";
import { addRelease, checkManifest, listReleases, receiveReleasePackage, ReleaseKeys } from "./services/releases.js";
import { isArchitecture, type Architecture } from "./services/package-architecture.js";
import { changeRollout, listRollouts, rolloutTargets, setInOffice, startRollout } from "./services/rollouts.js";
import { createHash } from "node:crypto";

const USAGE = `platform-admin <command> [options]

  Every command that changes something takes --as <username>, authorised by the session you signed in with (sign-in below) or by
  --code <6 digits> from that person's own authenticator, checked like a console step-up (used once, wrong codes count toward the
  account lock). The code is what gets you into the platform, not a toll on each write. Commands with no --as only read.

  sign-in --as u --password <their password> [--code <6 digits>]   sign in as that person; the session is kept in a file only they can read
  sign-out                                   end that session on the server, and forget it here
  migrate                                   apply migrations (uses DATABASE_OWNER_URL)
  user add --username u --name "N" --role tier1|tier2|admin [--as <admin>]   prints a one-time temporary password; --as is needed once any Admin exists
  user reset-password --username u --as <admin>             new temporary password; ends the user's sessions
  token create --as <admin>                 one-time bootstrap token for one cabinet (valid 7 days)
  token create --site <siteId> [--role R] [--cabinets 1-100] [--days 1-30] --as <admin>   a site installer's token (default 10 cabinets, 7 days)
  pending                                   enrollment requests waiting for approval
  approve <requestId> --as <admin> --client C --site S --cabinet N --role sync|satellite|standalone --baseline inherited|capture|<versionId>
                                            the baseline decision is required (docs/spec/15-baselines-and-config.md)
  reject <requestId> --as <admin>
  cabinets                                  every cabinet, with online status
  revoke <cabinetId> --as <admin>
  issue <cabinetId> <operation> [paramsJson] --as <user> [--write]   --write is required for a write operation
  package verify <file> --type driver|msi   run the server's package checks on a file (no database needed)
  package upload <file> --type driver|msi --name N --version V --vendor X [--hardware-id ID] --as <admin>
  package approve <packageId> --as <admin>  a different Admin than the uploader
  package retire <packageId> --as <admin>
  writes pause|resume [--client <clientId> | --cabinet <cabinetId>] [--reason R] --as <admin>
  user resume-writes --username u --as <admin>               after a user went over their write limit
  release check --manifest m.json --signature s.json --package p.zip   the server's checks of a signed release (no database needed)
  release add --manifest m.json --signature s.json --package p.zip --architecture windows-x64|windows-x86 --as <admin>   put a signed release in the update store
  release list
  rollout start <version> --architecture windows-x64|windows-x86 --pilot <cabinetId> [--success 95] [--failure 5] --as <admin>
  rollout list                              rollouts, newest first, with per-batch counts
  rollout show <rolloutId>                  per-cabinet results
  rollout pause|resume|stop <rolloutId> --as <admin>
  cabinet in-office <cabinetId> on|off --as <admin>   batch 2 of every rollout
  command <commandId>                       a command's status and result
  audit-verify                              recompute the audit hash chain
  status                                    health summary: database size, disk, backup, certificates, counters, open operations alerts`;

const ROLE_RANK: Record<string, number> = RANKS;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Refused("config", 1, `${name} is not set; it is needed to check authenticator codes`);
  return v;
}

/**
 * The person a command acts as (F3, docs/spec/02-security-model.md "The operator command line"): access to the server's shell is not
 * authority. One of two proofs names them: their authenticator code, checked as the console checks a step-up (single use, the step
 * claimed atomically, the account's lock honoured, a wrong code counted toward it); or the session they signed in with
 * (platform-admin sign-in), which is the console's own session — the code is what gets you into the platform, not a toll on every
 * write. Every authorised attempt is audited as cli.authenticate with the path ("cli") and the proof ("authenticator" or "session");
 * a refusal before either proof is checked leaves no row.
 */
function authorizer(pool: Pool, secrets: () => SecretBox, command: string) {
  return async (username: string | undefined, minimumRole: "tier1" | "tier2" | "admin", code: string | undefined): Promise<string> => {
    if (!username) throw new Refused("usage", 2, "--as <username> is required");
    const row = await personNamed(pool, username);
    if (!row) throw new Refused("usage", 2, `no active user ${username}`);
    if ((ROLE_RANK[row.role] ?? 0) < ROLE_RANK[minimumRole]!) throw new Refused("forbidden", 2, `${username} is ${row.role}; this needs ${minimumRole}`);
    if (!code) {
      const actor = await sessionActor(pool, await sessionPolicy(pool));
      if (!actor) throw new Refused("usage", 2, `--code <the 6-digit code from that person's authenticator> is required, or sign in first: platform-admin sign-in --as ${username}`);
      if (actor.userId !== row.id) throw new Refused("forbidden", 2, `the stored session belongs to ${actor.username}; sign in as ${username} first (${sessionFile()})`);
      if (actor.stage !== "complete") throw new Refused("setup_required", 2, `${username} has not finished signing in yet`);
      await transaction(pool, c => audit(c, { actorKind: "user", actorId: row.id, action: "cli.authenticate", outcome: "succeeded", details: { via: "cli", proof: "session", command } }));
      return row.id;
    }
    if (!/^\d{6}$/.test(code)) throw new Refused("usage", 2, "--code <the 6-digit code from that person's authenticator> is required");
    if (!row.totp_enabled || !row.totp_secret_enc) throw new Refused("totp_required", 2, `${username} has no authenticator set up; sign in to the console once to set it up`);
    if (row.locked) throw new Refused("account_locked", 2, `${username} is locked after repeated failures; try again later`);
    const details = { via: "cli", proof: "authenticator", command };
    const step = totp.verify(secrets().open(row.totp_secret_enc), code, Date.now(), row.totp_last_step === null ? null : Number(row.totp_last_step));
    if (step === null) {
      await recordAuthFailure(pool, row.id, "failed_step_ups", "cli");
      await transaction(pool, c => audit(c, { actorKind: "user", actorId: row.id, action: "cli.authenticate", outcome: "refused", details }));
      throw new Refused("invalid_code", 2, "that code is not right");
    }
    await transaction(pool, async c => {
      if (!(await spendCodeStep(c, row.id, step))) throw new Refused("invalid_code", 2, "that code was already used");
      await audit(c, { actorKind: "user", actorId: row.id, action: "cli.authenticate", outcome: "succeeded", details });
    });
    return row.id;
  };
}

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: { as: { type: "string" }, code: { type: "string" }, password: { type: "string" }, cabinets: { type: "string" }, days: { type: "string" }, username: { type: "string" }, name: { type: "string" }, role: { type: "string" },
      client: { type: "string" }, site: { type: "string" }, cabinet: { type: "string" }, write: { type: "boolean" }, type: { type: "string" },
      version: { type: "string" }, vendor: { type: "string" }, "hardware-id": { type: "string", multiple: true }, reason: { type: "string" },
      manifest: { type: "string" }, signature: { type: "string" }, package: { type: "string" }, pilot: { type: "string" }, success: { type: "string" }, failure: { type: "string" },
      architecture: { type: "string" }, baseline: { type: "string" } },
  });
  const [command, ...rest] = positionals;
  if (!command) { console.log(USAGE); return; }

  if (command === "migrate") {
    // The owner's account (it may create tables and roles), not the application's.
    const owner = await connectOwner(databaseUrl(process.env, "DATABASE_OWNER_URL"));
    // A failure leaves the Admins an operations alert (security.ts, D110).
    try { const ran = await migrate(owner, undefined, version => alertMigrationFailed(owner, version)); console.log(ran.length ? `Applied ${ran.join(", ")}` : "Up to date."); }
    finally { await owner.close(); }
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

  /** A release is one version for one Windows architecture, so every command that names a release names which one. */
  const architecture = (): Architecture => {
    if (!isArchitecture(values.architecture)) throw new Refused("usage", 2, "--architecture windows-x64|windows-x86 is required");
    return values.architecture;
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
  const pool = await createPool(config.databaseUrl, 2);
  // The authenticator secrets are opened with the console's key; read only when a command needs a person's code.
  const authorize = authorizer(pool, () => new SecretBox(config.console?.secretKey ?? required("CONSOLE_SECRET_KEY")), command);
  try {
    switch (["user", "token", "package", "writes", "release", "rollout", "cabinet"].includes(command) ? `${command} ${rest.shift()}` : command) {
      case "sign-in": {
        if (!values.as || !values.password) throw new Refused("usage", 2, "sign-in --as <username> --password <their password> [--code <6 digits>]");
        const signedIn = await signIn(pool, () => new SecretBox(config.console?.secretKey ?? required("CONSOLE_SECRET_KEY")),
          { username: values.as, password: values.password, ...(values.code ? { code: values.code } : {}) });
        console.log(`signed in as ${values.as} until ${signedIn.expiresAt.toISOString()}  ${sessionFile()}`);
        return;
      }
      case "sign-out": {
        const gone = await signOut(pool);
        console.log(gone ? `signed out ${gone.username}` : "there was no stored session");
        return;
      }
      case "release add": {
        const r = await releaseInput();
        const a = architecture();
        const adminId = await authorize(values.as, "admin", values.code);
        mkdirSync(config.releases.dir, { recursive: true, mode: 0o700 });
        const store = { dir: config.releases.dir, maxBytes: config.releases.maxBytes, keys: ReleaseKeys.fromFolder(config.releases.keysDir) };
        const version = await addRelease(pool, store.keys, adminId, r.manifest, r.signature, a, null);
        const added = await receiveReleasePackage(pool, store, adminId, version, a, createReadStream(r.packagePath));
        console.log(`${added.version}  ${added.architecture}  ${added.state}  sha256 ${added.sha256}`);
        return;
      }
      case "release list":
        for (const r of await listReleases(pool)) console.log(`${r.version}  ${r.architecture}  ${r.state}  from ${r.minimumVersion}  ${r.sizeBytes} bytes  added ${r.addedAt} by ${r.addedBy.name}`);
        return;
      case "rollout start": {
        if (!rest[0] || !values.pilot) throw new Refused("usage", 2, USAGE);
        const id = await startRollout(pool, await authorize(values.as, "admin", values.code), { version: rest[0], architecture: architecture(), pilotCabinetId: values.pilot.toLowerCase(),
          successRatePercent: Number(values.success ?? "95"), failureLimitPercent: Number(values.failure ?? "5") }, null);
        console.log(id);
        return;
      }
      case "rollout list":
        for (const r of await listRollouts(pool))
          console.log(`${r.id}  ${r.version}  ${r.architecture}  ${r.state}  batch ${r.currentBatch}  ${r.batches.map(b => `[${b.batch}: ${b.succeeded}/${b.total} ok, ${b.failed} failed]`).join(" ")}${r.pausedReason ? `  ${r.pausedReason}` : ""}`);
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
        await changeRollout(pool, await authorize(values.as, "admin", values.code), rest[0], action, null);
        console.log(`Rollout ${action === "stop" ? "stopped" : action + "d"}.`);
        return;
      }
      case "cabinet in-office": {
        if (!rest[0] || (rest[1] !== "on" && rest[1] !== "off")) throw new Refused("usage", 2, USAGE);
        await setInOffice(pool, await authorize(values.as, "admin", values.code), rest[0], rest[1] === "on", null);
        console.log(rest[1] === "on" ? "In office." : "Not in office.");
        return;
      }
      case "package upload": {
        if (!rest[0] || !values.name || !values.version || !values.vendor || (values.type !== "driver" && values.type !== "msi")) throw new Refused("usage", 2, USAGE);
        const adminId = await authorize(values.as, "admin", values.code);
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
        await approvePackage(pool, await authorize(values.as, "admin", values.code), rest[0], null);
        console.log("Approved.");
        return;
      case "package retire":
        if (!rest[0]) throw new Refused("usage", 2, USAGE);
        await retirePackage(pool, await authorize(values.as, "admin", values.code), rest[0], null);
        console.log("Retired.");
        return;
      case "writes pause":
      case "writes resume": {
        const adminId = await authorize(values.as, "admin", values.code);
        const paused = command === "writes" && positionals[1] === "pause";
        if (values.client && values.cabinet) throw new Refused("usage", 2, "give --client or --cabinet, not both");
        const target = values.cabinet ? { cabinetId: values.cabinet } : values.client ? { clientId: values.client } : null;
        if (target) {
          // Says which client was changed and how many cabinets that covers, so a pause on the wrong client is seen at once.
          const r = await transaction(pool, c => setClientPauseByCli(c, adminId, target, paused, values.reason ?? null));
          console.log(`Writes ${paused ? "paused" : "resumed"} for client ${r.name} (${r.clientId}): ${r.cabinets} active cabinet${r.cabinets === 1 ? "" : "s"}.`);
          return;
        }
        await transaction(pool, async c => {
          await upsertSetting(c, "writes.paused", { paused, reason: values.reason ?? null, by: adminId, at: new Date().toISOString() }, adminId);
          await audit(c, { actorKind: "user", actorId: adminId, action: paused ? "writes.pause" : "writes.resume", outcome: "succeeded",
            details: { scope: "fleet", clientId: null, reason: values.reason ?? null, via: "cli" } });
        });
        console.log(paused ? "Writes paused fleet-wide." : "Writes resumed fleet-wide.");
        return;
      }
      case "user resume-writes": {
        if (!values.username) throw new Refused("usage", 2, USAGE);
        const adminId = await authorize(values.as, "admin", values.code);
        await transaction(pool, async c => {
          const resumed = await resumeWritesByUsername(c, values.username!);
          if (!resumed) throw new Refused("not_found", 1, "no such user");
          await audit(c, { actorKind: "user", actorId: adminId, action: "writes.user_resumed", targetKind: "user", targetId: resumed, outcome: "succeeded", details: { via: "cli" } });
        });
        console.log(`Writes resumed for ${values.username}.`);
        return;
      }
      case "user add": {
        if (!values.username || !values.name || !values.role || !(values.role in ROLE_RANK)) throw new Refused("usage", 2, USAGE);
        // Without --as only while no active Admin exists (the first install); afterwards an Admin's code is needed like any other change.
        const admins = Number((await pool.query<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'")).rows[0]!.n);
        const by = admins === 0 && !values.as ? null : await authorize(values.as, "admin", values.code);
        const id = randomUUID();
        const temporary = randomBytes(12).toString("base64url");
        const hash = await hashPassword(temporary);
        await transaction(pool, async c => {
          await addUserFromCommandLine(c, { id, username: values.username!, name: values.name!, role: values.role!, passwordHash: hash });
          await audit(c, { actorKind: by ? "user" : "system", actorId: by ?? "platform-admin", action: "user.create", targetKind: "user", targetId: id, outcome: "succeeded",
            details: { username: values.username, role: values.role, via: "cli", ...(by ? {} : { bootstrap: true }) } });
        });
        console.log(`User ${values.username} (${values.role}) created: ${id}`);
        console.log(`Temporary password (shown once; must be changed at first sign-in): ${temporary}`);
        return;
      }
      case "user reset-password": {
        if (!values.username) throw new Refused("usage", 2, USAGE);
        const adminId = await authorize(values.as, "admin", values.code);
        const temporary = randomBytes(12).toString("base64url");
        const hash = await hashPassword(temporary);
        await transaction(pool, async c => {
          const target = await setTemporaryPasswordByUsername(c, values.username!, hash);
          if (!target) throw new Refused("not_found", 1, "no such user");
          await endAllSessions(c, target);
          await audit(c, { actorKind: "user", actorId: adminId, action: "user.password.reset", targetKind: "user", targetId: target, outcome: "succeeded" });
        });
        console.log(`Temporary password for ${values.username} (shown once): ${temporary}`);
        return;
      }
      case "token create": {
        // --site makes a site installer's token (F6.R1): for up to --cabinets cabinets of that site (and --role), for --days days.
        const whole = (v: string | undefined) => v === undefined ? undefined : /^\d{1,3}$/.test(v) ? Number(v) : NaN;
        if (values.role && !["sync", "satellite", "standalone"].includes(values.role)) throw new Refused("usage", 2, "--role is sync, satellite or standalone");
        const scope = values.site ? { siteId: values.site, role: values.role as "sync" | "satellite" | "standalone" | undefined, cabinets: whole(values.cabinets), days: whole(values.days) } : undefined;
        if (values.site && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(values.site)) throw new Refused("usage", 2, "--site is the site's ID");
        const { token, expiresAt, cabinets } = await createBootstrapToken(pool, await authorize(values.as, "admin", values.code), undefined, scope);
        console.log(`Bootstrap token (shown once, ${scope ? `for up to ${cabinets} cabinets of that site, ` : ""}valid until ${expiresAt.toISOString()}):\n${token}`);
        return;
      }
      case "pending":
        for (const p of await pendingRequests(pool))
          console.log(`${p.id}  ${p.createdAt.toISOString()}  ${p.fingerprints.hostname}  serial ${p.fingerprints.serialNumber ?? "-"}  from ${p.sourceAddress ?? "-"}  agent ${p.fingerprints.agentVersion}${p.intended ? `  for ${p.intended.client} / ${p.intended.site}${p.intended.role ? ` (${p.intended.role})` : ""}` : ""}`);
        return;
      case "approve": {
        const role = values.role;
        const decision = values.baseline;
        if (!rest[0] || !values.client || !values.site || !values.cabinet || !(role === "sync" || role === "satellite" || role === "standalone") || !decision)
          throw new Refused("usage", 2, USAGE);
        // Checked against the same contract as the console's approval, so the command line cannot approve what the console could not. It runs
        // on the server with the operator's own database access and no step-up, so the token is a placeholder the contract needs and nothing consumes.
        const body = consoleBodies.approve.parse({ client: values.client, site: values.site, cabinet: values.cabinet, role,
          baseline: decision === "inherited" || decision === "capture" ? { use: decision } : { use: "attach", versionId: decision }, stepUpToken: "c".repeat(43) });
        const r = await approveEnrollment(pool, await issuingKey(config), rest[0],
          { clientName: body.client, siteName: body.site, cabinetName: body.cabinet, role: body.role, baseline: body.baseline }, await authorize(values.as, "admin", values.code));
        console.log(`Approved. Cabinet ${r.cabinetId}, certificate ${r.serial}. Baseline: ${r.baseline.decision}. The agent picks it up on its next enrollment poll.`);
        return;
      }
      case "reject":
        if (!rest[0]) throw new Refused("usage", 2, USAGE);
        await rejectEnrollment(pool, rest[0], await authorize(values.as, "admin", values.code));
        console.log("Rejected.");
        return;
      case "cabinets":
        for (const c of await listCabinets(pool))
          console.log(`${c.id}  ${c.online ? "online " : "offline"}  ${c.client} / ${c.site} / ${c.name} (${c.role})  ${c.status}  ${c.hostname ?? ""}  agent ${c.agentVersion ?? "-"}  last ${c.lastHeartbeatAt?.toISOString() ?? "never"}`);
        return;
      case "revoke":
        if (!rest[0]) throw new Refused("usage", 2, USAGE);
        await revokeCabinet(pool, rest[0], await authorize(values.as, "admin", values.code));
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
        const as = await authorize(values.as, isWrite ? "tier2" : "tier1", values.code);
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
      case "status": {
        // The same summary as the console's System health page; needs no sign-in because it runs on the server host with the database account.
        const ca = await issuingKey(config).then(k => k.certificatePem, () => undefined);
        console.log(formatHealth(await healthSummary(pool, { caCertificatePem: ca })).join("\n"));
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
