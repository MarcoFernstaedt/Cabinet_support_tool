// The alert badge in the top bar and the announcements of new major alerts
// (docs/spec/06-console-spec.md "Layout" and "Accessibility").
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { claim } from "../lib/alerts";
import { useAlertNews, type AlertNews } from "../lib/commands";
import { Link, useRouter } from "../lib/router";

/** The count of open (unclaimed) major alerts, kept current by the live stream. */
export function AlertBadge({ current }: { current: boolean }) {
  const [count, setCount] = useState<number | null>(null);
  const load = useCallback(() => { api<{ openMajor: number }>("GET", "/api/alerts/summary", undefined, { background: true }).then(s => setCount(s.openMajor), () => undefined); }, []);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  useAlertNews(load);
  return (
    <Link to="/alerts" aria-current={current ? "page" : undefined} className="alerts-link">
      Alerts{count !== null && count > 0 && <> <span className="badge crit count">{count}<span className="sr-only"> open major {count === 1 ? "alert" : "alerts"}</span></span></>}
    </Link>
  );
}

/** New major alerts appear without a refresh: a card to claim it and a polite announcement. */
export function MajorAlertToasts() {
  const { navigate } = useRouter();
  const [items, setItems] = useState<(AlertNews & { note?: string })[]>([]);
  const [said, setSaid] = useState("");
  useAlertNews(n => {
    if (n.change === "created" && n.severity === "major") {
      setItems(list => [n, ...list.filter(x => x.alertId !== n.alertId)].slice(0, 3));
      setSaid(`New major alert: ${n.title} on ${n.cabinet.name}, ${n.client.name}, ${n.site.name}.`);
    } else if (n.change !== "created") {
      // Someone claimed or resolved it: say who, and stop offering the claim.
      setItems(list => list.map(x => x.alertId === n.alertId ? { ...x, state: n.state, claimedBy: n.claimedBy } : x));
    }
  });
  const dismiss = (id: string) => setItems(list => list.filter(x => x.alertId !== id));
  const take = async (n: AlertNews) => {
    const r = await claim(n.alertId);
    if (r.alert) { dismiss(n.alertId); navigate(`/cabinets/${n.cabinet.id}/alerts`); }
    else setItems(list => list.map(x => x.alertId === n.alertId ? { ...x, state: "claimed", claimedBy: r.takenBy ?? null, ...(r.problem ? { note: r.problem } : {}) } : x));
  };
  return (<>
    <div className="sr-only" aria-live="polite" role="status">{said}</div>
    {items.length > 0 && (
      <aside className="toasts" aria-label="New major alerts">
        {items.map(n => (
          <div key={n.alertId} className="toast">
            <p><span className="badge crit">Major</span> <strong>{n.title}</strong>{n.sitePattern && <> <span className="badge warn">Site-wide pattern</span></>}</p>
            <p className="small">{n.cabinet.name} · {n.client.name} / {n.site.name}</p>
            {n.state === "claimed" && n.claimedBy ? <p className="small">Claimed by <strong>{n.claimedBy.name}</strong>.</p>
              : n.state === "resolved" ? <p className="small">Resolved.</p> : null}
            {n.note && <p className="small error">{n.note}</p>}
            <div className="row gap">
              {n.state === "open" && <button className="btn primary small" onClick={() => void take(n)}>Claim and open cabinet</button>}
              <button className="btn ghost small" onClick={() => dismiss(n.alertId)}>Dismiss</button>
            </div>
          </div>))}
      </aside>)}
  </>);
}
