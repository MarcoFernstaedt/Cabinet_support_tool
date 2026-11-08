// Which Windows the fleet runs (F20, decision-log D55): active cabinets counted by edition, build family and architecture from the latest
// system.info each answered; cabinets never read counted apart; demo cabinets left out; the update source said to be unread. Through the
// real console route on a real SQL Server, with hostile and malformed answers stored the way a cabinet could send them.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SecretBox } from "../src/auth/secrets.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { ConsoleHarness, ORIGIN, type Account } from "./console-harness.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);
const call = h.call.bind(h);
let t1: Account;
let siteId: string;
const userId = randomUUID();

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  t1 = await h.account("tier1");
  const clientId = randomUUID();
  siteId = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'reader', 'Reader', 'tier1')", [userId]);
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour')", [clientId]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Pier')", [siteId, clientId]);
});
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

async function cabinet(architecture: string | null, demo = false) {
  const id = randomUUID();
  await db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, architecture, demo_scenario) VALUES ($1, $2, $3, 'standalone', 'active', $4, $5)`,
    [id, siteId, `K ${id.slice(0, 6)}`, architecture, demo ? "healthy" : null]);
  return id;
}
/** A system.info answer the cabinet gave `minutesAgo`. */
const info = (cabinetId: string, minutesAgo: number, output: Record<string, unknown>) => db.app.query(
  `INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result, result_at)
   VALUES ($1, $2, 'system.info', '{}', $3, DATEADD(minute, -$4, SYSUTCDATETIME()), DATEADD(minute, 5 - $4, SYSUTCDATETIME()), 'succeeded', $5, DATEADD(minute, -$4, SYSUTCDATETIME()))`,
  [randomUUID(), cabinetId, userId, minutesAgo, JSON.stringify({ status: "succeeded", output })]);
const W10 = "Windows 10 IoT Enterprise LTSC 2021", W11 = "Windows 11 IoT Enterprise LTSC 2024";

test("cabinets are counted by edition, build family and architecture from their latest answer; unread ones apart; demo left out", async () => {
  const a = await cabinet("windows-x64"), b = await cabinet("windows-x64"), c = await cabinet("windows-x86"), d = await cabinet("windows-x64");
  await cabinet("windows-x64"); // never read
  const demo = await cabinet("windows-x64", true);
  // a was on 11 and is now on 10: only its newest answer counts.
  await info(a, 90, { osVersion: W11, osBuild: "26100.2033" });
  await info(a, 10, { osVersion: W10, osBuild: "19044.999" });
  await info(b, 20, { osVersion: W10, osBuild: "19044.5011" });
  await info(c, 20, { osVersion: W10, osBuild: "19044.4291" });
  await info(d, 20, { osVersion: W11, osBuild: "26100.2033" });
  await info(demo, 20, { osVersion: "Demo Windows", osBuild: "1.1" });
  const r = await call("GET", "/api/fleet/compatibility", undefined, t1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = (r.body.rows as { edition: string; buildFamily: string; architecture: string; cabinets: number; lowestBuild: string; highestBuild: string }[])
    .map(x => [x.edition, x.buildFamily, x.architecture, x.cabinets, x.lowestBuild, x.highestBuild]);
  assert.deepEqual(rows, [
    [W10, "19044", "windows-x64", 2, "19044.999", "19044.5011"], // revisions compared as numbers: 999 is older than 5011
    [W10, "19044", "windows-x86", 1, "19044.4291", "19044.4291"],
    [W11, "26100", "windows-x64", 1, "26100.2033", "26100.2033"],
  ]);
  assert.deepEqual([r.body.cabinetsInFleet, r.body.cabinetsRead, r.body.notRead, r.body.updateSource], [5, 4, 1, "not_read"]);
});

test("a malformed or hostile answer is grouped as unknown, never as a wrong build, and nothing in it runs", async () => {
  const k = await cabinet(null);
  await info(k, 5, { osVersion: "", osBuild: "'; DROP TABLE cabinets; --" });
  const r = await call("GET", "/api/fleet/compatibility", undefined, t1);
  assert.equal(r.status, 200);
  const odd = (r.body.rows as { edition: string | null; buildFamily: string | null; architecture: string | null; lowestBuild: string | null }[]).find(x => x.architecture === null)!;
  assert.deepEqual([odd.edition, odd.buildFamily, odd.lowestBuild], [null, "'; DROP TABLE cabinets; --", null], "the text is only data; no revision is invented");
  assert.equal(Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM cabinets")).rows[0]!.n), 7);
});

test("the report is for signed-in people only", async () => {
  const r = await app.inject({ method: "GET", url: "/api/fleet/compatibility" });
  assert.equal(r.statusCode, 401);
});
