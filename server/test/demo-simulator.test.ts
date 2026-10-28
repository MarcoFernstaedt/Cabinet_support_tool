// The demo simulator keeps answering while it sends its heartbeats: the once-a-minute sweep of every simulated cabinet runs beside the
// ticks, not inside one, so a read issued during a sweep (a diagnosis started at that moment) is answered at once rather than after the
// whole sweep. Before, a sweep held the tick for seconds idle and far longer on a loaded server, and a diagnosis could run out its minute.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DemoSimulator, enableDemo } from "../src/demo/demo.js";
import { issueFromConsole } from "../src/services/console-commands.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
let owner: string;

test.before(async () => {
  db = await createTestDatabase();
  owner = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, 'demo.owner', 'Demo owner', 'admin', 'x')`, [owner]);
  await enableDemo(db.app, owner);
});
test.after(async () => { await db.drop(); });

test("a command issued while the heartbeat sweep runs is answered without waiting for the sweep", async () => {
  const sim = new DemoSimulator(db.app, () => {}, 50, [10, 20]);
  try {
    const healthy = (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM cabinets WHERE demo_scenario = 'healthy' ORDER BY name")).rows[0]!.id;
    // The first tick is due a sweep: it starts it and returns at once.
    const started = Date.now();
    await sim.tick();
    assert.ok(Date.now() - started < 1_000, `the tick waited ${Date.now() - started} ms`);
    const sweep = sim.settled();
    let swept = false;
    void sweep.then(() => { swept = true; });
    // A read issued now is taken and answered by the next ticks while the sweep goes on.
    const command = await issueFromConsole(db.app, { userId: owner, role: "admin" }, healthy, "system.info", {});
    sim.start();
    let status = "queued";
    for (const end = Date.now() + 5_000; Date.now() < end && status !== "succeeded"; await new Promise(r => setTimeout(r, 20)))
      status = (await db.app.query<{ status: string }>("SELECT status FROM commands WHERE id = $1", [command.commandId])).rows[0]!.status;
    assert.equal(status, "succeeded");
    // The sweep still finishes and every reporting cabinet has its heartbeat.
    await sweep;
    assert.ok(swept);
    const stale = (await db.app.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cabinets WHERE demo_scenario = 'healthy' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < DATEADD(minute, -1, SYSUTCDATETIME()))")).rows[0]!.n;
    assert.equal(Number(stale), 0);
  } finally { sim.stop(); await sim.settled(); }
});
