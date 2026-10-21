// The configuration changes the agent reported for one cabinet: each item that changed, what it was and what it is, and the window it is known to
// have changed in. Shown under "What changed", next to the changes Windows logged itself.
import { useState } from "react";
import { useLoad } from "../lib/useLoad";
import { Pager, usePaged } from "./Pager";
import { Badge, Empty } from "./ui";
import { CATEGORIES, categoryName, FieldChange, WhenKnown, type FieldChanges } from "./ConfigParts";

export interface ConfigChange { id: number; category: string; itemKey: string; change: string; fields: FieldChanges; notBefore: string | null; observedAt: string; exactAt: string | null; gap: boolean; viaPlatform: boolean; violatesBaseline: boolean }

export function ConfigChanges({ cabinetId, headingId = "config-changes-heading" }: { cabinetId: string; headingId?: string }) {
  const [filter, setFilter] = useState({ category: "", q: "", violations: false, days: "14" });
  const query = new URLSearchParams({ days: filter.days, ...(filter.category ? { category: filter.category } : {}), ...(filter.q.trim() ? { q: filter.q.trim() } : {}), ...(filter.violations ? { violations: "true" } : {}) }).toString();
  const { data, problem } = useLoad<{ changes: ConfigChange[] }>(`/api/cabinets/${cabinetId}/config-changes?${query}`);
  const paged = usePaged(data?.changes ?? []);
  return (
    <section className="panel" aria-labelledby={headingId}>
      <div className="panel-head"><h2 id={headingId}>Configuration the agent reported changing</h2></div>
      <p className="muted small">Each line is one item whose settings were different at the cabinet's next look. The time is the window between two looks, never a moment the platform does not know.</p>
      <form className="row gap wrap" onSubmit={e => e.preventDefault()}>
        <label className="field inline"><span>Category</span><select value={filter.category} onChange={e => setFilter(f => ({ ...f, category: e.target.value }))}>
          <option value="">All</option>{CATEGORIES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
        <label className="field inline"><span>Item</span><input type="search" value={filter.q} maxLength={100} onChange={e => setFilter(f => ({ ...f, q: e.target.value }))} /></label>
        <label className="field inline"><span>Days</span><select value={filter.days} onChange={e => setFilter(f => ({ ...f, days: e.target.value }))}>{["1", "7", "14", "30", "90"].map(d => <option key={d}>{d}</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={filter.violations} onChange={e => setFilter(f => ({ ...f, violations: e.target.checked }))} /> Only changes that go against the baseline</label>
      </form>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && data.changes.length === 0 && <Empty>No configuration changes in this period.</Empty>}
      {data && data.changes.length > 0 && (
        <div className="table-wrap"><table className="table compact">
          <caption className="sr-only">Configuration changes, newest first</caption>
          <thead><tr><th scope="col">What changed</th><th scope="col">When it is known to have changed</th><th scope="col">Notes</th></tr></thead>
          <tbody>{paged.rows.map(c => (
            <tr key={c.id}>
              <th scope="row">{categoryName(c.category)}: {c.itemKey} <span className="muted">{c.change}</span><FieldChange fields={c.fields} /></th>
              <td><WhenKnown c={c} /></td>
              <td>{c.violatesBaseline && <Badge tone="crit">Goes against the baseline</Badge>} {c.viaPlatform && <Badge tone="info">Made through the platform</Badge>}</td>
            </tr>))}</tbody>
        </table></div>)}
      <Pager {...paged} label="configuration changes" />
    </section>
  );
}
