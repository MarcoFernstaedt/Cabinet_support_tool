// crash.list as the console shows it (contracts: crash.list). Kept free of React so it is tested on its own.

export interface Minidump { name: string; writtenAt: string; sizeBytes: number; stopCode: number | null; parameters: string[] | null; problem: "not_a_dump" | "too_short" | "unreadable" | null }

/** A stop code as Windows writes it: 0x and eight hex digits; why it is missing when it is. */
export function stopCodeText(d: Pick<Minidump, "stopCode" | "problem">): string {
  if (typeof d.stopCode === "number" && Number.isInteger(d.stopCode) && d.stopCode >= 0 && d.stopCode <= 0xffffffff)
    return `0x${d.stopCode.toString(16).toUpperCase().padStart(8, "0")}`;
  switch (d.problem) {
    case "not_a_dump": return "Not a crash dump";
    case "too_short": return "File too short to read";
    case "unreadable": return "Windows would not open it";
    default: return "Not read";
  }
}

/** A file size in KB, MB or GB, one decimal above 1 MB; a dash for nonsense. */
export function sizeText(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
