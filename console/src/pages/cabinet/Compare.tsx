// Compare this cabinet with another at the same site: network, firewall, services, drivers and updates. The fastest way to find what is
// different about the one that fails.
import { useState } from "react";
import { useRunner } from "../../lib/commands";
import { compareReadings, MAX_DIFFERENCES, type Difference, type Reading } from "../../lib/compare";
import { Badge, Empty } from "../../components/ui";
import type { CabinetDetail } from "./CabinetPage";

const READS: [keyof Reading, string][] = [["info", "system.info"], ["net", "network.config"], ["firewall", "firewall.state"], ["services", "services.list"], ["drivers", "drivers.list"], ["updates", "updates.status"]];

export function Compare({ cabinet }: { cabinet: CabinetDetail }) {
  const run = useRunner();
  const others = cabinet.siblings.filter(s => s.id !== cabinet.id);
  const [other, setOther] = useState(others[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [diffs, setDiffs] = useState<Difference[] | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const otherName = others.find(o => o.id === other)?.name ?? "other";
  const go = async () => {
    setBusy(true); setDiffs(null); setMissing([]);
    const read = async (id: string) => {
      const r: Reading = {}, failed: string[] = [];
      await Promise.all(READS.map(async ([k, op]) => {
        try { const res = await run<never>(id, op, {}); if (res.status === "succeeded" && res.output) (r as Record<string, unknown>)[k] = res.output; else failed.push(op); } catch { failed.push(op); }
      }));
      return { r, failed };
    };
    try {
      const [a, b] = await Promise.all([read(cabinet.id), read(other)]);
      setMissing([...new Set([...a.failed, ...b.failed])]);
      setDiffs(compareReadings(a.r, b.r));
    } finally { setBusy(false); }
  };
  const areas = diffs ? [...new Set(diffs.map(d => d.area))] : [];
  return (
    <section className="panel" aria-labelledby="compare-heading">
      <div className="panel-head">
        <h2 id="compare-heading">Compare</h2>
        <div className="row gap wrap">
          <span>{cabinet.name} with</span>
          <label className="sr-only" htmlFor="compare-with">Other cabinet</label>
          <select id="compare-with" value={other} onChange={e => { setOther(e.target.value); setDiffs(null); }} disabled={others.length === 0 || busy}>
            {others.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <button className="btn primary" disabled={!other || busy} onClick={() => void go()}>{busy ? "Reading both…" : "Compare"}</button>
        </div>
      </div>
      {others.length === 0 && <Empty>This site has no other cabinet to compare with.</Empty>}
      {diffs && diffs.length >= MAX_DIFFERENCES && <p className="small"><Badge tone="warn">Cut short</Badge> Only the first {MAX_DIFFERENCES} differences are shown.</p>}
      {diffs && <p className="muted small">Compared: system, network adapter, firewall profiles and rules, services, drivers and installed updates.</p>}
      {missing.length > 0 && <p className="small"><Badge tone="warn">Incomplete</Badge> Could not read {missing.join(", ")} from one of the cabinets.</p>}
      {diffs && (diffs.length === 0 ? <p><Badge tone="ok">No differences</Badge> in the readings compared.</p> : (
        <table className="table compact">
          <caption className="sr-only">Differences between {cabinet.name} and {otherName}</caption>
          <thead><tr><th scope="col">Area</th><th scope="col">What</th><th scope="col">{cabinet.name}</th><th scope="col">{otherName}</th></tr></thead>
          <tbody>{areas.flatMap(area => diffs.filter(d => d.area === area).map((d, i) => (
            <tr key={`${area}-${d.what}-${i}`}><th scope="row">{i === 0 ? area : ""}</th><td>{d.what}</td><td>{d.a}</td><td>{d.b}</td></tr>)))}</tbody>
        </table>))}
    </section>
  );
}
