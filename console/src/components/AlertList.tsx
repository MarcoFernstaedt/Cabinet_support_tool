// One list of alerts, used by the Alerts area, the cabinet view and the scanner section.
// Clicking an unclaimed major alert claims it and opens its cabinet; if someone else got
// there first, the list says who (docs/spec/06-console-spec.md "Alerts area").
import { useState } from "react";
import { api, describeError } from "../lib/api";
import { claim, type Alert, type Match, type StoredEvent } from "../lib/alerts";
import { Link, useRouter } from "../lib/router";
import { atLeast, useSession } from "../lib/session";
import { ago, fullTime } from "../lib/time";
import { Badge, Empty } from "./ui";
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
  const [mapping, setMapping] = useState<Match | null>(null);
  const [shown, setShown] = useState(50);
  const say = (id: string, text: string) => setNotes(n => ({ ...n, [id]: text }));

  const take = async (a: Alert, open: boolean) => {
    const r = await claim(a.id);
    if (r.alert) { onChanged(); if (open) navigate(`/cabinets/${a.cabinet.id}/alerts`); }
    else if (r.takenBy) { say(a.id, `${r.takenBy.name} claimed this first.`); onChanged(); }
    else say(a.id, r.problem ?? "Could not claim.");
  };
  const resolve = async (a: Alert) => {
    try {
      await api("POST", `/api/alerts/${a.id}/resolve`, resolution.trim() ? { note: resolution.trim().slice(0, 256) } : {});
      setResolving(null); setResolution(""); onChanged();
    } catch (e) { say(a.id, describeError(e)); }
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
          <li key={a.id} className={`alert-row ${a.severity} ${a.state}`}>
            <div>
              <div className="row gap wrap">
                <Badge tone={a.severity === "major" ? "crit" : "info"}>{a.severity === "major" ? "Major" : "Minor"}</Badge>
                {a.unrecognized && <Badge tone="off">Unrecognized</Badge>}
                {a.scope === "cabinet" && <span title="Stays on this cabinet: it is not in the fleet alert list or its counts."><Badge tone="info">Cabinet alert</Badge></span>}
                {a.sitePattern && <Badge tone="warn">Site-wide pattern</Badge>}
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
              {notes[a.id] && <p className="small error" role="alert">{notes[a.id]}</p>}
              {resolving === a.id && (
                <form className="row gap wrap" onSubmit={e => { e.preventDefault(); void resolve(a); }}>
                  <label className="field"><span>What fixed it (optional)</span><input value={resolution} maxLength={256} onChange={e => setResolution(e.target.value)} autoFocus /></label>
                  <button className="btn primary small">Resolve</button>
                  <button type="button" className="btn ghost small" onClick={() => setResolving(null)}>Cancel</button>
                </form>)}
            </div>
            <div className="actions">
              {a.state === "open" && <button className="btn small" onClick={() => void take(a, false)}>Claim</button>}
              {a.state !== "resolved" && (mine || atLeast(me, "admin")) && resolving !== a.id &&
                <button className="btn small" onClick={() => { setResolving(a.id); setResolution(""); }}>Resolve…</button>}
              {a.unrecognized && a.state !== "resolved" && atLeast(me, "tier2") && a.lastEventId && <button className="btn small" onClick={() => void map(a)}>Map to issue</button>}
            </div>
          </li>);
      })}
    </ul>
    {alerts.length > shown && <p className="row gap"><button className="btn" onClick={() => setShown(n => n + 50)}>Show {Math.min(50, alerts.length - shown)} more</button><span className="muted small" role="status">Showing {shown} of {alerts.length}</span></p>}
    <MapToIssue open={mapping !== null} initial={mapping ?? {}} onClose={() => { setMapping(null); onChanged(); }} />
  </>);
}
