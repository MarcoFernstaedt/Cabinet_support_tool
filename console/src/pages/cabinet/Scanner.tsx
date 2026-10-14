// The fingerprint scanner: status, the automated troubleshooting checklist, likely scanners
// when none is configured, and the scanner's hardware IDs, editable in the console.
import { useEffect, useState } from "react";
import type { PeripheralStatusOutput } from "@mashura/cabinet-contracts/types";
import { api, describeError } from "../../lib/api";
import { useOperation } from "../../lib/commands";
import { atLeast, useSession } from "../../lib/session";
import { fullTime } from "../../lib/time";
import { Link } from "../../lib/router";
import { Badge, KeyValues, OperationPanel, OUTCOME_LABEL, OUTCOME_TONE, StepUpDialog } from "../../components/ui";
import type { CabinetDetail } from "./CabinetPage";
import { CabinetAlerts, SCANNER_ISSUE } from "./CabinetAlerts";
import { PackageList, type LibraryPackage } from "./Software";
import { useLoad } from "../../lib/useLoad";
import { SCANNER_SOURCE, ScannerIdsEditor } from "../../components/DeviceSettings";
import { UsbPorts } from "../../components/UsbPorts";

interface History { drops24h: number; drops7d: number; offNow: boolean; lead: string | null; firstDropAt: string | null;
  episodes: { at: string; state: string }[]; changes: { at: string; kind: "driver" | "update"; title: string; relatedToScanner: boolean; hoursBeforeFirstDrop: number }[] }

/** How often the scanner has dropped off lately, and what was installed on the cabinet just before it started. */
function Drops({ cabinetId }: { cabinetId: string }) {
  const { data } = useLoad<History>(`/api/cabinets/${cabinetId}/scanner-history`);
  if (!data || data.drops7d === 0) return null;
  const timeline = [...data.episodes.map(e => ({ at: e.at, text: e.state === "recovered" ? "Scanner came back" : e.state === "disconnected" ? "Scanner dropped off" : e.state === "driver_missing" ? "Scanner had no driver" : "Scanner reported an error", tone: e.state === "recovered" ? "ok" as const : "crit" as const })),
    ...data.changes.map(c => ({ at: c.at, text: `${c.kind === "driver" ? "Driver installed" : "Windows update installed"}: ${c.title}`, tone: "info" as const }))].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <section className="panel" aria-labelledby="drops-heading">
      <h2 id="drops-heading" data-tour="scanner-drops">Drops <Badge tone={data.drops24h >= 3 ? "crit" : "warn"}>{data.drops24h} in the last 24 hours</Badge></h2>
      {data.lead && <p>{data.lead}</p>}
      <ol className="timeline">{timeline.map((t, i) => (
        <li key={i}><span className="when" title={fullTime(t.at)}>{fullTime(t.at)}</span><span className="what"><Badge tone={t.tone}>{t.text.split(":")[0]!}</Badge>{t.text.includes(":") ? t.text.slice(t.text.indexOf(":")) : ""}</span></li>))}</ol>
      {data.changes.some(c => c.kind === "driver") && <p className="small muted">Next: look at the driver under Devices and drivers. If the software library has the previous version for this scanner, it can go back on from Scanner drivers, further down this page.</p>}
    </section>
  );
}

const CHECK_NAME: Record<string, string> = {
  device_present: "Scanner plugged in", no_device_error: "No Windows device error", driver_installed: "Driver installed", driver_signed: "Driver signed",
  usb_power_saving: "USB power saving", recent_reconnects: "Reconnects in the last 24 hours", usb_controller_errors: "USB controllers and hubs", biometric_service: "Windows Biometric Service",
};

