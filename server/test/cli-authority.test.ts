// F3 (docs/spec/02-security-model.md "The operator command line"): shell access to the server is not authority. Every command line action
// that changes something needs the named person's own authenticator code, checked like a console step-up: used once, refused when wrong,
// missing or malformed, refused while the account is locked, and each failure counted toward the lock. Every attempt that reaches the code check is audited, a refusal before it is not.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SecretBox } from "../src/auth/secrets.js";
import * as totp from "../src/auth/totp.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const KEY = randomBytes(32).toString("base64");
const box = new SecretBox(KEY);

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db.drop(); });

function cli(...args: string[]) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, DATABASE_URL: db.appUrl, CONSOLE_SECRET_KEY: KEY };
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** An active user with an authenticator; returns their id and secret. */
async function person(username: string, role: "tier1" | "tier2" | "admin", authenticator = true) {
  const id = randomUUID(), secret = totp.newSecret();
  if (authenticator)
    await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, totp_enabled, totp_secret_enc) VALUES ($1, $2, $3, $4, 'x', 1, $5)`,
      [id, username, username, role, box.seal(secret)]);
  else await db.app.query(`INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, $2, $3, $4, 'x')`, [id, username, username, role]);
  return { id, secret };
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
