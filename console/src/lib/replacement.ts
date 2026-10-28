// Replacing a cabinet in its approval (docs/spec/05-server-spec.md "Replacing a cabinet"): when a drive fails and the agent is installed
// again, the approver says which cabinet the new one replaces. Only an active cabinet of the same site and role can be replaced; this list
// is a convenience, and the server checks it all again.

/** A cabinet of the approval's site, as the site page lists it. */
export interface SiteCabinet { id: string; name: string; role: string; status: string; online: boolean; lastHeartbeatAt: string | null }

/** The cabinets the new one may replace: active, of the chosen role; the ones not heard from first, since a failed drive stops reporting. */
export function replaceable(cabinets: readonly SiteCabinet[], role: string): SiteCabinet[] {
  return cabinets.filter(c => c.status === "active" && c.role === role)
    .sort((a, b) => Number(a.online) - Number(b.online) || a.name.localeCompare(b.name));
}

/** The approval's replacesCabinetId: sent only when the chosen cabinet is still one it may replace (a role change drops it). */
export function replacesFrom(chosen: string, candidates: readonly SiteCabinet[]): { replacesCabinetId: string } | Record<string, never> {
  return chosen && candidates.some(c => c.id === chosen) ? { replacesCabinetId: chosen } : {};
}

/** What the approval does to the cabinet it replaces, said in the confirmation. */
export function replacementSentence(old: SiteCabinet, newName: string): string {
  const name = newName.trim();
  const rename = name.toLowerCase() === old.name.toLowerCase() ? ` It takes the name ${old.name}; the old record is renamed "${old.name} (replaced <date>)".` : "";
  const sync = old.role === "sync" ? " Its satellites move to the new cabinet." : old.role === "satellite" ? " It keeps the sync cabinet the old one reached." : "";
  return `It replaces ${old.name}: the old cabinet is retired with its history kept, its certificate revoked and its open alerts resolved.${rename}${sync}` +
    " Its own settings (scanner IDs, watched services, file paths, approved programs, USB watch and baseline) are copied to the new cabinet." +
    " Once the new cabinet reports, its firewall policy, time zone, drawer address and any fixed network settings are put back on it in your name, each one verified.";
}

// ---- What a replacement put back on the machine (05-server-spec.md "Replacing a cabinet") ----------------------------------------------

export interface ReapplyStep { kind: "firewall" | "time_zone" | "drawer" | "dns" | "address"; operation: string; params: Record<string, unknown> | null; state: string; detail: string | null; updatedAt: string }
export interface Reapply { state: "waiting" | "running" | "done" | "stopped"; detail: string | null; queuedAt: string; finishedAt: string | null; steps: ReapplyStep[] }

const KIND: Record<ReapplyStep["kind"], string> = { firewall: "Firewall policy", time_zone: "Time zone", drawer: "Drawer address", dns: "DNS servers", address: "Network address" };
export const stepLabel = (s: ReapplyStep) => KIND[s.kind] ?? s.kind;

const onOff = (v: unknown) => (v ? "on" : "off");
/** The value a step puts on the machine, in words; null for a step with nothing to send. */
export function stepValue(s: ReapplyStep): string | null {
  const p = s.params;
  if (!p) return null;
  if (s.kind === "firewall") { const f = p.profiles as Record<string, unknown>; return `Domain ${onOff(f.domain)}, Private ${onOff(f.private)}, Public ${onOff(f.public)}`; }
  if (s.kind === "time_zone") return String(p.timeZoneId);
  if (s.kind === "dns") return (p.servers as string[]).join(", ");
  return `${String(p.address)}/${String(p.prefixLength)}${p.gateway ? `, gateway ${String(p.gateway)}` : ", no gateway"}`;
}

export const STEP_STATE: Record<string, [string, "ok" | "warn" | "crit" | "info" | "off"]> = {
  pending: ["Waiting", "off"], issued: ["Sent", "info"], verified: ["Done, verified", "ok"], not_verified: ["Not verified", "warn"], failed: ["Failed", "crit"], skipped: ["Not needed", "off"],
};

/** The re-apply as a whole, in one sentence. */
export function reapplySummary(r: Reapply, oldName: string): string {
  if (r.state === "waiting") return `Waiting for this cabinet to report: then ${oldName}'s firewall policy, time zone, drawer address and fixed network settings are put back.`;
  if (r.state === "running") return `Putting back ${oldName}'s settings, one at a time.`;
  return r.detail ?? (r.state === "done" ? "Finished." : "Stopped.");
}
