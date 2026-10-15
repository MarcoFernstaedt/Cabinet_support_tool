// One list of alerts, used by the Alerts area, the cabinet view and the scanner section.
// Clicking an unclaimed major alert claims it and opens its cabinet; if someone else got
// there first, the list says who (docs/spec/06-console-spec.md "Alerts area").
import { symptomForAlert } from "../lib/symptoms";
import { useLoad } from "../lib/useLoad";
import { KnownFixes, SaveFix } from "./KnownFixes";
import { useState } from "react";
import { api, describeError } from "../lib/api";
import { claim, type Alert, type Match, type StoredEvent } from "../lib/alerts";
import { Link, useRouter } from "../lib/router";
import { atLeast, useSession } from "../lib/session";
import { ago, fullTime } from "../lib/time";
import { Badge, ConfirmDialog, Empty } from "./ui";
import { MapToIssue } from "./MapToIssue";

/** The pre-filled match for an event: log, source, event ID and hardware ID when there is one (docs/spec/05-server-spec.md). */
export function matchFor(e: Pick<StoredEvent, "kind" | "source" | "device">): Match {
  if (e.kind === "error" && e.source) {
    const m: Match = { log: e.source.log, source: e.source.source, eventId: e.source.eventId };
    if (e.source.hardwareId) m.hardwareId = e.source.hardwareId;
    return m;
  }
  const m: Match = { kind: e.kind };
  if (e.device?.hardwareIds[0]) m.hardwareId = e.device.hardwareIds[0];
  return m;
}

