// An honest empty state (F8.R5, decision-log D45): when there is nothing to compare with the last healthy state, both routes say why,
// never a bare empty answer. Each reason is reached the way it happens: not judged yet, no configuration, no approved baseline, judged
// but never healthy, healthy with no mark kept, and a mark whose configuration is gone. Through the real console routes on a real SQL Server.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SecretBox } from "../src/auth/secrets.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { evaluateHealth } from "../src/services/cabinet-health.js";
import { configHash, type Item } from "../src/services/config-canonical.js";
import { ingestConfig } from "../src/services/config-ingest.js";
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
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour')", [clientId]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Pier')", [siteId, clientId]);
});
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

const svc = (name: string): Item => ({ key: `service:${name}`, values: { startType: "automatic", state: "running" } as Item["values"] });
const snap = (items: Item[]) => ({ observedAt: new Date(Date.now() - 60_000).toISOString(), category: "services", hash: configHash(items), truncated: false, items }) as never;
async function newCabinet() {
  const id = randomUUID();
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES ($1, $2, $3, 'standalone', 'active', SYSUTCDATETIME())", [id, siteId, `K ${id.slice(0, 6)}`]);
  return id;
}
/** The reason from both routes, which must agree. */
async function reason(cabinetId: string): Promise<string | null> {
  const since = await call("GET", `/api/cabinets/${cabinetId}/since-healthy`, undefined, t1);
  const compare = await call("GET", `/api/cabinets/${cabinetId}/compare-healthy`, undefined, t1);
  assert.equal(since.status, 200, JSON.stringify(since.body));
  assert.equal(compare.status, 200, JSON.stringify(compare.body));
  assert.equal(since.body.nothingToCompare, compare.body.nothingToCompare, "both routes give the same reason");
  return since.body.nothingToCompare;
}

test("each way of having nothing to compare is named, the way it happens", async () => {
  const fresh = await newCabinet();
  assert.equal(await reason(fresh), "not_evaluated");
  await evaluateHealth(db.app, fresh);
  assert.equal(await reason(fresh), "no_configuration", "the real evaluation of a cabinet that reported nothing");
  await ingestConfig(db.app, fresh, [snap([svc("Spooler")])], "agent");
  await evaluateHealth(db.app, fresh);
  assert.equal(await reason(fresh), "no_baseline", "the real evaluation with configuration but no approved baseline");

  const never = await newCabinet();
  await db.app.query("INSERT INTO cabinet_health (cabinet_id, state, evaluated_at, since, reasons) VALUES ($1, 'degraded', SYSUTCDATETIME(), SYSUTCDATETIME(), $2)",
    [never, JSON.stringify([{ code: "required_item", text: "service:Spooler is not as the baseline requires." }])]);
  assert.equal(await reason(never), "never_healthy");

  const unmarked = await newCabinet();
  await db.app.query("INSERT INTO cabinet_health (cabinet_id, state, evaluated_at, since, reasons, last_healthy_at) VALUES ($1, 'degraded', SYSUTCDATETIME(), SYSUTCDATETIME(), '[]', DATEADD(day, -2, SYSUTCDATETIME()))", [unmarked]);
  assert.equal(await reason(unmarked), "no_mark", "healthy once, but no mark kept");
});

test("a mark whose configuration is gone says so; a mark that can be compared has no reason at all", async () => {
  const k = await newCabinet();
  await ingestConfig(db.app, k, [snap([svc("Spooler")])], "agent");
  // A mark that points at a services version no longer kept (as after a prune of old versions).
  const gone = (await db.app.query<{ id: string }>("INSERT INTO healthy_marks (cabinet_id, marked_at, versions) OUTPUT inserted.id VALUES ($1, DATEADD(day, -1, SYSUTCDATETIME()), $2)",
    [k, JSON.stringify({ services: 999_999_999 })])).rows[0]!.id;
  await db.app.query("INSERT INTO cabinet_health (cabinet_id, state, evaluated_at, since, reasons, last_healthy_at, last_mark_id) VALUES ($1, 'degraded', SYSUTCDATETIME(), SYSUTCDATETIME(), '[]', DATEADD(day, -1, SYSUTCDATETIME()), $2)", [k, gone]);
  assert.equal(await reason(k), "versions_pruned");
  // The mark of what is in force now: comparable, so no reason.
  const now = Number((await db.app.query<{ v: string }>("SELECT version_id AS v FROM config_current WHERE cabinet_id = $1 AND category = 'services'", [k])).rows[0]!.v);
  const ok = (await db.app.query<{ id: string }>("INSERT INTO healthy_marks (cabinet_id, marked_at, versions) OUTPUT inserted.id VALUES ($1, SYSUTCDATETIME(), $2)",
    [k, JSON.stringify({ services: now })])).rows[0]!.id;
  await db.app.query("UPDATE cabinet_health SET last_mark_id = $2 WHERE cabinet_id = $1", [k, ok]);
  assert.equal(await reason(k), null);
});
