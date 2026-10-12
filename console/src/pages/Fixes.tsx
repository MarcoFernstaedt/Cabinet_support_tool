// The review queue for known fixes (docs/spec/14-network-troubleshooting.md). Members submit what fixed a problem; an Admin, or a Tier 2 who
// has been granted it, approves or rejects. An approved fix is shown to everyone wherever the same problem comes up. The server checks the
// permission on every request; this page only hides what the person cannot use.
import { useState } from "react";
import { api } from "../lib/api";
import { useAction } from "../lib/useAction";
import { useLoad } from "../lib/useLoad";
import { atLeast, useSession } from "../lib/session";
import { Link } from "../lib/router";
import { ago, fullTime } from "../lib/time";
import { Breadcrumbs } from "../components/Layout";
import { Badge, Empty, KeyValues } from "../components/ui";
import { environmentRows, symptomLabel, type KnownFix } from "../components/KnownFixes";

type Fix = KnownFix & { symptom: KnownFix["symptom"] & { issueName?: string | null } };

export function FixQueue() {
  const { me } = useSession();
  if (!me.canApproveFixes) return (
    <div className="page"><h1>Known fixes</h1>
      <p>Only an Admin, or a Tier 2 who has been granted it, reviews fixes. Anyone can save one from a diagnosis or an alert; it appears here for review.</p></div>);
  return <Queue />;
}

function Queue() {
  const { me } = useSession();
  const queue = useLoad<{ pending: Fix[]; decided: Fix[] }>("/api/known-fixes/review");
  const inUse = useLoad<{ fixes: Fix[] }>("/api/known-fixes");
  const { run, problem } = useAction();
  const [note, setNote] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const done = (text: string) => { setNote(text); queue.reload(); inUse.reload(); window.dispatchEvent(new Event("fixes-changed")); };
  const decide = async (f: Fix, verb: "approve" | "reject") => {
    if (!await run(() => api("POST", `/api/known-fixes/${f.id}/${verb}`, verb === "reject" && reason.trim() ? { reason: reason.trim() } : {}))) return;
    setRejecting(null); setReason("");
    done(verb === "approve" ? `Approved “${f.title}”. It is now shown to everyone wherever the same problem comes up.` : `Rejected “${f.title}”. ${f.savedBy} can see why.`);
  };
  const remove = async (f: Fix) => { if (await run(() => api("POST", `/api/known-fixes/${f.id}/remove`, {}))) done(`Removed “${f.title}”.`); };
  const approved = (inUse.data?.fixes ?? []).filter(f => f.status === "approved");
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Fleet", to: "/" }, { label: "Known fixes" }]} />
      <h1>Known fixes</h1>
      <p className="muted">What members found fixed a problem, saved with the setup it was fixed on. An approved fix is shown to everyone the next time the same problem comes up.</p>
      {problem && <p className="error" role="alert">{problem}</p>}
      {note && <p className="notice ok" role="status">{note}</p>}

      <section className="panel" aria-labelledby="fix-waiting">
        <h2 id="fix-waiting">Waiting for approval{queue.data ? ` (${queue.data.pending.length})` : ""}</h2>
        {queue.data && queue.data.pending.length === 0 && <Empty>Nothing is waiting. A fix a member saves appears here.</Empty>}
        <ul className="plain stack">{queue.data?.pending.map(f => (
          <li key={f.id} className="finding warn">
            <div className="finding-head"><Badge tone="warn">Waiting</Badge> <strong>{f.title}</strong></div>
            <p className="muted small">For: {symptomLabel(f.symptom)}</p>
            <p className="pre">{f.solution}</p>
            <p className="muted small">From {f.savedBy}, <span title={fullTime(f.savedAt)}>{ago(f.savedAt)}</span>{f.fromCabinet ? <>, on <strong>{f.fromCabinet}</strong></> : null}.</p>
            <details><summary className="small">The setup it was fixed on</summary><KeyValues rows={environmentRows(f.environment)} /></details>
            {rejecting === f.id
              ? (<form className="row gap wrap" onSubmit={e => { e.preventDefault(); void decide(f, "reject"); }}>
                  <label className="field"><span>Why (optional, they will see it)</span><input autoFocus maxLength={256} value={reason} onChange={e => setReason(e.target.value)} /></label>
                  <button className="btn small">Reject</button><button type="button" className="btn small ghost" onClick={() => { setRejecting(null); setReason(""); }}>Cancel</button></form>)
              : (<div className="row gap"><button className="btn primary small" data-tour="fix-approve" onClick={() => void decide(f, "approve")}>Approve</button>
                  <button className="btn small" onClick={() => { setRejecting(f.id); setReason(""); }}>Reject…</button></div>)}
          </li>))}
        </ul>
      </section>

      <section className="panel" aria-labelledby="fix-inuse">
        <h2 id="fix-inuse">In use{inUse.data ? ` (${approved.length})` : ""}</h2>
        {inUse.data && approved.length === 0 && <Empty>No approved fixes yet.</Empty>}
        <div className="table-wrap">{approved.length > 0 && <table className="table compact">
          <caption className="sr-only">Approved known fixes</caption>
          <thead><tr><th scope="col">Fix</th><th scope="col">For</th><th scope="col">Saved by</th><th scope="col">Approved by</th><th scope="col">Shown</th><th scope="col"></th></tr></thead>
          <tbody>{approved.map(f => (
            <tr key={f.id}><th scope="row">{f.title}<div className="muted small">{f.solution.length > 120 ? `${f.solution.slice(0, 120)}…` : f.solution}</div></th>
              <td>{symptomLabel(f.symptom)}</td><td>{f.savedBy}</td><td>{f.reviewedBy ?? "—"}</td><td>{f.seenCount}×</td>
              <td>{atLeast(me, "tier2") && <button className="btn small ghost" onClick={() => void remove(f)}>Remove</button>}</td></tr>))}</tbody>
        </table>}</div>
      </section>

      <section className="panel" aria-labelledby="fix-decided">
        <h2 id="fix-decided">Recently decided</h2>
        {queue.data && queue.data.decided.length === 0 && <Empty>Nothing has been decided yet.</Empty>}
        <ul className="plain">{queue.data?.decided.map(f => (
          <li key={f.id}><Badge tone={f.status === "approved" ? "ok" : "crit"}>{f.status === "approved" ? "Approved" : "Rejected"}</Badge> <strong>{f.title}</strong>{" "}
            <span className="muted small">by {f.savedBy}, decided by {f.reviewedBy ?? "—"} {f.reviewedAt ? ago(f.reviewedAt) : ""}{f.reviewNote ? ` · ${f.reviewNote}` : ""}</span></li>))}
        </ul>
      </section>
      <p className="muted small">Who may approve: Admins, and any Tier 2 an Admin allows under <Link to="/admin/users">Users</Link>.</p>
    </div>
  );
}
