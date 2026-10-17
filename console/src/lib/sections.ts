// The tabs of a cabinet, in the order they are shown. The welcome tour is tested against this list, so a new tab cannot be left out of it.
export const SECTIONS = [
  ["overview", "Overview"], ["standards", "Standards"], ["troubleshoot", "Troubleshoot"], ["changes", "What changed"], ["compare", "Compare"], ["alerts", "Alerts"],
  ["events", "Event logs"], ["services", "Services"], ["processes", "Processes"], ["files", "Files"], ["devices", "Devices and drivers"], ["drives", "Drive health"], ["updates", "Windows updates"], ["time", "Time"],
  ["network", "Network"], ["firewall", "Firewall"], ["scanner", "Fingerprint scanner"], ["crashes", "Crashes and restarts"],
  ["windows", "Windows"], ["software", "Software"], ["history", "Command history"],
] as const;
export type SectionId = (typeof SECTIONS)[number][0];