export function AlertList({ alerts, onChanged, showCabinet = true, empty }: { alerts: Alert[]; onChanged: () => void; showCabinet?: boolean; empty: string }) {
  const { me } = useSession();
  const { navigate } = useRouter();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");
  const [asFix, setAsFix] = useState(false);
  const [confirmFix, setConfirmFix] = useState<Alert | null>(null);
  const [mapping, setMapping] = useState<Match | null>(null);
  const [shown, setShown] = useState(50);
  // Which issue types have a saved fix, so only those alerts look the fix up.
  const known = useLoad<{ fixes: { status: string; symptom: { kind: string; issueTypeId?: string } }[] }>("/api/known-fixes");
  // Approved fixes apply to every cabinet in the fleet: the alert's issue type is all that has to match.
  const fixCount = new Map<string, number>();
  for (const f of known.data?.fixes ?? []) if (f.status === "approved" && f.symptom.kind === "issue" && f.symptom.issueTypeId) fixCount.set(f.symptom.issueTypeId, (fixCount.get(f.symptom.issueTypeId) ?? 0) + 1);
  const withFix = new Set(fixCount.keys());
  const say = (id: string, text: string) => setNotes(n => ({ ...n, [id]: text }));

  const take = async (a: Alert, open: boolean) => {
    const r = await claim(a.id);
    if (r.alert) { onChanged(); if (open) navigate(`/cabinets/${a.cabinet.id}/alerts`); }
    else if (r.takenBy) { say(a.id, `${r.takenBy.name} claimed this first.`); onChanged(); }
    else say(a.id, r.problem ?? "Could not claim.");
  };
  const resolve = async (a: Alert, saveFix = false) => {
    try {
      // The same words become a possible fix for every cabinet, tied to this alert.
      if (saveFix && a.issueTypeId && resolution.trim()) {
        await api("POST", "/api/known-fixes", { title: a.title.slice(0, 120), solution: resolution.trim(), symptom: { kind: "issue", issueTypeId: a.issueTypeId }, cabinetId: a.cabinet.id, alertId: a.id });
        window.dispatchEvent(new Event("fixes-changed")); known.reload();
      }
      await api("POST", `/api/alerts/${a.id}/resolve`, resolution.trim() ? { note: resolution.trim().slice(0, 256) } : {});
      setResolving(null); setResolution(""); setAsFix(false); onChanged();
    } catch (e) { say(a.id, describeError(e)); throw e; }
  };
  const map = async (a: Alert) => {
    if (!a.lastEventId) return;
    try { setMapping(matchFor(await api<StoredEvent>("GET", `/api/events/${a.lastEventId}`))); }
    catch (e) { say(a.id, describeError(e)); }
  };

  if (alerts.length === 0) return <Empty>{empty}</Empty>;
  return (<>
    <ul className="alert-list">
      {alerts.slice(0, shown).map(a => {
        const mine = a.claimedBy?.id === me.id;
        return (
          <li key={a.id} data-cabinet={a.cabinet.name} className={`alert-row ${a.severity} ${a.state}`}>
            <div>
              <div className="row gap wrap">
                <Badge tone={a.severity === "major" ? "crit" : "info"}>{a.severity === "major" ? "Major" : "Minor"}</Badge>
                {a.unrecognized && <Badge tone="off">Unrecognized</Badge>}
                {a.scope === "cabinet" && <span title="Stays on this cabinet: it is not in the fleet alert list or its counts."><Badge tone="info">Cabinet alert</Badge></span>}
                {a.sitePattern && <Badge tone="warn">Site-wide pattern</Badge>}
                {a.issueTypeId && a.state !== "resolved" && fixCount.has(a.issueTypeId) && <Link to={`/cabinets/${a.cabinet.id}/alerts`} title="A fix that worked on this problem before is saved. Open the cabinet to read it."><Badge tone="ok">{fixCount.get(a.issueTypeId)} possible {fixCount.get(a.issueTypeId) === 1 ? "fix" : "fixes"}</Badge></Link>}
                {a.state === "open" && a.severity === "major"
                  ? <button className="linkish title" onClick={() => void take(a, true)} title="Claim this alert and open its cabinet">{a.title}</button>
                  : <Link className="title" to={`/cabinets/${a.cabinet.id}/alerts`}>{a.title}</Link>}
              </div>
              <div className="meta">
                {showCabinet && <span><Link to={`/cabinets/${a.cabinet.id}`}>{a.cabinet.name}</Link> · {a.client.name} / {a.site.name}</span>}
                <span>{a.occurrences} {a.occurrences === 1 ? "occurrence" : "occurrences"}</span>
                <span title={fullTime(a.firstSeen)}>first {fullTime(a.firstSeen)}</span>
                <span title={fullTime(a.lastSeen)}>last {ago(a.lastSeen)}</span>
                <span>{a.state === "open" ? "Open, unclaimed" : a.state === "claimed" ? <>Claimed by <strong>{mine ? "you" : a.claimedBy?.name}</strong></>
                  : <>Resolved {a.resolvedBy ? <>by {a.resolvedBy.name}</> : "on its own"} {ago(a.resolvedAt)}</>}</span>
              </div>
              {a.resolution && <p className="small muted">{a.resolution}</p>}
              {a.issueTypeId && withFix.has(a.issueTypeId) && a.state !== "resolved" && <KnownFixes symptom={{ kind: "issue", issueTypeId: a.issueTypeId }} cabinetId={a.cabinet.id} />}
              {a.issueTypeId && a.state === "resolved" && (a.resolvedBy?.id === me.id || atLeast(me, "admin")) && <SaveFix symptom={{ kind: "issue", issueTypeId: a.issueTypeId }} cabinetId={a.cabinet.id} suggestedTitle={a.title} alertId={a.id} />}
              {notes[a.id] && <p className="small error" role="alert">{notes[a.id]}</p>}
              {resolving === a.id && (
                <form className="row gap wrap" onSubmit={e => { e.preventDefault(); if (asFix && me.canApproveFixes && resolution.trim()) setConfirmFix(a); else void resolve(a, asFix).catch(() => undefined); }}>
                  <label className="field"><span>What fixed it (optional)</span><input value={resolution} maxLength={256} onChange={e => setResolution(e.target.value)} autoFocus /></label>
                  {a.issueTypeId && resolution.trim() && <label className="check small"><input type="checkbox" checked={asFix} onChange={e => setAsFix(e.target.checked)} /> Also keep this as a possible fix for every cabinet{me.canApproveFixes ? "" : " (an Admin approves it first)"}</label>}
                  <button className="btn primary small">Resolve</button>
                  <button type="button" className="btn ghost small" onClick={() => setResolving(null)}>Cancel</button>
                </form>)}
            </div>
            <div className="actions">
              {a.state !== "resolved" && symptomForAlert(a.title) && <Link className="btn small" to={`/cabinets/${a.cabinet.id}/troubleshoot?symptom=${symptomForAlert(a.title)}`}>Troubleshoot</Link>}
              {a.state === "open" && <button className="btn small" onClick={() => void take(a, false)}>Claim</button>}
              {a.state !== "resolved" && (mine || atLeast(me, "admin")) && resolving !== a.id &&
                <button className="btn small" onClick={() => { setResolving(a.id); setResolution(""); }}>Resolve…</button>}
              {a.unrecognized && a.state !== "resolved" && atLeast(me, "tier2") && a.lastEventId && <button className="btn small" data-tour="map-to-issue" onClick={() => void map(a)}>Map to issue</button>}
            </div>
          </li>);
      })}
    </ul>
    {alerts.length > shown && <p className="row gap"><button className="btn" onClick={() => setShown(n => n + 50)}>Show {Math.min(50, alerts.length - shown)} more</button><span className="muted small" role="status">Showing {shown} of {alerts.length}</span></p>}
    <ConfirmDialog open={confirmFix !== null} title="Save this as a fix too?" confirmLabel="Resolve and save the fix" onClose={() => setConfirmFix(null)} onConfirm={() => resolve(confirmFix!, true)}
      description={<p>“{resolution.trim()}” is written into the alert's resolution and kept as a possible fix for every cabinet. It needs no approval because you can approve fixes; it is logged under your name.</p>} />
    <MapToIssue open={mapping !== null} initial={mapping ?? {}} onClose={() => { setMapping(null); onChanged(); }} />
  </>);
}
