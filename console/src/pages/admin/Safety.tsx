// Fleet safety (pause writes fleet-wide or per client; people paused by their limit), security
// alerts, and platform settings — docs/spec/06-console-spec.md "Admin screens".
import { DemoMode } from "./Setup";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useSecurityNews } from "../../lib/commands";
import { Link } from "../../lib/router";
import { useWriteStatus } from "../../lib/writes";
import { fullTime } from "../../lib/time";
import { Breadcrumbs } from "../../components/Layout";
import { Badge, Empty, KeyValues } from "../../components/ui";
import { useStepUp } from "../../components/StepUp";
import { useLoad } from "../../lib/useLoad";

interface Safety {
  fleet: { paused: boolean; reason: string | null; at?: string | null };
  clients: { id: string; name: string; paused: boolean; reason: string | null }[];
  pausedUsers: { id: string; name: string; username: string; reason: string | null; writeLimit: number }[];
}

export function FleetSafety() {
  const { data, problem, reload } = useLoad<Safety>("/api/admin/fleet-safety");
  const banner = useWriteStatus();
  const step = useStepUp();
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const after = (text: string) => { setDone(text); setReason(""); reload(); banner.reload(); };
  const pause = (scope: { id: string; name: string } | null, paused: boolean) => {
    const where = scope ? `${scope.name}'s cabinets` : "every cabinet";
    const body = { paused, ...(paused && reason.trim() ? { reason: reason.trim() } : {}) };
    step.ask(paused ? "writes.pause" : "writes.resume", scope?.id ?? "fleet",
      <><p>{paused ? "Pause" : "Resume"} changes to <strong>{where}</strong>.</p>{paused && <p className="muted">Diagnostics keep working. Reason: {reason.trim() || "none given"}</p>}</>,
      async token => {
        await api("POST", scope ? `/api/admin/clients/${scope.id}/writes` : "/api/admin/writes", { ...body, stepUpToken: token });
        after(`Changes to ${where} ${paused ? "paused" : "resumed"}.`);
      }, body);
  };
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Fleet safety" }]} />
      <h1>Fleet safety</h1>
      <p className="muted">Pausing stops every change to cabinets at once, for incidents or anything that looks wrong. Diagnostics keep working.</p>
      {done && <p className="notice ok" role="status">{done}</p>}
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && <>
        <section className="panel" aria-labelledby="fleet-pause">
          <h2 id="fleet-pause">The whole fleet</h2>
          <p>{data.fleet.paused ? <><Badge tone="crit">Changes paused</Badge> {data.fleet.reason}</> : <Badge tone="ok">Changes allowed</Badge>}</p>
          <label className="field"><span>Reason (shown in the banner)</span><input maxLength={256} value={reason} onChange={e => setReason(e.target.value)} placeholder="Investigating unexpected firewall changes" /></label>
          {data.fleet.paused
            ? <button className="btn primary" onClick={() => pause(null, false)}>Resume changes fleet-wide</button>
            : <button className="btn danger" onClick={() => pause(null, true)}>Pause changes fleet-wide</button>}
        </section>
        <section className="panel" aria-labelledby="client-pause">
          <h2 id="client-pause">By client</h2>
          {data.clients.length === 0 ? <Empty>No clients.</Empty> : (
            <ul className="plain">{data.clients.map(c => (
              <li key={c.id} className="row gap wrap">
                <strong>{c.name}</strong> {c.paused ? <><Badge tone="warn">Paused</Badge> <span className="muted">{c.reason}</span></> : <Badge tone="ok">Allowed</Badge>}
                {c.paused ? <button className="btn small" onClick={() => pause(c, false)}>Resume</button> : <button className="btn small danger" onClick={() => pause(c, true)}>Pause</button>}
              </li>))}
            </ul>)}
        </section>
        <section className="panel" aria-labelledby="paused-people">
          <h2 id="paused-people">People whose changes their limit paused</h2>
          {data.pausedUsers.length === 0 ? <Empty>Nobody is paused.</Empty> : (
            <ul className="plain">{data.pausedUsers.map(u => (
              <li key={u.id} className="row gap wrap">
                <Link to={`/admin/users/${u.id}`}>{u.name}</Link> <span className="muted">({u.username}, limit {u.writeLimit} an hour) {u.reason}</span>
                <button className="btn small" onClick={() => step.ask("user.resume_writes", u.id, <p>Resume changes by <strong>{u.name}</strong>. Check their activity first.</p>,
                  async t => { await api("POST", `/api/admin/users/${u.id}/resume-writes`, { stepUpToken: t }); after(`${u.name}'s changes resumed.`); })}>Resume</button>
              </li>))}
            </ul>)}
        </section>
      </>}
      {step.dialog}
    </div>
  );
}

