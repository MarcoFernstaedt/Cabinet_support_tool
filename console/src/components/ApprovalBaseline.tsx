// The baseline decision in a pending cabinet's approval (docs/spec/15-baselines-and-config.md "Baselines at enrollment"). It shows which
// approved baseline would apply at the chosen client and site, and with none the approver attaches an approved one or asks for a capture.
// The server checks the decision again; this only collects it.
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { choiceAfterPreview, inForceText, type BaselineChoice, type BaselinePreview } from "../lib/approval-baseline";
import { Badge } from "./ui";

const SCOPE_LABEL: Record<string, string> = { global: "fleet", model: "model", client: "client", site: "site" };

/** Reads what applies for the client and site as they are typed, and keeps the choice sensible when it changes. */
export function useBaselinePreview(requestId: string, client: string, site: string, setChoice: (f: (c: BaselineChoice) => BaselineChoice) => void) {
  const [preview, setPreview] = useState<BaselinePreview | null>(null);
  const c = client.trim(), s = site.trim();
  useEffect(() => {
    setPreview(null);
    if (!c || !s) return;
    let live = true;
    // A short pause so typing a name does not send a request per letter.
    const t = setTimeout(() => {
      void api<BaselinePreview>("GET", `/api/admin/enrollments/${requestId}/baseline?${new URLSearchParams({ client: c, site: s })}`)
        .then(p => { if (live) { setPreview(p); setChoice(choice => choiceAfterPreview(choice, p)); } })
        .catch(() => undefined);
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [requestId, c, s, setChoice]);
  return preview;
}

export function BaselineFields({ name, preview, choice, onChoice, attachId, onAttach }: {
  name: string; preview: BaselinePreview | null; choice: BaselineChoice; onChoice: (c: BaselineChoice) => void; attachId: string; onAttach: (id: string) => void;
}) {
  if (!preview) return <p className="muted small">Enter the client and site to see which baseline applies.</p>;
  const inForce = preview.inForce;
  return (
    <fieldset className="stack" aria-label="Baseline">
      <legend>Baseline</legend>
      {inForce.length > 0 ? <p className="small">{inForceText(inForce)}.</p>
        : <p className="small"><Badge tone="warn">Baseline required</Badge> No approved baseline applies to this site. Choose one.</p>}
      {preview.modelBaselines > 0 && <p className="muted small">A model baseline may also apply once the cabinet reports its model.</p>}
      {inForce.length > 0 && <label><input type="radio" name={`${name}-baseline`} checked={choice === "inherited"} onChange={() => onChoice("inherited")} /> Use the baseline in force</label>}
      {!preview.siteHasOwn && (
        <label><input type="radio" name={`${name}-baseline`} checked={choice === "attach"} disabled={preview.choices.length === 0} onChange={() => onChoice("attach")} /> Attach an approved baseline to this site
          {preview.choices.length === 0 && <span className="muted small"> (none approved yet)</span>}</label>)}
      {choice === "attach" && (
        <label className="field"><span>Approved baseline</span>
          <select required value={attachId} onChange={e => onAttach(e.target.value)}>
            <option value="">Choose</option>
            {preview.choices.map(c => <option key={c.versionId} value={c.versionId}>{c.name} ({SCOPE_LABEL[c.scope] ?? c.scope}, v{c.version})</option>)}
          </select></label>)}
      <label><input type="radio" name={`${name}-baseline`} checked={choice === "capture"} onChange={() => onChoice("capture")} /> Capture this cabinet&apos;s configuration as the site baseline draft</label>
      {choice === "capture" && <span className="muted small">Taken from its first full report after it comes online. An Admin other than you approves it under Admin, Baselines.</span>}
    </fieldset>
  );
}
