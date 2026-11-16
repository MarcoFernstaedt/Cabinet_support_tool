import Fastify from "fastify";
import { registerSessionFrameRoute } from "../src/agent-api/session-frame-route.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { grantPermission, revokePermission, requireCabinetPermission } from "../src/services/user-permissions.js";
import { openSession } from "../src/services/session-opening.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import { paramsHash } from "../src/auth/canonical.js";
import { boundTo } from "../src/auth/stepup.js";
import { SessionRelay } from "../src/agent-api/session-relay.js";
import { SessionLifecycle } from "../src/services/session-lifecycle.js";

let db: TestDatabase;
const admin = randomUUID(), user = randomUUID(), cabinet = randomUUID(), otherCabinet = randomUUID(), site = randomUUID(), otherSite = randomUUID();
test.before(async () => {
  db = await createTestDatabase();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'grants-admin', 'Admin', 'admin'), ($2, 'grants-user', 'User', 'tier1')", [admin, user]);
  const client = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Grants client')", [client]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $3, 'One'), ($2, $3, 'Two')", [site, otherSite, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $3, 'One', 'standalone', 'active'), ($2, $4, 'Two', 'standalone', 'active')", [cabinet, otherCabinet, site, otherSite]);
});
test.after(async () => { await db?.drop(); });
const grant = (kind: string, scope: string | null) => db.app.transaction(tx => grantPermission(tx, admin, user, "session.open", kind, scope));
test("real grants match only their scopes, revoke durably, reject duplicates and deny deletion", async () => {
  await assert.rejects(requireCabinetPermission(db.app, admin, cabinet, "session.open"), /matching permission/);
  for (const [kind, scope] of [["site", otherSite], ["cabinet", otherCabinet]] as const) {
    const id = await grant(kind, scope);
    await assert.rejects(requireCabinetPermission(db.app, user, cabinet, "session.open"), /matching permission/);
    await requireCabinetPermission(db.app, user, otherCabinet, "session.open");
    await db.app.transaction(tx => revokePermission(tx, admin, id));
  }
  for (const [kind, scope] of [["fleet", null], ["site", site], ["cabinet", cabinet]] as const) {
    const id = await grant(kind, scope);
    await requireCabinetPermission(db.app, user, cabinet, "session.open");
    await assert.rejects(grant(kind, scope));
    await assert.rejects(db.app.query("DELETE FROM user_permissions WHERE id = $1", [id]));
    assert.equal(await db.app.transaction(tx => revokePermission(tx, admin, id)), true);
    assert.equal(await db.app.transaction(tx => revokePermission(tx, admin, id)), false);
    await assert.rejects(requireCabinetPermission(db.app, user, cabinet, "session.open"), /matching permission/);
    const actions = (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE JSON_VALUE(details, '$.permissionId') = $1 ORDER BY seq", [id])).rows;
    assert.deepEqual(actions.map(x => x.action), ["permission.grant", "permission.revoke"]);
  }
  for (const [kind, scope] of [["fleet", cabinet], ["site", null], ["rank", null]] as const)
    await assert.rejects(db.app.query("INSERT INTO user_permissions (id, user_id, permission, scope_kind, scope_id, granted_by) VALUES ($1, $2, 'session.open', $3, $4, $5)", [randomUUID(), user, kind, scope, admin]));
});
test("real session opening requires grant and bound step-up, commits command and audit, and refuses a second live session", async () => {
  const input = { kind: "diagnostic" as const, reason: "Find the failure", stepUpToken: "missing" };
  await assert.rejects(openSession(db.app, admin, cabinet, input), /matching permission/);
  const id = await grant("cabinet", cabinet);
  await assert.rejects(openSession(db.app, user, cabinet, input), /valid step-up/);
  const token = await issueStepUpToken(db.app, user, "session.open", cabinet, paramsHash({ kind: input.kind, reason: input.reason }));
  const opened = await openSession(db.app, user, cabinet, { ...input, stepUpToken: boundTo(token, input) });
  const commands = (await db.app.query<{ params: { sessionId: string; kind: string } }>("SELECT params FROM commands WHERE operation = 'session.open' AND cabinet_id = $1", [cabinet])).rows;
  assert.deepEqual(commands.map(c => c.params), [{ sessionId: opened.sessionId, kind: "diagnostic" }]);
  const token2 = await issueStepUpToken(db.app, user, "session.open", cabinet);
  await assert.rejects(openSession(db.app, user, cabinet, { ...input, stepUpToken: token2 }), /already live/);
  let lifecycle: SessionLifecycle;
  const relay = new SessionRelay((c, s, active) => lifecycle.authorize(c, s, active));
  lifecycle = new SessionLifecycle(db.app, (c, s) => relay.close(c, s));
  const app = Fastify();
  app.addHook("onRequest", async request => { request.cabinet = { id: cabinet } as NonNullable<typeof request.cabinet>; });
  registerSessionFrameRoute(app, relay, () => 57);
  try {
    const send = () => app.inject({ method: "POST", url: `/agent/v1/sessions/${opened.sessionId}/frames`, payload: { data: Buffer.from("private diagnostic output").toString("base64") } });
    await db.app.query("UPDATE remote_sessions SET opened_at = DATEADD(second, -1, SYSUTCDATETIME()), last_seen_at = DATEADD(second, -1, SYSUTCDATETIME()) WHERE id = $1", [opened.sessionId]);
    const before = (await db.app.query<{ last_seen_at: Date }>("SELECT last_seen_at FROM remote_sessions WHERE id = $1", [opened.sessionId])).rows[0]!.last_seen_at;
    assert.equal((await send()).statusCode, 200);
    const after = (await db.app.query<{ last_seen_at: Date }>("SELECT last_seen_at FROM remote_sessions WHERE id = $1", [opened.sessionId])).rows[0]!.last_seen_at;
    assert.ok(after > before);
    await db.app.transaction(tx => revokePermission(tx, admin, id));
    assert.equal((await send()).statusCode, 404);
    assert.equal(await relay.exchange(cabinet, opened.sessionId, "console", Buffer.alloc(0)), null);
  } finally { await app.close(); }
  const closed = (await db.app.query<{ close_reason: string }>("SELECT close_reason FROM remote_sessions WHERE id = $1", [opened.sessionId])).rows[0];
  assert.equal(closed!.close_reason, "Opening operator permission revoked");
});

test("real admission serializes same-cabinet races and releases the cabinet immediately on operator end", async () => {
  const permission = await grant("fleet", null);
  const input = { kind: "diagnostic" as const, reason: "Race admission", stepUpToken: "" };
  const tokens = await Promise.all([1, 2].map(() => issueStepUpToken(db.app, user, "session.open", cabinet)));
  const outcomes = await Promise.allSettled(tokens.map(stepUpToken => openSession(db.app, user, cabinet, { ...input, stepUpToken })));
  assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(o => o.status === "rejected").length, 1);
  const session = outcomes.find(o => o.status === "fulfilled")!.value.sessionId;
  const lifecycle = new SessionLifecycle(db.app, () => {});
  await lifecycle.endByOperator(session, user, "explicit", "Finished");
  const reopened = await openSession(db.app, user, cabinet, { ...input, stepUpToken: await issueStepUpToken(db.app, user, "session.open", cabinet) });
  await lifecycle.endByOperator(reopened.sessionId, user, "explicit", "Finished again");
  await db.app.transaction(tx => revokePermission(tx, admin, permission));
});

