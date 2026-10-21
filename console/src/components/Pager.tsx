// Paging for long lists: a fixed number of rows per page with Previous and Next, so a page never turns into a long scroll.
// The page resets to the first when the list itself changes (a new filter, a reload with different rows).
import { useEffect, useState } from "react";

export const PAGE_SIZE = 25;

export function usePaged<T>(rows: readonly T[], size = PAGE_SIZE) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  useEffect(() => { setPage(0); }, [rows.length, size]);
  const at = Math.min(page, pages - 1);
  return { rows: rows.slice(at * size, at * size + size), page: at, pages, total: rows.length, size, setPage };
}

export function Pager({ page, pages, total, size, setPage, label = "rows" }: { page: number; pages: number; total: number; size: number; setPage: (n: number) => void; label?: string }) {
  if (total <= size) return null;
  const from = page * size + 1, to = Math.min(total, (page + 1) * size);
  return (
    <nav className="pager row gap wrap" aria-label={`Pages of ${label}`}>
      <button className="btn small" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
      <span className="muted small" role="status">{from}–{to} of {total} · page {page + 1} of {pages}</span>
      <button className="btn small" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</button>
    </nav>
  );
}