interface SecurityRow {
  id: string; kind: string; title: string; detail: Record<string, unknown>; state: "open" | "resolved"; occurrences: number; firstSeen: string; lastSeen: string;
  user: { id: string; name: string } | null; cabinet: { id: string; name: string } | null; resolvedBy: string | null; resolvedAt: string | null; resolution: string | null;
}

const KIND: Record<string, string> = {
  write_volume: "Unusual write volume", failed_logins: "Repeated failed sign-ins", failed_step_ups: "Repeated failed confirmations", new_location: "Sign-in from a new network",
  audit_chain: "Audit chain break", agent_self_check: "Agent self-check failed", package_refused: "Package refused", signature_failure: "Signature failure",
  certificate: "Revoked or unknown certificate",
};

export function SecurityAlerts() {
  const [state, setState] = useState<"open" | "resolved" | "all">("open");
  const { data, problem, reload } = useLoad<SecurityRow[]>(`/api/admin/security-alerts?state=${state}`);
  useSecurityNews(() => reload());
  const step = useStepUp();
  const [notes, setNotes] = useState<Record<string, string>>({});
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Security alerts" }]} />
      <h1>Security alerts</h1>
      <div className="row gap" role="group" aria-label="Show">
        {(["open", "resolved", "all"] as const).map(s => <button key={s} className={`btn small ${state === s ? "primary" : ""}`} aria-pressed={state === s} onClick={() => setState(s)}>{s[0]!.toUpperCase() + s.slice(1)}</button>)}
      </div>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && (data.length === 0 ? <Empty>{state === "open" ? "No open security alerts." : "None."}</Empty> : (
        <ul className="plain security-list" aria-label="Security alerts, open first, newest first">{data.map(a => (
          <li key={a.id} className={`card ${a.state === "open" ? "crit" : ""}`}>
            <div className="panel-head">
              <div>
                <Badge tone={a.state === "open" ? "crit" : "off"}>{KIND[a.kind] ?? a.kind}</Badge> <strong>{a.title}</strong>
                <div className="small">
                  {a.occurrences > 1 ? `${a.occurrences} times, ` : ""}first {fullTime(a.firstSeen)}{a.occurrences > 1 && <>, last {fullTime(a.lastSeen)}</>}
                  {a.user && <> · <Link to={`/admin/users/${a.user.id}`}>{a.user.name}</Link></>}
                  {a.cabinet && <> · <Link to={`/cabinets/${a.cabinet.id}`}>{a.cabinet.name}</Link></>}
                </div>
              </div>
            </div>
            <details><summary>Details</summary><pre>{JSON.stringify(a.detail, null, 2)}</pre></details>
            {a.state === "open" ? (
              <form className="row gap wrap" onSubmit={e => { e.preventDefault(); const note = (notes[a.id] ?? "").trim();
                step.ask("security_alert.resolve", a.id, <><p>Close the security alert <strong>{a.title}</strong>.</p><p className="muted">What was found: {note}</p></>,
                  async t => { await api("POST", `/api/admin/security-alerts/${a.id}/resolve`, { note, stepUpToken: t }); reload(); }, { note }); }}>
                <label className="field inline"><span>What you found</span><input required maxLength={256} value={notes[a.id] ?? ""} onChange={e => setNotes(n => ({ ...n, [a.id]: e.target.value }))} /></label>
                <button className="btn primary" type="submit">Close alert</button>
              </form>
            ) : <p className="small">Closed by {a.resolvedBy} {fullTime(a.resolvedAt)}: {a.resolution}</p>}
          </li>))}
        </ul>))}
      {step.dialog}
    </div>
  );
}

