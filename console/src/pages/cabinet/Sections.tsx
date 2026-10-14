// The diagnostic sections of the cabinet view, with their write actions (Writes.tsx) for the roles the catalog allows.
import { adapterRows, NeighborsTable, PingSummary, RoutesTable, TraceTable } from "../../components/NetworkReadings";
import { PacketPath } from "../../components/PacketPath";
import { DiagnoseNetwork } from "./Diagnose";
import { useEffect, useMemo, useState } from "react";
import type { DevicesListOutput, DiskSmartOutput, DriversListOutput, FilesListOutput, FirewallStateOutput, NetworkConfigOutput,
  NetworkTestOutput, NetworkTraceOutput, UpdatesStatusOutput } from "@mashura/cabinet-contracts/types";
import { useOperation } from "../../lib/commands";
import { bytes, fullTime } from "../../lib/time";
import { Badge, Empty, KeyValues, OperationPanel } from "../../components/ui";
import type { CabinetDetail } from "./CabinetPage";
import { AdapterEdit, Countdown, FirewallHistory, FirewallPolicyPanel, ProfileControl, Snapshots, useAdapterWrites, useCanWrite, useDriverUninstall, useProfileWrite, useRuleWrites, useUpdateRollback } from "./Writes";

export function DevicesDrivers({ cabinet }: { cabinet: CabinetDetail }) {
  const cabinetId = cabinet.id;
  const devices = useOperation<DevicesListOutput>(cabinetId, "devices.list");
  const drivers = useOperation<DriversListOutput>(cabinetId, "drivers.list");
  const [problemsOnly, setProblemsOnly] = useState(true);
  const [filter, setFilter] = useState("");
  const uninstall = useDriverUninstall(cabinet, () => void drivers.start());
  useEffect(() => { void devices.start({ problemsOnly: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (<>
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
            <table className="table compact">
              <caption className="sr-only">Devices</caption>
              <thead><tr><th scope="col">Device</th><th scope="col">Class</th><th scope="col">Status</th><th scope="col">Driver</th></tr></thead>
              <tbody>{rows.map(d => (
                <tr key={d.instanceId}>
                  <th scope="row">{d.name}<div className="muted small wrap">{d.instanceId}</div></th>
                  <td>{d.class ?? "—"}</td>
                  <td>{d.errorCode ? <><Badge tone="crit">Code {d.errorCode}</Badge><div className="small">{d.errorText}</div></> : <Badge tone="ok">{d.status}</Badge>}</td>
                  <td>{d.driver ? `${d.driver.name} ${d.driver.version ?? ""}` : "—"}</td>
                </tr>))}
              </tbody>
            </table>)}
          {out.truncated && <p className="muted small">Showing the first 5,000 devices.</p>}
        </>);
      }}
    </OperationPanel>
    <OperationPanel title="Installed drivers" run={drivers} onRun={() => void drivers.start()} buttonLabel="List drivers">
      {out => (
        <table className="table compact">
          <caption className="sr-only">Drivers</caption>
          <thead><tr><th scope="col">Published name</th><th scope="col">Original name</th><th scope="col">Class</th><th scope="col">Version</th><th scope="col">Provider</th><th scope="col">Signer</th>{uninstall.allowed && <th scope="col"><span className="sr-only">Actions</span></th>}</tr></thead>
          <tbody>{out.drivers.map(d => (
            <tr key={d.publishedName}><th scope="row">{d.publishedName}</th><td>{d.originalName ?? "—"}</td><td>{d.className ?? "—"}</td>
              <td>{d.version ?? "—"}</td><td>{d.provider ?? "—"}</td><td>{d.signer ?? <Badge tone="warn">Unsigned</Badge>}</td>{uninstall.allowed && <td>{uninstall.button(d)}</td>}</tr>))}
          </tbody>
        </table>)}
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
        <h3>History</h3>
        {out.installed.length === 0 ? <Empty>No update history.</Empty> : (
          <table className="table compact">
            <caption className="sr-only">Installed updates</caption>
            <thead><tr><th scope="col">Installed</th><th scope="col">Update</th><th scope="col">Result</th>{rollback.allowed && <th scope="col"><span className="sr-only">Roll back</span></th>}</tr></thead>
            <tbody>{out.installed.map((u, i) => <tr key={i}><td>{fullTime(u.installedAt)}</td><td>{u.title}</td>
              <td><Badge tone={RESULT_TONE[u.result] ?? "off"}>{u.result.replaceAll("_", " ")}</Badge>{u.errorCode ? <span className="muted small"> 0x{(u.errorCode >>> 0).toString(16)}</span> : null}</td>{rollback.allowed && <td>{u.result === "succeeded" ? rollback.button(u) : null}</td>}</tr>)}</tbody>
          </table>)}
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
  return (
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
  );
}

