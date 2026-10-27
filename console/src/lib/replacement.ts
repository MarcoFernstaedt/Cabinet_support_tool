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
    " Its own settings (scanner IDs, watched services, file paths, approved programs, USB watch and baseline) are copied to the new cabinet.";
}
