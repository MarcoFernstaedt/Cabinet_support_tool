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

const CHECK_NAME: Record<string, string> = {
  device_present: "Scanner plugged in", no_device_error: "No Windows device error", driver_installed: "Driver installed", driver_signed: "Driver signed",
  usb_power_saving: "USB power saving", recent_reconnects: "Reconnects in the last 24 hours", usb_controller_errors: "USB controllers and hubs", biometric_service: "Windows Biometric Service",
};

export function Scanner({ cabinet, onSettingsChanged }: { cabinet: CabinetDetail; onSettingsChanged: () => void }) {
  const status = useOperation<PeripheralStatusOutput>(cabinet.id, "peripheral.status");
  useEffect(() => { void status.start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const rerun = () => void status.start();
  return (<>
    <OperationPanel title="Fingerprint scanner" description="Runs the standard scanner troubleshooting on the cabinet and says what to try next."
      run={status} onRun={rerun} buttonLabel="Check the scanner">
      {out => <ScannerResult out={out} cabinet={cabinet} onUse={() => { onSettingsChanged(); rerun(); }} />}
    </OperationPanel>
    <CabinetAlerts cabinetId={cabinet.id} issueTypeId={SCANNER_ISSUE} title="Scanner alerts" />
    <ScannerIds cabinet={cabinet} onSaved={() => { onSettingsChanged(); rerun(); }} />
  </>);
}

function ScannerResult({ out, cabinet, onUse }: { out: PeripheralStatusOutput; cabinet: CabinetDetail; onUse: () => void }) {
  const problems = out.checks.filter(c => c.outcome === "fail" || c.outcome === "warn");
  return (<>
    <p className="lead">
      {!out.configured ? <Badge tone="warn">Scanner hardware ID not set</Badge>
        : out.connected ? <Badge tone="ok">Scanner connected</Badge> : <Badge tone="crit">Scanner not connected</Badge>}
      {" "}{problems.length === 0 && out.configured ? "Every check passed." : `${problems.length} check${problems.length === 1 ? "" : "s"} need attention.`}
    </p>
    <ul className="checklist" aria-label="Scanner checks">
      {out.checks.map(c => (
        <li key={c.check} className={`check-${c.outcome}`}>
          <Badge tone={OUTCOME_TONE[c.outcome]}>{OUTCOME_LABEL[c.outcome]}</Badge>
          <div><strong>{CHECK_NAME[c.check] ?? c.check}</strong><div>{c.summary}</div></div>
        </li>))}
    </ul>
    {out.configured && (
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

/** Likely scanners, with a one-click way to make one this cabinet's scanner (Tier 2 and Admin, with step-up). */
function Candidates({ out, cabinet, onUse }: { out: PeripheralStatusOutput; cabinet: CabinetDetail; onUse: () => void }) {
  const { me } = useSession();
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="group">
      <h3>Likely scanners on this cabinet</h3>
      <table className="table compact">
        <caption className="sr-only">Biometric and fingerprint devices</caption>
        <thead><tr><th scope="col">Device</th><th scope="col">Connected</th><th scope="col">Hardware IDs</th>{atLeast(me, "tier2") && <th scope="col"><span className="sr-only">Action</span></th>}</tr></thead>
        <tbody>{out.candidates.map(c => (
          <tr key={c.instanceId}>
            <th scope="row">{c.name}<div className="muted small">{c.class ?? ""}</div></th>
            <td>{c.connected ? <Badge tone="ok">Connected</Badge> : <Badge tone="off">Not connected</Badge>}</td>
            <td className="wrap"><code>{c.hardwareIds.join(", ")}</code></td>
            {atLeast(me, "tier2") && <td><button className="btn small" disabled={c.hardwareIds.length === 0} onClick={() => { setProblem(null); setChosen(c.hardwareIds.slice(0, 16)); }}>Use as this cabinet's scanner</button></td>}
          </tr>))}
        </tbody>
      </table>
      {problem && <p className="error" role="alert">{problem}</p>}
      <StepUpDialog open={chosen !== null} action="cabinet.scanner" target={cabinet.id} onClose={() => setChosen(null)}
        description={<p>Use <code>{chosen?.join(", ")}</code> as the fingerprint scanner on <strong>{cabinet.name}</strong>. This changes which device the scanner checks look at; nothing changes on the cabinet itself.</p>}
        onToken={async token => {
          try { await api("PUT", `/api/cabinets/${cabinet.id}/scanner`, { hardwareIds: chosen, stepUpToken: token }); onUse(); }
          catch (e) { setProblem(describeError(e)); }
        }} />
    </div>
  );
}

function ScannerIds({ cabinet, onSaved }: { cabinet: CabinetDetail; onSaved: () => void }) {
  const { me } = useSession();
  const [text, setText] = useState((cabinet.scanner.cabinetHardwareIds ?? []).join("\n"));
  const [pending, setPending] = useState<string[] | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const source = cabinet.scanner.cabinetHardwareIds ? "this cabinet's own setting"
    : cabinet.scanner.fleetHardwareIds ? "the fleet default" : "the cabinet's local configuration (none set in the console)";
  const ids = text.split(/\s+/).map(s => s.trim()).filter(Boolean);
  return (
    <section className="panel" aria-labelledby="scanner-ids">
      <h2 id="scanner-ids">Scanner hardware IDs</h2>
      <p>In use: {cabinet.scanner.effective?.length ? <code>{cabinet.scanner.effective.join(", ")}</code> : <span className="muted">none</span>} <span className="muted">— from {source}.</span></p>
      <p className="muted small">The fleet default is set by an admin under <Link to="/admin/scanner">Admin → Scanner default</Link>. A cabinet with a different scanner model can have its own IDs here.</p>
      {atLeast(me, "tier2") && (
        <form onSubmit={e => { e.preventDefault(); setProblem(null); setPending(ids.length ? ids : null); }} className="stack">
          <label className="field"><span>This cabinet's scanner IDs (one per line; leave empty to use the fleet default)</span>
            <textarea rows={3} value={text} onChange={e => setText(e.target.value)} placeholder={"USB\\VID_1234&PID_5678"} /></label>
          <div className="row gap"><button className="btn" disabled={ids.length > 16}>Save for this cabinet</button>{ids.length > 16 && <span className="error">At most 16 IDs.</span>}</div>
          {problem && <p className="error" role="alert">{problem}</p>}
        </form>
      )}
      <StepUpDialog open={pending !== undefined} action="cabinet.scanner" target={cabinet.id} onClose={() => setPending(undefined)}
        description={<p>{pending ? <>Set the scanner IDs for <strong>{cabinet.name}</strong> to <code>{pending.join(", ")}</code>.</> : <>Remove <strong>{cabinet.name}</strong>'s own scanner IDs and use the fleet default.</>}</p>}
        onToken={async token => {
          try { await api("PUT", `/api/cabinets/${cabinet.id}/scanner`, { hardwareIds: pending ?? null, stepUpToken: token }); onSaved(); }
          catch (e) { setProblem(describeError(e)); }
        }} />
    </section>
  );
}
