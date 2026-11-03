// storage.health as the console shows it (contracts: storage.health). Kept free of React so it is tested on its own.

export interface CriticalWarnings {
  spareBelowThreshold: boolean; temperatureOutOfRange: boolean; reliabilityDegraded: boolean; readOnly: boolean;
  volatileBackupFailed: boolean; persistentMemoryReadOnly: boolean;
}
export interface NvmeLog { criticalWarnings: CriticalWarnings; mediaErrors: number; percentageUsed: number; temperatureCelsius: number | null }

const WARNING_TEXT: [keyof CriticalWarnings, string][] = [
  ["readOnly", "The drive has made itself read-only"],
  ["reliabilityDegraded", "The drive reports its reliability is degraded"],
  ["spareBelowThreshold", "Spare blocks are below the drive's own threshold"],
  ["volatileBackupFailed", "The drive's power-loss backup has failed"],
  ["persistentMemoryReadOnly", "The drive's persistent memory is read-only"],
  ["temperatureOutOfRange", "The drive is outside its temperature limits"],
];

/** What the drive itself says is wrong, worst first, and how bad: any critical warning from the drive is "crit"; media errors alone "warn". */
export function nvmeVerdict(log: NvmeLog): { tone: "ok" | "warn" | "crit"; lines: string[] } {
  const lines = WARNING_TEXT.filter(([k]) => log.criticalWarnings[k] === true).map(([, t]) => t);
  const hard = lines.length > 0 && lines.some(l => !l.includes("temperature"));
  if (log.mediaErrors > 0) lines.push(`${log.mediaErrors.toLocaleString("en-US")} unrecovered data error${log.mediaErrors === 1 ? "" : "s"}`);
  return { tone: hard ? "crit" : lines.length > 0 ? "warn" : "ok", lines };
}

/** A volume's repair state in words; null when nothing is asked for. */
export function repairText(repair: string, dirty: boolean | null): string | null {
  const ask = repair === "full_repair_needed" ? "Needs a full repair (chkdsk /f)"
    : repair === "spot_fix_needed" ? "Needs a spot fix (chkdsk /spotfix)"
    : repair === "scan_needed" ? "Needs a scan (chkdsk /scan)" : null;
  if (dirty === true) return ask ? `${ask}; Windows will check it at the next start` : "Windows will check it at the next start";
  return ask;
}

/** Why a drive has no health log, in words. */
export function noLogText(problem: string | null): string {
  switch (problem) {
    case "not_nvme": return "Not an NVMe drive: see Drive health above";
    case "not_supported": return "Its driver does not pass the health query on";
    case "unreadable": return "The drive's answer could not be read";
    default: return "Not read";
  }
}
