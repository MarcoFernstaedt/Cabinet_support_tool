// Case notes on a cabinet (or on one of its alerts): who did what, in their words. Everyone from Tier 1 adds and reads them; a note is never
// edited. An Admin can remove the text of one (a password pasted by mistake), with a reason; the note stays, marked removed.
import { useState } from "react";
import { api, describeError } from "../lib/api";
import { useLoad } from "../lib/useLoad";
import { atLeast, useSession } from "../lib/session";
import { ago, fullTime } from "../lib/time";
import { Badge } from "./ui";

interface Note { id: string; alertId: string | null; alertTitle: string | null; author: { id: string; name: string }; kind: string; body: string | null; createdAt: string; redacted: { at: string; by: string | null; reason: string | null } | null }

export function CabinetNotes({ cabinetId, alertId, compact = false }: { cabinetId: string; alertId?: string; compact?: boolean }) {
  const { me } = useSession();
  const { data, problem, reload } = useLoad<{ notes: Note[] }>(`/api/cabinets/${cabinetId}/notes${alertId ? `?alertId=${alertId}` : ""}`);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const add = async () => {
    setBusy(true); setError(null);
    try { await api("POST", `/api/cabinets/${cabinetId}/notes`, { body: text.trim(), ...(alertId ? { alertId } : {}) }); setText(""); reload(); }
    catch (e) { setError(describeError(e)); } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setError(null);
    try { await api("POST", `/api/notes/${id}/redact`, { reason: reason.trim() }); setRemoving(null); setReason(""); reload(); }
    catch (e) { setError(describeError(e)); }
  };
  const notes = data?.notes ?? [];
  return (
    <div className="stack" aria-label="Case notes">
      <h3>{alertId ? "Notes on this alert" : "Case notes"}</h3>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && notes.length === 0 && <p className="muted small">No notes yet.</p>}
      <ul className="plain">
        {(compact ? notes.slice(0, 3) : notes).map(n => (
          <li key={n.id} className="small">
            <strong>{n.author.name}</strong> <span className="muted" title={fullTime(n.createdAt)}>{ago(n.createdAt)}</span>{" "}
            {n.kind === "resolution" && <Badge tone="ok">Resolved</Badge>}{n.alertTitle && !alertId && <span className="muted"> on “{n.alertTitle}”</span>}
            <div style={{ whiteSpace: "pre-wrap" }}>{n.redacted ? <em className="muted">Text removed by {n.redacted.by ?? "an Admin"}: {n.redacted.reason}</em> : n.body}</div>
            {atLeast(me, "admin") && !n.redacted && (removing === n.id
              ? <form className="row gap wrap" onSubmit={e => { e.preventDefault(); void remove(n.id); }}>
                  <label className="field"><span>Why remove the text</span><input value={reason} maxLength={200} onChange={e => setReason(e.target.value)} autoFocus /></label>
                  <button className="btn small danger" disabled={reason.trim().length < 3}>Remove the text</button>
                  <button type="button" className="btn small ghost" onClick={() => setRemoving(null)}>Cancel</button>
                </form>
              : <button className="linkish small" onClick={() => { setRemoving(n.id); setReason(""); }}>Remove text…</button>)}
          </li>))}
      </ul>
      {compact && notes.length > 3 && <p className="small muted">{notes.length - 3} older notes are on the cabinet's Overview.</p>}
      <form className="stack" onSubmit={e => { e.preventDefault(); if (text.trim()) void add(); }}>
        <label className="field"><span>Add a note (what you found, did, or left for the next person; no passwords or patient data)</span>
          <textarea rows={2} maxLength={2000} value={text} onChange={e => setText(e.target.value)} /></label>
        {error && <p className="error small" role="alert">{error}</p>}
        <p><button className="btn small primary" disabled={busy || text.trim().length === 0}>{busy ? "Saving…" : "Add note"}</button></p>
      </form>
    </div>
  );
}