test("the real fleet cap is eight and ending one session immediately releases admission", async () => {
  const permission = await grant("fleet", null);
  const cabinets = Array.from({ length: 9 }, () => randomUUID());
  const lifecycle = new SessionLifecycle(db.app, () => {});
  const live: string[] = [];
  const open = async (cabinetId: string) => openSession(db.app, user, cabinetId, { kind: "diagnostic", reason: "Fleet capacity check",
    stepUpToken: await issueStepUpToken(db.app, user, "session.open", cabinetId) });
  try {
    for (const [n, cabinetId] of cabinets.entries())
      await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, $3, 'standalone', 'active')", [cabinetId, site, `Fleet ${n}`]);
    for (const cabinetId of cabinets.slice(0, 7)) live.push((await open(cabinetId)).sessionId);
    const contenders = await Promise.allSettled(cabinets.slice(7).map(open));
    assert.equal(contenders.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(contenders.filter(r => r.status === "rejected").length, 1);
    live.push(contenders.find(r => r.status === "fulfilled")!.value.sessionId);
    const refusedIndex = contenders.findIndex(r => r.status === "rejected");
    await assert.rejects(open(cabinets[7 + refusedIndex]!), /fleet limit/);
    await lifecycle.endByOperator(live.shift()!, user, "explicit", "Make space");
    live.push((await open(cabinets[7 + refusedIndex]!)).sessionId);
  } finally {
    for (const id of live) await lifecycle.endByOperator(id, user, "explicit", "Capacity test complete");
    await db.app.transaction(tx => revokePermission(tx, admin, permission));
  }
});
