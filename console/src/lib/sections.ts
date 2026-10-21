// The tabs of a cabinet, in the order they are shown. The welcome tour is tested against this list, so a new tab cannot be left out of it.
export const SECTIONS = [
  ["overview", "Overview"], ["standards", "Standards"], ["troubleshoot", "Troubleshoot"], ["changes", "What changed"], ["compare", "Compare"], ["baseline", "Baseline"], ["alerts", "Alerts"],
  ["events", "Event logs"], ["services", "Services"], ["processes", "Processes"], ["files", "Files"], ["devices", "Devices and drivers"], ["drives", "Drive health"], ["updates", "Windows updates"], ["time", "Time"],
  ["network", "Network"], ["firewall", "Firewall"], ["scanner", "Fingerprint scanner"], ["crashes", "Crashes and restarts"],
  ["windows", "Windows"], ["software", "Software"], ["history", "Command history"],
] as const;
export type SectionId = (typeof SECTIONS)[number][0];

/** How the tabs are grouped in the cabinet's side menu. A tab that is in no group is listed under "More", so a new tab is never lost. */
export const SECTION_GROUPS: { title: string | null; ids: readonly string[] }[] = [
  { title: null, ids: ["overview", "troubleshoot", "alerts", "changes", "compare", "baseline", "standards"] },
  { title: "Windows", ids: ["events", "services", "processes", "updates", "time", "windows", "software", "files"] },
  { title: "Hardware", ids: ["devices", "drives", "scanner"] },
  { title: "Network", ids: ["network", "firewall"] },
  { title: "Record", ids: ["crashes", "history"] },
];
export function groupedSections(): { title: string | null; items: (readonly [string, string])[] }[] {
  const placed = new Set(SECTION_GROUPS.flatMap(g => g.ids));
  const byId = new Map<string, readonly [string, string]>(SECTIONS.map(s => [s[0], s]));
  const groups = SECTION_GROUPS.map(g => ({ title: g.title, items: g.ids.map(i => byId.get(i)).filter((x): x is readonly [string, string] => !!x) }));
  const rest = SECTIONS.filter(s => !placed.has(s[0]));
  if (rest.length) groups.push({ title: "More", items: rest });
  return groups.filter(g => g.items.length);
}
