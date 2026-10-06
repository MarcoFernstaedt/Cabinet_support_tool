// Agent-originated events. Stored now; symptom rules and alerts arrive in milestone 4.
import type pg from "pg";
import type { EventBatch } from "../contracts.js";
import { safeJson, transaction } from "../db/db.js";

/** Stores a batch; a repeated eventId is ignored, so agent retries never duplicate. */
export async function storeEvents(pool: pg.Pool, cabinetId: string, batch: EventBatch): Promise<number> {
  return transaction(pool, async c => {
    let stored = 0;
    for (const e of batch.events) {
      const r = await c.query(
        `INSERT INTO events (event_id, cabinet_id, kind, occurred_at, source, command_id, severity_hint, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (event_id) DO NOTHING`,
        [e.eventId, cabinetId, e.kind, e.occurredAt, e.source ? safeJson(e.source) : null, e.commandId ?? null, e.severityHint ?? null, e.detail ? safeJson(e.detail) : null]);
      stored += r.rowCount ?? 0;
    }
    return stored;
  });
}
