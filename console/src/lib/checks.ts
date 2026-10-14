// Read-only checks the console can run on a cabinet, each with a plain-words summary of the answer. The live check on the Overview page
// runs all of them; the Troubleshoot page runs the ones a symptom calls for. Nothing here changes a cabinet, and no summary uses a pattern
// match on text: they read fields of the answer.
import { useCallback, useState } from "react";
import { useRunner } from "./commands";
import { analyseUsb, type UsbDevice } from "./usb";

export type Out = Record<string, unknown>;
export interface Check { id: string; label: string; operation: string; params: Record<string, unknown>; summarize: (o: Out) => { ok: boolean; text: string } }
export type CheckState = { status: "waiting" | "running" | "passed" | "failed"; text: string; ms: number | null; raw: string | null };

const arr = (v: unknown): Out[] => (Array.isArray(v) ? (v as Out[]) : []);
const n = (v: unknown) => (typeof v === "number" ? v : 0);
const gb = (bytes: unknown) => `${(n(bytes) / 1024 ** 3).toFixed(1)} GB`;
const mb = (bytes: unknown) => `${Math.round(n(bytes) / 1024 ** 2)} MB`;
const newest = (o: Out) => { const e = arr(o.entries); return e.length === 0 ? null : `${e.length} ${e.length === 1 ? "entry" : "entries"}; newest: ${String(e[0]!.source)} event ${String(e[0]!.eventId)} at ${String(e[0]!.time)}: ${String(e[0]!.firstLine)}`; };

/** Free space under a tenth of the drive, or under 10 GB, is where Windows and the application start to struggle. */
export const lowSpace = (v: Out) => n(v.sizeBytes) > 0 && (n(v.freeBytes) < n(v.sizeBytes) / 10 || n(v.freeBytes) < 10 * 1024 ** 3);

