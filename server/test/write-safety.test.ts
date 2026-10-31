// Write safety found on real hardware (2026-10-30 test report): a client's pause must stop the very next write on that client's cabinets,
// whichever way it was set, and resuming a person who went over the hourly limit must let them write again rather than pausing them on
// their next write with the writes that paused them.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { paramsHash } from "../src/auth/canonical.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import { transaction } from "../src/db/db.js";
import { issueFromConsole } from "../src/services/console-commands.js";
import { Refused } from "../src/services/errors.js";
import { bulkApply } from "../src/services/firewall-policy.js";
import { startJob } from "../src/services/fleet-jobs.js";
import { resumeUserWrites } from "../src/services/users.js";
import { setClientPause, setClientPauseByCli } from "../src/services/writes.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
let admin: string;
test.before(async () => {
  db = await createTestDatabase();
  admin = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, 'admin', 'Admin', 'admin', 'x')", [admin]);
});
test.after(async () => { await db.drop(); });

/** A client with one site and one active, writable cabinet. A live client's name is unique; a removed one keeps its name, as the
 *  field test database's leftover "Home" did. */
async function clientWithCabinet(name: string, removed = false): Promise<{ client: string; cabinet: string }> {
  const [client, site, cabinet] = [randomUUID(), randomUUID(), randomUUID()];
  await db.app.query(`INSERT INTO clients (id, name, removed_at) VALUES ($1, $2, ${removed ? "SYSUTCDATETIME()" : "NULL"})`, [client, name]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'North Phoenix')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, read_only) VALUES ($1, $2, 'DEVICEB', 'standalone', 'active', 0)", [cabinet, site]);
  return { client, cabinet };
}
const timeSync = (user: string, cabinet: string) => issueFromConsole(db.app, { userId: user, role: "admin" }, cabinet, "time.sync", {}, undefined, true);
const timeSyncAs = (user: string, cabinet: string) => issueFromConsole(db.app, { userId: user, role: "tier2" }, cabinet, "time.sync", {}, undefined, true);
async function refusal(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { assert.ok(e instanceof Refused, String(e)); return e.code; }
  return "accepted";
}

test("pausing by cabinet pauses that cabinet's own client, even when a removed client has the same name, and the next write is refused", async () => {
  const twin = await clientWithCabinet("Home", true), mine = await clientWithCabinet("Home");
  const r = await transaction(db.app, c => setClientPauseByCli(c, admin, { cabinetId: mine.cabinet }, true, "lab64"));
  assert.deepEqual(r, { clientId: mine.client, name: "Home", cabinets: 1 });
  assert.equal(await refusal(timeSync(admin, mine.cabinet)), "writes_paused");
  assert.equal((await db.app.query<{ p: boolean }>("SELECT write_paused AS p FROM clients WHERE id = $1", [twin.client])).rows[0]!.p, false, "the removed client of the same name is untouched");
  await transaction(db.app, c => setClientPauseByCli(c, admin, { cabinetId: mine.cabinet }, false, null));
  assert.equal(await refusal(timeSync(admin, mine.cabinet)), "accepted");
});

test("pausing by client id pauses that client (an upper-case id too) and says which client and how many cabinets it covers", async () => {
  const one = await clientWithCabinet("North A"), other = await clientWithCabinet("North B");
  const r = await transaction(db.app, c => setClientPauseByCli(c, admin, { clientId: other.client.toUpperCase() }, true, "lab64"));
  assert.equal(r.clientId, other.client);
  assert.equal(r.cabinets, 1);
  // Another client's pause leaves this cabinet writable, and the output names the client that was paused.
  assert.equal(await refusal(timeSync(admin, one.cabinet)), "accepted");
  assert.equal(await refusal(timeSync(admin, other.cabinet)), "writes_paused");
});

