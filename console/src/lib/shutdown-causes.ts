// Why a cabinet restarted without shutting down cleanly, in words (server: classifyShutdowns in crashes.ts). Kept free of React.

export interface ShutdownCauses { bugCheck: number; forcedOff: number; powerLossOrHang: number }

/** One line splitting the unexpected restarts by cause, skipping causes with none; null when there were none at all. */
export function causesLine(c: ShutdownCauses | null | undefined): string | null {
  if (!c) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
  const parts = [
    [n(c.bugCheck), "after a blue screen"],
    [n(c.forcedOff), "the power button was held"],
    [n(c.powerLossOrHang), "power lost or Windows froze"],
  ].filter(([k]) => (k as number) > 0).map(([k, t]) => `${k} ${t}`);
  return parts.length ? parts.join(" · ") : null;
}
