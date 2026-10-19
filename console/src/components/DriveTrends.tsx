// What the platform has learned about a cabinet's drives over time, and which drives anywhere in the fleet need attention. The level is
// worked out on the server from the drive's history (growth of bad sectors, wear projected forward, heat); this shows it with its reasons.
import { useLoad } from "../lib/useLoad";
import { ago, fullTime } from "../lib/time";
import { Link } from "../lib/router";
import { Badge } from "./ui";

type Level = "ok" | "watch" | "act" | "urgent";
const LEVEL: Record<Level, { tone: "ok" | "info" | "warn" | "crit"; label: string; advice: string }> = {
  ok: { tone: "ok", label: "Fine", advice: "" },
  watch: { tone: "info", label: "Watch", advice: "Nothing to do yet. Look at it again at the next visit." },
  act: { tone: "warn", label: "Plan a replacement", advice: "Order a replacement drive and make sure backups are current." },
  urgent: { tone: "crit", label: "Back up and replace now", advice: "Back up now and replace the drive as soon as possible." },
};
export const levelBadge = (level: Level) => <Badge tone={LEVEL[level].tone}>{LEVEL[level].label}</Badge>;

interface Drive {
  key: string; model: string | null; serialNumber: string | null; level: Level; reasons: { code: string; level: Level; text: string }[];
  projection: { wearFullInDays: number | null; reallocatedPer30Days: number | null; temperatureRise30Days: number | null }; assessedAt: string;
  latest: { at: string; health: string; temperature: number | null; powerOnHours: number | null; reallocated: number | null; pending: number | null; uncorrectable: number | null; wear: number | null } | null;
  history: { at: string; reallocated: number | null; pending: number | null; wear: number | null; temperature: number | null }[];
}

const W = 240, H = 56, PAD = 3;
/** A small line of one value over time, scaled to its own range (a flat line is drawn flat, not stretched). */
export function Sparkline({ points, label }: { points: { t: number; v: number }[]; label: string }) {
  if (points.length < 2) return null;
  const lo = Math.min(...points.map(p => p.v)), hi = Math.max(...points.map(p => p.v)), t0 = points[0]!.t, t1 = points[points.length - 1]!.t;
  const y = (v: number) => (hi === lo ? H / 2 : H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD));
  const line = points.map(p => `${(PAD + ((p.t - t0) / Math.max(1, t1 - t0)) * (W - 2 * PAD)).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="trend-svg" role="img" aria-label={`${label}: from ${points[0]!.v} to ${points[points.length - 1]!.v} over ${Math.round((t1 - t0) / 86_400_000)} days`}>
      <polyline points={line} fill="none" className="trend-line" />
    </svg>
  );
}

const series = (d: Drive, pick: (h: Drive["history"][number]) => number | null) =>
  d.history.flatMap(h => { const v = pick(h); return v === null ? [] : [{ t: Date.parse(h.at), v }]; });

export function DriveTrends({ cabinetId }: { cabinetId: string }) {
  const { data, problem } = useLoad<{ drives: Drive[] }>(`/api/cabinets/${cabinetId}/drives`);
  if (problem) return <p className="error" role="alert">{problem}</p>;
  if (!data || data.drives.length === 0) return data ? <p className="muted small">No drive history yet. The cabinet's agent reports its drives once a day.</p> : null;
  return (
    <section className="panel" aria-labelledby="drive-trends-heading">
      <h2 id="drive-trends-heading">Drive history</h2>
      <p className="muted small">Each drive's own health report, kept daily, so a drive that is getting worse shows up before it fails.</p>
      <div className="cards">{data.drives.map(d => (
        <article key={d.key} className={`card ${LEVEL[d.level].tone === "crit" ? "crit" : LEVEL[d.level].tone === "warn" ? "warn" : ""}`} aria-label={`History of ${d.model ?? d.key}`}>
          <h4>{d.model ?? d.key} {levelBadge(d.level)}</h4>
          {d.level !== "ok" && <p>{LEVEL[d.level].advice}</p>}
          {d.reasons.length > 0 && <ul>{d.reasons.map(r => <li key={r.code}>{r.text}</li>)}</ul>}
          {d.projection.wearFullInDays !== null && <p className="small">Wear projected to reach 100% in about <strong>{d.projection.wearFullInDays} days</strong> at its recent rate.</p>}
          <div className="trends">
            {d.history.some(h => h.wear !== null) && <figure className="trend"><figcaption><strong>Wear</strong> <span className="trend-now">{d.latest?.wear ?? "?"}%</span></figcaption><Sparkline label="Wear" points={series(d, h => h.wear)} /></figure>}
            {d.history.some(h => (h.reallocated ?? 0) > 0) && <figure className="trend"><figcaption><strong>Reallocated sectors</strong> <span className="trend-now">{d.latest?.reallocated ?? "?"}</span></figcaption><Sparkline label="Reallocated sectors" points={series(d, h => h.reallocated)} /></figure>}
            {d.history.some(h => h.temperature !== null) && <figure className="trend"><figcaption><strong>Temperature</strong> <span className="trend-now">{d.latest?.temperature ?? "?"} °C</span></figcaption><Sparkline label="Temperature" points={series(d, h => h.temperature)} /></figure>}
          </div>
          <p className="muted small">{d.history.length} reports, the latest {d.latest ? fullTime(d.latest.at) : "never"}.</p>
        </article>))}
      </div>
    </section>
  );
}

interface AtRisk { cabinetId: string; cabinet: string; site: string; client: string; demo: boolean; model: string | null; level: Level; reasons: string[]; assessedAt: string }

/** Drives that are a concern anywhere in the fleet. Shows nothing at all when every drive is fine. */
export function DrivesAtRisk() {
  const { data } = useLoad<{ drives: AtRisk[] }>("/api/fleet/drives-at-risk");
  if (!data || data.drives.length === 0) return null;
  return (
    <section className="panel" aria-labelledby="at-risk-heading">
      <h2 id="at-risk-heading">Drives to look at</h2>
      <p className="muted small">Judged from each drive's own reports over time. Replace before they fail.</p>
      <table className="table compact">
        <caption className="sr-only">Drives at risk</caption>
        <thead><tr><th scope="col">Cabinet</th><th scope="col">Client · site</th><th scope="col">Drive</th><th scope="col">Level</th><th scope="col">Why</th><th scope="col">Judged</th></tr></thead>
        <tbody>{data.drives.map((d, i) => (
          <tr key={`${d.cabinetId}-${i}`}>
            <th scope="row"><Link to={`/cabinets/${d.cabinetId}/drives`}>{d.cabinet}</Link></th>
            <td>{d.client} · {d.site}</td><td>{d.model ?? "—"}</td><td>{levelBadge(d.level)}</td><td>{d.reasons.join(" ")}</td><td>{ago(d.assessedAt)}</td>
          </tr>))}</tbody>
      </table>
    </section>
  );
}
