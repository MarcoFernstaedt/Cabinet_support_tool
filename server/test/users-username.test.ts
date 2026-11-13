// The username rule, at the service and at the table: what the admin console's form offers has to be creatable, and what
// it does not offer has to come back as an answer rather than as a check-constraint error.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as users from "../src/services/users.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import { Refused } from "../src/services/errors.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db.drop(); });

const refused = async (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof Refused && e.code === code, `expected ${code}`);

async function admin() {
  const id = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled) VALUES ($1, $2, 'Boss', 'admin', 'x', 0, 1)",
    [id, `admin.${id.slice(0, 8)}`]);
  return id;
}
const make = async (boss: string, username: string) =>
  users.createUser(db.app, boss, { username, name: "New Person", role: "tier1" }, await issueStepUpToken(db.app, boss, "user.create", "fleet"));

test("a username with a dash or an underscore can be created, as the admin form offers", async () => {
  const boss = await admin();
  for (const username of ["jane-doe", "jane_doe", "j.doe", "jd", "a".repeat(64)]) {
    const created = await make(boss, username);
    assert.equal((await db.app.query("SELECT username FROM users WHERE id = $1", [created.id])).rows[0].username, username);
  }
});

test("a username outside the rule comes back as an answer, not as a table error", async () => {
  const boss = await admin();
  for (const username of ["Jane Doe", "Jane", "a", "a".repeat(65), "bad name'; --", "a b", "a!b", "a/b", ""])
    await refused(make(boss, username), "username_invalid");
});

test("the table refuses what the service refuses, so the service is not the only way in", async () => {
  await assert.rejects(db.app.query("INSERT INTO users (id, username, name, role, password_hash, must_change_password) VALUES ($1, $2, 'X', 'tier1', 'x', 0)", [randomUUID(), "Jane Doe"]));
  await assert.rejects(db.app.query("INSERT INTO users (id, username, name, role, password_hash, must_change_password) VALUES ($1, $2, 'X', 'tier1', 'x', 0)", [randomUUID(), "UPPER"]));
  await assert.rejects(db.app.query("INSERT INTO users (id, username, name, role, password_hash, must_change_password) VALUES ($1, $2, 'X', 'tier1', 'x', 0)", [randomUUID(), "a".repeat(65)]));
});
