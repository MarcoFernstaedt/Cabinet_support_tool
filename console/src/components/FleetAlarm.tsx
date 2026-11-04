// The fleet alarm (decision-log D23): when the same problem hits many sites, everyone with the console open hears it within seconds.
// A red banner on every page until acknowledged, a short sound, and a desktop notification when the browser allows it. A console opened
// later shows the open patterns at once. Acknowledging hides the banner in this browser only; the pattern stays open until it resolves.
import { useCallback, useEffect, useState } from "react";
import { useFleetNews, type FleetNews } from "../lib/commands";
import { alarmText, parseAcknowledged, unacknowledged, type OpenPattern } from "../lib/fleet-alarm";
import { useLoad } from "../lib/useLoad";
import { Link } from "../lib/router";

const KEY = "fleetAlarm.acknowledged";
const readAck = (): Set<string> => { try { return parseAcknowledged(localStorage.getItem(KEY)); } catch { return new Set(); } };
const writeAck = (s: Set<string>) => { try { localStorage.setItem(KEY, JSON.stringify([...s])); } catch { /* storage unavailable: the banner just comes back */ } };

/** A short two-tone beep, made here: no sound file to load. Browsers may block it until the page has been used; the banner still shows. */
function beep(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [880, 660].forEach((hz, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = hz; g.gain.value = 0.15;
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.25); o.stop(ctx.currentTime + i * 0.25 + 0.2);
    });
    setTimeout(() => { void ctx.close(); }, 1000);
  } catch { /* no sound available */ }
}

function desktop(p: OpenPattern): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const n = new Notification("Fleet alert", { body: alarmText(p), tag: p.id, requireInteraction: true });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* notifications unavailable */ }
}

export function FleetAlarm() {
  const { data, problem, reload } = useLoad<{ patterns: (OpenPattern & { resolvedAt: string | null })[] }>("/api/fleet-patterns");
  // A failed load is said, and tried again every minute, so a console never sits silent believing all is well.
  useEffect(() => {
    if (!problem) return;
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
  }, [problem, reload]);
  const [ack, setAck] = useState<Set<string>>(readAck);
  const [live, setLive] = useState<OpenPattern[]>([]);
  const [permission, setPermission] = useState(() => (typeof Notification === "undefined" ? "unsupported" : Notification.permission));
  useFleetNews((n: FleetNews) => {
    if (n.change === "opened") {
      const p = { id: n.id, title: n.title, sites: n.sites, cabinets: n.cabinets, clients: n.clients };
      setLive(l => [p, ...l.filter(x => x.id !== n.id)]);
      beep();
      desktop(p);
    } else setLive(l => l.filter(x => x.id !== n.id));
    reload();
  });
  // Open patterns from the server, plus any just announced that the list has not caught up with.
  const known = new Map<string, OpenPattern & { resolvedAt?: string | null }>();
  for (const p of data?.patterns ?? []) known.set(p.id, p);
  for (const p of live) if (!known.has(p.id)) known.set(p.id, p);
  const shown = unacknowledged([...known.values()], ack);
  const acknowledge = useCallback((id: string) => setAck(a => { const next = new Set(a); next.add(id); writeAck(next); return next; }), []);
  // The tab counts open alarms; the title it had before comes back when none is left.
  useEffect(() => {
    if (shown.length === 0) return;
    const before = document.title;
    document.title = `(${shown.length}) Fleet alert`;
    return () => { if (document.title === `(${shown.length}) Fleet alert`) document.title = before; };
  }, [shown.length]);
  if (problem && shown.length === 0)
    return (
      <div className="banner warn fleet-alarm" role="status">
        <p>Could not check for fleet alerts ({problem}). Trying again every minute. <button className="btn small" onClick={reload}>Try now</button></p>
      </div>);
  if (shown.length === 0) return null;
  return (
    <div className="banner crit fleet-alarm" role="alert" aria-live="assertive">
      {shown.slice(0, 3).map(p => (
        <p key={p.id}><strong>Fleet alert.</strong> {alarmText(p)}. <Link to="/incidents">See who has it and what they have in common</Link>{" "}
          <button className="btn small" onClick={() => acknowledge(p.id)}>Acknowledge</button></p>))}
      {shown.length > 3 && <p>And {shown.length - 3} more on the Incidents page.</p>}
      {permission === "default" && (
        <p><button className="btn small" onClick={() => { void Notification.requestPermission().then(setPermission); }}>Also alert me on the desktop</button></p>)}
    </div>);
}
