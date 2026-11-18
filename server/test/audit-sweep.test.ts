// F4 (docs/spec/05-server-spec.md "Audit log"): every automatic and destructive transition writes an audit row in the same transaction as
// the change. Two halves:
// - a sweep over the server's own source: every statement that changes a row's state or status, and every DELETE, sits in a function that
//   writes an audit row, or closes alerts through closeAutomatically (its CLOSED_OUTPUT clause), or is listed below with the reason it
//   is not a transition of its own. A new one that is none of these fails here until it is audited or argued for in this list;
// - closeAutomatically itself: one audit row per alert it closed, in the same transaction, none when nothing closed, and no close at all
//   without the OUTPUT clause the audit is built from.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CLOSED_OUTPUT, closeAutomatically } from "../src/services/automatic-close.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

/** Not transitions of their own, each with why. `has` is text on the statement's line. */
const NOT_TRANSITIONS: { file: string; has: string; why: string }[] = [
  { file: "services/commands.ts", has: "SET status = 'delivered'", why: "a delivery lease, renewed on every re-offer; the command's issue, result and expiry are audited" },
  { file: "diagnose/diagnoses.ts", has: "UPDATE diagnoses SET state = 'done'", why: "a read-only diagnosis's own progress; every read it issues is audited as command.issue" },
  { file: "diagnose/diagnoses.ts", has: "UPDATE diagnoses SET state = 'failed'", why: "as above" },
  { file: "services/fleet-jobs.ts", has: "UPDATE fleet_job_targets SET state = $3", why: "one target's progress in a job whose start, cancel and finish are audited, as is every command it issues" },
  { file: "services/replacement-reapply.ts", has: "SET state = 'issued', command_id", why: "one step's progress in a re-apply whose finish is audited, as is every command it issues" },
  { file: "services/replacement-reapply.ts", has: "SET state = 'skipped'", why: "as above" },
  { file: "services/replacement-reapply.ts", has: "UPDATE replacement_reapply_steps SET state = $3", why: "as above" },
  { file: "services/rollouts.ts", has: "UPDATE rollout_targets SET state = 'offered'", why: "the upgrade offered to one cabinet of a rollout whose start, pause and stop are audited, and whose outcome per cabinet is (upgrade.outcome)" },
  { file: "auth/sessions.ts", has: "DELETE FROM sessions WHERE id_hash", why: "sign-out; its only caller (auth-routes.ts) audits it in the same transaction" },
  { file: "auth/sessions.ts", has: "DELETE FROM sessions WHERE user_id", why: "ends a user's sessions, or all but one of them; every caller (users.ts, cli.ts, auth-routes.ts) audits the change that ends them in the same transaction" },
  { file: "services/settings.ts", has: "DELETE FROM settings WHERE [key] = $1", why: "removeSetting (D117); every caller audits the change in the same transaction: device-settings, filefacts-allowlist, firewall-policy, time (twice) and watched-services in the function that calls it, approved-apps in the callers of writeApprovedLevel" },
  { file: "services/usb-sql.ts", has: "usbPolicyDeleteSql", why: "run only by usb-store.ts, which audits the policy change in the same transaction" },
  { file: "services/baseline-drift.ts", has: "DELETE d FROM cabinet_drift", why: "a derived table, recomputed from the baseline and the latest readings" },
  { file: "services/cabinet-health.ts", has: "DELETE FROM healthy_marks", why: "keeps the newest healthy marks within a cap; older marks are derived history" },
  { file: "services/config-ingest.ts", has: "DELETE FROM config_versions", why: "keeps the newest configuration versions (and any a healthy mark points at); readings, not decisions" },
  { file: "services/error-trends.ts", has: "DELETE FROM error_daily WHERE [day] =", why: "a derived day of counts, replaced by its recomputation in the same statement" },
  { file: "services/error-trends.ts", has: "DELETE FROM issue_daily WHERE [day] =", why: "as above" },
  { file: "db/db.ts", has: "DELETE TOP ($1) FROM notifications", why: "wake-up signals between server processes, of no use after an hour; the nightly run is audited as retention.run with the count" },
  { file: "services/cabinets.ts", has: "DELETE FROM health_samples", why: "raw samples folded into health_hourly in the same transaction by the retention run, its only caller; the run is audited as retention.run with the count" },
  { file: "services/maintenance.ts", has: "DELETE TOP ($1) FROM health_hourly", why: "retention through inBatches, which audits every batch that removed anything (retention.batch)" },
  { file: "services/ops-meter.ts", has: "DELETE FROM ops_counters", why: "operations counters past 90 days; the nightly run is audited as retention.run with the count" },
];

/**
 * A statement that changes a row's state or status, or deletes rows. It is matched across lines (SQL is written over several), from
 * UPDATE through its SET clause only (a state named after WHERE, FROM or OUTPUT is a condition, not a change), or DELETE … FROM.
 */
