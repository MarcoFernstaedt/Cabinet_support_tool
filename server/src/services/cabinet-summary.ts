// A cabinet at a glance: the machine, its Windows, and its memory and storage, from what the platform has already read. Each part comes
// from the latest stored answer of one read (system.hardware, system.performance, system.info) or from the latest heartbeat load
// sample, and carries the time it was read, so a figure is never shown without its age. A part never read is null. Nothing here asks
// the cabinet anything; reading it again is the operations' own job.
import type { Queryable } from "../db/db.js";

type Out = Record<string, unknown>;
const obj = (v: unknown): Out | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Out : null;
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const text = (v: unknown): string | null => typeof v === "string" && v.trim() !== "" ? v : null;
const bool = (v: unknown): boolean | null => typeof v === "boolean" ? v : null;

export interface CabinetSummary {
  machine: { manufacturer: string | null; model: string | null; cpu: string | null; logicalCores: number | null; memoryBytes: number | null;
    memoryModules: number | null; biosVersion: string | null; biosDate: string | null; tpm: { present: boolean; enabled: boolean | null; version: string | null } | null;
    secureBoot: boolean | null; lastBoot: string | null; readAt: string } | null;
  windows: { edition: string | null; build: string | null; architecture: string | null; uptimeSeconds: number | null; readAt: string | null } | null;
  memory: { totalBytes: number; availableBytes: number; readAt: string } | null;
  volumes: { drive: string; label: string | null; fileSystem: string | null; sizeBytes: number; freeBytes: number }[];
  volumesReadAt: string | null;
  /** The latest heartbeat load sample: what the cabinet reports every few minutes on its own. */
  load: { cpuPercent: number; memoryUsedPercent: number; diskFreePercent: number; at: string } | null;
}

/** The latest stored successful answer of each of these reads for one cabinet. */
async function latest(db: Queryable, cabinetId: string, operations: readonly string[]): Promise<Map<string, { at: Date; output: Out }>> {
  const rows = (await db.query<{ operation: string; at: Date; output: string | null }>(
    `SELECT operation, [at], output FROM (
       SELECT operation, result_at AS [at], JSON_QUERY(result, '$.output') AS output,
              ROW_NUMBER() OVER (PARTITION BY operation ORDER BY result_at DESC) AS rn
         FROM commands WHERE cabinet_id = $1 AND status = 'succeeded' AND result IS NOT NULL
          AND operation IN (SELECT value FROM OPENJSON($2))) x
      WHERE rn = 1`, [cabinetId, JSON.stringify(operations)])).rows;
  const out = new Map<string, { at: Date; output: Out }>();
  for (const r of rows) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(r.output ?? "null"); } catch { parsed = null; }
    const o = obj(parsed);
    if (o) out.set(r.operation, { at: r.at, output: o });
  }
  return out;
}

export async function cabinetSummary(db: Queryable, cabinetId: string): Promise<CabinetSummary> {
  const reads = await latest(db, cabinetId, ["system.hardware", "system.performance", "system.info"]);
  const k = (await db.query<{ architecture: string | null }>("SELECT architecture FROM cabinets WHERE id = $1", [cabinetId])).rows[0];
  const sample = (await db.query<{ at: Date; cpu_percent: number; memory_used_percent: number; disk_free_percent: number }>(
    "SELECT TOP (1) [at], cpu_percent, memory_used_percent, disk_free_percent FROM health_samples WHERE cabinet_id = $1 ORDER BY [at] DESC", [cabinetId])).rows[0];

  const hw = reads.get("system.hardware");
  const h = hw?.output;
  const bios = obj(h?.bios), cpu = obj(h?.cpu), mem = obj(h?.memory), tpm = obj(h?.tpm);
  const machine = h ? {
    manufacturer: text(h.manufacturer), model: text(h.model), cpu: text(cpu?.model), logicalCores: num(cpu?.logicalCores),
    memoryBytes: num(mem?.totalBytes), memoryModules: num(mem?.moduleCount), biosVersion: text(bios?.version), biosDate: text(bios?.date),
    tpm: tpm && typeof tpm.present === "boolean" ? { present: tpm.present, enabled: bool(tpm.enabled), version: text(tpm.version) } : null,
    secureBoot: bool(h.secureBoot), lastBoot: text(h.lastBoot), readAt: hw.at.toISOString(),
  } : null;

  const info = reads.get("system.info");
  const windows = info || k?.architecture ? {
    edition: text(info?.output.osVersion), build: text(info?.output.osBuild), architecture: k?.architecture ?? null,
    uptimeSeconds: num(info?.output.uptimeSeconds), readAt: info?.at.toISOString() ?? null,
  } : null;

  const perf = reads.get("system.performance");
  const pm = obj(perf?.output.memory);
  const total = num(pm?.totalBytes), available = num(pm?.availableBytes);
  const memory = perf && total !== null && available !== null ? { totalBytes: total, availableBytes: available, readAt: perf.at.toISOString() } : null;
  const volumes = (Array.isArray(perf?.output.volumes) ? perf!.output.volumes as unknown[] : []).map(obj)
    .filter((v): v is Out => v !== null && typeof v.drive === "string" && num(v.sizeBytes) !== null && num(v.freeBytes) !== null)
    .map(v => ({ drive: v.drive as string, label: text(v.label), fileSystem: text(v.fileSystem), sizeBytes: num(v.sizeBytes)!, freeBytes: num(v.freeBytes)! }))
    .filter(v => v.sizeBytes > 0)
    .slice(0, 32);

  return {
    machine, windows, memory, volumes, volumesReadAt: perf && volumes.length > 0 ? perf.at.toISOString() : null,
    load: sample ? { cpuPercent: sample.cpu_percent, memoryUsedPercent: sample.memory_used_percent, diskFreePercent: sample.disk_free_percent, at: sample.at.toISOString() } : null,
  };
}
