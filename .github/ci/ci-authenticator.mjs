// CI only: the authenticator app of the CI's own test accounts, so the Windows job can prove who it is to the operator command line
// the same way a person does (F3, docs/spec/02-security-model.md "Control 8"). It is never part of a release and never runs on a server
// that serves cabinets.
//
//   node .github/ci/ci-authenticator.mjs enroll <username>   give the account an authenticator (as the console's set-up step would)
//   node .github/ci/ci-authenticator.mjs code <username>     print that account's current code; waits for the next 30-second step
//                                                            when this step's code was already handed out, since a code is used once
//
// Reads DATABASE_URL and CONSOLE_SECRET_KEY (generated per CI run, never stored) and keeps each account's secret in CI_AUTHENTICATOR_DIR,
// the runner's temporary folder, which is discarded with the runner.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const server = new URL("../../server/dist/src/", import.meta.url);
const { SecretBox } = await import(new URL("auth/secrets.js", server).href);
const totp = await import(new URL("auth/totp.js", server).href);
const { createPool } = await import(new URL("db/db.js", server).href);

const [command, username] = process.argv.slice(2);
const dir = process.env.CI_AUTHENTICATOR_DIR;
if (!["enroll", "code"].includes(command ?? "") || !username || !/^[a-z0-9._-]{1,64}$/.test(username) || !dir)
  throw new Error("Usage: CI_AUTHENTICATOR_DIR=… node ci-authenticator.mjs enroll|code <username>");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${username}.json`);

if (command === "enroll") {
  const secret = totp.newSecret();
  const pool = await createPool(process.env.DATABASE_URL, 1);
  try {
    const r = await pool.query("UPDATE users SET totp_enabled = 1, totp_secret_enc = $2 WHERE username = $1 AND status = 'active'",
      [username, new SecretBox(process.env.CONSOLE_SECRET_KEY ?? "").seal(secret)]);
    if (r.rowCount !== 1) throw new Error(`no active user ${username}`);
  } finally { await pool.end(); }
  writeFileSync(file, JSON.stringify({ secret: secret.toString("hex"), lastStep: -1 }));
} else {
  const state = JSON.parse(readFileSync(file, "utf8"));
  let step = totp.stepAt(Date.now());
  while (step <= state.lastStep) { await sleep(1000); step = totp.stepAt(Date.now()); }
  writeFileSync(file, JSON.stringify({ ...state, lastStep: step }));
  process.stdout.write(totp.code(Buffer.from(state.secret, "hex"), step) + "\n");
}
