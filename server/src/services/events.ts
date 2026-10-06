// Agent-originated events: stored, then run through the alerts engine in the same transaction,
// so an event is never stored without its alert or alerted without being stored.
import type pg from "pg";
import type { Event, EventBatch } from "../contracts.js";
import { safeJson, transaction } from "../db/db.js";
import { processEvents, type Outcome } from "./alerts.js";

/** Stores a batch; a repeated eventId is ignored, so agent retries never duplicate or count twice. */
export async function storeEvents(pool: pg.Pool, cabinetId: string, batch: EventBatch): Promise<{ stored: number; outcomes: Outcome[] }> {
  return transaction(pool, async c => {
    const fresh: Event[] = [];
    for (const e of batch.events) {
      const r = await c.query(
        `INSERT INTO events (event_id, cabinet_id, kind, occurred_at, source, command_id, severity_hint, detail, device)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (event_id) DO NOTHING`,
        [e.eventId, cabinetId, e.kind, e.occurredAt, e.source ? safeJson(e.source) : null, e.commandId ?? null, e.severityHint ?? null,
         e.detail ? safeJson(e.detail) : null, e.device ? safeJson(e.device) : null]);
      if (r.rowCount === 1) fresh.push(e);
    }
    const outcomes = await processEvents(c, cabinetId, fresh);
    return { stored: fresh.length, outcomes };
  });
}