export function Network({ cabinet }: { cabinet: CabinetDetail }) {
  const cabinetId = cabinet.id;
  const config = useOperation<NetworkConfigOutput>(cabinetId, "network.config");
  const adapterWrites = useAdapterWrites(cabinet, () => void config.start());
  useEffect(() => { void config.start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const dnsCount = Math.min(4, Math.max(0, ...(config.result?.output?.adapters.filter(a => a.connected).map(a => a.dns.servers.length) ?? [0])));
  return (<>
    <DiagnoseNetwork cabinetId={cabinet.id} cabinetName={cabinet.name} />
    <OperationPanel title="Network adapters" run={config} onRun={() => void config.start()}>
      {out => <div className="cards">{out.adapters.map(a => (
        <article key={a.interfaceIndex} className="card" aria-label={`Adapter ${a.name}`}>
          <h3>{a.name} <Badge tone={a.connected ? "ok" : "off"}>{a.connected ? "Connected" : "Disconnected"}</Badge></h3>
          <KeyValues rows={adapterRows(a as never)} />
          <AdapterEdit key={`${a.interfaceIndex}-${config.at}`} cabinet={cabinet} adapter={a} writes={adapterWrites} />
        </article>))}</div>}
    </OperationPanel>
    {adapterWrites.outcome}{adapterWrites.dialog}
    {config.result?.output && (config.result.output.routes || config.result.output.neighbors) && (
      <section className="panel" aria-labelledby="routes-heading">
        <h2 id="routes-heading">Routes and ARP table</h2>
        <RoutesTable routes={(config.result.output.routes ?? []) as never} />
        <NeighborsTable neighbors={(config.result.output.neighbors ?? []) as never} />
      </section>)}
    <PacketPath cabinetId={cabinetId} dnsCount={dnsCount} />
    <section className="panel" aria-labelledby="tests-heading">
      <h2 id="tests-heading">Probes</h2>
      <div className="tests">
        {Array.from({ length: Math.max(dnsCount, 1) }, (_, i) => (
          <NetTest key={i} cabinetId={cabinetId} label={`DNS server ${i + 1} (lookup)`} params={{ target: "dns_server", method: "dns", dnsServerIndex: i }} />))}
        <SyncTcpTest cabinetId={cabinetId} />
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
          <ul className="rules" aria-label="Firewall rules">
            {shown.slice(0, 500).map((r, i) => (
              <li key={i}><strong>{r.name}</strong> {r.createdByPlatform && <Badge tone="info">Platform</Badge>}{" "}
                <Badge tone={r.enabled ? "ok" : "off"}>{r.enabled ? "Enabled" : "Disabled"}</Badge>{" "}
                <span>{r.direction === "in" ? "Inbound" : "Outbound"} · {r.action} · {r.protocol ?? "any"}{r.localPorts ? ` · local ${r.localPorts}` : ""}{r.remotePorts ? ` · remote ${r.remotePorts}` : ""}</span>
                {r.programPath && <div className="muted small wrap">{r.programPath}</div>}
                {allowed && rules.actions(r)}
              </li>))}
          </ul>
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
          <table className="table compact">
            <caption className="sr-only">Contents of {out.path}</caption>
            <thead><tr><th scope="col">Name</th><th scope="col">Size</th><th scope="col">Modified</th></tr></thead>
            <tbody>{[...out.entries].filter(e => !filter || e.name.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => (a.type === b.type ? 0 : a.type === "directory" ? -1 : 1) || (sort === "size" ? (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) : sort === "modified" ? String(b.modifiedAt ?? "").localeCompare(String(a.modifiedAt ?? "")) : a.name.localeCompare(b.name))).map(e => (
              <tr key={e.name}>
                <th scope="row">{e.type === "directory"
                  ? <button className="linkish" onClick={() => open((out.path.endsWith("\\") ? out.path : out.path + "\\") + e.name)}>📁 {e.name}</button>
                  : <span>{e.name}</span>}</th>
                <td>{e.type === "file" ? bytes(e.sizeBytes) : "—"}</td><td>{fullTime(e.modifiedAt)}</td>
              </tr>))}
            </tbody>
          </table>)}
        <div className="row gap">
          <button className="btn" disabled={out.page <= 1} onClick={() => open(out.path, out.page - 1)}>Previous</button>
          <button className="btn" disabled={!out.hasMore} onClick={() => open(out.path, out.page + 1)}>Next</button>
          <span className="muted small">Page {out.page}</span>
        </div>
      </>)}
    </OperationPanel>
  );
}
