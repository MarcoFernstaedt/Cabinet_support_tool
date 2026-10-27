// The baseline decision in a pending cabinet's approval (docs/spec/15-baselines-and-config.md "Baselines at enrollment"). It shows which
// approved baseline would apply at the chosen client and site, and with none the approver attaches an approved one or asks for a capture.
// The server checks the decision again; this only collects it.
import { useEffect, useState } from "react";
import { api, describeError } from "../lib/api";
import { choiceAfterPreview, inForceText, type BaselineChoice, type BaselinePreview } from "../lib/approval-baseline";
import { Badge } from "./ui";

const SCOPE_LABEL: Record<string, string> = { global: "fleet", model: "model", client: "client", site: "site" };

/** What the approval knows about baselines: nothing asked yet, the answer, or why it could not be read (with a way to ask again). */
export interface BaselinePreviewState { preview: BaselinePreview | null; problem: string | null; retry: () => void }

/** Reads what applies for the client and site as they are typed, and keeps the choice sensible when it changes. */
export function useBaselinePreview(requestId: string, client: string, site: string, setChoice: (f: (c: BaselineChoice) => BaselineChoice) => void): BaselinePreviewState {
  const [preview, setPreview] = useState<BaselinePreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const c = client.trim(), s = site.trim();
  useEffect(() => {
    setPreview(null);
    setProblem(null);
    if (!c || !s) return;
    let live = true;
    // A short pause so typing a name does not send a request per letter.
    const t = setTimeout(() => {
      void api<BaselinePreview>("GET", `/api/admin/enrollments/${requestId}/baseline?${new URLSearchParams({ client: c, site: s })}`)
        .then(p => { if (live) { setPreview(p); setChoice(choice => choiceAfterPreview(choice, p)); } })
        // Said, with a way back: a failed read must not leave Approve disabled with nothing to act on.
        .catch(e => { if (live) setProblem(describeError(e)); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [requestId, c, s, setChoice, attempt]);
  return { preview, problem, retry: () => setAttempt(a => a + 1) };
}

export function BaselineFields({ name, state, filled, choice, onChoice, attachId, onAttach }: {
  name: string; state: BaselinePreviewState; filled: boolean; choice: BaselineChoice; onChoice: (c: BaselineChoice) => void; attachId: string; onAttach: (id: string) => void;
}) {
  const { preview, problem, retry } = state;
  if (problem) return (
    <p className="error small" role="alert">Could not read which baselines apply: {problem}{" "}
      <button type="button" className="btn small" onClick={retry}>Try again</button></p>);
  if (!preview) return <p className="muted small">{filled ? "Reading which baseline applies…" : "Enter the client and site to see which baseline applies."}</p>;
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
      {choice === "capture" && <span className="muted small">Taken from its first full report after it comes online. Another Admin approves it under Admin, Baselines; you cannot approve your own while another Admin exists.</span>}
    </fieldset>
  );
}
