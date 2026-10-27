// Whether a client uses a fingerprint scanner (docs/spec/05-server-spec.md "Fingerprint scanner per client"). On: the scanner's service is
// added to the client's approved list (waiting for the Admin's signature when signing is on) and to its watched services. Off: no scanner
// checks, alerts or watching for the client's cabinets. The server checks the role, the code and every field; this only collects them.
import { useState } from "react";
import { api } from "../lib/api";
import { useStepUp } from "./StepUp";
import { Badge } from "./ui";
import { choiceFrom, EMPTY_FIELDS, type ClientScannerState, type ScannerChoice, type ScannerFields } from "../lib/scanner-choice";

export { choiceFrom, EMPTY_FIELDS, type ClientScannerState, type ScannerChoice, type ScannerFields };

/** The inputs for a scanner that is switched on: the service's display name, its key name, its program, and optional hardware IDs. */
export function ScannerServiceFields({ fields, onChange, idPrefix }: { fields: ScannerFields; onChange: (f: ScannerFields) => void; idPrefix: string }) {
  const set = (k: keyof ScannerFields) => (e: { target: { value: string } }) => onChange({ ...fields, [k]: e.target.value });
  return (
    <>
      <label className="field"><span>Service display name</span><input id={`${idPrefix}-name`} maxLength={128} value={fields.name} onChange={set("name")} /></label>
      <label className="field"><span>Service key name</span><input id={`${idPrefix}-service`} maxLength={80} placeholder="e.g. BioScanSvc" value={fields.serviceName} onChange={set("serviceName")} /></label>
      <label className="field"><span>Service program</span><input id={`${idPrefix}-path`} maxLength={260} placeholder="C:\Program Files\Vendor\scanner.exe" value={fields.path} onChange={set("path")} /></label>
      <label className="field"><span>Scanner hardware IDs (optional, comma separated)</span><input id={`${idPrefix}-ids`} maxLength={600} placeholder="USB\VID_1234&PID_5678" value={fields.hardwareIds} onChange={set("hardwareIds")} /></label>
    </>
  );
}

const APPROVAL: Record<string, { tone: "ok" | "warn" | "crit"; text: string }> = {
  approved: { tone: "ok", text: "Approved and watched" },
  waiting: { tone: "warn", text: "Waiting for the approved-list signature" },
  missing: { tone: "crit", text: "Not on the approved list" },
};

/** The client page's panel: the current setting, and for an Admin the switch. */
export function ClientScannerPanel({ clientId, name, state, admin, onSaved }: { clientId: string; name: string; state: ClientScannerState | null; admin: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState<ScannerFields>(EMPTY_FIELDS);
  const step = useStepUp();
  const save = (choice: ScannerChoice) => step.ask("client.fingerprint_scanner", clientId,
    choice.enabled ? <p>Use a fingerprint scanner at <strong>{name}</strong>: add <strong>{choice.service!.serviceName}</strong> to its approved programs and watched services.</p>
      : <p>Stop using a fingerprint scanner at <strong>{name}</strong>. Scanner checks and alerts stop, open scanner alerts are resolved, and the scanner's service is no longer watched.</p>,
    async t => { await api("PUT", `/api/clients/${clientId}/fingerprint-scanner`, { scanner: choice, stepUpToken: t }); setEditing(false); onSaved(); },
    { scanner: choice });
  const choice = choiceFrom(fields);
  if (!state) return null;
  const status = APPROVAL[state.approval ?? ""];
  return (
    <div className="stack">
      <p>{state.enabled ? <>Used. {state.service ? <>Service <code>{state.service}</code>{status && <> · <Badge tone={status.tone}>{status.text}</Badge></>}</> : "Service not set up through the platform."}</>
        : "Not used: no scanner checks, alerts or watching for this client's cabinets."}</p>
      {admin && !editing && (
        <span className="row gap">
          {(!state.enabled || !state.service) && <button className="btn small" onClick={() => setEditing(true)}>{state.enabled ? "Set up the scanner's service" : "Use a fingerprint scanner"}</button>}
          {state.enabled && <button className="btn small" onClick={() => save({ enabled: false })}>Stop using a fingerprint scanner</button>}
        </span>)}
      {admin && editing && (
        <form className="row gap wrap" onSubmit={e => { e.preventDefault(); if (choice) save(choice); }}>
          <ScannerServiceFields fields={fields} onChange={setFields} idPrefix={`client-scanner-${clientId}`} />
          <button className="btn small primary" disabled={!choice}>Use this scanner service</button>
          <button type="button" className="btn small" onClick={() => setEditing(false)}>Cancel</button>
        </form>)}
      {step.dialog}
    </div>
  );
}
