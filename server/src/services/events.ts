// Agent-originated events: stored, then run through the alerts engine in the same transaction,
// so an event is never stored without its alert or alerted without being stored.
import { raiseSecurityAlert } from "./security.js";
import type pg from "pg";
import type { Event, EventBatch } from "../contracts.js";
import { safeJson, transaction } from "../db/db.js";
import { processEvents, type Outcome } from "./alerts.js";

/** Stores a batch; a repeated eventId is ignored, so agent retries never duplicate or count twice. */
/** Which checks in an agent's security event raise which security alert (a safety-net rollback is reported, but is not one of them). */
const AGENT_SECURITY: Record<string, "agent_self_check" | "package_refused" | "signature_failure"> = {
  self_check: "agent_self_check", package_refused: "package_refused", hash_mismatch: "package_refused", publisher_not_trusted: "package_refused",
  signature_invalid: "signature_failure", signature: "signature_failure",
};
const AGENT_SECURITY_TITLE = {
  agent_self_check: "A cabinet agent failed its self-check", package_refused: "A cabinet refused a package", signature_failure: "A cabinet reported a signature failure",
} as const;

export async function storeEvents(pool: pg.Pool, cabinetId: string, batch: EventBatch): Promise<{ stored: number; outcomes: Outcome[] }> {
  return transaction(pool, async c => {
    const fresh: Event[] = [];
    for (const original of batch.events) {
      let e = original;
      // A firewall change claims a platform command: it must be a firewall write this cabinet was sent; otherwise it is unexplained.
      if (e.kind === "firewall_changed" && e.commandId) {
        const ok = (await c.query("SELECT 1 FROM commands WHERE id = $1 AND cabinet_id = $2 AND operation IN ('firewall.setProfile', 'firewall.setRule', 'firewall.restore')",
          [e.commandId, cabinetId])).rows[0];
        if (!ok) { const { commandId: _ignored, ...rest } = e; e = rest; }
      }
      const r = await c.query(
        `INSERT INTO events (event_id, cabinet_id, kind, occurred_at, source, command_id, severity_hint, detail, device)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (event_id) DO NOTHING`,
        [e.eventId, cabinetId, e.kind, e.occurredAt, e.source ? safeJson(e.source) : null, e.commandId ?? null, e.severityHint ?? null,
         e.detail ? safeJson(e.detail) : null, e.device ? safeJson(e.device) : null]);
      if (r.rowCount === 1) {
        fresh.push(e);
        // An agent's own security report: a failed self-check, a refused package or a signature failure goes to Admins.
        const check = e.kind === "security" ? e.detail?.fields?.check : undefined;
        const kind = check ? AGENT_SECURITY[check] : undefined;
        if (kind)
          await raiseSecurityAlert(c, { kind, signature: `${kind}|${cabinetId}`, cabinetId, title: AGENT_SECURITY_TITLE[kind],
            detail: { eventId: e.eventId, check, message: e.detail?.message ?? null, fields: e.detail?.fields ?? {} } });
        if (e.kind === "firewall_changed") {
          // The write's own result already recorded the change; the agent's event confirms it. Later events for the
          // same command (a profile's timer turning it back on, a safety-net rollback) are further changes.
          const linked = e.commandId ? await c.query("UPDATE firewall_changes SET event_id = $2 WHERE id = (SELECT id FROM firewall_changes WHERE command_id = $1 AND event_id IS NULL LIMIT 1)",
            [e.commandId, e.eventId]) : null;
          if (!linked || linked.rowCount === 0)
            await c.query(`INSERT INTO firewall_changes (cabinet_id, command_id, event_id, explained, detail, occurred_at) VALUES ($1, $2, $3, $4, $5, $6)`,
              [cabinetId, e.commandId ?? null, e.eventId, !!e.commandId, e.detail ? safeJson(e.detail) : null, e.occurredAt]);
        }
      }
    }
    const outcomes = await processEvents(c, cabinetId, fresh);
    return { stored: fresh.length, outcomes };
  });
}
