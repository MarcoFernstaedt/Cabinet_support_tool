// For Admins: the open security alert count on the Admin link, and new security alerts
// announced as they happen (docs/spec/05-server-spec.md "Security alerts").
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useSecurityNews, type SecurityNews } from "../lib/commands";
import { Link } from "../lib/router";

export function AdminLink({ current }: { current: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const load = useCallback(() => { api<{ open: number }>("GET", "/api/admin/security-alerts/summary", undefined, { background: true }).then(s => setOpen(s.open), () => undefined); }, []);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  useSecurityNews(load);
  return (
    <Link to="/admin" aria-current={current ? "page" : undefined} className="alerts-link">
      Admin{open !== null && open > 0 && <> <span className="badge crit count" title="Open security alerts">{open}<span className="sr-only"> open security {open === 1 ? "alert" : "alerts"}</span></span></>}
    </Link>
  );
}

/** A new security alert appears at once on every Admin's console, and is announced to screen readers. */
export function SecurityToasts() {
  const [items, setItems] = useState<SecurityNews[]>([]);
  const [said, setSaid] = useState("");
  useSecurityNews(n => {
    if (!n.created) return;
    setItems(list => [n, ...list.filter(x => x.id !== n.id)].slice(0, 3));
    setSaid(`Security alert: ${n.title}.`);
  });
  return (
    <>
      <div className="sr-only" aria-live="assertive">{said}</div>
      {items.length > 0 && (
        <aside className="toasts security" aria-label="New security alerts">
          {items.map(n => (
            <div key={n.id} className="toast crit">
              <strong>Security alert</strong>
              <p>{n.title}</p>
              <div className="row gap">
                <Link to="/admin/security" className="btn small primary" onClick={() => setItems(l => l.filter(x => x.id !== n.id))}>Open security alerts</Link>
                <button className="btn small" onClick={() => setItems(l => l.filter(x => x.id !== n.id))}>Dismiss</button>
              </div>
            </div>))}
        </aside>)}
    </>
  );
}
