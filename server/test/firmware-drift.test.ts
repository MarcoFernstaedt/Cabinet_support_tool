// Firmware as a declared expectation per model (F19.R7, decision-log D48). The BIOS version and date are read into the hardware item; a
// baseline approved for a model can expect them. A cabinet of that model reporting other firmware drifts, and the drift opens a named,
// minor alert saying what it has and what was expected; firmware changed back to the expected one closes it, audited. Nothing is ever
// flashed. Through the real baseline approval, configuration ingest and drift on a real SQL Server.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SecretBox } from "../src/auth/secrets.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { reevaluationsSettled } from "../src/console-api/baseline-routes.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { FIRMWARE_SIGNATURE, firmwareTitle } from "../src/services/baseline-drift.js";
import { configHash, type Item } from "../src/services/config-canonical.js";
import { ingestAndEvaluate } from "../src/services/config-service.js";
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
let a1: Account, a2: Account;
let siteId: string;
const MODEL = "OptiPlex 7090";

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  [a1, a2] = [await h.account("admin"), await h.account("admin")];
  const clientId = randomUUID();
  siteId = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour')", [clientId]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Pier')", [siteId, clientId]);
  // The model's baseline expects its approved firmware.
  const draft = await call("POST", "/api/baselines/drafts", { scope: { kind: "model", id: MODEL }, description: "Approved firmware for the model",
    content: { items: [{ category: "system", key: "hardware", mode: "match", expect: { biosVersion: "1.18.0", biosDate: "2023-05-09" } }] } }, a1);
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  assert.equal((await call("POST", `/api/baselines/versions/${draft.body.id}/propose`, {}, a1)).status, 200);
  const note = "The model's approved firmware.";
  assert.equal((await call("POST", `/api/baselines/versions/${draft.body.id}/approve`, { note, stepUpToken: await h.codeToken(a2, "baseline.approve", draft.body.id, { note }) }, a2)).status, 200);
  await reevaluationsSettled();
});
test.after(async () => { await reevaluationsSettled(); await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

let minute = 0;
const hardware = (biosVersion: string, biosDate: string, model = MODEL): Item => ({ key: "hardware", values: { manufacturer: "Dell Inc.", model, biosVersion, biosDate } as Item["values"] });
const report = (cabinetId: string, item: Item) => {
  const items = [item];
  return ingestAndEvaluate(db.app, cabinetId, [{ observedAt: new Date(Date.now() - 3_600_000 + (minute += 1) * 60_000).toISOString(), category: "system", hash: configHash(items), truncated: false, items }] as never, "agent");
};
async function cabinetOfModel(model = MODEL) {
  const id = randomUUID();
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at, model) VALUES ($1, $2, $3, 'standalone', 'active', SYSUTCDATETIME(), $4)", [id, siteId, `K ${id.slice(0, 6)}`, model]);
  return id;
}
const alerts = async (cabinetId: string) => (await db.app.query<{ state: string; title: string; severity: string }>(
  "SELECT state, title, severity FROM alerts WHERE cabinet_id = $1 AND signature = $2", [cabinetId, FIRMWARE_SIGNATURE])).rows;

test("a cabinet on older firmware than its model expects drifts, and the drift opens one minor alert saying what it has and what was expected", async () => {
  const k = await cabinetOfModel();
  await report(k, hardware("1.12.0", "2022-02-17"));
  await reevaluationsSettled();
  const [a] = await alerts(k);
  assert.deepEqual([a?.state, a?.severity], ["open", "minor"]);
  assert.equal(a!.title, "Firmware differs from its model's expectation: BIOS 1.12.0, expected 1.18.0; BIOS date 2022-02-17, expected 2023-05-09");
  // Updated by hand to the approved firmware: the next reading closes it, audited as automatic.
  await report(k, hardware("1.18.0", "2023-05-09"));
  await reevaluationsSettled();
  assert.deepEqual((await alerts(k)).map(x => x.state), ["resolved"]);
  const audit = (await db.app.query<{ actor_id: string }>("SELECT TOP (1) actor_id FROM audit_log WHERE action = 'alert.resolve' AND actor_kind = 'system' ORDER BY seq DESC")).rows[0]!;
  assert.equal(audit.actor_id, "firmware-drift");
});

test("firmware that changed silently on a cabinet that matched is drift too; another model's cabinet and matching firmware open nothing", async () => {
  const k = await cabinetOfModel();
  await report(k, hardware("1.18.0", "2023-05-09"));
  await reevaluationsSettled();
  assert.deepEqual(await alerts(k), [], "on the expected firmware");
  await report(k, hardware("1.19.0", "2024-03-01"));
  await reevaluationsSettled();
  assert.equal((await alerts(k))[0]?.state, "open", "a newer, unplanned firmware is a change too");
  const other = await cabinetOfModel("OptiPlex 3080");
  await report(other, hardware("2.14.0", "2022-11-03", "OptiPlex 3080"));
  await reevaluationsSettled();
  assert.deepEqual(await alerts(other), [], "no baseline for its model, so no expectation");
});

test("the title says what differs, field by field", () => {
  assert.equal(firmwareTitle([{ category: "system", itemKey: "hardware", field: "biosVersion", mode: "match", expected: "1.18.0", actual: null } as never]),
    "Firmware differs from its model's expectation: BIOS unknown, expected 1.18.0");
});
