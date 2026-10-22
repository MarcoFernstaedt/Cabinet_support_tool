// The welcome tour for people who will use the platform: a guide beside the real page that goes through the menu and each cabinet tab, outlining
// each one as it is explained (docs/platform/first-sign-in.md). It is shown at first sign-in and from the Account page. Stopping it, by any route,
// counts as having seen it. Its place is kept for this browser tab, so a reload does not lose it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { useRouter } from "../lib/router";
import { currentPath } from "../lib/base";
import { useSession } from "../lib/session";
import { useSpotlight } from "../lib/spotlight";
import { forMode, welcomeSteps } from "../lib/welcome-tour";

type Mode = "choose" | "quick" | "full";
interface Place { mode: Mode; step: number }
/** Kept per person, so the next person to sign in at this browser never finds someone else's tour half done. */
const key = (userId: string) => `welcome-tour:${userId}`;
const read = (userId: string): Place | null => {
  try { const v = sessionStorage.getItem(key(userId))?.split(":"); return v && (v[0] === "choose" || v[0] === "quick" || v[0] === "full") && Number.isInteger(Number(v[1])) ? { mode: v[0], step: Number(v[1]) } : null; }
  catch { return null; }
};
const write = (userId: string, p: Place | null) => { try { if (p) sessionStorage.setItem(key(userId), `${p.mode}:${p.step}`); else sessionStorage.removeItem(key(userId)); } catch { /* storage unavailable */ } };

/** Starts the tour from anywhere (first sign-in, the Account page). */
export const startWelcomeTour = () => window.dispatchEvent(new Event("welcome-tour"));

export function WelcomeTour() {
  const { me, refresh } = useSession();
  const { navigate, path } = useRouter();
  const [place, setPlace] = useState<Place | null>(() => read(me.id));
  const [cabinetId, setCabinetId] = useState<string | null | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);

  // The first time a person signs in, the tour starts by itself.
  const offered = useRef(false);
  useEffect(() => { if (!me.tourCompleted && !offered.current && !read(me.id)) { offered.current = true; setPlace({ mode: "choose", step: 0 }); write(me.id, { mode: "choose", step: 0 }); } }, [me.tourCompleted, me.id]);
  useEffect(() => {
    const on = () => { const p = { mode: "choose" as Mode, step: 0 }; write(me.id, p); setPlace(p); };
    window.addEventListener("welcome-tour", on);
    return () => window.removeEventListener("welcome-tour", on);
  }, [me.id]);
  // A cabinet to walk through, if the person can see any.
  useEffect(() => {
    if (!place || cabinetId !== undefined) return;
    api<{ cabinet: { id: string } | null }>("GET", "/api/fleet/first-cabinet").then(r => setCabinetId(r.cabinet?.id ?? null), () => setCabinetId(null));
  }, [place, cabinetId]);

  const all = useMemo(() => (cabinetId === undefined ? null : welcomeSteps(me, cabinetId)), [me, cabinetId]);
  const steps = all ? forMode(all, place?.mode === "quick" ? "quick" : "full") : null;
  const step = place && steps ? steps[Math.min(place.step, steps.length - 1)] : undefined;
  const { found, spot, pos, dim, panel, lookAgain } = useSpotlight(place?.mode === "choose" ? undefined : step?.target, `${place?.mode}:${place?.step}:${path}`, 8_000);

  const stop = useCallback((seen = true) => {
    write(me.id, null); setPlace(null);
    if (seen) void api("POST", "/api/auth/tour-complete", {}).then(() => refresh(), () => undefined);
  }, [refresh, me.id]);
  const go = useCallback((mode: Mode, n: number) => {
    const list = all ? forMode(all, mode === "quick" ? "quick" : "full") : null;
    const next = { mode, step: n };
    write(me.id, next); setPlace(next);
    const to = list?.[n]?.path;
    if (to && to !== currentPath()) navigate(to);
  }, [all, navigate, me.id]);
  // Each step's heading takes the focus, so a keyboard or screen-reader user hears where they are.
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [place?.mode, place?.step, step?.id]);
  useEffect(() => {
    if (!place) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") stop(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [place, stop]);

  if (!place || !steps || !step) return null;
  const choosing = place.mode === "choose";
  const n = Math.min(place.step, steps.length - 1), last = n === steps.length - 1;
  const first = steps[0]!;
  return (<>
    {!choosing && dim && spot && <div className="tour-spot" aria-hidden="true" style={spot} />}
    <aside ref={panel} role="dialog" aria-modal="false" aria-labelledby="welcome-title" aria-describedby="welcome-body"
      className={`demo-tour welcome-tour${choosing ? " centered" : ""}${pos && !choosing ? " anchored" : ""}`} style={pos && !choosing ? { top: pos.top, left: pos.left } : undefined}>
      {!choosing && <p className="muted small">{place.mode === "quick" ? "Quick tour" : "Full tour"} · step {n} of {steps.length - 1}</p>}
      <h2 id="welcome-title" ref={heading} tabIndex={-1}>{choosing ? first.title : step.title}</h2>
      <div id="welcome-body" className="stack">
        {(choosing ? first.body : step.body).map((p, i) => <p key={i}>{p}</p>)}
        {!choosing && step.needs && <p className="small"><strong>Who can do what:</strong> {step.needs}</p>}
        {!choosing && step.target && found === "missing" && <p className="small muted" role="status">This is not on screen for you, so it is not outlined. Carry on.</p>}
      </div>
      {choosing ? (
        <div className="row gap wrap">
          <button className="btn primary" onClick={() => go("full", 1)}>Take the tour</button>
          <button className="btn" onClick={() => go("quick", 1)}>Short version</button>
          <button className="btn ghost" onClick={() => stop()}>Skip tour</button>
        </div>
      ) : (
        <div className="row gap wrap">
          <button className="btn small" onClick={() => go(place.mode, Math.max(1, n - 1))} disabled={n <= 1}>Back</button>
          {last ? <button className="btn small primary" onClick={() => { stop(); if (currentPath() !== "/") navigate("/"); }}>Finish</button> : <button className="btn small primary" onClick={() => go(place.mode, n + 1)}>Next</button>}
          {found === "missing" && <button className="btn small ghost" onClick={lookAgain}>Look again</button>}
          <button className="btn small ghost" onClick={() => stop()}>Skip tour</button>
        </div>
      )}
    </aside>
  </>);
}
