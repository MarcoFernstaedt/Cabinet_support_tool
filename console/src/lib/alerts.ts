// Alerts as the console shows them. The server decides who may claim, resolve or map.
import { api, ApiError, describeError } from "./api";

export interface Person { id: string; name: string }
export interface Alert {
  id: string; scope: "fleet" | "cabinet"; cabinet: { id: string; name: string }; site: { id: string; name: string }; client: { id: string; name: string };
  issueTypeId: string | null; unrecognized: boolean; severity: "major" | "minor"; title: string; state: "open" | "claimed" | "resolved";
  occurrences: number; firstSeen: string; lastSeen: string; sitePattern: boolean; ruleId: string | null; lastEventId: string | null;
  claimedBy: Person | null; claimedAt: string | null; resolvedBy: Person | null; resolvedAt: string | null; resolution: string | null;
  resolutionCause?: string | null; resolutionFix?: string | null;
}
export interface IssueType { id: string; name: string; severity: "major" | "minor"; description: string; builtIn: boolean; openAlerts: number; liveRules: number }

export type Match = { kind?: string; log?: string; source?: string; eventId?: number; level?: string; hardwareId?: string; phrase?: string };

export interface StoredEvent {
  eventId: string; cabinetId: string; kind: string; occurredAt: string; receivedAt: string;
  source: { log: string; source: string; eventId: number; level: string; recordId: number; hardwareId?: string; deviceInstanceId?: string } | null;
  detail: { message?: string; fields?: Record<string, string> } | null;
  device: { hardwareIds: string[]; deviceInstanceId?: string; name?: string; state: string; problemCode?: number } | null;
  severityHint: string | null; alertId: string | null; ruleId: string | null; issueName: string | null;
  elsewhere?: { otherCabinets: number; events: number; issueName: string | null; days: number } | null;
}

/** Claims an alert. Returns the alert, or who already has it. */
export async function claim(alertId: string): Promise<{ alert?: Alert; takenBy?: Person; problem?: string }> {
  try { return { alert: await api<Alert>("POST", `/api/alerts/${alertId}/claim`) }; }
  catch (e) {
    if (e instanceof ApiError && e.code === "already_claimed") return { takenBy: e.data.claimedBy as Person };
    return { problem: describeError(e) };
  }
}

export const KIND_LABEL: Record<string, string> = {
  error: "Event log error", scanner: "Fingerprint scanner", smart_warning: "Drive health", firewall_changed: "Firewall change", agent_status: "Agent", security: "Security",
};

/** A match in plain words, for lists and the history. */
export function describeMatch(m: Match): string {
  const parts: string[] = [];
  if (m.kind) parts.push(KIND_LABEL[m.kind] ?? m.kind);
  if (m.log) parts.push(`log ${m.log}`);
  if (m.source) parts.push(`source ${m.source}`);
  if (m.eventId !== undefined) parts.push(`event ID ${m.eventId}`);
  if (m.level) parts.push(`level ${m.level}`);
  if (m.hardwareId) parts.push(`hardware ${m.hardwareId}`);
  if (m.phrase) parts.push(`message contains "${m.phrase}"`);
  return parts.join(" · ");
}