export function Scanner({ cabinet, onSettingsChanged }: { cabinet: CabinetDetail; onSettingsChanged: () => void }) {
  const status = useOperation<PeripheralStatusOutput>(cabinet.id, "peripheral.status");
  useEffect(() => { void status.start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const rerun = () => void status.start();
  return (<>
    <Drops cabinetId={cabinet.id} />
    <OperationPanel title="Fingerprint scanner"
      run={status} onRun={rerun} buttonLabel="Check the scanner">
      {out => <ScannerResult out={out} cabinet={cabinet} onUse={() => { onSettingsChanged(); rerun(); }} />}
    </OperationPanel>
    <UsbPorts cabinetId={cabinet.id} scannerIds={status.result?.output?.hardwareIds ?? []} scannerName={status.result?.output?.name ?? null} />
    <CabinetAlerts cabinetId={cabinet.id} issueTypeId={SCANNER_ISSUE} title="Scanner alerts" />
    <ScannerIds cabinet={cabinet} onSaved={() => { onSettingsChanged(); rerun(); }} />
    <ScannerDrivers cabinet={cabinet} />
  </>);
}

/** Approved driver packages for this cabinet's scanner hardware IDs, with Install (Tier 2 and Admin). */
function ScannerDrivers({ cabinet }: { cabinet: CabinetDetail }) {
  const { data, problem } = useLoad<LibraryPackage[]>("/api/packages");
  const ids = new Set((cabinet.scanner.effective ?? []).map(h => h.toUpperCase()));
  const drivers = (data ?? []).filter(p => p.type === "driver" && p.hardwareIds.some(h => ids.has(h.toUpperCase())));
  return (
    <section className="panel" aria-labelledby="scanner-drivers-heading">
      <h3 id="scanner-drivers-heading">Scanner drivers from the software library</h3>
      {problem && <p className="error" role="alert">{problem}</p>}
      {ids.size === 0 ? <p className="muted">Set the scanner's hardware IDs to see matching driver packages.</p>
        : data && <PackageList cabinet={cabinet} packages={drivers} empty="No approved driver package lists this scanner's hardware IDs." />}
    </section>
  );
}

function ScannerResult({ out, cabinet, onUse }: { out: PeripheralStatusOutput; cabinet: CabinetDetail; onUse: () => void }) {
  const problems = out.checks.filter(c => c.outcome === "fail" || c.outcome === "warn");
  return (<>
    <p className="lead">
      {!out.configured && !out.name ? <Badge tone="warn">No scanner found</Badge>
        : out.connected ? <Badge tone="ok">Scanner connected</Badge> : <Badge tone="crit">Scanner not connected</Badge>}
      {!out.configured && out.name && <> <Badge tone="info">Found automatically</Badge></>}
      {" "}{problems.length === 0 && (out.configured || out.name) ? "Every check passed." : `${problems.length} check${problems.length === 1 ? " needs" : "s need"} attention.`}
    </p>
    <ul className="checklist" aria-label="Scanner checks">
      {out.checks.map(c => (
        <li key={c.check} className={`check-${c.outcome}`}>
          <Badge tone={OUTCOME_TONE[c.outcome]}>{OUTCOME_LABEL[c.outcome]}</Badge>
          <div><strong>{CHECK_NAME[c.check] ?? c.check}</strong><div>{c.summary}</div></div>
        </li>))}
    </ul>
    {(out.configured || out.name) && (
      <KeyValues rows={[
        ["Device", out.name], ["Windows status", out.status], ["USB port", out.locationInfo],
        ["Error", out.errorCode ? `Code ${out.errorCode}: ${out.errorText ?? ""}` : "none"],
        ["Driver", out.driver ? `${out.driver.name}${out.driver.version ? " " + out.driver.version : ""}` : null],
        ["Driver date", out.driver?.date ? fullTime(out.driver.date) : null], ["Signed by", out.driver?.signer ?? null],
        ["Hardware IDs", out.hardwareIds.length ? out.hardwareIds.join(", ") : null],
      ]} />
    )}
    {out.candidates.length > 0 && <Candidates out={out} cabinet={cabinet} onUse={onUse} />}
    {!out.configured && out.candidates.length === 0 && <p className="muted">No biometric or fingerprint device is visible to Windows on this cabinet. Check the scanner is plugged in, then run the check again.</p>}
  </>);
}

/** Likely scanners, with a one-click way to make one the scanner for this cabinet, its site or its whole client (Tier 2 and Admin, with step-up). */
function Candidates({ out, cabinet, onUse }: { out: PeripheralStatusOutput; cabinet: CabinetDetail; onUse: () => void }) {
  const { me } = useSession();
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [level, setLevel] = useState<"cabinet" | "site" | "client">("client");
  const [problem, setProblem] = useState<string | null>(null);
  const target = { cabinet: cabinet.id, site: cabinet.site.id, client: cabinet.client.id }[level];
  const what = { cabinet: <strong>{cabinet.name}</strong>, site: <>every cabinet at <strong>{cabinet.site.name}</strong></>, client: <>every cabinet of <strong>{cabinet.client.name}</strong></> }[level];
  return (
    <div className="group">
      <h3>Likely scanners on this cabinet</h3>
      {atLeast(me, "tier2") && (
        <label className="field inline"><span>Use a device as the scanner for</span>
          <select value={level} onChange={e => setLevel(e.target.value as typeof level)}>
            <option value="client">All of {cabinet.client.name}</option><option value="site">This site ({cabinet.site.name})</option><option value="cabinet">This cabinet only</option>
          </select></label>)}
      <table className="table compact">
        <caption className="sr-only">Biometric and fingerprint devices</caption>
        <thead><tr><th scope="col">Device</th><th scope="col">Connected</th><th scope="col">Hardware IDs</th>{atLeast(me, "tier2") && <th scope="col"><span className="sr-only">Action</span></th>}</tr></thead>
        <tbody>{out.candidates.map(c => (
          <tr key={c.instanceId}>
            <th scope="row">{c.name}<div className="muted small">{c.class ?? ""}</div></th>
            <td>{c.connected ? <Badge tone="ok">Connected</Badge> : <Badge tone="off">Not connected</Badge>}</td>
            <td className="wrap"><code>{c.hardwareIds.join(", ")}</code></td>
            {atLeast(me, "tier2") && <td><div className="row gap wrap">
              <button className="btn small" disabled={c.hardwareIds.length === 0} onClick={() => { setProblem(null); setChosen(modelIds(c.hardwareIds)); }}>Use this model</button>
              {vendorId(c.hardwareIds) && <button className="btn small" onClick={() => { setProblem(null); setChosen([vendorId(c.hardwareIds)!]); }}>Any model from this vendor</button>}
            </div></td>}
          </tr>))}
        </tbody>
      </table>
      {problem && <p className="error" role="alert">{problem}</p>}
      <StepUpDialog open={chosen !== null} action={`${level}.scanner`} target={target} onClose={() => setChosen(null)} params={{ hardwareIds: chosen }}
        description={<p>Use <code>{chosen?.join(", ")}</code> as the fingerprint scanner for {what}. This changes which device the scanner checks look at; nothing changes on the cabinets themselves.</p>}
        onToken={async token => {
          try { await api("PUT", `/api/${level}s/${target}/scanner`, { hardwareIds: chosen, stepUpToken: token }); onUse(); }
          catch (e) { setProblem(describeError(e)); }
        }} />
    </div>
  );
}

/** The model's IDs without the revision, so a firmware update does not stop it matching (a revision-only ID is kept if that is all there is). */
function modelIds(ids: string[]): string[] {
  const models = ids.filter(id => !/&REV_[0-9A-F]+$/i.test(id));
  return (models.length ? models : ids).slice(0, 16);
}

/** USB\VID_xxxx from a USB hardware ID, which matches every model from that vendor. */
function vendorId(ids: string[]): string | null {
  for (const id of ids) { const m = /^(USB\\VID_[0-9A-F]{4})&/i.exec(id); if (m) return m[1]!.toUpperCase(); }
  return null;
}

function ScannerIds({ cabinet, onSaved }: { cabinet: CabinetDetail; onSaved: () => void }) {
  const { me } = useSession();
  const sc = cabinet.scanner;
  const above = sc.siteHardwareIds ? <>the site's setting applies (<code>{sc.siteHardwareIds.join(", ")}</code>).</>
    : sc.clientHardwareIds ? <>the client's setting applies (<code>{sc.clientHardwareIds.join(", ")}</code>).</>
    : sc.fleetHardwareIds ? <>the fleet default applies (<code>{sc.fleetHardwareIds.join(", ")}</code>).</> : "the cabinet finds its scanner automatically (the Biometric device).";
  return (
    <section className="panel" aria-labelledby="scanner-ids">
      <h2 id="scanner-ids">Scanner hardware IDs</h2>
      <p>In use: {sc.effective?.length ? <code>{sc.effective.join(", ")}</code> : <span className="muted">automatic detection (the Biometric device)</span>}{sc.effective?.length ? <span className="muted"> — from {SCANNER_SOURCE[sc.source] ?? sc.source}.</span> : null}</p>
      <p className="muted small">Usually set once for the whole client, on <Link to={`/clients/${cabinet.client.id}`}>{cabinet.client.name}</Link>; a site (<Link to={`/sites/${cabinet.site.id}`}>{cabinet.site.name}</Link>) or this cabinet can differ.
        The fleet default is under <Link to="/admin/scanner">Admin → Device defaults</Link>.</p>
      <ScannerIdsEditor label="This cabinet's own scanner IDs" current={sc.cabinetHardwareIds} inherited={above}
        endpoint={`/api/cabinets/${cabinet.id}/scanner`} action="cabinet.scanner" target={cabinet.id} what={cabinet.name} editable={atLeast(me, "tier2")} onSaved={onSaved} />
    </section>
  );
}
