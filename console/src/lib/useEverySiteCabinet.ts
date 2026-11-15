// The hook half of site-cabinets.ts: the same full read, in useLoad's shape (data, a problem to show, a reload for "Try again").
import { useEffect, useState } from "react";
import { api, describeError } from "./api";
import { everySiteCabinet, type SitePage } from "./site-cabinets";

export function useEverySiteCabinet<C, A extends SitePage<C>>(siteId: string | null): { data: A | null; problem: string | null; reload: () => void } {
  const [state, setState] = useState<{ siteId: string; data: A | null; problem: string | null } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!siteId) return;
    let live = true;
    everySiteCabinet<C, A>(path => api<A>("GET", path), siteId)
      .then(data => { if (live) setState({ siteId, data, problem: null }); }, e => { if (live) setState({ siteId, data: null, problem: describeError(e) }); });
    return () => { live = false; };
  }, [siteId, tick]);
  const mine = state && state.siteId === siteId ? state : null;
  return { data: mine?.data ?? null, problem: mine?.problem ?? null, reload: () => setTick(t => t + 1) };
}
