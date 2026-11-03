// The diagnostic sections of the cabinet view, with their write actions (Writes.tsx) for the roles the catalog allows.
import { DriveTrends } from "../../components/DriveTrends";
import { adapterRows, ipconfigText, NeighborsTable, PingSummary, RoutesTable, TraceTable } from "../../components/NetworkReadings";
import { PortCheck } from "../../components/PortCheck";
import { PacketPath } from "../../components/PacketPath";
import { DrawerCheck } from "./DrawerCheck";
import { UsbPorts } from "../../components/UsbPorts";
import { DiagnoseNetwork } from "./Diagnose";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pager, usePaged } from "../../components/Pager";
import type { DevicesListOutput, DiskSmartOutput, DriversListOutput, FilesListOutput, FirewallStateOutput, NetworkConfigOutput,
  NetworkTestOutput, NetworkTraceOutput, UpdatesStatusOutput, DatabaseConnectivityOutput, StorageHealthOutput } from "@mashura/cabinet-contracts/types";
import { useOperation } from "../../lib/commands";
import { noLogText, nvmeVerdict, repairText } from "../../lib/storage-health";
import { bytes, fullTime } from "../../lib/time";
import { Badge, Empty, KeyValues, OperationPanel } from "../../components/ui";
import type { CabinetDetail } from "./CabinetPage";
import { AdapterEdit, Countdown, FirewallHistory, FirewallPolicyPanel, ProfileControl, Snapshots, useAdapterWrites, useCanWrite, useDriverUninstall, useProfileWrite, useRuleWrites, useUpdateRollback, useFlushDns } from "./Writes";

/** Pages a list of rows: the children draw the table for the rows of the current page. */
function PagedRows<T>({ rows, label, children }: { rows: readonly T[]; label: string; children: (page: T[]) => ReactNode }) {
  const paged = usePaged(rows);
  return (<>{children(paged.rows)}<Pager {...paged} label={label} /></>);
}

