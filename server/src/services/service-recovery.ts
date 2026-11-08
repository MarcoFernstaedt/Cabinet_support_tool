// A service set to restart the computer when it fails (F14.R3, decision-log D43). services.list reads each service's recovery actions
// (first, second and later failures); a "reboot" in any of them means one failing service can restart the whole cabinet, and each restart
// then looks like a crash. When a reading lists any, one minor alert names them; when a later reading lists none, the alert is closed
// automatically and the close is audited (F4). The reading is the cabinet's own answer to services.list, checked against its schema
// before this runs (commands.ts storeResult).
import type { Queryable } from "../db/db.js";
import { upsertAlert } from "./alerts.js";
import { closeAutomatically, CLOSED_OUTPUT } from "./automatic-close.js";
import { ISSUE } from "./rules.js";

type Action = "none" | "restart" | "reboot" | "run_program";
export interface ServiceWithRecovery { name: string; displayName?: string | null; recovery?: { firstFailure: Action; secondFailure: Action; subsequentFailures: Action } | null }

export const REBOOT_SIGNATURE = "service-reboot-recovery";
const CLEARED = "No service is set to restart the computer any more (seen in the cabinet's service list).";

/** The services whose recovery restarts the computer, by name, sorted. */
export function rebootingServices(services: readonly ServiceWithRecovery[]): string[] {
  return services.filter(s => s.recovery && [s.recovery.firstFailure, s.recovery.secondFailure, s.recovery.subsequentFailures].includes("reboot"))
    .map(s => s.name).sort((a, b) => a.localeCompare(b));
}

/** The alert's title: up to five names, then how many more. */
export function rebootTitle(names: readonly string[]): string {
  const shown = names.slice(0, 5).join(", ");
  return `Set to restart the computer if it fails: ${shown}${names.length > 5 ? ` and ${names.length - 5} more` : ""}`;
}

/** Opens, updates or closes the cabinet's alert from one services.list reading, in the caller's transaction. */
export async function checkServiceRecovery(db: Queryable, cabinetId: string, services: readonly ServiceWithRecovery[]): Promise<"opened" | "closed" | "none"> {
  const names = rebootingServices(services);
  if (names.length > 0) {
    const title = rebootTitle(names);
    const { id } = await upsertAlert(db, { cabinetId, issueTypeId: ISSUE.serviceRebootRecovery, severity: "minor", signature: REBOOT_SIGNATURE, title,
      seenAt: new Date(), ruleId: null, eventId: null });
    // The fold keeps an open alert's first title; this one names the services, so it follows the latest reading.
    await db.query("UPDATE alerts SET title = $2 WHERE id = $1 AND title <> $2", [id, title]);
    return "opened";
  }
  const closed = await closeAutomatically(db, "service-recovery",
    `UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME(), resolution = $2 ${CLOSED_OUTPUT}
      WHERE cabinet_id = $1 AND signature = $3 AND state <> 'resolved'`, [cabinetId, CLEARED, REBOOT_SIGNATURE]);
  return closed.length > 0 ? "closed" : "none";
}
