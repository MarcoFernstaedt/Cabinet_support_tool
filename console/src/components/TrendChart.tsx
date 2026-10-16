// Load over time for one cabinet, as three small line charts drawn by hand: no chart library. Each shows the range it covers, the latest
// value, and a line a person can read at a glance; the values are also in the table under the chart for anyone who cannot see the line.
import { useState } from "react";
import { useLoad } from "../lib/useLoad";
import { fullTime } from "../lib/time";

interface Point { at: string; cpu: number; memory: number; diskFree: number }
const RANGES = [["6", "6 hours"], ["24", "24 hours"], ["72", "3 days"], ["168", "7 days"], ["336", "14 days"]] as const;
const W = 360, H = 90, PAD = 4;

/** The polyline of values against time, 0 to 100 on the vertical, or "" when there is nothing to draw. */
export function linePath(points: { t: number; v: number }[], from: number, to: number): string {
  if (points.length === 0 || to <= from) return "";
  return points.map(p => `${(PAD + ((p.t - from) / (to - from)) * (W - 2 * PAD)).toFixed(1)},${(H - PAD - (Math.min(100, Math.max(0, p.v)) / 100) * (H - 2 * PAD)).toFixed(1)}`).join(" ");
}

function Chart({ title, points, pick, hint, tone }: { title: string; points: Point[]; pick: (p: Point) => number; hint: string; tone: string }) {
  const series = points.map(p => ({ t: Date.parse(p.at), v: pick(p) }));
  const from = series[0]?.t ?? 0, to = series[series.length - 1]?.t ?? 0;
  const last = series[series.length - 1];
  return (
    <figure className="trend">
      <figcaption><strong>{title}</strong> <span className="muted small">{hint}</span> {last && <span className="trend-now">{last.v}%</span>}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${last ? `${last.v}% at ${fullTime(new Date(last.t).toISOString())}` : "no samples"}`} className={`trend-svg ${tone}`}>
        {[25, 50, 75].map(g => <line key={g} x1={PAD} x2={W - PAD} y1={H - PAD - (g / 100) * (H - 2 * PAD)} y2={H - PAD - (g / 100) * (H - 2 * PAD)} className="trend-grid" />)}
        <polyline points={linePath(series, from, to)} fill="none" className="trend-line" />
      </svg>
    </figure>
  );
}

export function TrendCharts({ cabinetId }: { cabinetId: string }) {
  const [hours, setHours] = useState("24");
  const { data, problem } = useLoad<{ hours: number; points: Point[] }>(`/api/cabinets/${cabinetId}/health?hours=${hours}`);
  return (
    <section className="panel" aria-labelledby="trend-heading">
      <div className="panel-head">
        <div><h3 id="trend-heading">Load over time</h3><p className="muted small">Sampled from the cabinet's heartbeat about every 5 minutes.</p></div>
        <label className="field inline"><span>Range</span><select value={hours} onChange={e => setHours(e.target.value)}>{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      </div>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && data.points.length === 0 && <p className="muted">No samples yet. The cabinet sends one with its heartbeat once its agent is up to date.</p>}
      {data && data.points.length > 0 && (
        <div className="trends">
          <Chart title="Processor" points={data.points} pick={p => p.cpu} hint="busy" tone="cpu" />
          <Chart title="Memory" points={data.points} pick={p => p.memory} hint="in use; a line that only climbs is a leak" tone="memory" />
          <Chart title="System drive" points={data.points} pick={p => p.diskFree} hint="free; falling means filling up" tone="disk" />
        </div>)}
    </section>
  );
}
