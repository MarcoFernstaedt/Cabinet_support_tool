// Resolving an alert (docs/spec/12-milestones-8-to-12.md "Resolution notes"): what was wrong, and what fixed it, picked from the issue type's
// approved fixes or typed. The platform counts which fix resolved each issue type's alerts and shows "usually fixed by" first on the next
// alert of that type; a typed fix can be kept as a known fix for every cabinet (an Admin approves it first unless the person may approve fixes).
import { useState } from "react";
import { api, describeError } from "../lib/api";
import { useLoad } from "../lib/useLoad";
import { useSession } from "../lib/session";
import { ago } from "../lib/time";
import type { Alert } from "../lib/alerts";

interface Resolutions { resolved: number; withFix: number; fixes: { fix: string; count: number; lastAt: string; fixId: string | null; solution: string | null }[];
  recent: { alertId: string; cabinet: { name: string }; resolvedBy: string | null; resolvedAt: string; cause: string | null; fix: string | null }[] }

/** "Usually fixed by..." for an issue type: the fixes that resolved its alerts most often, and the last few resolutions with their causes. */
export function UsualFixes({ issueTypeId }: { issueTypeId: string }) {
  const { data } = useLoad<Resolutions>(`/api/issues/${issueTypeId}/resolutions`);
  if (!data || (data.fixes.length === 0 && data.recent.length === 0)) return null;
  return (
    <div className="small">
      {data.fixes.length > 0 && <p><span className="muted">Usually fixed by:</span> {data.fixes.map((f, i) => <span key={i}>{i > 0 && "; "}<strong>{f.fix}</strong> <span className="muted">({f.count} of {data.withFix})</span></span>)}</p>}
      {data.recent.length > 0 && <details><summary>Last time ({data.recent.length})</summary>
        <ul className="plain">{data.recent.map(r => <li key={r.alertId}><strong>{r.cabinet.name}</strong>, {r.resolvedBy ?? "someone"} {ago(r.resolvedAt)}{r.cause ? <>: {r.cause}</> : null}{r.fix ? <> Fix: {r.fix}</> : null}</li>)}</ul></details>}
    </div>
  );
}

export function ResolveForm({ alert, onDone, onCancel }: { alert: Alert; onDone: () => void; onCancel: () => void }) {
  const { me } = useSession();
  const known = useLoad<{ fixes: { id: string; title: string; status: string; symptom: { kind: string } }[] }>(alert.issueTypeId ? `/api/known-fixes?issueTypeId=${alert.issueTypeId}` : null);
  const approved = (known.data?.fixes ?? []).filter(f => f.status === "approved" && f.symptom.kind === "issue");
  const [cause, setCause] = useState("");
  const [choice, setChoice] = useState("");   // "" or a known fix's id
  const [typed, setTyped] = useState("");
  const [keep, setKeep] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setProblem(null);
    const body: Record<string, unknown> = {};
    if (cause.trim()) body.cause = cause.trim();
    if (note.trim()) body.note = note.trim();
    if (!choice && typed.trim()) { body.fix = { kind: "text", text: typed.trim() }; if (keep) body.saveFix = true; }
    else if (choice) body.fix = { kind: "known", fixId: choice };
    try { await api("POST", `/api/alerts/${alert.id}/resolve`, body); window.dispatchEvent(new Event("fixes-changed")); onDone(); }
    catch (e) { setProblem(describeError(e)); } finally { setBusy(false); }
  };
  return (
    <form className="stack" onSubmit={e => { e.preventDefault(); void submit(); }} aria-label="Resolve this alert">
      {alert.issueTypeId && <UsualFixes issueTypeId={alert.issueTypeId} />}
      <label className="field"><span>What was wrong (optional)</span><textarea rows={2} maxLength={500} value={cause} onChange={e => setCause(e.target.value)} autoFocus /></label>
      {approved.length > 0 && <label className="field"><span>Use a known fix</span>
        <select value={choice} onChange={e => setChoice(e.target.value)}>
          <option value="">None: I will type it</option>
          {approved.map(f => <option key={f.id} value={f.id}>{f.title}</option>)}
        </select></label>}
      {!choice && <>
        <label className="field"><span>What fixed it (optional)</span><input value={typed} maxLength={256} onChange={e => setTyped(e.target.value)} /></label>
        {alert.issueTypeId && typed.trim() && <label className="check small"><input type="checkbox" checked={keep} onChange={e => setKeep(e.target.checked)} /> Also keep this as a possible fix for every cabinet{me.canApproveFixes ? "" : " (an Admin approves it first)"}</label>}
      </>}
      <label className="field"><span>Note (optional)</span><input value={note} maxLength={256} onChange={e => setNote(e.target.value)} /></label>
      {problem && <p className="error small" role="alert">{problem}</p>}
      <p className="row gap"><button className="btn primary small" disabled={busy}>{busy ? "Resolving…" : "Resolve"}</button> <button type="button" className="btn ghost small" onClick={onCancel}>Cancel</button></p>
    </form>
  );
}
