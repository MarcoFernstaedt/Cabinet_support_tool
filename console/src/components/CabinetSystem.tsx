// A cabinet at a glance: Windows, processor, memory, storage, the machine and its security, from the platform's latest stored reads.
// Every role sees it. Each figure shows how old it is; "Read now" asks the cabinet again (system information and performance) and the
// panel reloads from what was stored.
import { useLoad } from "../lib/useLoad";
import { useOperation } from "../lib/commands";
import { ago, bytes, duration, fullTime } from "../lib/time";
import { architectureLabel } from "../lib/architecture";

interface Summary {
  machine: { manufacturer: string | null; model: string | null; cpu: string | null; logicalCores: number | null; memoryBytes: number | null; memoryModules: number | null;
    biosVersion: string | null; biosDate: string | null; tpm: { present: boolean; enabled: boolean | null; version: string | null } | null; secureBoot: "on" | "off" | "unsupported" | null;
    lastBoot: string | null; readAt: string } | null;
  windows: { edition: string | null; build: string | null; architecture: string | null; uptimeSeconds: number | null; readAt: string | null } | null;
  memory: { totalBytes: number; availableBytes: number; readAt: string } | null;
  volumes: { drive: string; label: string | null; fileSystem: string | null; sizeBytes: number; freeBytes: number }[];
  volumesReadAt: string | null;
  load: { cpuPercent: number; memoryUsedPercent: number; diskFreePercent: number; at: string } | null;
}

/** A usage bar; the figures beside it carry the meaning, so the bar is decoration for screen readers. */
function Meter({ used, warnAt = 85, critAt = 95 }: { used: number; warnAt?: number; critAt?: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(used)));
  const tone = pct >= critAt ? "crit" : pct >= warnAt ? "warn" : "ok";
  return <span className={`meter ${tone}`} aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>;
}

/** How old a figure is, after a separator: "· 10 min ago". */
const When = ({ at }: { at: string | null | undefined }) => at ? <span className="muted small when" title={fullTime(at)}>· {ago(at)}</span> : null;
const unknown = <span className="muted">Not read yet</span>;
/** The three states the agent reports, worded as the Windows tab words them. */
const SECURE_BOOT = { on: "on", off: "off", unsupported: "not supported" } as const;

export function CabinetSystem({ cabinetId, cabinetName }: { cabinetId: string; cabinetName: string }) {
  const { data, problem, reload } = useLoad<Summary>(`/api/cabinets/${cabinetId}/summary`);
  const hardware = useOperation(cabinetId, "system.hardware");
  const perf = useOperation(cabinetId, "system.performance");
  const busy = hardware.state === "running" || perf.state === "running";
  const readNow = async () => { await Promise.all([hardware.start(), perf.start()]); reload(); };
  const m = data?.machine, w = data?.windows, mem = data?.memory, load = data?.load;
  const memUsed = mem ? (mem.totalBytes - mem.availableBytes) / mem.totalBytes * 100 : load?.memoryUsedPercent ?? null;
  return (
    <section className="panel" aria-labelledby="system-heading">
      <div className="panel-head">
        <h2 id="system-heading">System</h2>
        <button className="btn small" disabled={busy} onClick={() => void readNow()}>{busy ? "Reading…" : "Read now"}</button>
      </div>
      {problem && <p className="error" role="alert">{problem}</p>}
      {(hardware.problem || perf.problem) && <p className="error small" role="alert">{hardware.problem ?? perf.problem}</p>}
      {data && (
        <div className="sysgrid">
          <div className="tile">
            <span className="tile-label">Windows</span>
            <span className="tile-value">{w?.edition ?? unknown}</span>
            <span className="tile-sub">{[w?.build ? `Build ${w.build}` : null, architectureLabel(w?.architecture)].filter(Boolean).join(" · ") || " "}</span>
            <span className="tile-sub">{w?.uptimeSeconds != null ? <>Up {duration(w.uptimeSeconds)} <When at={w.readAt} /></> : " "}</span>
          </div>
          <div className="tile">
            <span className="tile-label">Processor</span>
            <span className="tile-value">{m?.cpu ?? unknown}</span>
            <span className="tile-sub">{m?.logicalCores ? `${m.logicalCores} logical cores` : " "}</span>
            <span className="tile-sub">{load ? <>{load.cpuPercent}% in use <When at={load.at} /></> : " "}</span>
          </div>
          <div className="tile">
            <span className="tile-label">Memory</span>
            <span className="tile-value">{mem ? `${bytes(mem.totalBytes - mem.availableBytes)} of ${bytes(mem.totalBytes)}` : m?.memoryBytes ? `${bytes(m.memoryBytes)} installed` : unknown}</span>
            {memUsed !== null && <Meter used={memUsed} />}
            <span className="tile-sub">{memUsed !== null ? <>{Math.round(memUsed)}% in use{m?.memoryModules ? ` · ${m.memoryModules} module${m.memoryModules === 1 ? "" : "s"}` : ""} <When at={mem?.readAt ?? load?.at} /></> : " "}</span>
          </div>
          <div className="tile">
            <span className="tile-label">Machine</span>
            <span className="tile-value">{[m?.manufacturer, m?.model].filter(Boolean).join(" ") || unknown}</span>
            <span className="tile-sub">{m?.biosVersion ? `BIOS ${m.biosVersion}${m.biosDate ? ` (${m.biosDate.slice(0, 10)})` : ""}` : " "}</span>
            <span className="tile-sub">{m ? <>TPM {m.tpm ? (m.tpm.present ? `${m.tpm.version ?? "present"}${m.tpm.enabled === false ? ", disabled" : ""}` : "not present") : "unknown"} · Secure Boot {m.secureBoot === null ? "unknown" : SECURE_BOOT[m.secureBoot]}</> : " "}</span>
          </div>
          <div className="tile wide">
            <span className="tile-label">Storage {data.volumesReadAt && <When at={data.volumesReadAt} />}</span>
            {data.volumes.length === 0
              ? <span className="tile-value">{load ? `${load.diskFreePercent}% free on the system drive` : unknown}</span>
              : <table className="table compact volumes"><caption className="sr-only">Drives on {cabinetName}</caption>
                  <thead><tr><th scope="col">Drive</th><th scope="col">Used</th><th scope="col">Free</th><th scope="col">Size</th></tr></thead>
                  <tbody>{data.volumes.map(v => {
                    const used = (v.sizeBytes - v.freeBytes) / v.sizeBytes * 100;
                    return (
                      <tr key={v.drive}>
                        <th scope="row">{v.drive}{v.label ? <span className="muted"> {v.label}</span> : null}</th>
                        <td><Meter used={used} warnAt={85} critAt={92} /> {Math.round(used)}%</td>
                        <td>{bytes(v.freeBytes)}</td>
                        <td>{bytes(v.sizeBytes)}{v.fileSystem ? <span className="muted"> {v.fileSystem}</span> : null}</td>
                      </tr>);
                  })}</tbody>
                </table>}
          </div>
        </div>)}
    </section>
  );
}
