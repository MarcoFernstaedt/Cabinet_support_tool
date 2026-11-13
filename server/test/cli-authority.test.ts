// F3 (docs/spec/02-security-model.md "The operator command line"): shell access to the server is not authority. Every command line action
// that changes something needs the named person's own authenticator code, checked like a console step-up: used once, refused when wrong,
// missing or malformed, refused while the account is locked, and each failure counted toward the lock. Every attempt that reaches the code check is audited, a refusal before it is not.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/auth/passwords.js";
import { SecretBox } from "../src/auth/secrets.js";
import * as totp from "../src/auth/totp.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const KEY = randomBytes(32).toString("base64");
const box = new SecretBox(KEY);

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db.drop(); });

/**
 * Each session gets a file of its own, so one test's sign-in can never authorise another test's command; the default path is one
 * nothing writes, which is "not signed in". Every test that does not sign in therefore exercises the --code path alone.
 */
const SESSION_DIR = mkdtempSync(join(tmpdir(), "cabinet-cli-sessions-"));
function run(session: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, DATABASE_URL: db.appUrl, CONSOLE_SECRET_KEY: KEY,
    CABINET_CLI_SESSION_FILE: join(SESSION_DIR, session) };
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const cli = (...args: string[]) => run("not-signed-in", ...args);

