// Editors for the device settings that follow the client: the fingerprint scanner's hardware IDs and the sync
// cabinet's TCP ports. Each level (fleet, client, site, cabinet) is edited the same way; an empty value removes
// that level's setting so the level above applies. The server enforces roles and needs a step-up for each change.
import { useState, type ReactNode } from "react";
import { api, describeError } from "../lib/api";
import { parseSyncPorts, SYNC_PORTS_RULE } from "../lib/ports";
import { StepUpDialog } from "./ui";

export const SCANNER_SOURCE: Record<string, string> = {
  cabinet: "this cabinet's own setting", site: "the site's setting", client: "the client's setting", fleet: "the fleet default",
  automatic: "nowhere: the cabinet finds its scanner automatically (the Biometric device)",
};
export const PORTS_SOURCE: Record<string, string> = { site: "this site's own setting", client: "the client's default", fleet: "the fleet default", none: "nowhere (no ports set)" };

const parseIds = (text: string) => text.split(/\s+/).map(s => s.trim()).filter(Boolean);

/** One level's scanner hardware IDs. */
export function ScannerIdsEditor({ label, current, inherited, endpoint, action, target, what, editable, onSaved }: {
  label: string; current: string[] | null; inherited: ReactNode; endpoint: string; action: string; target: string; what: string; editable: boolean; onSaved: () => void;
}) {
  const [text, setText] = useState((current ?? []).join("\n"));
  const [pending, setPending] = useState<string[] | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const ids = parseIds(text);
  return (
    <div className="stack">
      <p>{current?.length ? <>Set here: <code>{current.join(", ")}</code></> : <>Nothing set here; {inherited}</>}</p>
      {editable && (
        <form className="stack" onSubmit={e => { e.preventDefault(); setProblem(null); setSaved(false); setPending(ids.length ? ids : null); }}>
          <label className="field"><span>{label} (one per line; a vendor ID such as <code>USB\VID_1234</code> matches every model from that vendor; empty to remove)</span>
            <textarea rows={3} value={text} onChange={e => setText(e.target.value)} placeholder={"USB\\VID_1234\nUSB\\VID_1234&PID_5678"} /></label>
          <div className="row gap"><button className="btn" disabled={ids.length > 16}>Save</button>
            {ids.length > 16 && <span className="error">At most 16 IDs.</span>}
            {saved && <span className="ok" role="status">Saved. Cabinets use it from their next heartbeat.</span>}</div>
          {problem && <p className="error" role="alert">{problem}</p>}
        </form>)}
      <StepUpDialog open={pending !== undefined} action={action} target={target} onClose={() => setPending(undefined)}
        description={<p>{pending ? <>Use <code>{pending.join(", ")}</code> as the fingerprint scanner for {what}.</> : <>Remove the scanner IDs set for {what}.</>}
          {" "}This changes which device the scanner checks look at; nothing changes on the cabinets themselves.</p>}
        onToken={async token => {
          try { await api("PUT", endpoint, { hardwareIds: pending ?? null, stepUpToken: token }); setSaved(true); onSaved(); }
          catch (e) { setProblem(describeError(e)); }
        }} />
    </div>
  );
}

/** One level's sync cabinet TCP ports (client or fleet; a site's are edited with its address). */
export function PortsEditor({ current, inherited, endpoint, action, target, what, editable, onSaved }: {
  current: number[] | null; inherited: ReactNode; endpoint: string; action: string; target: string; what: string; editable: boolean; onSaved: () => void;
}) {
  const [text, setText] = useState((current ?? []).join(", "));
  const [pending, setPending] = useState<number[] | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { ports, valid } = parseSyncPorts(text);
  return (
    <div className="stack">
      <p>{current ? <>Set here: <strong>{current.length ? current.join(", ") : "none"}</strong></> : <>Nothing set here; {inherited}</>}</p>
      {editable && (
        <form className="row gap wrap" onSubmit={e => { e.preventDefault(); setProblem(null); setSaved(false); setPending(ports.length ? ports : null); }}>
          <label className="field inline"><span>TCP ports (up to 4, comma separated; empty to remove)</span><input value={text} placeholder="e.g. 1433, 5000" onChange={e => setText(e.target.value)} /></label>
          <button className="btn" disabled={!valid}>Save</button>
          {!valid && <span className="error">{SYNC_PORTS_RULE}</span>}
          {saved && <span className="ok" role="status">Saved.</span>}
          {problem && <span className="error" role="alert">{problem}</span>}
        </form>)}
      <StepUpDialog open={pending !== undefined} action={action} target={target} onClose={() => setPending(undefined)}
        description={<p>{pending ? <>Use ports <strong>{pending.join(", ")}</strong> for the sync cabinet tests of {what}.</> : <>Remove the sync ports set for {what}.</>}</p>}
        onToken={async token => {
          try { await api("PUT", endpoint, { ports: pending ?? null, stepUpToken: token }); setSaved(true); onSaved(); }
          catch (e) { setProblem(describeError(e)); }
        }} />
    </div>
  );
}
