import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { Link, useRouter } from "../lib/router";
import { atLeast, roleName, useSession } from "../lib/session";
import { AlertBadge, MajorAlertToasts } from "./AlertCenter";
import { WritePauseBanner } from "../lib/writes";
import { DemoBanner } from "./DemoBanner";
import { SignInNotice } from "./SignIns";
import { AdminLink, SecurityToasts } from "./SecurityCenter";
import { FixesLink } from "./KnownFixes";

interface Hit { kind: "client" | "site" | "cabinet"; id: string; name: string; context: string; }

/** Jump to any client, site or cabinet by name or host name, from anywhere (docs/spec/06-console-spec.md). */
export function JumpControl() {
  const { navigate } = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const listId = useId();
  useEffect(() => {
    if (q.trim().length < 1) { setHits([]); return; }
    const t = setTimeout(() => { api<Hit[]>("GET", `/api/fleet/search?q=${encodeURIComponent(q.trim())}`).then(h => { setHits(h); setActive(0); }, () => setHits([])); }, 150);
    return () => clearTimeout(t);
  }, [q]);
  const go = (h: Hit) => { setQ(""); setHits([]); navigate(`/${h.kind}s/${h.id}`); };
  return (
    <div className="jump" role="search">
      <label className="sr-only" htmlFor={`${listId}-input`}>Jump to a client, site or cabinet</label>
      <input id={`${listId}-input`} type="search" placeholder="Jump to…" aria-label="Jump to client, site or cabinet" value={q} autoComplete="off"
        role="combobox" aria-expanded={hits.length > 0} aria-controls={listId} aria-activedescendant={hits[active] ? `${listId}-${active}` : undefined}
        onChange={e => setQ(e.target.value)}
        onKeyDown={e => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, hits.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
          if (e.key === "Enter" && hits[active]) { e.preventDefault(); go(hits[active]!); }
          if (e.key === "Escape") { setQ(""); setHits([]); }
        }} />
      {hits.length > 0 && (
        <ul id={listId} role="listbox" className="jump-results">
          {hits.map((h, i) => (
            <li key={`${h.kind}-${h.id}`} id={`${listId}-${i}`} role="option" aria-selected={i === active}
              className={i === active ? "active" : ""} onMouseDown={e => { e.preventDefault(); go(h); }}>
              <span className="kind">{h.kind}</span> <strong>{h.name}</strong> {h.context && <span className="muted">· {h.context}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { me, signOut } = useSession();
  const { path } = useRouter();
  const main = useRef<HTMLElement>(null);
  const section = path.startsWith("/admin") ? "admin" : path.startsWith("/account") ? "account" : path.startsWith("/alerts") || path.startsWith("/triage") ? "alerts"
    : path.startsWith("/issues") ? "issues" : path.startsWith("/fixes") ? "fixes" : path.startsWith("/incidents") ? "incidents" : path.startsWith("/search") ? "search" : path.startsWith("/fleet-operations") ? "operations" : path.split("?")[0] === "/" || /^\/(clients|sites|cabinets)\//.test(path) ? "fleet" : "";
  return (
    <>
      <a className="skip" href="#main" onClick={e => { e.preventDefault(); main.current?.focus(); }}>Skip to content</a>
      <header className="topbar">
        <Link to="/" className="brand"><span className="mark" aria-hidden="true">◆</span> Mashura <span className="muted">Support Console</span></Link>
        <nav aria-label="Main">
          <Link to="/" aria-current={section === "fleet" ? "page" : undefined}>Fleet</Link>
          <AlertBadge current={section === "alerts"} />
          <Link to="/search" aria-current={section === "search" ? "page" : undefined}>Search</Link>
          <Link to="/incidents" aria-current={section === "incidents" ? "page" : undefined}>Incidents</Link>
          <Link to="/fleet-operations" aria-current={section === "operations" ? "page" : undefined}>Fleet operations</Link>
          <Link to="/issues" aria-current={section === "issues" ? "page" : undefined}>Issues</Link>
          {me.canApproveFixes && <FixesLink current={section === "fixes"} />}
          {atLeast(me, "admin") && <AdminLink current={section === "admin"} />}
        </nav>
        <JumpControl />
        <div className="user">
          <Link to="/account" aria-current={section === "account" ? "page" : undefined}>{me.name} <span className="muted">· {roleName(me.role)}</span></Link>
          <button className="btn ghost small" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>
      <WritePauseBanner />
      <DemoBanner />
      <SignInNotice />
      <main id="main" ref={main} tabIndex={-1}>{children}</main>
      <MajorAlertToasts />
      {atLeast(me, "admin") && <SecurityToasts />}
    </>
  );
}

export function Breadcrumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="crumbs">
      <ol>{items.map((i, n) => <li key={n}>{i.to ? <Link to={i.to}>{i.label}</Link> : <span aria-current="page">{i.label}</span>}</li>)}</ol>
    </nav>
  );
}
