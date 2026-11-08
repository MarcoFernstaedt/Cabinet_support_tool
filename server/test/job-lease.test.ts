// One writer per background job across server instances (F21.R1, decision-log D49): two instances that both run the job loop never both
// run a job. Each job is leased by name; the holder renews it every run, another instance takes it over only after the holder stops
// renewing and its lease runs out. On a real SQL Server, with the two instances asking at the same moment.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { leased, takeLease } from "../src/services/job-lease.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db.drop(); });

const A = "instance-a", B = "instance-b";

test("two instances asking for the same lease at the same moment: exactly one gets it, every time", async () => {
  for (let round = 0; round < 25; round++) {
    const name = `jobs.race-${round}`;
    const [a, b] = await Promise.all([takeLease(db.app, name, 60_000, A), takeLease(db.app, name, 60_000, B)]);
    assert.equal(Number(a) + Number(b), 1, `round ${round}: ${a} and ${b}`);
  }
});

test("the holder renews its lease; the other cannot take it while it runs, and takes it over once it has run out", async () => {
  const name = `jobs.takeover-${randomUUID().slice(0, 8)}`;
  assert.equal(await takeLease(db.app, name, 60_000, A), true);
  assert.equal(await takeLease(db.app, name, 60_000, A), true, "the holder renews");
  assert.equal(await takeLease(db.app, name, 60_000, B), false, "not while A's lease runs");
  // A stops renewing (it crashed, or was shut down) and its lease runs out.
  await db.app.query("UPDATE job_leases SET until = DATEADD(second, -1, SYSUTCDATETIME()) WHERE name = $1", [name]);
  assert.equal(await takeLease(db.app, name, 60_000, B), true, "B takes it over");
  assert.equal(await takeLease(db.app, name, 60_000, A), false, "and A, back, does not take it back while B holds it");
});

test("a job run by two instances' loops runs once per round, always by the same instance, and moves when that one stops", async () => {
  const name = `jobs.minute-${randomUUID().slice(0, 8)}`;
  const ran: string[] = [];
  const jobOf = (who: string) => leased(db.app, name, 60_000, async () => { ran.push(who); }, who);
  const [a, b] = [jobOf(A), jobOf(B)];
  for (let round = 0; round < 10; round++) await Promise.all([a(), b()]);
  assert.equal(ran.length, 10, `ran ${ran.length} times in 10 rounds`);
  assert.equal(new Set(ran).size, 1, "always the same instance");
  const holder = ran[0]!;
  // The holder stops; once its lease has run out, the other instance's next round runs the job.
  await db.app.query("UPDATE job_leases SET until = DATEADD(second, -1, SYSUTCDATETIME()) WHERE name = $1", [name]);
  const other = holder === A ? b : a;
  assert.equal(await other(), true);
  assert.equal(ran.at(-1), holder === A ? B : A);
});

test("a lease that cannot be read is not held: the job is skipped, never run by two", async () => {
  let ran = 0;
  const broken = { query: async () => { throw new Error("database unavailable"); } } as never;
  assert.equal(await leased(broken, "jobs.broken", 60_000, async () => { ran++; }, A)(), false);
  assert.equal(ran, 0);
});
