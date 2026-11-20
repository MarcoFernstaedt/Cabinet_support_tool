// A cabinet's make and model, now written in one place, config-ingest.ts, the owner of those two columns (F21.R2, decision-log D119): a
// configuration snapshot and a system.hardware result both keep them through rememberCabinetModel. It trims, keeps what the cabinet did
// not give, writes only the cabinet it names, and checks the cabinet before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA_DIR } from "@mashura/cabinet-contracts/load";
import { rememberCabinetModel } from "../src/services/config-ingest.js";
import { issueCommand, storeResult, takeQueuedCommands } from "../src/services/commands.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function cabinet(): Promise<string> {
  const client = randomUUID(), site = randomUUID(), k = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, manufacturer, model) VALUES ($1, $2, 'K', 'standalone', 'active', 'Old Make', 'Old Model')", [k, site]);
  return k;
}
const of = async (id: string) => (await db.app.query<{ manufacturer: string | null; model: string | null }>("SELECT manufacturer, model FROM cabinets WHERE id = $1", [id])).rows[0]!;
// A connection that fails the test if it is used: a refusal, or a call with nothing to write, has to stop before the database.
const untouched: Queryable = { query: async () => { throw new Error("reached the database"); } };

test("the make and model are trimmed and kept; one the cabinet did not give keeps what was stored; another cabinet is not touched", async () => {
  const a = await cabinet(), b = await cabinet();
  await rememberCabinetModel(db.app, a, { manufacturer: "  Omnicell  ", model: "XT".padEnd(250, "x") });
  assert.deepEqual(await of(a), { manufacturer: "Omnicell", model: "XT".padEnd(200, "x") });
  await rememberCabinetModel(db.app, a.toUpperCase(), { manufacturer: "", model: "Pyxis ES" });
  assert.deepEqual(await of(a), { manufacturer: "Omnicell", model: "Pyxis ES" }, "an empty make keeps the stored one");
  await rememberCabinetModel(db.app, a, { manufacturer: 7, model: null });
  assert.deepEqual(await of(a), { manufacturer: "Omnicell", model: "Pyxis ES" }, "a value that is not text is not taken");
  assert.deepEqual(await of(b), { manufacturer: "Old Make", model: "Old Model" });
});

test("nothing to keep writes nothing, and the cabinet is checked before the database is touched", async () => {
  for (const reported of [{}, { manufacturer: "   ", model: "" }, { manufacturer: null, model: undefined }, null as never])
    await rememberCabinetModel(untouched, randomUUID(), reported);
  for (const bad of [undefined, null, 7, "", "1' OR '1'='1", `${randomUUID()}x`, [randomUUID()]])
    await assert.rejects(rememberCabinetModel(untouched, bad as string, { manufacturer: "M", model: "N" }), /the cabinet must be a uuid/, JSON.stringify(bad));
});

test("a system.hardware result keeps the make and model the cabinet reports, through the same function", async () => {
  const k = await cabinet(), user = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, $2, 'Tech', 'tier1')", [user, `u${user.slice(0, 8)}`]);
  const output = JSON.parse(readFileSync(join(dirname(SCHEMA_DIR), "examples", "operations", "system.hardware", "output", "valid", "typical.json"), "utf8")) as { manufacturer: string; model: string };
  const cmd = await issueCommand(db.app, user, k, "system.hardware", {});
  await takeQueuedCommands(db.app, k);
  await storeResult(db.app, k, { commandId: cmd.commandId, status: "succeeded", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), output } as never);
  assert.deepEqual(await of(k), { manufacturer: output.manufacturer.trim(), model: output.model.trim() });
});
