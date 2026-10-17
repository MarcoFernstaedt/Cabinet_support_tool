import test from "node:test";
import { randomUUID } from "node:crypto";
import { disableDemo, enableDemo } from "../src/demo/demo.js";
import { reviewKnownFix, saveKnownFix } from "../src/services/known-fixes.js";
import { createTestDatabase } from "./database.js";
// Turning demo mode off or resetting it after the guided demo has been used: fixes, resolved alerts and site checks point at the simulated fleet.
test("a used demo resets cleanly", async () => {
  const db = await createTestDatabase();
  try {
    const admin = randomUUID();
    await db.app.query(`INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, 'ada', 'Ada', 'admin', 'x')`, [admin]);
    await enableDemo(db.app, admin);
    const fix = (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM known_fixes")).rows[0]!.id;
    await reviewKnownFix(db.app, admin, fix, "approved");
    const cab = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE name = 'Operating Room'")).rows[0]!.id;
    await saveKnownFix(db.app, { userId: admin, canApproveFixes: true }, { title: "t", solution: "s", symptom: { kind: "finding", key: "obs-ping-loss" }, cabinetId: cab });
    const alert = (await db.app.query<{ id: string }>("SELECT TOP (1) a.id FROM alerts a JOIN cabinets k ON k.id=a.cabinet_id WHERE k.name='Reception'")).rows[0]!.id;
    await saveKnownFix(db.app, { userId: admin, canApproveFixes: true }, { title: "t2", solution: "s2", symptom: { kind: "finding", key: "obs-arp" }, cabinetId: cab, alertId: alert });
    await db.app.query("UPDATE alerts SET state='resolved', resolved_by=$1, resolved_at=SYSUTCDATETIME(), resolution='x' WHERE id=$2", [admin, alert]);
    const site = (await db.app.query<{ id: string }>("SELECT id FROM sites WHERE name = 'Midtown Manhattan'")).rows[0]!.id;
    await db.app.query("INSERT INTO diagnosis_batches (id, created_by, label, site_id, total, cabinet_ids) VALUES ($1, $2, 'Midtown Manhattan: 9 cabinets', $3, 9, $4)", [randomUUID(), admin, site, [cab]]);
    try { await disableDemo(db.app, admin); await enableDemo(db.app, admin); } catch (e) { console.log("RESET FAILED:", (e as Error).message); throw e; }

  } finally { await db.drop(); }
});
