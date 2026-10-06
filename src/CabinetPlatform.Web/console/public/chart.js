import { h, svg, dateTime, pct } from "./ui.js";

// One series, one percentage axis (0–100). The card title names the series,
// so no legend; hover shows a crosshair and the exact value; a table view
// gives the same numbers without relying on the line.
export function percentChart({ title, points, threshold }) {
  const data = points.filter(p => typeof p.v === "number" && Number.isFinite(p.v) && Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  const figure = h("figure", { class: "chart" }, h("figcaption", null, h("span", null, title), h("strong", null, data.length ? pct(data.at(-1).v) : "—")));
  if (data.length < 2) {
    figure.append(h("p", { class: "muted chart-empty" }, data.length ? "Only one sample so far. The trend appears after the next heartbeat." : "No samples in this window."));
    return figure;
  }
  const W = 560, H = 190, L = 50, R = 12, T = 12, B = 30;
  const t0 = data[0].t, t1 = data.at(-1).t;
  const x = t => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = v => T + (1 - Math.min(100, Math.max(0, v)) / 100) * (H - T - B);
  const grid = [0, 50, 100].map(v => svg("g", { class: "grid" },
    svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v) }),
    svg("text", { x: L - 8, y: y(v) + 6, "text-anchor": "end" }, `${v}%`)));
  const time = t => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const path = data.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = `${path}L${x(t1).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z`;
  const cross = svg("line", { class: "crosshair", y1: T, y2: H - B, visibility: "hidden" });
  const dot = svg("circle", { class: "dot", r: 4, visibility: "hidden" });
  const plot = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${title}: ${data.length} samples from ${dateTime(t0)} to ${dateTime(t1)}, latest ${pct(data.at(-1).v)}` },
    ...grid,
    threshold ? svg("line", { class: "threshold", x1: L, x2: W - R, y1: y(threshold), y2: y(threshold) }) : null,
    svg("path", { class: "area", d: area }),
    svg("path", { class: "line", d: path }),
    svg("text", { class: "axis", x: L, y: H - 4 }, time(t0)),
    svg("text", { class: "axis", x: W - R, y: H - 4, "text-anchor": "end" }, time(t1)),
    cross, dot);
  const tip = h("div", { class: "chart-tip", hidden: true });
  const wrap = h("div", { class: "chart-plot" }, plot, tip);
  const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); };
  wrap.addEventListener("pointerleave", hide);
  wrap.addEventListener("pointermove", e => {
    const box = plot.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = data[0];
    for (const p of data) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
    const cx = x(best.t), cy = y(best.v);
    cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.replaceChildren(h("strong", null, pct(best.v)), h("span", null, dateTime(best.t)));
    tip.style.left = `${(cx / W) * 100}%`;
    tip.style.top = `${(cy / H) * 100}%`;
  });
  figure.append(wrap, h("details", { class: "chart-table" }, h("summary", null, "Show data table"),
    h("table", null, h("thead", null, h("tr", null, h("th", null, "Collected"), h("th", null, title))),
      h("tbody", null, data.slice().reverse().map(p => h("tr", null, h("td", null, dateTime(p.t)), h("td", null, pct(p.v))))))));
  return figure;
}