// The likely field case: the old CLI paused a removed client of the same name by its id and said "Writes paused.".
test("an unknown cabinet, an unknown client and a removed client are refused, and nothing is paused", async () => {
  const gone = await clientWithCabinet("Gone");
  await db.app.query("UPDATE clients SET removed_at = SYSUTCDATETIME() WHERE id = $1", [gone.client]);
  for (const target of [{ cabinetId: randomUUID() }, { clientId: randomUUID() }, { clientId: gone.client }])
    await assert.rejects(transaction(db.app, c => setClientPauseByCli(c, admin, target, true, null)), (e: unknown) => e instanceof Refused && e.code === "not_found");
  assert.equal((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM clients WHERE write_paused = 1 AND id = $1", [gone.client])).rows[0]!.n, 0);
});

test("a person resumed after going over the hourly limit can write again, and the limit counts again from the resume", async () => {
  const { cabinet } = await clientWithCabinet("Limits");
  const tech = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role, password_hash, write_limit) VALUES ($1, 'tech', 'Tech', 'tier2', 'x', 2)", [tech]);
  const write = () => issueFromConsole(db.app, { userId: tech, role: "tier2" }, cabinet, "time.sync", {}, undefined, true);
  assert.equal(await refusal(write()), "accepted");
  assert.equal(await refusal(write()), "accepted");
  assert.equal(await refusal(write()), "write_limit_reached");
  assert.equal(await refusal(write()), "writes_paused_for_you");

  // An Admin resumes some time after the pause, never in the same second (commands carry whole seconds, so that case counts them).
  await db.app.query("UPDATE commands SET issued_at = DATEADD(second, -30, issued_at) WHERE issued_by = $1", [tech]);
  await resumeUserWrites(db.app, admin, tech, await issueStepUpToken(db.app, admin, "user.resume_writes", tech, paramsHash({})));
  // Before the fix this write tripped the limit again and paused them, with the two writes that had paused them.
  assert.equal(await refusal(write()), "accepted");
  assert.equal(await refusal(write()), "accepted");
  assert.equal(await refusal(write()), "write_limit_reached", "the limit still holds after the resume");
});

/** A Tier 2 with a limit of 2 who went over it on this cabinet and was paused, then resumed by an Admin. */
async function resumedAfterLimit(cabinet: string): Promise<string> {
  const tech = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role, password_hash, write_limit) VALUES ($1, $2, 'Tech', 'tier2', 'x', 2)", [tech, `tech.${tech.slice(0, 6)}`]);
  const write = () => issueFromConsole(db.app, { userId: tech, role: "tier2" }, cabinet, "time.sync", {}, undefined, true);
  await write(); await write();
  assert.equal(await refusal(write()), "write_limit_reached");
  await db.app.query("UPDATE commands SET issued_at = DATEADD(second, -30, issued_at) WHERE issued_by = $1", [tech]);
  await resumeUserWrites(db.app, admin, tech, await issueStepUpToken(db.app, admin, "user.resume_writes", tech, paramsHash({})));
  return tech;
}

test("a resumed person can start a fleet job and apply a bulk firewall change: every write path counts from the resume", async () => {
  const { client, cabinet } = await clientWithCabinet("Bulk paths");
  const tech = await resumedAfterLimit(cabinet);
  const jobId = randomUUID();
  const job = { operation: "time.sync" as const, cabinetIds: [cabinet], batchSize: 1 };
  // Before the fix both of these were refused write_limit_reached by the writes that had paused the person.
  assert.equal(await refusal(startJob(db.app, { userId: tech, role: "tier2" }, { jobId, ...job,
    stepUpToken: await issueStepUpToken(db.app, tech, "fleet.job", jobId, paramsHash(job)) })), "accepted");
  assert.equal(await refusal(bulkApply(db.app, tech, "client", client,
    await issueStepUpToken(db.app, tech, "bulk.firewall_policy", client, paramsHash({ scope: "client", id: client })))), "accepted");
});

test("the console's client pause refuses a removed client, as the CLI does", async () => {
  const gone = await clientWithCabinet("Console gone");
  await db.app.query("UPDATE clients SET removed_at = SYSUTCDATETIME() WHERE id = $1", [gone.client]);
  const token = await issueStepUpToken(db.app, admin, "writes.pause", gone.client);
  assert.equal(await refusal(setClientPause(db.app, admin, gone.client, true, "x", token)), "not_found");
  assert.equal((await db.app.query<{ p: boolean }>("SELECT write_paused AS p FROM clients WHERE id = $1", [gone.client])).rows[0]!.p, false);
});

test("going over the limit with a fleet job or a bulk firewall change pauses the person, as a single command does", async () => {
  const { client, cabinet } = await clientWithCabinet("Bulk limit");
  const overLimit = async (): Promise<string> => {
    const tech = randomUUID();
    await db.app.query("INSERT INTO users (id, username, name, role, password_hash, write_limit) VALUES ($1, $2, 'Tech', 'tier2', 'x', 2)", [tech, `tech.${tech.slice(0, 6)}`]);
    await timeSyncAs(tech, cabinet); await timeSyncAs(tech, cabinet);
    return tech;
  };
  const paused = async (tech: string) => {
    assert.equal((await db.app.query<{ p: boolean }>("SELECT writes_paused AS p FROM users WHERE id = $1", [tech])).rows[0]!.p, true);
    assert.equal((await db.app.query("SELECT 1 FROM security_alerts WHERE kind = 'write_volume' AND user_id = $1 AND state = 'open'", [tech])).rows.length, 1);
    assert.equal(await refusal(timeSyncAs(tech, cabinet)), "writes_paused_for_you");
  };

  const jobber = await overLimit();
  const jobId = randomUUID();
  const job = { operation: "time.sync" as const, cabinetIds: [cabinet], batchSize: 1 };
  // Before this change both were refused write_limit_reached but left the person unpaused, though the refusal says "paused".
  assert.equal(await refusal(startJob(db.app, { userId: jobber, role: "tier2" }, { jobId, ...job,
    stepUpToken: await issueStepUpToken(db.app, jobber, "fleet.job", jobId, paramsHash(job)) })), "write_limit_reached");
  await paused(jobber);

  const bulker = await overLimit();
  assert.equal(await refusal(bulkApply(db.app, bulker, "client", client,
    await issueStepUpToken(db.app, bulker, "bulk.firewall_policy", client, paramsHash({ scope: "client", id: client })))), "write_limit_reached");
  await paused(bulker);
});