const checkList: Check[] = [
  { id: "info", label: "System information", operation: "system.info", params: {},
    summarize: o => ({ ok: typeof o.hostname === "string", text: `${String(o.hostname)}, ${String(o.osVersion)} (build ${String(o.osBuild)}), agent ${String(o.agentVersion)}, up ${Math.round(n(o.uptimeSeconds) / 3600)} h, ${o.readOnlyMode ? "read-only" : "changes allowed"}` }) },
  { id: "logs", label: "Event logs that can be read", operation: "eventlog.channels", params: {},
    summarize: o => { const c = arr(o.channels).filter(x => x.available); return { ok: c.length > 0, text: `${c.length} logs available: ${c.slice(0, 4).map(x => `${String(x.log)} (${n(x.entryCount)} entries)`).join(", ")}${c.length > 4 ? ", …" : ""}` }; } },
  { id: "system-log", label: "Recent System log errors", operation: "eventlog.query", params: { log: "System", levels: ["error", "critical", "warning"] },
    summarize: o => ({ ok: true, text: newest(o) ?? "No errors or warnings in what the log returned." }) },
  { id: "app-log", label: "Recent Application log errors", operation: "eventlog.query", params: { log: "Application", levels: ["error", "critical"] },
    summarize: o => ({ ok: true, text: newest(o) ?? "No errors in what the log returned." }) },
  { id: "services", label: "Windows services", operation: "services.list", params: {},
    summarize: o => { const s = arr(o.services); return { ok: s.length > 0, text: `${s.length} services, ${s.filter(x => x.state === "running").length} running` }; } },
  { id: "firewall", label: "Windows firewall", operation: "firewall.state", params: {},
    summarize: o => { const p = arr(o.profiles); return { ok: p.length === 3, text: `${p.map(x => `${String(x.profile)} ${x.enabled ? "on" : "off"}`).join(", ")}; ${arr(o.rules).length} rules read` }; } },
  { id: "time", label: "Time and time zone", operation: "time.status", params: {},
    summarize: o => ({ ok: typeof o.timeZoneId === "string", text: `${String(o.timeZoneName)} (${String(o.timeZoneId)}), local time ${String(o.localTime)}` }) },
  { id: "net", label: "Network adapters, leases, routes and ARP", operation: "network.config", params: {},
    summarize: o => { const a = arr(o.adapters).filter(x => x.connected); const first = a[0] as { ipv4?: { addresses?: { address: string }[]; gateways?: string[] }; details?: { leaseExpires?: string | null } } | undefined;
      const address = first?.ipv4?.addresses?.[0]?.address;
      return { ok: a.length > 0 && !!address && !address.startsWith("169.254."), text: `${a.length} connected ${a.length === 1 ? "adapter" : "adapters"}; ${address ?? "no address"}${address?.startsWith("169.254.") ? " (a 169.254 address means the DHCP server never answered)" : ""} via ${first?.ipv4?.gateways?.[0] ?? "no gateway"}; ${arr(o.routes).length} routes, ${arr(o.neighbors).length} ARP entries${first?.details?.leaseExpires ? `; lease ends ${first.details.leaseExpires}` : ""}` }; } },
  { id: "ping", label: "Ping the gateway (4 requests)", operation: "network.test", params: { target: "gateway", method: "ping", count: 4 },
    summarize: o => { const s = o.statistics as { received: number; sent: number; lossPercent: number; avgMs: number | null } | null | undefined;
      return { ok: o.success === true, text: o.success ? `${s ? `${s.received} of ${s.sent} replies, ${s.lossPercent}% lost, average ${s.avgMs ?? "?"} ms` : `reached in ${String(o.latencyMs)} ms`}` : `no answer${o.error ? `: ${String(o.error)}` : ""}` }; } },
  { id: "loss", label: "Packet loss to the gateway (20 requests)", operation: "network.test", params: { target: "gateway", method: "ping", count: 20 },
    summarize: o => { const s = o.statistics as { received: number; sent: number; lossPercent: number; minMs: number | null; avgMs: number | null; maxMs: number | null; jitterMs: number | null } | null | undefined;
      if (!o.success || !s) return { ok: false, text: `no answer${o.error ? `: ${String(o.error)}` : ""}` };
      return { ok: s.lossPercent === 0 && (s.jitterMs ?? 0) < 15, text: `${s.received} of ${s.sent} replies, ${s.lossPercent}% lost; fastest ${s.minMs} ms, average ${s.avgMs} ms, slowest ${s.maxMs} ms, jitter ${s.jitterMs} ms${s.lossPercent > 0 ? ". Any loss on the first hop points at the cable, the switch port or the adapter, not at the internet." : ""}` }; } },
  { id: "dns", label: "Resolve the platform server's name", operation: "network.test", params: { target: "platform_server", method: "dns" },
    summarize: o => ({ ok: o.success === true, text: o.success ? `resolved${(Array.isArray(o.resolvedAddresses) && o.resolvedAddresses.length > 0) ? ` to ${(o.resolvedAddresses as string[]).join(", ")}` : ""}` : `failed${o.error ? `: ${String(o.error)}` : ""}` }) },
  { id: "trace", label: "Path to the platform server", operation: "network.trace", params: { target: "platform_server" },
    summarize: o => { const h = arr(o.hops); return { ok: h.some(x => x.address), text: `${h.length} hops, ${o.reached ? "reached" : "did not reach"} ${String(o.resolvedTarget ?? "")}${o.error ? ` (${String(o.error)})` : ""}` }; } },
  { id: "perf", label: "Processor, memory, drives and busiest programs", operation: "system.performance", params: {},
    summarize: o => {
      const cpu = o.cpu as Out, mem = o.memory as Out, vols = arr(o.volumes), disks = arr(o.physicalDisks), top = arr(o.byCpu)[0], heavy = arr(o.byMemory)[0];
      const low = vols.filter(lowSpace), busy = disks.filter(d => n(d.busyPercent) > 85), memFree = n(mem.totalBytes) > 0 ? n(mem.availableBytes) / n(mem.totalBytes) : 1;
      const notes = [n(cpu.usedPercent) > 85 && "processor is nearly saturated", memFree < 0.1 && "less than a tenth of memory is free", n(mem.pagesPerSecond) > 200 && "Windows is paging heavily", low.length > 0 && `${low.map(v => String(v.drive)).join(", ")} is nearly full`, busy.length > 0 && "a drive is busy most of the time"].filter(Boolean);
      return { ok: notes.length === 0, text: `processor ${n(cpu.usedPercent)}% of ${n(cpu.logicalProcessors)} cores; memory ${gb(mem.availableBytes)} free of ${gb(mem.totalBytes)}; ${vols.map(v => `${String(v.drive)} ${gb(v.freeBytes)} free of ${gb(v.sizeBytes)}`).join(", ") || "no drives read"}; ${disks.map(d => `disk ${String(d.name)} ${n(d.busyPercent)}% busy`).join(", ")}${top ? `; busiest: ${String(top.name)} (${n(top.cpuPercent)}% processor)` : ""}${heavy ? `, biggest: ${String(heavy.name)} (${mb(heavy.workingSetBytes)})` : ""}${notes.length ? `. Look at: ${notes.join("; ")}.` : ""}` }; } },
  { id: "listeners", label: "Ports listening and connections in use", operation: "network.listeners", params: {},
    summarize: o => { const l = arr(o.listeners), c = o.counts as Out; const ports = l.slice(0, 8).map(x => `${n(x.port)}${x.process ? ` (${String(x.process)})` : ""}`).join(", ");
      return { ok: l.length > 0, text: `${n(c.listening)} listening${ports ? `: ${ports}${l.length > 8 ? ", …" : ""}` : ""}; ${n(c.established)} connected, ${n(c.timeWait)} closing${o.truncated ? " (list cut short)" : ""}` }; } },
  { id: "disk", label: "Drive health (SMART)", operation: "disk.smart", params: {},
    summarize: o => { const d = arr(o.drives); const bad = d.filter(x => x.health !== "healthy" || x.predictFailure === true || n(x.pendingSectors) > 0 || n(x.uncorrectableErrors) > 0);
      return { ok: d.length > 0 && bad.length === 0, text: d.length === 0 ? "No drive reported health data." : `${d.length} ${d.length === 1 ? "drive" : "drives"}: ${d.map(x => `${String(x.model ?? "drive")} ${String(x.health)}${x.reallocatedSectors ? `, ${n(x.reallocatedSectors)} reallocated sectors` : ""}`).join("; ")}. A healthy reading is not a guarantee: check the storage events too.` }; } },
  { id: "storage-log", label: "Disk errors in the System log", operation: "eventlog.query", params: { log: "System", levels: ["error", "critical"], source: "disk" },
    summarize: o => ({ ok: arr(o.entries).length === 0, text: newest(o) ?? "No errors from the disk driver in what the log returned." }) },
  { id: "scm-log", label: "Service Control Manager events", operation: "eventlog.query", params: { log: "System", levels: ["error", "warning"], source: "Service Control Manager" },
    summarize: o => ({ ok: arr(o.entries).length === 0, text: newest(o) ?? "No service failures or timeouts in what the log returned." }) },
  { id: "critical-log", label: "Critical events, crashes and unexpected restarts", operation: "eventlog.query", params: { log: "System", levels: ["critical"] },
    summarize: o => ({ ok: arr(o.entries).length === 0, text: newest(o) ?? "No critical events in what the log returned." }) },
  { id: "updates", label: "Windows updates", operation: "updates.status", params: {},
    summarize: o => { const i = arr(o.installed), p = arr(o.pending), failed = i.filter(x => x.result !== "succeeded");
      return { ok: failed.length === 0, text: `${i.length} recent, ${failed.length} failed, ${p.length} waiting${i[0] ? `; latest ${String(i[0].kb ?? i[0].title)} on ${String(i[0].installedAt ?? "?")}` : ""}${o.lastInstallResult ? `; last install ${String(o.lastInstallResult)}` : ""}` }; } },
  { id: "usb", label: "USB ports and the fingerprint scanner", operation: "usb.ports", params: {},
    summarize: o => { const a = analyseUsb(arr(o.devices) as unknown as UsbDevice[], [], null, o.truncated === true); return { ok: a.tone === "ok", text: a.summary }; } },
  { id: "devices", label: "Devices with a problem", operation: "devices.list", params: { problemsOnly: true },
    summarize: o => { const d = arr(o.devices); return { ok: d.length === 0, text: d.length === 0 ? "Device Manager shows nothing wrong." : `${d.length} with a problem: ${d.slice(0, 4).map(x => `${String(x.name)} (code ${String(x.errorCode ?? "?")})`).join(", ")}${d.length > 4 ? ", …" : ""}` }; } },
];

