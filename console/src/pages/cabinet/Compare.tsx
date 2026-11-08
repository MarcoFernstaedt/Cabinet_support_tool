// Compare this cabinet with another at the same site: network, firewall, services, drivers and updates. The fastest way to find what is
// different about the one that fails.
import { useMemo, useState } from "react";
import { Pager, usePaged } from "../../components/Pager";
import { useRunner } from "../../lib/commands";
import { compareReadings, MAX_DIFFERENCES, type Difference, type Reading } from "../../lib/compare";
import { Badge, Empty } from "../../components/ui";
import { api, describeError } from "../../lib/api";
import { categoryName, NOTHING_TO_COMPARE, show } from "../../components/ConfigParts";
import type { CabinetDetail } from "./CabinetPage";

const READS: [keyof Reading, string][] = [["info", "system.info"], ["net", "network.config"], ["firewall", "firewall.state"], ["services", "services.list"], ["drivers", "drivers.list"], ["updates", "updates.status"]];

export function Compare({ cabinet }: { cabinet: CabinetDetail }) {
  const run = useRunner();
  const others = cabinet.siblings.filter(s => s.id !== cabinet.id);
  const [other, setOther] = useState(others[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [diffs, setDiffs] = useState<Difference[] | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  // What the cabinet is compared with: another cabinet (read now), the approved baseline, or its own last healthy state. The last two use what
  // the platform already holds, ask nothing of the cabinet and change nothing on it.
  const [mode, setMode] = useState<"cabinet" | "baseline" | "healthy">("cabinet");
  const [problem, setProblem] = useState<string | null>(null);
  const otherName = others.find(o => o.id === other)?.name ?? "other";
  const goStored = async () => {
    setBusy(true); setDiffs(null); setMissing([]); setProblem(null);
    try {
      if (mode === "baseline") {
        const r = await api<{ drift: { category: string; itemKey: string; field: string; mode: string; expected: unknown; actual: unknown }[] }>("GET", `/api/cabinets/${cabinet.id}/drift`);
        setDiffs(r.drift.slice(0, MAX_DIFFERENCES).map(d => ({ area: categoryName(d.category), what: d.field ? `${d.itemKey} · ${d.field}` : d.itemKey,
          a: d.mode === "present" ? "Missing" : d.mode === "absent" ? "Present" : show(d.actual), b: d.mode === "present" ? "Present" : d.mode === "absent" ? "Not present" : show(d.expected) })));
      } else {
        const r = await api<{ markId: number | null; changes: { category: string; key: string; change: string; fields: Record<string, { before: unknown; after: unknown }> }[]; unavailable: string[]; nothingToCompare?: string | null }>("GET", `/api/cabinets/${cabinet.id}/compare-healthy`);
        // With nothing to compare, the reason why (F8.R5).
        if (!r.markId || r.nothingToCompare === "versions_pruned") { setProblem(NOTHING_TO_COMPARE[r.nothingToCompare ?? "no_mark"] ?? NOTHING_TO_COMPARE.no_mark!); return; }
        setMissing(r.unavailable.map(categoryName));
        const rows: Difference[] = [];
        for (const c of r.changes) {
          const f = Object.entries(c.fields);
          if (f.length === 0) rows.push({ area: categoryName(c.category), what: c.key, a: c.change === "removed" ? "Missing" : "Present", b: c.change === "removed" ? "Present" : "Not present" });
          for (const [name, v] of f) rows.push({ area: categoryName(c.category), what: `${c.key} · ${name}`, a: show(v.after), b: show(v.before) });
        }
        setDiffs(rows.slice(0, MAX_DIFFERENCES));
      }
    } catch (e) { setProblem(describeError(e)); } finally { setBusy(false); }
  };
  const go = async () => {
    if (mode !== "cabinet") return goStored();
    setBusy(true); setDiffs(null); setMissing([]); setProblem(null);
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
  const flat = useMemo(() => {
    const list = diffs ?? [];
    return [...new Set(list.map(d => d.area))].flatMap(area => list.filter(d => d.area === area).map((d, i) => ({ area, d, first: i === 0 })));
  }, [diffs]);
  const paged = usePaged(flat);
  return (
    <section className="panel" aria-labelledby="compare-heading">
      <div className="panel-head">
        <h2 id="compare-heading">Compare</h2>
        <div className="row gap wrap">
          <span>{cabinet.name} with</span>
          <label className="sr-only" htmlFor="compare-mode">Compare with</label>
          <select id="compare-mode" value={mode} onChange={e => { setMode(e.target.value as typeof mode); setDiffs(null); setProblem(null); setMissing([]); }} disabled={busy}>
            <option value="cabinet">another cabinet</option><option value="baseline">its baseline</option><option value="healthy">its last healthy state</option>
          </select>
          {mode === "cabinet" && <>
            <label className="sr-only" htmlFor="compare-with">Other cabinet</label>
            <select id="compare-with" value={other} onChange={e => { setOther(e.target.value); setDiffs(null); }} disabled={others.length === 0 || busy}>
              {others.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select></>}
          <button className="btn primary" disabled={(mode === "cabinet" && !other) || busy} onClick={() => void go()}>{busy ? (mode === "cabinet" ? "Reading both…" : "Comparing…") : "Compare"}</button>
        </div>
      </div>
      {mode === "cabinet" && others.length === 0 && <Empty>This site has no other cabinet to compare with.</Empty>}
      {problem && <p className="error" role="alert">{problem}</p>}
      {mode !== "cabinet" && !diffs && !busy && !problem && <p className="muted">{mode === "baseline" ? "Lists where this cabinet differs from the approved baseline that applies to it." : "Lists what differs from the configuration this cabinet had when it was last recorded healthy."} It uses what the platform already holds and changes nothing on the cabinet.</p>}
      {mode === "cabinet" && others.length > 0 && !diffs && !busy && <p className="muted">Pick a cabinet at this site and press Compare. Both cabinets are read now, and the differences are listed.</p>}
      {diffs && diffs.length >= MAX_DIFFERENCES && <p className="small"><Badge tone="warn">Cut short</Badge> Only the first {MAX_DIFFERENCES} differences are shown.</p>}
      {diffs && mode === "cabinet" && <p className="muted small">Compared: system, network adapter, firewall profiles and rules, services, drivers and installed updates.</p>}
      {missing.length > 0 && <p className="small"><Badge tone="warn">Incomplete</Badge> {mode === "cabinet" ? `Could not read ${missing.join(", ")} from one of the cabinets.` : `The older ${missing.join(", ")} is no longer kept, so it is not compared.`}</p>}
      {diffs && (diffs.length === 0 ? <p><Badge tone="ok">No differences</Badge> in the readings compared.</p> : (
        <table className="table compact">
          <caption className="sr-only">Differences between {cabinet.name} and {mode === "cabinet" ? otherName : mode === "baseline" ? "its baseline" : "its last healthy state"}</caption>
          <thead><tr><th scope="col">Area</th><th scope="col">What</th><th scope="col">{cabinet.name}</th><th scope="col">{mode === "cabinet" ? otherName : mode === "baseline" ? "Baseline" : "Last healthy"}</th></tr></thead>
          <tbody>{paged.rows.map(({ area, d, first }, i) => (
            <tr key={`${area}-${d.what}-${paged.page}-${i}`}><th scope="row">{first || i === 0 ? area : ""}</th><td>{d.what}</td><td>{d.a}</td><td>{d.b}</td></tr>))}</tbody>
        </table>))}
      {diffs && diffs.length > 0 && <Pager {...paged} label="differences" />}
    </section>
  );
}