export function DevicesDrivers({ cabinet }: { cabinet: CabinetDetail }) {
  const cabinetId = cabinet.id;
  const devices = useOperation<DevicesListOutput>(cabinetId, "devices.list");
  const drivers = useOperation<DriversListOutput>(cabinetId, "drivers.list");
  const [problemsOnly, setProblemsOnly] = useState(true);
  const [filter, setFilter] = useState("");
  const uninstall = useDriverUninstall(cabinet, () => void drivers.start());
  useEffect(() => { void devices.start({ problemsOnly: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (<>
    <UsbPorts cabinetId={cabinetId} />
    <OperationPanel title="Devices" run={devices}
      onRun={() => void devices.start({ problemsOnly })} buttonLabel="List devices">
      {out => {
        const f = filter.toLowerCase();
        const rows = out.devices.filter(d => !f || d.name.toLowerCase().includes(f) || (d.class ?? "").toLowerCase().includes(f));
        return (<>
          <div className="row gap wrap">
            <label className="check"><input type="checkbox" checked={problemsOnly} onChange={e => { setProblemsOnly(e.target.checked); void devices.start({ problemsOnly: e.target.checked }); }} /> Only devices with problems</label>
            <label className="field inline"><span>Filter</span><input value={filter} onChange={e => setFilter(e.target.value)} /></label>
          </div>
          {rows.length === 0 ? <Empty>{problemsOnly ? "No device reports a problem." : "No devices match."}</Empty> : (
            <PagedRows rows={rows} label="devices">{page => (<table className="table compact">
              <caption className="sr-only">Devices</caption>
              <thead><tr><th scope="col">Device</th><th scope="col">Class</th><th scope="col">Status</th><th scope="col">Driver</th></tr></thead>
              <tbody>{page.map(d => (
                <tr key={d.instanceId}>
                  <th scope="row">{d.name}<div className="muted small wrap">{d.instanceId}</div></th>
                  <td>{d.class ?? "—"}</td>
                  <td>{d.errorCode ? <><Badge tone="crit">Code {d.errorCode}</Badge><div className="small">{d.errorText}</div></> : <Badge tone="ok">{d.status}</Badge>}</td>
                  <td>{d.driver ? `${d.driver.name} ${d.driver.version ?? ""}` : "—"}</td>
                </tr>))}
              </tbody>
            </table>)}</PagedRows>)}
          {out.truncated && <p className="muted small">Showing the first 5,000 devices.</p>}
        </>);
      }}
    </OperationPanel>
    <OperationPanel title="Installed drivers" run={drivers} onRun={() => void drivers.start()} buttonLabel="List drivers">
      {out => (
        <PagedRows rows={out.drivers} label="drivers">{page => (<table className="table compact">
          <caption className="sr-only">Drivers</caption>
          <thead><tr><th scope="col">Published name</th><th scope="col">Original name</th><th scope="col">Class</th><th scope="col">Version</th><th scope="col">Provider</th><th scope="col">Signer</th>{uninstall.allowed && <th scope="col"><span className="sr-only">Actions</span></th>}</tr></thead>
          <tbody>{page.map(d => (
            <tr key={d.publishedName}><th scope="row">{d.publishedName}</th><td>{d.originalName ?? "—"}</td><td>{d.className ?? "—"}</td>
              <td>{d.version ?? "—"}</td><td>{d.provider ?? "—"}</td><td>{d.signer ?? <Badge tone="warn">Unsigned</Badge>}</td>{uninstall.allowed && <td>{uninstall.button(d)}</td>}</tr>))}
          </tbody>
        </table>)}</PagedRows>)}
    </OperationPanel>
    {uninstall.outcome}{uninstall.dialog}
  </>);
}

const RESULT_TONE: Record<string, "ok" | "warn" | "crit" | "info" | "off"> = { succeeded: "ok", succeeded_with_errors: "warn", failed: "crit", aborted: "warn", in_progress: "info", unknown: "off" };

export function Updates({ cabinet }: { cabinet: CabinetDetail }) {
  const cabinetId = cabinet.id;
  const op = useOperation<UpdatesStatusOutput>(cabinetId, "updates.status");
  const rollback = useUpdateRollback(cabinet, () => void op.start());
  useEffect(() => { void op.start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (<>
    <OperationPanel title="Windows updates" run={op} onRun={() => void op.start()}>
      {out => (<>
        <KeyValues rows={[["Last check", fullTime(out.lastCheckAt)], ["Last install", fullTime(out.lastInstallAt)],
          ["Last install result", out.lastInstallResult ? <Badge tone={RESULT_TONE[out.lastInstallResult] ?? "off"}>{out.lastInstallResult.replaceAll("_", " ")}</Badge> : null],
          ["Pending", `${out.pending.length} (${out.pending.filter(p => p.isSecurity).length} security)`]]} />
        {out.pending.length > 0 && (<><h3>Pending</h3>
          <ul className="plain">{out.pending.map((p, i) => <li key={i}>{p.isSecurity && <Badge tone="warn">Security</Badge>} {p.title} <span className="muted">{p.classification ?? ""}</span></li>)}</ul></>)}
        {rollback.allowed && (() => {
          const latest = [...out.installed].filter(u => u.result === "succeeded" && u.kb).sort((x, y) => String(y.installedAt ?? "").localeCompare(String(x.installedAt ?? "")))[0];
          return latest ? <p className="row gap wrap"><span>Most recent update: <strong>{latest.kb}</strong> {latest.title}</span>{rollback.button(latest, "Roll back the last update")}</p> : null;
        })()}
        <h3>History</h3>
        {out.installed.length === 0 ? <Empty>No update history.</Empty> : (
          <PagedRows rows={out.installed} label="installed updates">{page => (<table className="table compact">
            <caption className="sr-only">Installed updates</caption>
            <thead><tr><th scope="col">Installed</th><th scope="col">Update</th><th scope="col">Result</th>{rollback.allowed && <th scope="col"><span className="sr-only">Roll back</span></th>}</tr></thead>
            <tbody>{page.map((u, i) => <tr key={i}><td>{fullTime(u.installedAt)}</td><td>{u.title}</td>
              <td><Badge tone={RESULT_TONE[u.result] ?? "off"}>{u.result.replaceAll("_", " ")}</Badge>{u.errorCode ? <span className="muted small"> 0x{(u.errorCode >>> 0).toString(16)}</span> : null}</td>{rollback.allowed && <td>{u.result === "succeeded" ? rollback.button(u) : null}</td>}</tr>)}</tbody>
          </table>)}</PagedRows>)}
      </>)}
    </OperationPanel>
    {rollback.outcome}{rollback.dialog}
  </>);
}

const HEALTH: Record<string, ["ok" | "warn" | "crit" | "off", string]> = {
  healthy: ["ok", "Healthy"], warning: ["warn", "Warning: plan a replacement"], failing: ["crit", "Failing: replace this drive"], unknown: ["off", "Unknown"],
};

export function DriveHealth({ cabinetId }: { cabinetId: string }) {
  const op = useOperation<DiskSmartOutput>(cabinetId, "disk.smart");
  useEffect(() => { void op.start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (<>
    <DriveTrends cabinetId={cabinetId} />
    <OperationPanel title="Drive health"
      run={op} onRun={() => void op.start()}>
      {out => out.drives.length === 0 ? <Empty>No drive reported health data.</Empty> : (
        <div className="cards">{out.drives.map((d, i) => {
          const [tone, label] = HEALTH[d.health] ?? HEALTH.unknown!;
          return (
            <article key={i} className={`card ${tone}`} aria-label={`Drive ${d.model ?? i + 1}`}>
              <h3>{d.model ?? `Drive ${i + 1}`}</h3>
              <p><Badge tone={tone}>{label}</Badge></p>
              <KeyValues rows={[["Serial", d.serialNumber], ["Failure predicted", d.predictFailure === null ? null : d.predictFailure ? "Yes" : "No"],
                ["Temperature", d.temperatureCelsius === null ? null : `${d.temperatureCelsius} °C`], ["Power-on hours", d.powerOnHours?.toLocaleString() ?? null],
                ["Reallocated sectors", d.reallocatedSectors], ["Pending sectors", d.pendingSectors], ["Uncorrectable errors", d.uncorrectableErrors],
                ["Wear", d.wearPercent === null ? null : `${d.wearPercent}%`]]} />
            </article>);
        })}</div>)}
    </OperationPanel>
    <StorageHealth cabinetId={cabinetId} />
  </>);
}

const VOLUME_HEALTH: Record<string, ["ok" | "warn" | "crit" | "off", string]> = {
  healthy: ["ok", "Healthy"], warning: ["warn", "Warning"], unhealthy: ["crit", "Unhealthy"], unknown: ["off", "Unknown"],
};

/** storage.health: each NVMe drive's own health log and each fixed volume's state. Run on request: it opens the drives in the broker. */
function StorageHealth({ cabinetId }: { cabinetId: string }) {
  const op = useOperation<StorageHealthOutput>(cabinetId, "storage.health");
  return (
    <OperationPanel title="Storage health (NVMe log and volumes)" run={op} onRun={() => void op.start()} buttonLabel="Read storage health">
      {out => (<>
        {out.drives.length === 0 ? <Empty>No drive was reported.</Empty> : (
          <div className="cards">{out.drives.map(d => {
            const v = d.nvme ? nvmeVerdict(d.nvme) : null;
            const tone = v?.tone ?? "off";
            return (
              <article key={d.number} className={`card ${tone}`} aria-label={`Disk ${d.number}`}>
                <h3>Disk {d.number}: {d.model ?? "unknown model"}</h3>
                {!d.nvme ? <p>{noLogText(d.nvmeProblem)}</p> : (<>
                  <p><Badge tone={tone}>{tone === "ok" ? "No warnings from the drive" : tone === "crit" ? "The drive reports a problem" : "Watch this drive"}</Badge></p>
                  {v!.lines.length > 0 && <ul>{v!.lines.map(l => <li key={l}>{l}</li>)}</ul>}
                  <KeyValues rows={[["Rated life used", `${d.nvme.percentageUsed}%`],
                    ["Spare", d.nvme.availableSparePercent === null ? null : `${d.nvme.availableSparePercent}% (drive warns below ${d.nvme.spareThresholdPercent ?? "?"}%)`],
                    ["Temperature", d.nvme.temperatureCelsius === null ? null : `${d.nvme.temperatureCelsius} °C`],
                    ["Unsafe shutdowns", d.nvme.unsafeShutdowns.toLocaleString()], ["Power-on hours", d.nvme.powerOnHours.toLocaleString()],
                    ["Written", bytes(d.nvme.dataWrittenBytes)], ["Error log entries", d.nvme.errorLogEntries.toLocaleString()]]} />
                </>)}
              </article>);
          })}</div>)}
        {out.volumes.length > 0 && (
          <table className="table compact"><caption>Fixed volumes</caption>
            <thead><tr><th scope="col">Volume</th><th scope="col">File system</th><th scope="col">Free</th><th scope="col">Health</th><th scope="col">Repair</th></tr></thead>
            <tbody>{out.volumes.map((v, i) => {
              const [tone, label] = VOLUME_HEALTH[v.health] ?? VOLUME_HEALTH.unknown!;
              return (<tr key={i}>
                <td>{v.letter ? `${v.letter}:` : "(no letter)"}{v.label ? ` ${v.label}` : ""}</td>
                <td>{v.fileSystem.toUpperCase()}</td>
                <td>{bytes(v.freeBytes)} of {bytes(v.sizeBytes)}</td>
                <td><Badge tone={tone}>{label}</Badge></td>
                <td>{repairText(v.repair, v.dirty) ?? "None"}</td>
              </tr>);
            })}</tbody>
          </table>)}
      </>)}
    </OperationPanel>);
}

export function Network({ cabinet }: { cabinet: CabinetDetail }) {
  const cabinetId = cabinet.id;
  const config = useOperation<NetworkConfigOutput>(cabinetId, "network.config");
  const adapterWrites = useAdapterWrites(cabinet, () => void config.start());
  useEffect(() => { void config.start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const dnsCount = Math.min(4, Math.max(0, ...(config.result?.output?.adapters.filter(a => a.connected).map(a => a.dns.servers.length) ?? [0])));
  return (<>
    <PacketPath cabinetId={cabinetId} dnsCount={dnsCount} />
    <DiagnoseNetwork cabinetId={cabinet.id} cabinetName={cabinet.name} />
    <DrawerCheck cabinet={cabinet} />
    <OperationPanel title="Network adapters" run={config} onRun={() => void config.start()}>
      {out => <div className="cards adapters">{out.adapters.map(a => (
        <article key={a.interfaceIndex} className="card" aria-label={`Adapter ${a.name}`}>
          <h3>{a.name} <Badge tone={a.connected ? "ok" : "off"}>{a.connected ? "Connected" : "Disconnected"}</Badge></h3>
          <KeyValues rows={adapterRows(a as never)} />
          <AdapterEdit key={`${a.interfaceIndex}-${config.at}`} cabinet={cabinet} adapter={a} writes={adapterWrites} />
        </article>))}</div>}
    </OperationPanel>
    {config.result?.output && <AdapterTools cabinet={cabinet} output={config.result.output as never} />}
    {adapterWrites.outcome}{adapterWrites.dialog}
    {config.result?.output && (config.result.output.routes || config.result.output.neighbors) && (
      <section className="panel" aria-labelledby="routes-heading">
        <h2 id="routes-heading">Routes and ARP table</h2>
        <RoutesTable routes={(config.result.output.routes ?? []) as never} />
        <NeighborsTable neighbors={(config.result.output.neighbors ?? []) as never} />
      </section>)}
    <section className="panel" aria-labelledby="tests-heading">
      <h2 id="tests-heading">Probes</h2>
      <div className="tests row">
        {Array.from({ length: Math.max(dnsCount, 1) }, (_, i) => (
          <NetTest key={i} cabinetId={cabinetId} label={`DNS server ${i + 1} (lookup)`} params={{ target: "dns_server", method: "dns", dnsServerIndex: i }} />))}
        <SyncTcpTest cabinetId={cabinetId} />
        <SyncDatabaseTest cabinetId={cabinetId} />
        <NetTest cabinetId={cabinetId} label="Platform server (DNS)" params={{ target: "platform_server", method: "dns" }} />
      </div>
    </section>
  </>);
}

function NetTest({ cabinetId, label, params }: { cabinetId: string; label: string; params: Record<string, unknown> }) {
  const op = useOperation<NetworkTestOutput>(cabinetId, "network.test");
  const out = op.result?.output;
  return (
    <div className="test" aria-live="polite">
      <button className="btn" onClick={() => void op.start(params)} disabled={op.state === "running"}>{op.state === "running" ? "Testing…" : label}</button>
      {op.problem && <span className="error">{op.problem}</span>}
      {op.result && op.result.status !== "succeeded" && <span className="error">{op.result.error?.message}</span>}
      {out && <span>{out.success ? <Badge tone="ok">Reached</Badge> : <Badge tone="crit">Failed</Badge>}{" "}
        {out.resolvedTarget && <code>{out.resolvedTarget}</code>}{out.latencyMs !== null && ` in ${out.latencyMs} ms`}
        {out.resolvedAddresses.length > 0 && <> → {out.resolvedAddresses.join(", ")}</>}{out.error && <span className="muted"> — {out.error}</span>}
        {out.statistics && <> <PingSummary s={out.statistics as never} /></>}</span>}
    </div>
  );
}

function SyncTcpTest({ cabinetId }: { cabinetId: string }) {
  const [port, setPort] = useState("");
  const n = Number(port);
  return (
    <div className="test">
      <label className="field inline"><span>Sync cabinet TCP port</span><input inputMode="numeric" value={port} onChange={e => setPort(e.target.value.replace(/\D/g, ""))} size={6} /></label>
      {Number.isInteger(n) && n >= 1 && n <= 65535
        ? <NetTest cabinetId={cabinetId} label={`Sync cabinet port ${n} (TCP)`} params={{ target: "sync_cabinet", method: "tcp", port: n }} />
        : <span className="muted small">Port 1–65535</span>}
    </div>
  );
}

const DB_RESULT: Record<DatabaseConnectivityOutput["result"], string> = {
  sql_server: "SQL Server answers", not_sql_server: "Something answers, but not SQL Server", refused: "Port closed",
  no_answer: "No answer", unreachable: "Unreachable", no_sync_cabinet: "No sync cabinet set",
};
const ENCRYPTION: Record<string, string> = { off: "encrypts the sign-in only", on: "encrypts", required: "requires encryption", not_supported: "has no certificate" };
const TLS_PROBLEM: Record<string, string> = { name_mismatch: "does not name this address", untrusted_chain: "not from a trusted authority", missing: "none presented" };

/** Whether SQL Server answers on the sync cabinet, before any sign-in: no credential is sent and no database is opened. */
function SyncDatabaseTest({ cabinetId }: { cabinetId: string }) {
  const [port, setPort] = useState("1433");
  const n = Number(port);
  const op = useOperation<DatabaseConnectivityOutput>(cabinetId, "database.connectivity");
  const out = op.result?.output;
  const valid = Number.isInteger(n) && n >= 1 && n <= 65535;
  return (
    <div className="test" aria-live="polite">
      <label className="field inline"><span>Sync database port</span><input inputMode="numeric" value={port} onChange={e => setPort(e.target.value.replace(/\D/g, ""))} size={6} /></label>
      <button className="btn" onClick={() => void op.start({ port: n })} disabled={!valid || op.state === "running"}>{op.state === "running" ? "Checking…" : "Check the sync database"}</button>
      {op.problem && <span className="error">{op.problem}</span>}
      {op.result && op.result.status !== "succeeded" && <span className="error">{op.result.error?.message}</span>}
      {out && <span>
        <Badge tone={out.result === "sql_server" ? "ok" : "crit"}>{DB_RESULT[out.result]}</Badge>{" "}
        {out.address && <code>{out.address}:{out.port}</code>}
        {out.prelogin?.serverVersion && <> · version {out.prelogin.serverVersion}</>}
        {out.prelogin?.encryption && <> · {ENCRYPTION[out.prelogin.encryption]}</>}
        {out.tls?.certificate && <> · certificate {out.tls.certificate.subject}{out.tls.certificate.selfSigned ? " (self-signed)" : ""}</>}
        {out.tls && out.tls.problems.length > 0 && <span className="muted"> — certificate {out.tls.problems.map(p => TLS_PROBLEM[p]).join(", ")}</span>}
        {out.error && <span className="muted"> — {out.error}</span>}
      </span>}
    </div>
  );
}

export function Firewall({ cabinet }: { cabinet: CabinetDetail }) {
  const op = useOperation<FirewallStateOutput>(cabinet.id, "firewall.state");
  const [filter, setFilter] = useState({ text: "", direction: "any", action: "any", enabled: "any" });
  const [changes, setChanges] = useState(0);
  const changed = () => { setChanges(n => n + 1); void op.start(); };
  const allowed = useCanWrite(cabinet, "firewall.setRule");
  const rules = useRuleWrites(cabinet, changed);
  const profileWrite = useProfileWrite(cabinet, changed);
  useEffect(() => { void op.start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (<>
    <FirewallPolicyPanel cabinet={cabinet} version={changes} onChanged={changed} />
    <OperationPanel title="Firewall" run={op} onRun={() => void op.start()}>
      {out => {
        const f = filter.text.toLowerCase();
        const shown = out.rules.filter(r => (!f || r.name.toLowerCase().includes(f) || (r.localPorts ?? "").includes(f) || (r.remotePorts ?? "").includes(f))
          && (filter.direction === "any" || r.direction === filter.direction) && (filter.action === "any" || r.action === filter.action)
          && (filter.enabled === "any" || String(r.enabled) === filter.enabled));
        return (<>
          <div className="cards">{out.profiles.map(p => (
            <article key={p.profile} className={`card ${p.enabled ? "" : "warn"}`} aria-label={`${p.profile} profile`}>
              <h3>{p.profile[0]!.toUpperCase() + p.profile.slice(1)} profile</h3>
              <p>{p.enabled ? <Badge tone="ok">On</Badge> : <Badge tone="warn">Off</Badge>}</p>
              <KeyValues rows={[["Inbound default", p.defaultInbound], ["Outbound default", p.defaultOutbound]]} />
              {!p.enabled && p.reenableAt && <p className="small"><Countdown until={p.reenableAt} /></p>}
              <ProfileControl key={`${p.profile}-${op.at}`} cabinet={cabinet} profile={p} write={profileWrite} />
            </article>))}</div>
          <PortCheck cabinetId={cabinet.id} firewall={out} />
          {allowed && <div className="row gap"><button className="btn" onClick={rules.add}>Add a rule…</button></div>}
          {rules.editor}
          <div className="row gap wrap filters">
            <label className="field inline"><span>Name or port</span><input value={filter.text} onChange={e => setFilter(x => ({ ...x, text: e.target.value }))} /></label>
            {(["direction", "action", "enabled"] as const).map(k => (
              <label key={k} className="field inline"><span>{k[0]!.toUpperCase() + k.slice(1)}</span>
                <select value={filter[k]} onChange={e => setFilter(x => ({ ...x, [k]: e.target.value }))}>
                  <option value="any">Any</option>
                  {(k === "direction" ? ["in", "out"] : k === "action" ? ["allow", "block"] : ["true", "false"]).map(v => <option key={v} value={v}>{v === "true" ? "Enabled" : v === "false" ? "Disabled" : v}</option>)}
                </select></label>))}
            <span className="muted small">{shown.length} of {out.rules.length} rules</span>
          </div>
          <PagedRows rows={shown} label="firewall rules">{page => (<ul className="rules" aria-label="Firewall rules">
            {page.map((r, i) => (
              <li key={i}><strong>{r.name}</strong> {r.createdByPlatform && <Badge tone="info">Platform</Badge>}{" "}
                <Badge tone={r.enabled ? "ok" : "off"}>{r.enabled ? "Enabled" : "Disabled"}</Badge>{" "}
                <span>{r.direction === "in" ? "Inbound" : "Outbound"} · {r.action} · {r.protocol ?? "any"}{r.localPorts ? ` · local ${r.localPorts}` : ""}{r.remotePorts ? ` · remote ${r.remotePorts}` : ""}</span>
                {r.programPath && <div className="muted small wrap">{r.programPath}</div>}
                {allowed && rules.actions(r)}
              </li>))}
          </ul>)}</PagedRows>
          {shown.length > 500 && <p className="muted small">Showing the first 500 matches; narrow the filter to see more.</p>}
        </>);
      }}
    </OperationPanel>
    {profileWrite.outcome}{rules.outcome}
    {op.result?.output && <Snapshots cabinet={cabinet} state={op.result.output} onChanged={changed} />}
    <FirewallHistory cabinet={cabinet} version={changes} />
    {rules.dialog}{profileWrite.dialog}
  </>);
}

export function Files({ cabinetId }: { cabinetId: string }) {
  const op = useOperation<FilesListOutput>(cabinetId, "files.list");
  const [path, setPath] = useState("C:\\");
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<"name" | "size" | "modified">("name");
  const open = (p: string, n = 1) => { setPath(p); setPage(n); void op.start({ path: p, page: n, pageSize: 200 }); };
  useEffect(() => { open("C:\\"); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const parts = useMemo(() => path.slice(3).split("\\").filter(Boolean), [path]);
  return (
    <OperationPanel title="Files" run={op}
      onRun={() => open(path, page)} buttonLabel="List">
      {out => (<>
        <nav aria-label="Folder path" className="crumbs"><ol>
          <li><button className="linkish" onClick={() => open("C:\\")}>C:</button></li>
          {parts.map((p, i) => <li key={i}><button className="linkish" onClick={() => open("C:\\" + parts.slice(0, i + 1).join("\\"))}>{p}</button></li>)}
        </ol></nav>
        <div className="row gap wrap filters">
          <label className="field inline"><span>Filter</span><input value={filter} onChange={e => setFilter(e.target.value)} placeholder="name" /></label>
          <label className="field inline"><span>Sort</span><select value={sort} onChange={e => setSort(e.target.value as typeof sort)}><option value="name">Name</option><option value="size">Size</option><option value="modified">Modified</option></select></label>
          <span className="muted small">{out.path}</span>
        </div>
        {out.entries.length === 0 ? <Empty>Empty folder.</Empty> : (
          <PagedRows rows={[...out.entries].filter(e => !filter || e.name.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => (a.type === b.type ? 0 : a.type === "directory" ? -1 : 1) || (sort === "size" ? (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) : sort === "modified" ? String(b.modifiedAt ?? "").localeCompare(String(a.modifiedAt ?? "")) : a.name.localeCompare(b.name)))} label="files and folders">{page => (<table className="table compact">
            <caption className="sr-only">Contents of {out.path}</caption>
            <thead><tr><th scope="col">Name</th><th scope="col">Size</th><th scope="col">Modified</th></tr></thead>
            <tbody>{page.map(e => (
              <tr key={e.name}>
                <th scope="row">{e.type === "directory"
                  ? <button className="linkish" onClick={() => open((out.path.endsWith("\\") ? out.path : out.path + "\\") + e.name)}>📁 {e.name}</button>
                  : <span>{e.name}</span>}</th>
                <td>{e.type === "file" ? bytes(e.sizeBytes) : "—"}</td><td>{fullTime(e.modifiedAt)}</td>
              </tr>))}
            </tbody>
          </table>)}</PagedRows>)}
        <div className="row gap">
          <button className="btn" disabled={out.page <= 1} onClick={() => open(out.path, out.page - 1)}>Previous</button>
          <button className="btn" disabled={!out.hasMore} onClick={() => open(out.path, out.page + 1)}>Next</button>
          <span className="muted small">Page {out.page}</span>
        </div>
      </>)}
    </OperationPanel>
  );
}

/** Machine-wide proxy and a copy of the whole read as `ipconfig /all`-style text. */
function AdapterTools({ cabinet, output }: { cabinet: CabinetDetail; output: { adapters: never[]; proxy?: { winHttp: string | null } | null } }) {
  const [copied, setCopied] = useState(false);
  const flush = useFlushDns(cabinet);
  const copy = async () => { try { await navigator.clipboard.writeText(ipconfigText(cabinet.name, output.adapters, output.proxy)); setCopied(true); } catch { setCopied(false); } };
  return (
    <p className="panel row gap wrap small">
      <span>WinHTTP proxy: <strong>{output.proxy === undefined || output.proxy === null ? "not reported" : output.proxy.winHttp ?? "direct access"}</strong></span>
      <button className="btn small" onClick={() => void copy()}>{copied ? "Copied" : "Copy as ipconfig text"}</button>
      {flush.button}
      {flush.outcome}{flush.dialog}
    </p>
  );
}
