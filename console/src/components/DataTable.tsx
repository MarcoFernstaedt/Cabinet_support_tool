// One table for every list reading: typed columns, an optional filter box over the text columns, and a cap on rows drawn at once.
import { useMemo, useState, type ReactNode } from "react";
import { Empty } from "./ui";

export interface Column<R> { header: string; cell: (row: R) => ReactNode; text?: (row: R) => string; first?: boolean }

export function DataTable<R>({ label, rows, columns, empty, limit = 200, filterable = true, truncated }: {
  label: string; rows: readonly R[]; columns: Column<R>[]; empty: string; limit?: number; filterable?: boolean; truncated?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [all, setAll] = useState(false);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? rows.filter(r => columns.some(c => c.text?.(r).toLowerCase().includes(q))) : rows;
  }, [rows, columns, filter]);
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  const drawn = all ? shown : shown.slice(0, limit);
  return (<>
    <div className="row gap wrap">
      {filterable && <input type="search" aria-label={`Filter ${label}`} placeholder="Filter" value={filter} onChange={e => setFilter(e.target.value)} />}
      <span className="muted small">{shown.length === rows.length ? `${rows.length} ${label}` : `${shown.length} of ${rows.length} ${label}`}{truncated ? " (the cabinet sent its first part only)" : ""}</span>
    </div>
    <table className="table compact">
      <caption className="sr-only">{label}</caption>
      <thead><tr>{columns.map(c => <th key={c.header} scope="col">{c.header}</th>)}</tr></thead>
      <tbody>{drawn.map((r, i) => (
        <tr key={i}>{columns.map(c => c.first ? <th key={c.header} scope="row">{c.cell(r)}</th> : <td key={c.header}>{c.cell(r)}</td>)}</tr>))}
      </tbody>
    </table>
    {!all && shown.length > limit && <button className="btn" onClick={() => setAll(true)}>Show all {shown.length}</button>}
  </>);
}

export const dash = <span className="muted">—</span>;
export const orDash = (v: ReactNode | null | undefined) => (v === null || v === undefined || v === "" ? dash : v);