interface Settings {
  offlineAlertDays: number; sessionIdleMinutes: number; sessionAbsoluteHours: number;
  retention: { eventsDays: number; commandsDays: number; alertsDays: number; firewallDays: number };
}

export function PlatformSettings() {
  const { data, problem, reload } = useLoad<Settings>("/api/admin/settings");
  const [form, setForm] = useState<Settings | null>(null);
  const step = useStepUp();
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => { if (data) setForm(data); }, [data]);
  if (problem) return <div className="page"><p className="error" role="alert">{problem}</p></div>;
  if (!data || !form) return <div className="page"><p className="muted" role="status">Loading…</p></div>;
  const num = (label: string, value: number, min: number, max: number, set: (n: number) => void, unit: string) => (
    <label className="field inline"><span>{label} ({min}–{max} {unit})</span>
      <input type="number" min={min} max={max} required value={value} onChange={e => set(Number(e.target.value))} /></label>);
  const changes = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const k of ["offlineAlertDays", "sessionIdleMinutes", "sessionAbsoluteHours"] as const) if (form[k] !== data[k]) c[k] = form[k];
    const r: Record<string, number> = {};
    for (const k of ["eventsDays", "commandsDays", "alertsDays", "firewallDays"] as const) if (form.retention[k] !== data.retention[k]) r[k] = form.retention[k];
    if (Object.keys(r).length) c.retention = r;
    return c;
  };
  const save = () => {
    const c = changes();
    step.ask("settings.update", "fleet", <><p>Change these settings:</p><KeyValues rows={Object.entries(c).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])} />
</>,
      async t => { await api("PUT", "/api/admin/settings", { ...c, stepUpToken: t }); setDone("Settings saved."); reload(); }, c);
  };
  const set = (patch: Partial<Settings>) => setForm(f => f && { ...f, ...patch });
  const setR = (patch: Partial<Settings["retention"]>) => setForm(f => f && { ...f, retention: { ...f.retention, ...patch } });
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Settings" }]} />
      <h1>Settings</h1>
      {done && <p className="notice ok" role="status">{done}</p>}
      <form className="form" onSubmit={e => { e.preventDefault(); save(); }}>
        <section className="panel" aria-labelledby="s-alerts"><h2 id="s-alerts">Alerts</h2>
          {num("Offline alert after", form.offlineAlertDays, 1, 90, n => set({ offlineAlertDays: n }), "days")}</section>
        <section className="panel" aria-labelledby="s-sessions"><h2 id="s-sessions">Sign-in</h2>
          <div className="row gap wrap">
            {num("Sign out after idle", form.sessionIdleMinutes, 5, 240, n => set({ sessionIdleMinutes: n }), "minutes")}
            {num("Sign out after at most", form.sessionAbsoluteHours, 1, 24, n => set({ sessionAbsoluteHours: n }), "hours")}
          </div>
          <p className="muted small">Every account, Tier 1 included, signs in with a password and an authenticator code.</p>
        </section>
        <section className="panel" aria-labelledby="s-retention"><h2 id="s-retention">Keep data for</h2>
          <div className="row gap wrap">
            {num("Events", form.retention.eventsDays, 7, 3650, n => setR({ eventsDays: n }), "days")}
            {num("Command results", form.retention.commandsDays, 7, 3650, n => setR({ commandsDays: n }), "days")}
            {num("Resolved alerts", form.retention.alertsDays, 30, 3650, n => setR({ alertsDays: n }), "days")}
            {num("Firewall history", form.retention.firewallDays, 30, 3650, n => setR({ firewallDays: n }), "days")}
          </div>
          <p className="muted small">The audit log is kept forever.</p>
        </section>
        <button className="btn primary" type="submit" disabled={Object.keys(changes()).length === 0}>Save settings</button>
      </form>
      <DemoMode />
      {step.dialog}
    </div>
  );
}
