// Processor, memory, each drive and each physical disk, from system.performance. Used above the process list.
import type { SystemPerformanceOutput } from "@mashura/cabinet-contracts/types";
import { bytes } from "../lib/time";

const pct = (v: number) => `${Math.round(v)}%`;

function Meter({ label, value, detail, warnAt = 85 }: { label: string; value: number; detail: string; warnAt?: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="meter" role="group" aria-label={label}>
      <div className="row gap"><strong>{label}</strong><span className="muted small">{detail}</span></div>
      <div aria-hidden="true" style={{ background: "var(--line, #243044)", height: ".5rem", borderRadius: 2 }}>
        <div style={{ width: `${v}%`, height: "100%", borderRadius: 2, background: v >= warnAt ? "var(--warn, #d97706)" : "var(--accent, #22d3ee)" }} />
      </div>
    </div>
  );
}

export function PerformanceStrip({ p }: { p: SystemPerformanceOutput }) {
  const memUsed = p.memory.totalBytes > 0 ? 100 * (1 - p.memory.availableBytes / p.memory.totalBytes) : 0;
  return (
    <div className="cards perf">
      <Meter label="Processor" value={p.cpu.usedPercent} detail={`${pct(p.cpu.usedPercent)} · ${p.cpu.logicalProcessors} logical${p.cpu.queueLength !== null ? ` · queue ${p.cpu.queueLength}` : ""}`} />
      <Meter label="Memory" value={memUsed} detail={`${bytes(p.memory.totalBytes - p.memory.availableBytes)} of ${bytes(p.memory.totalBytes)}${p.memory.pagesPerSecond !== null ? ` · ${p.memory.pagesPerSecond} pages/s` : ""}`} />
      {p.volumes.map(v => <Meter key={v.drive} label={`Volume ${v.drive}`} value={v.sizeBytes ? 100 * (1 - v.freeBytes / v.sizeBytes) : 0} warnAt={90} detail={`${bytes(v.freeBytes)} free of ${bytes(v.sizeBytes)}${v.fileSystem ? ` · ${v.fileSystem}` : ""}`} />)}
      {p.physicalDisks.map(d => <Meter key={d.name} label={`Disk ${d.name}`} value={d.busyPercent} detail={`${pct(d.busyPercent)} busy · queue ${d.queueLength} · ${d.readsPerSecond} r/s ${d.writesPerSecond} w/s`} />)}
    </div>
  );
}