/** An active user with an authenticator, whose password does not have to be changed any more; returns their id and secret. */
async function person(username: string, role: "tier1" | "tier2" | "admin", authenticator = true, password = "x", mustChange = false) {
  const id = randomUUID(), secret = totp.newSecret(), hash = await hashPassword(password);
  if (authenticator)
    await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, totp_enabled, totp_secret_enc, must_change_password) VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
      [id, username, username, role, hash, box.seal(secret), mustChange ? 1 : 0]);
  else await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password) VALUES ($1, $2, $3, $4, $5, $6)`, [id, username, username, role, hash, mustChange ? 1 : 0]);
  return { id, secret, password };
}
const codeNow = (secret: Buffer, offset = 0) => totp.code(secret, totp.stepAt(Date.now()) + offset);
const audits = async (actorId: string, action: string) => (await db.app.query<{ outcome: string; details: Record<string, unknown> }>(
  "SELECT outcome, details FROM audit_log WHERE actor_id = $1 AND action = $2 ORDER BY seq", [actorId, action])).rows;
const tokens = async () => Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM bootstrap_tokens")).rows[0]!.n);

test("the first Admin is created without --as; after that, creating a user needs an Admin's code", async () => {
  const first = cli("user", "add", "--username", "first.admin", "--name", "First", "--role", "admin");
  assert.equal(first.status, 0, first.out);
  const second = cli("user", "add", "--username", "intruder", "--name", "Intruder", "--role", "admin");
  assert.equal(second.status, 2, second.out);
  assert.equal(Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE username = 'intruder'")).rows[0]!.n), 0);
});

test("a change with the right code from the person's authenticator goes ahead, and is audited as authorised by it", async () => {
  const a = await person("cli.admin", "admin");
  const before = await tokens();
  const r = cli("token", "create", "--as", "cli.admin", "--code", codeNow(a.secret));
  assert.equal(r.status, 0, r.out);
  assert.equal(await tokens(), before + 1);
  const rows = await audits(a.id, "cli.authenticate");
  assert.deepEqual(rows.map(x => [x.outcome, x.details.via, x.details.proof]), [["succeeded", "cli", "authenticator"]]);
});

test("a missing, malformed, wrong or reused code changes nothing; a name alone is no longer enough", async () => {
  const a = await person("cli.admin2", "admin");
  const before = await tokens();
  for (const code of [undefined, "", "12345", "1234567", "abcdef", "12 456", "' OR 1=1"]) {
    const r = cli("token", "create", "--as", "cli.admin2", ...(code === undefined ? [] : ["--code", code]));
    assert.equal(r.status, 2, `${code}: ${r.out}`);
  }
  // A code from far outside the window is wrong.
  assert.equal(cli("token", "create", "--as", "cli.admin2", "--code", codeNow(a.secret, 40)).status, 2);
  assert.equal(await tokens(), before, "nothing was created");
  // A good code works once; the same code again is refused.
  const good = codeNow(a.secret);
  assert.equal(cli("token", "create", "--as", "cli.admin2", "--code", good).status, 0);
  assert.equal(cli("token", "create", "--as", "cli.admin2", "--code", good).status, 2, "a code is used once");
  assert.equal(await tokens(), before + 1);
  // The wrong-window code and the reused one were counted toward the lock and audited as refused. The good code in between reset the
  // counter, so one failure is left and both refusals are on the chain.
  const failures = Number((await db.app.query<{ n: number }>("SELECT failed_logins AS n FROM users WHERE id = $1", [a.id])).rows[0]!.n);
  assert.equal(failures, 1, `failures counted: ${failures}`);
  const refused = (await audits(a.id, "cli.authenticate")).filter(x => x.outcome === "refused").length;
  assert.equal(refused, 2, `refusals audited: ${refused}`);
});

test("five wrong codes lock the account for the console too, and a locked account cannot act from the command line even with the right code", async () => {
  const a = await person("cli.admin3", "admin");
  const wrong = codeNow(a.secret) === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) assert.equal(cli("token", "create", "--as", "cli.admin3", "--code", wrong).status, 2);
  const locked = (await db.app.query<{ locked: boolean }>(
    "SELECT CAST(CASE WHEN locked_until > SYSUTCDATETIME() THEN 1 ELSE 0 END AS bit) AS locked FROM users WHERE id = $1", [a.id])).rows[0]!.locked;
  assert.equal(locked, true);
  assert.equal(Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM security_alerts WHERE kind = 'failed_step_ups' AND user_id = $1", [a.id])).rows[0]!.n), 1);
  const r = cli("token", "create", "--as", "cli.admin3", "--code", codeNow(a.secret));
  assert.equal(r.status, 2);
  assert.match(r.out, /locked/);
});

test("the code is the named person's own: another person's code, a lower role, or no authenticator set up is refused", async () => {
  const a = await person("cli.admin4", "admin");
  const t = await person("cli.tier2", "tier2");
  const none = await person("cli.noauth", "admin", false);
  const before = await tokens();
  assert.equal(cli("token", "create", "--as", "cli.admin4", "--code", codeNow(t.secret)).status, 2, "someone else's code");
  assert.equal(cli("token", "create", "--as", "cli.tier2", "--code", codeNow(t.secret)).status, 2, "tier2 cannot create tokens");
  assert.equal(cli("token", "create", "--as", "cli.noauth", "--code", "123456").status, 2);
  assert.equal(cli("token", "create", "--as", "nobody.here", "--code", "123456").status, 2);
  assert.equal(await tokens(), before);
  void a; void none;
});

test("read-only commands need no code", () => {
  const r = cli("pending");
  assert.equal(r.status, 0, r.out);
});

test("signing in once is what gets a person in: their later commands need no code at all", async () => {
  const a = await person("cli.session1", "admin", true, "correct-horse-battery");
  const before = await tokens();
  const signedIn = run("session1", "sign-in", "--as", "cli.session1", "--password", "correct-horse-battery", "--code", codeNow(a.secret));
  assert.equal(signedIn.status, 0, signedIn.out);
  assert.match(signedIn.out, /signed in as cli\.session1/);
  assert.equal(statSync(join(SESSION_DIR, "session1")).mode & 0o777, 0o600, "only that person can read the file");
  const r = run("session1", "token", "create", "--as", "cli.session1");
  assert.equal(r.status, 0, r.out);
  assert.equal(await tokens(), before + 1);
  const rows = await audits(a.id, "cli.authenticate");
  assert.deepEqual(rows.map(x => [x.outcome, x.details.via, x.details.proof]), [["succeeded", "cli", "session"]]);
  const signs = await audits(a.id, "cli.sign-in");
  assert.deepEqual(signs.map(x => [x.outcome, x.details.proof]), [["succeeded", "password+authenticator"]]);
});

test("a session names one person: it cannot authorise a command for somebody else", async () => {
  const a = await person("cli.session2", "admin", true, "pw-two");
  void await person("cli.other2", "admin");
  assert.equal(run("session2", "sign-in", "--as", "cli.session2", "--password", "pw-two", "--code", codeNow(a.secret)).status, 0);
  const r = run("session2", "token", "create", "--as", "cli.other2");
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /sign in as cli\.other2/);
});

test("the wrong password or the wrong code signs nobody in, and leaves no session behind", async () => {
  const a = await person("cli.session3", "admin", true, "pw-three");
  assert.equal(run("session3", "sign-in", "--as", "cli.session3", "--password", "not-the-password", "--code", codeNow(a.secret)).status, 2);
  assert.equal(existsSync(join(SESSION_DIR, "session3")), false);
  assert.equal(run("session3", "sign-in", "--as", "cli.session3", "--password", "pw-three", "--code", "000000").status, 2);
  assert.equal(existsSync(join(SESSION_DIR, "session3")), false);
  const refusals = (await audits(a.id, "cli.sign-in")).filter(x => x.outcome === "refused").length;
  assert.equal(refusals, 2, "both refusals are on the chain");
  assert.equal(run("session3", "token", "create", "--as", "cli.session3").status, 2, "and a command with no session still needs a code");
});

test("sign-out ends the session on the server, so a copy of the file is worth nothing", async () => {
  const a = await person("cli.session4", "admin", true, "pw-four");
  assert.equal(run("session4", "sign-in", "--as", "cli.session4", "--password", "pw-four", "--code", codeNow(a.secret)).status, 0);
  const kept = readFileSync(join(SESSION_DIR, "session4"), "utf8").trim();
  assert.equal(run("session4", "sign-out").status, 0);
  assert.equal(existsSync(join(SESSION_DIR, "session4")), false);
  assert.equal(Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE user_id = $1", [a.id])).rows[0]!.n), 0, "the session row is gone");
  writeFileSync(join(SESSION_DIR, "session4"), `${kept}\n`, { mode: 0o600 });
  assert.equal(run("session4", "token", "create", "--as", "cli.session4").status, 2, "and putting the id back does not bring it back");
});

test("an account that has not set its authenticator up finishes that in the console first", async () => {
  await person("cli.session5", "admin", false, "pw-five");
  const r = run("session5", "sign-in", "--as", "cli.session5", "--password", "pw-five");
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /console/);
  assert.equal(existsSync(join(SESSION_DIR, "session5")), false);
});

test("an account still holding a temporary password changes it in the console first", async () => {
  const a = await person("cli.session6", "admin", true, "pw-six", true);
  const r = run("session6", "sign-in", "--as", "cli.session6", "--password", "pw-six", "--code", codeNow(a.secret));
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /password_change/);
  assert.equal(existsSync(join(SESSION_DIR, "session6")), false);
});