const SET_CLAUSE = "(?:(?!\\b(?:WHERE|FROM|OUTPUT)\\b)[^;`\"])*?";
const CHANGE = new RegExp(`\\bUPDATE\\s+\\w+(?:\\s+WITH\\s*\\([^)]*\\))?\\s+SET\\b${SET_CLAUSE}\\b(?:a\\.)?(?:state|status)\\s*=|\\bDELETE\\s+(?:TOP\\s*\\(\\$?\\w+\\)\\s+)?(?:\\w+\\s+)?FROM\\b`, "g");
/** Whether a statement, wherever it starts and however it is laid out, is one CHANGE matches. */
const changes = (sql: string): boolean => { CHANGE.lastIndex = 0; return CHANGE.test(sql); };
/** Where a top-level function starts: a declaration at the start of a line. */
const DECLARATION = /^(export )?(async )?function |^(export )?const \w+ = (async )?\(/;
const AUDITS = /\baudit(Many)?\(/;
/**
 * A change run through inBatches with its audit argument (`{ table: … }`): inBatches writes a retention.batch audit row for every batch that
 * changed anything, in the batch's own transaction (maintenance.ts). Owners' prunes are written this way (D71). The call and its argument
 * are looked for on the statement's line and the two after it; without the argument, the batches are not audited and the change is not.
 */
export const auditedByBatches = (text: string): boolean => /\binBatches\(/.test(text) && /\{\s*table\s*:/.test(text);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out); else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Every state change or delete in the source that is neither audited nor listed above, as "file:line text". */
function unaudited(): { found: string[]; listedButGone: string[] } {
  const found: string[] = [], seen = new Set<number>();
  for (const path of sources(SRC)) {
    const file = relative(SRC, path).split("\\").join("/");
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    const starts = lines.flatMap((l, i) => DECLARATION.test(l) ? [i] : []);
    CHANGE.lastIndex = 0;
    for (let m = CHANGE.exec(text); m !== null; m = CHANGE.exec(text)) {
      const i = text.slice(0, m.index).split("\n").length - 1;              // the line the statement starts on
      const end = text.slice(m.index).search(/[;`"]/);
      const statement = text.slice(text.lastIndexOf("\n", m.index) + 1, end === -1 ? undefined : m.index + end); // its line, through the end of the statement
      const listed = NOT_TRANSITIONS.findIndex(n => n.file === file && (lines[i]!.includes(n.has) || statement.includes(n.has)));
      if (listed >= 0) { seen.add(listed); continue; }
      if (statement.includes("CLOSED_OUTPUT") || lines.slice(i, i + 3).join(" ").includes("CLOSED_OUTPUT")) continue;
      if (auditedByBatches(lines.slice(i, i + 3).join(" "))) continue;
      const from = [...starts].reverse().find(s => s <= i) ?? 0, to = starts.find(s => s > i) ?? lines.length;
      if (!AUDITS.test(lines.slice(from, to).join("\n"))) found.push(`${file}:${i + 1} ${lines[i]!.trim().slice(0, 100)}`);
    }
  }
  return { found, listedButGone: NOT_TRANSITIONS.filter((_, i) => !seen.has(i)).map(n => `${n.file}: ${n.has}`) };
}

test("every state change and every delete in the server is audited, or listed with the reason it is not a transition", () => {
  const { found, listedButGone } = unaudited();
  assert.deepEqual(found, [], `state changes with no audit row:\n${found.join("\n")}`);
  assert.deepEqual(listedButGone, [], "a listed exception no longer exists in the code; take it off the list");
});

test("the sweep sees what it is meant to: an unaudited close or delete, laid out on one line or several, and nothing that only reads", () => {
  for (const sql of ["UPDATE alerts SET state = 'resolved' WHERE id = $1", "UPDATE a SET a.state = 'x' FROM alerts a", "UPDATE commands SET result = 1, status = 'expired'",
    "UPDATE alerts WITH (FORCESEEK) SET state = 'resolved'", "DELETE FROM sessions", "DELETE TOP ($1) FROM events WHERE x", "DELETE d FROM cabinet_drift d",
    // Written across lines, as SQL usually is (review of #176).
    "UPDATE alerts\n    SET state = 'resolved',\n        resolved_at = SYSUTCDATETIME()\n  WHERE id = 'x'",
    "UPDATE alerts SET resolved_at = SYSUTCDATETIME(),\n                  state = 'resolved'\n WHERE id = $1",
    "UPDATE a\n   SET a.status = 'removed'\n  FROM cabinets a",
    "DELETE\n  FROM sessions\n WHERE user_id = $1"])
    assert.ok(changes(sql), sql);
  for (const sql of ["SELECT state FROM alerts WHERE status = 'open'", "UPDATE alerts SET last_seen = SYSUTCDATETIME() WHERE state <> 'resolved'", "INSERT INTO alerts (state) VALUES ('open')",
    // A state or status after the SET clause is a condition, not a change, whatever the layout.
    "UPDATE alerts SET last_seen = SYSUTCDATETIME()\n WHERE state = 'open'", "UPDATE commands SET ack_at = @now\n  WHERE status = 'delivered'",
    "UPDATE alerts SET title = $2 OUTPUT inserted.state INTO @o WHERE id = $1"])
    assert.ok(!changes(sql), sql);
});

test("a change run through inBatches counts as audited only with the audit argument that makes inBatches log each batch", () => {
  assert.ok(auditedByBatches(`return inBatches(db, "DELETE TOP ($1) FROM sessions WHERE expires_at < $2", [cutoff], o, { table: "sessions", cutoff });`));
  assert.ok(auditedByBatches(`await inBatches(pool, "DELETE TOP ($1) FROM x WHERE y < $2", [c], o,\n    { table: "x", cutoff: c });`));
  assert.ok(!auditedByBatches(`return inBatches(db, "DELETE TOP ($1) FROM notifications WHERE [at] < $2", [], o);`), "no audit argument: the batches are not logged");
  assert.ok(!auditedByBatches(`await db.query("DELETE TOP ($1) FROM sessions", [n]); const o = { table: "sessions" };`), "an object named table is not a batch call");
});

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db.drop(); });

async function openAlerts(n: number): Promise<{ cabinet: string; ids: string[] }> {
  const client = randomUUID(), site = randomUUID(), cabinet = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `Sweep ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'K', 'standalone', 'active')", [cabinet, site]);
  const ids: string[] = [];
  for (let i = 0; i < n; i++)
    ids.push((await db.app.query<{ id: string }>(`DECLARE @o TABLE (id uniqueidentifier);
      INSERT INTO alerts (cabinet_id, severity, signature, title, first_seen, last_seen) OUTPUT inserted.id INTO @o
      VALUES ($1, 'minor', $2, 'T', SYSUTCDATETIME(), SYSUTCDATETIME()); SELECT id FROM @o;`, [cabinet, `sweep:${i}`])).rows[0]!.id.toLowerCase());
  return { cabinet, ids };
}
const auditsFor = async (ids: string[]) => (await db.app.query<{ target_id: string; actor_kind: string; actor_id: string; details: Record<string, unknown> }>(
  "SELECT target_id, actor_kind, actor_id, details FROM audit_log WHERE action = 'alert.resolve' AND target_id IN (SELECT value FROM OPENJSON($1))", [JSON.stringify(ids)])).rows;

test("an automatic close audits each alert it closed, in the same transaction, and nothing when nothing closed", async () => {
  const { cabinet, ids } = await openAlerts(3);
  const close = () => closeAutomatically(db.app, "sweep-test",
    `UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME(), resolution = 'Gone.' ${CLOSED_OUTPUT} WHERE cabinet_id = $1 AND state <> 'resolved'`, [cabinet]);
  assert.equal((await close()).length, 3);
  const rows = await auditsFor(ids);
  assert.deepEqual(rows.map(r => r.target_id).sort(), [...ids].sort());
  assert.ok(rows.every(r => r.actor_kind === "system" && r.actor_id === "sweep-test" && r.details.automatic === true && r.details.resolution === "Gone."
    && r.details.cabinetId === cabinet.toLowerCase()));
  assert.equal((await close()).length, 0, "closed already");
  assert.equal((await auditsFor(ids)).length, 3, "a run that closes nothing writes nothing");
});

test("a close that fails rolls its audit rows back with it, and a close without the OUTPUT clause is refused before it runs", async () => {
  const { cabinet, ids } = await openAlerts(1);
  await assert.rejects(db.app.transaction(async tx => {
    await closeAutomatically(tx, "sweep-test", `UPDATE alerts SET state = 'resolved', resolution = 'Gone.' ${CLOSED_OUTPUT} WHERE cabinet_id = $1`, [cabinet]);
    throw new Error("the caller's transaction fails");
  }));
  assert.equal((await auditsFor(ids)).length, 0);
  assert.equal((await db.app.query<{ state: string }>("SELECT state FROM alerts WHERE id = $1", [ids[0]])).rows[0]!.state, "open");
  await assert.rejects(closeAutomatically(db.app, "sweep-test", "UPDATE alerts SET state = 'resolved' WHERE cabinet_id = $1", [cabinet]), /CLOSED_OUTPUT/);
  assert.equal((await db.app.query<{ state: string }>("SELECT state FROM alerts WHERE id = $1", [ids[0]])).rows[0]!.state, "open");
});
