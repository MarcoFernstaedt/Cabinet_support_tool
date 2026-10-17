// Pointing at a control on the real page: finding it (the page may still be loading), scrolling it into view, outlining it, dimming the rest, and
// placing a guide panel beside it so the panel never covers it. Used by the product tour and by the guided demo.
import { useEffect, useRef, useState } from "react";

/** The control a step is about: a CSS selector, and optionally text the element must contain. */
export interface Target { selector: string; text?: string }
export type Found = "looking" | "found" | "missing" | null;

export function useSpotlight(target: Target | undefined, resetKey: string, giveUpAfterMs = 90_000) {
  const [looks, setLooks] = useState(0);
  const [found, setFound] = useState<Found>(null);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const targetKey = target ? `${target.selector}|${target.text ?? ""}` : "";
  // Find the control, scroll it to the middle of the screen and outline it. A page may still be loading, so keep looking for a while.
  useEffect(() => {
    if (!target) { setFound(null); return; }
    let stopped = false, marked: Element | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    setFound("looking");
    const look = () => {
      if (stopped) return;
      const e = [...document.querySelectorAll<HTMLElement>(target.selector)].find(x => !target.text || (x.textContent ?? "").includes(target.text));
      if (e) { e.scrollIntoView({ behavior: "smooth", block: "center" }); e.classList.add("tour-target"); marked = e; setEl(e); setFound("found"); return; }
      if (Date.now() - started > giveUpAfterMs) { setFound("missing"); return; }
      timer = setTimeout(look, 400);
    };
    look();
    return () => { stopped = true; if (timer) clearTimeout(timer); marked?.classList.remove("tour-target"); setEl(null); };
  }, [resetKey, looks, targetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The page is shown whole for a moment, then everything but the control is dimmed, and the guide sits beside the control instead of over it.
  const [dim, setDim] = useState(false);
  const [spot, setSpot] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    setDim(false);
    if (!el) { setSpot(null); setPos(null); return; }
    const timer = setTimeout(() => setDim(true), 700);
    let last = "";
    const measure = () => {
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      const key = [r.top, r.left, r.width, r.height, window.innerWidth, window.innerHeight, panel.current?.offsetHeight ?? 0].map(Math.round).join(",");
      if (key === last) return;
      last = key;
      setSpot({ top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12 });
      setPos(panelPosition(r, 380, panel.current?.offsetHeight ?? 260));
    };
    measure();
    const t = setInterval(measure, 120);
    return () => { clearTimeout(timer); clearInterval(t); };
  }, [el]);

  return { found, el, spot, pos, dim, panel, lookAgain: () => setLooks(n => n + 1) };
}

/** Where the guide goes so it does not cover the control: beside it if there is room, else below or above; null puts it back in the corner. */
function panelPosition(r: DOMRect, width: number, height: number): { top: number; left: number } | null {
  const vw = window.innerWidth, vh = window.innerHeight, gap = 18, edge = 12;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  let at: { top: number; left: number } | null = null;
  if (r.right + gap + width + edge <= vw) at = { left: r.right + gap, top: r.top };
  else if (r.left - gap - width >= edge) at = { left: r.left - gap - width, top: r.top };
  else if (r.bottom + gap + height + edge <= vh) at = { top: r.bottom + gap, left: r.left };
  else if (r.top - gap - height >= edge) at = { top: r.top - gap - height, left: r.left };
  if (!at) return null;
  // Always fully on screen; and if keeping it on screen would put it over the control, use the corner instead.
  const top = clamp(at.top, edge, vh - height - edge), left = clamp(at.left, edge, vw - width - edge);
  const overlaps = left < r.right && left + width > r.left && top < r.bottom && top + height > r.top;
  return overlaps ? null : { top, left };
}
