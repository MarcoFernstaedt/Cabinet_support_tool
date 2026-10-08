// Map to issue (docs/spec/06-console-spec.md "Mapping an error to an issue"): pick the issue,
// keep or drop each pre-filled field, optionally add a message phrase, read the fleet preview,
// choose whether to regroup, and confirm with an authenticator code. The server re-checks all of it.
import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../lib/api";
import { describeMatch, KIND_LABEL, type IssueType, type Match } from "../lib/alerts";
import { atLeast, useSession } from "../lib/session";

/** The new-issue-type choice in the issue list. */
const NEW = "new";
/** Severity in plain words: where the alert shows. */
export const SEVERITY_LABEL = { major: "Major: on the home page and the Alerts tab", minor: "Minor: only on the cabinet" } as const;

type Field = "kind" | "log" | "source" | "eventId" | "level" | "hardwareId";
const FIELD_LABEL: Record<Field, string> = { kind: "Event type", log: "Log", source: "Source", eventId: "Event ID", level: "Level", hardwareId: "Hardware ID" };
interface Preview { events: number; cabinets: number; openUnrecognizedAlerts: number; days: number }

export function MapToIssue({ open, initial, onClose, onDone }: {
  open: boolean; initial: Match; onClose: () => void; onDone?: (r: { ruleId: string; state: string; regrouped: number }) => void;
}) {
  const { me } = useSession();
  const ref = useRef<HTMLDialogElement>(null);
  const fields = (Object.keys(FIELD_LABEL) as Field[]).filter(f => initial[f] !== undefined);
  const [issues, setIssues] = useState<IssueType[]>([]);
  const [issueTypeId, setIssueTypeId] = useState("");
  const [kept, setKept] = useState<Set<Field>>(new Set(fields));
  const [phrase, setPhrase] = useState("");
  const [regroup, setRegroup] = useState(true);
  const [severity, setSeverity] = useState<"" | "major" | "minor">("");
  const [newType, setNewType] = useState({ name: "", severity: "minor" as "major" | "minor", description: "" });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<{ state: string; regrouped: number } | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setKept(new Set(fields)); setPhrase(""); setRegroup(true); setCode(""); setProblem(null); setDone(null); setPreview(null);
      setSeverity(""); setNewType({ name: "", severity: "minor", description: "" }); setIssueTypeId("");
      api<IssueType[]>("GET", "/api/issues").then(list => { setIssues(list.filter(i => i.name !== "Cabinet offline")); }, e => setProblem(describeError(e)));
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const match: Match = {};
  for (const f of fields) if (kept.has(f)) (match as Record<string, unknown>)[f] = initial[f];
  if (phrase.trim().length >= 3) match.phrase = phrase.trim();
  const key = JSON.stringify(match);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setPreviewProblem(null);
    const t = setTimeout(() => {
      api<Preview>("POST", "/api/rules/preview", { match }).then(setPreview, e => setPreviewProblem(describeError(e)));
    }, 300);
    return () => clearTimeout(t);
  }, [key, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const creating = issueTypeId === NEW;
      const { token } = await api<{ token: string }>("POST", "/api/auth/step-up", { code, action: "rule.propose", target: creating ? "fleet" : issueTypeId });
      const r = await api<{ ruleId: string; state: string; regrouped: number }>("POST", "/api/rules", {
        ...(creating ? { newIssueType: { name: newType.name.trim(), severity: newType.severity, description: newType.description.trim() } } : { issueTypeId }),
        match, regroup, ...(severity ? { severity } : {}), stepUpToken: token });
      setDone(r);
      onDone?.(r);
    } catch (e) { setProblem(describeError(e)); }
    finally { setBusy(false); }
  };
  const chosen = issues.find(i => i.id === issueTypeId);
  const issueName = issueTypeId === NEW ? newType.name.trim() : chosen?.name;
  const typeSeverity = issueTypeId === NEW ? newType.severity : chosen?.severity;
  const newTypeReady = issueTypeId !== NEW || (newType.name.trim().length > 0 && newType.description.trim().length > 0);

  return (
    <dialog ref={ref} className="dialog wide" aria-labelledby="map-title" onClose={onClose}>
      <form method="dialog" onSubmit={e => { e.preventDefault(); void submit(); }}>
        <h2 id="map-title">Map to issue</h2>
        {done ? (<>
          <p role="status">{done.state === "live"
            ? <>The rule is live. From now on this error raises <strong>{issueName}</strong>.{done.regrouped > 0 && <> {done.regrouped} open unrecognized {done.regrouped === 1 ? "alert was" : "alerts were"} regrouped.</>}</>
            : <>The rule is waiting for an Admin to approve it. It does nothing until then.</>}</p>
          <div className="row gap end"><button type="button" className="btn primary" onClick={onClose}>Close</button></div>
        </>) : (<>
          <label className="field"><span>Issue</span>
            <select required value={issueTypeId} onChange={e => setIssueTypeId(e.target.value)}>
              <option value="">Choose the issue this error is a symptom of…</option>
              {issues.map(i => <option key={i.id} value={i.id}>{i.name} ({i.severity})</option>)}
              {atLeast(me, "admin") && <option value={NEW}>New issue type…</option>}
            </select>
          </label>
          {!atLeast(me, "admin") && <p className="small muted">No issue fits? Ask an Admin to add a new issue type, or map it to the closest one for now.</p>}
          {issueTypeId === NEW && (
            <fieldset className="match-fields"><legend>New issue type</legend>
              <label className="field"><span>Name</span><input required maxLength={128} value={newType.name} onChange={e => setNewType(t => ({ ...t, name: e.target.value }))} /></label>
              <label className="field"><span>Usual severity</span>
                <select value={newType.severity} onChange={e => setNewType(t => ({ ...t, severity: e.target.value as "major" | "minor" }))}>
                  <option value="major">{SEVERITY_LABEL.major}</option><option value="minor">{SEVERITY_LABEL.minor}</option></select></label>
              <label className="field"><span>What it means (shown to the team)</span>
                <input required maxLength={1000} value={newType.description} onChange={e => setNewType(t => ({ ...t, description: e.target.value }))} /></label>
            </fieldset>)}
          <label className="field"><span>How serious is this error</span>
            <select value={severity} onChange={e => setSeverity(e.target.value as "" | "major" | "minor")}>
              <option value="">As the issue usually is{typeSeverity ? ` (${typeSeverity})` : ""}</option>
              <option value="major">{SEVERITY_LABEL.major}</option>
              <option value="minor">{SEVERITY_LABEL.minor}</option>
            </select>
          </label>
          <fieldset className="match-fields"><legend>Match on (untick a field to widen the rule)</legend>
            {fields.map(f => (
              <label key={f}>
                <input type="checkbox" checked={kept.has(f)} onChange={e => setKept(k => { const n = new Set(k); if (e.target.checked) n.add(f); else n.delete(f); return n; })} />
                <span>{FIELD_LABEL[f]}</span>
                <code>{f === "kind" ? KIND_LABEL[String(initial.kind)] ?? String(initial.kind) : String(initial[f])}</code>
              </label>))}
          </fieldset>
          <label className="field"><span>Message must contain (optional, plain text, at least 3 characters)</span>
            <input value={phrase} maxLength={128} onChange={e => setPhrase(e.target.value.replace(/[\u0000-\u001f\u007f]/g, ""))} />
          </label>
          <div className="preview" aria-live="polite">
            <p className="small muted">{describeMatch(match) || "Nothing kept: keep at least one field."}</p>
            {preview ? <p>In the last {preview.days} days this would have matched <strong>{preview.events}</strong> {preview.events === 1 ? "event" : "events"} on <strong>{preview.cabinets}</strong> {preview.cabinets === 1 ? "cabinet" : "cabinets"}.</p>
              : previewProblem ? <p className="error">{previewProblem}</p> : <p className="muted">Counting matches across the fleet…</p>}
          </div>
          <label className="check"><input type="checkbox" checked={regroup} onChange={e => setRegroup(e.target.checked)} />
            Regroup matching open unrecognized alerts under this issue now{preview && preview.openUnrecognizedAlerts > 0 ? ` (${preview.openUnrecognizedAlerts})` : ""}</label>
          <p className="small muted">{atLeast(me, "admin") ? "As an Admin, your rule goes live straight away." : "Your rule waits for an Admin to approve it."}</p>
          <label className="field"><span>Authenticator code</span>
            <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} />
          </label>
          {problem && <p className="error" role="alert">{problem}</p>}
          <div className="row gap end">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy || !issueTypeId || !newTypeReady || code.length !== 6 || !!previewProblem}>{busy ? "Saving…" : atLeast(me, "admin") ? "Save and go live" : "Send for approval"}</button>
          </div>
        </>)}
      </form>
    </dialog>
  );
}