export const CHECKS: Check[] = checkList;
export const CHECK_BY_ID: Record<string, Check> = Object.fromEntries(checkList.map(c => [c.id, c]));

/** The checks the Overview page runs: everything that does not repeat another check's question. */
export const OVERVIEW_CHECKS: Check[] = checkList.filter(c => !["loss", "disk", "storage-log", "scm-log", "critical-log", "updates", "devices"].includes(c.id));

/** Runs a list of checks one after another against one cabinet and keeps each one's state. */
export function useChecks(cabinetId: string, list: Check[]) {
  const run = useRunner();
  const [rows, setRows] = useState<Record<string, CheckState>>({});
  const [busy, setBusy] = useState(false);
  const set = (id: string, s: CheckState) => setRows(r => ({ ...r, [id]: s }));
  const start = useCallback(async () => {
    setBusy(true); setRows(Object.fromEntries(list.map(c => [c.id, { status: "waiting", text: "", ms: null, raw: null } as CheckState])));
    for (const c of list) {
      set(c.id, { status: "running", text: "Asking the cabinet…", ms: null, raw: null });
      const t0 = Date.now();
      try {
        const r = await run<Out>(cabinetId, c.operation, c.params);
        const ms = Date.now() - t0;
        if (r.status === "succeeded" && r.output) {
          const s = c.summarize(r.output);
          set(c.id, { status: s.ok ? "passed" : "failed", text: s.text, ms, raw: JSON.stringify(r.output, null, 2).slice(0, 6000) });
        } else set(c.id, { status: "failed", text: `${r.status}${r.error ? `: ${r.error.code}: ${r.error.message}` : ""}`, ms, raw: null });
      } catch (e) { set(c.id, { status: "failed", text: e instanceof Error ? e.message : "could not ask the cabinet", ms: Date.now() - t0, raw: null }); }
    }
    setBusy(false);
  }, [run, cabinetId, list]);
  return { rows, busy, start };
}
