// What changed on this cabinet, newest first: Windows updates, drivers, services, software, restarts, the firewall, and what people did from here,
// next to the errors. The first thing to ask of a cabinet that has just started failing is what changed before it did.
import { useMemo, useState } from "react";
import { useLoad } from "../../lib/useLoad";
import { Pager, usePaged } from "../../components/Pager";
import { Badge, Empty } from "../../components/ui";
import { fullTime } from "../../lib/time";

interface Item { at: string; category: string; title: string; detail?: string | null }
const CHANGE = new Set(["update_installed", "update_started", "driver_installed", "service_installed", "software_installed", "software_removed", "firewall", "platform_change", "restart_requested"]);
const PROBLEM = new Set(["update_failed", "driver_failed", "service_failure", "unexpected_shutdown", "crash", "storage", "hardware", "scanner", "error"]);
const TONE: Record<string, "ok" | "warn" | "crit" | "info" | "off"> = { crash: "crit", unexpected_shutdown: "crit", storage: "crit", hardware: "crit", update_failed: "warn", driver_failed: "warn", service_failure: "warn", error: "warn", scanner: "warn" };
const DAYS = [["1", "24 hours"], ["3", "3 days"], ["7", "7 days"], ["14", "14 days"], ["30", "30 days"]] as const;

export function Changes({ cabinetId }: { cabinetId: string }) {
  const [days, setDays] = useState("7");
  const [only, setOnly] = useState<"all" | "changes" | "problems">("all");
  const { data, problem } = useLoad<{ items: Item[] }>(`/api/cabinets/${cabinetId}/timeline?days=${days}`);
  const items = useMemo(() => [...(data?.items ?? [])].filter(i => i.category !== "boot" || only === "all").sort((a, b) => b.at.localeCompare(a.at)), [data, only]);
  const shown = items.filter(i => only === "all" || (only === "changes" ? CHANGE.has(i.category) : PROBLEM.has(i.category)));
  const paged = usePaged(shown);
  // The first problem in the window, and every change in the day before it.
  const asc = [...(data?.items ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  const first = asc.find(i => PROBLEM.has(i.category));
  const before = first ? asc.filter(i => CHANGE.has(i.category) && i.at < first.at && new Date(first.at).getTime() - new Date(i.at).getTime() <= 86_400_000) : [];
  return (
    <section className="panel" aria-labelledby="changes-heading">
      <div className="panel-head">
        <h2 id="changes-heading">What changed</h2>
        <div className="row gap wrap">
          <label className="sr-only" htmlFor="changes-days">Period</label>
          <select id="changes-days" value={days} onChange={e => setDays(e.target.value)}>{DAYS.map(([v, l]) => <option key={v} value={v}>Last {l}</option>)}</select>
          <label className="sr-only" htmlFor="changes-only">Show</label>
          <select id="changes-only" value={only} onChange={e => setOnly(e.target.value as typeof only)}><option value="all">Everything</option><option value="changes">Changes only</option><option value="problems">Problems only</option></select>
        </div>
      </div>
      {problem && <p className="error" role="alert">{problem}</p>}
      {first && (
        <div className="notice warn" role="status">
          <strong>First problem: {first.title}</strong> at {fullTime(first.at)}.{" "}
          {before.length === 0 ? "Nothing changed in the 24 hours before it." : <>Changed in the 24 hours before it: {before.map(b => b.title).join("; ")}.</>}
        </div>)}
      {data && shown.length === 0 && <Empty>Nothing recorded in this period.</Empty>}
      {shown.length > 0 && (
        <table className="table compact">
          <caption className="sr-only">Changes and problems on this cabinet</caption>
          <thead><tr><th scope="col">When</th><th scope="col">Type</th><th scope="col">What</th><th scope="col">Detail</th></tr></thead>
          <tbody>{paged.rows.map((i, n) => (
            <tr key={`${i.at}-${n}`} className={first && i.at === first.at && i.title === first.title ? "warn" : undefined}>
              <td>{fullTime(i.at)}</td>
              <td><Badge tone={TONE[i.category] ?? (CHANGE.has(i.category) ? "info" : "off")}>{CHANGE.has(i.category) ? "Change" : PROBLEM.has(i.category) ? "Problem" : "Event"}</Badge></td>
              <th scope="row">{i.title}</th><td className="small">{i.detail ?? ""}</td>
            </tr>))}</tbody>
        </table>)}
      <Pager {...paged} label="changes" />
    </section>
  );
}
