// The command line's way in (docs/spec/02-security-model.md, F3). Access is proven once — the person's password and, when they
// have one, their authenticator code — and the session that results is the console's own, kept in a file only that person can
// read. Commands afterwards act as that person without asking for a fresh code: the code is what gets you into the platform,
// not a toll on every write. The session expires like any other (idle and absolute), and sign-out ends it on the server too.
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { audit, transaction, type Pool } from "../db/db.js";
import { recordAuthFailure } from "../services/auth-failures.js";
import { settleSignIn } from "../services/users.js";
import { Refused } from "../services/errors.js";
import { SettingsCache } from "../services/settings.js";
import { verifyPassword } from "./passwords.js";
import type { SecretBox } from "./secrets.js";
import { createSession, endSession, hashId, loadSession, nextStage, policyFrom, type SessionPolicy, type SessionUser } from "./sessions.js";
import * as totp from "./totp.js";

/** Where the session id is kept: the person's own home, overridable so a test never touches it. */
export const sessionFile = (): string => process.env.CABINET_CLI_SESSION_FILE ?? join(homedir(), ".cabinet-cli", "session");

/** The session policy the console uses, so a command line session lives exactly as long as a browser one. */
export const sessionPolicy = async (pool: Pool): Promise<SessionPolicy> => policyFrom(await new SettingsCache(pool).get());

export async function storedSessionId(): Promise<string | null> {
  try { const id = (await readFile(sessionFile(), "utf8")).trim(); return id.length ? id : null; }
  catch { return null; }
}

/** The signed-in person, if the stored session is still live. */
export async function sessionActor(pool: Pool, policy: SessionPolicy): Promise<SessionUser | null> {
  return loadSession(pool, (await storedSessionId()) ?? undefined, policy);
}

const keep = async (id: string): Promise<void> => {
  const path = sessionFile();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // The mode writeFile takes is masked by the umask, so it is set again on the file that already exists.
  await writeFile(path, `${id}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
};

export interface Person {
  id: string; role: SessionUser["role"]; password_hash: string | null; totp_enabled: boolean; totp_secret_enc: Buffer | null;
  totp_last_step: string | null; must_change_password: boolean; locked: boolean;
}

export const personNamed = async (pool: Pool, username: string): Promise<Person | undefined> => (await pool.query<Person>(
  `SELECT TOP (1) id, role, password_hash, totp_enabled, totp_secret_enc, totp_last_step, must_change_password,
          CAST(CASE WHEN locked_until IS NOT NULL AND locked_until > SYSUTCDATETIME() THEN 1 ELSE 0 END AS bit) AS locked
     FROM users WHERE username COLLATE Latin1_General_100_BIN2 = $1 AND status = 'active'`, [username])).rows[0];

/**
 * Sign in as one person: password, then their authenticator code when they have one, checked and claimed exactly as the console
 * checks it (single use, a wrong code counted toward the account's lock). The session is written where only that person can read
 * it. A refusal before the code is checked is audited as a refused sign-in, with no hint of which half was wrong.
 */
export async function signIn(pool: Pool, secrets: () => SecretBox, input: { username: string; password: string; code?: string }): Promise<{ userId: string; expiresAt: Date }> {
  const policy = await sessionPolicy(pool);
  const person = await personNamed(pool, input.username);
  const ok = await verifyPassword(person?.password_hash ?? null, input.password);
  const refused = async (reason: string, outcome: string) => {
    if (person) await recordAuthFailure(pool, person.id, reason === "invalid_code" ? "failed_step_ups" : "failed_logins", "cli");
    await transaction(pool, c => audit(c, { actorKind: person ? "user" : "system", actorId: person?.id ?? "cli", action: "cli.sign-in", outcome: "refused",
      details: { username: input.username, via: "cli", reason } }));
  };
  // A lock is shown only to someone who knows the password: a wrong password gets the same answer for every account.
  if (person?.locked && ok) throw new Refused("account_locked", 2, `${input.username} is locked after repeated failures; try again later`);
  if (!person || !ok) { await refused("invalid_credentials", "refused"); throw new Refused("invalid_credentials", 2, `no active user ${input.username} with that password`); }
  const needsCode = person.totp_enabled && person.totp_secret_enc !== null;
  let step: number | null = null;
  if (needsCode) {
    if (!input.code || !/^\d{6}$/.test(input.code)) throw new Refused("usage", 2, "--code <the 6-digit code from that person's authenticator> is required");
    step = totp.verify(secrets().open(person.totp_secret_enc!), input.code, Date.now(), person.totp_last_step === null ? null : Number(person.totp_last_step));
    if (step === null) { await refused("invalid_code", "refused"); throw new Refused("invalid_code", 2, "that code is not right"); }
  }
  // Everything after the password belongs to the console, so an account that still has setup to do finishes it there. The
  // authenticator step is behind us either way: an account that has one passed it above, and one without goes to totp_setup.
  const stage = nextStage({ totpEnabled: person.totp_enabled, role: person.role, mustChangePassword: person.must_change_password }, true);
  if (stage !== "complete") {
    await refused("setup_required", "refused");
    throw new Refused("setup_required", 2, `${input.username} has not finished signing in to the console yet (${stage}); do that first`);
  }
  const id = await transaction(pool, async c => {
    // The sign-in writes the users table through its owner, which is also where the one-use rule for the code lives.
    if (!(await settleSignIn(c, person.id, step))) throw new Refused("invalid_code", 2, "that code was already used");
    const session = await createSession(c, person.id, "complete", "command line", policy);
    await audit(c, { actorKind: "user", actorId: person.id, action: "cli.sign-in", outcome: "succeeded",
      details: { username: input.username, via: "cli", proof: needsCode ? "password+authenticator" : "password" } });
    return session;
  });
  await keep(id);
  return { userId: person.id, expiresAt: new Date(Date.now() + policy.absoluteHours * 3_600_000) };
}

/** Sign out: the session ends on the server, so the file being deleted late cannot leave a live session behind. */
export async function signOut(pool: Pool): Promise<{ username: string } | null> {
  const policy = await sessionPolicy(pool);
  const actor = await sessionActor(pool, policy);
  const id = await storedSessionId();
  if (id) await endSession(pool, hashId(id));
  await rm(sessionFile(), { force: true });
  if (!actor) return null;
  await transaction(pool, c => audit(c, { actorKind: "user", actorId: actor.userId, action: "cli.sign-out", outcome: "succeeded",
    details: { username: actor.username, via: "cli" } }));
  return { username: actor.username };
}