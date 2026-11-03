// boot.history as the console says it (contracts: boot.history). Kept free of React so it is tested on its own.

export interface BootRecord {
  startedAt: string; previous: "clean" | "requested" | "unexpected" | "unknown"; previousEndedAt: string | null;
  uptimeBeforeSeconds: number | null; reason: string | null; cause: "bug_check" | "forced_off" | "power_loss_or_hang" | null;
}

const CAUSE: Record<string, string> = { bug_check: "a blue screen", forced_off: "the power button was held", power_loss_or_hang: "power lost, or Windows froze" };

/** How the run before a start ended, in words; a value the console does not know is said plainly rather than hidden. */
export function endText(b: Pick<BootRecord, "previous" | "cause" | "reason">): string {
  switch (b.previous) {
    case "clean": return "Shut down normally";
    case "requested": return b.reason ? `Restart requested: ${b.reason}` : "Restart requested";
    case "unexpected": return `Did not shut down: ${b.cause ? CAUSE[b.cause] ?? b.cause : "cause not known"}`;
    case "unknown": return "Not in the log";
    default: return String(b.previous);
  }
}

/** How long a run lasted: days and hours, hours and minutes, or minutes; a dash when the log does not say. */
export function durationText(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const m = Math.floor(seconds / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d} d ${h % 24} h`;
  if (h > 0) return `${h} h ${m % 60} min`;
  return `${m} min`;
}
