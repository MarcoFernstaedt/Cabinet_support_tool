import { useEffect, useState } from "react";
import { api, describeError } from "./api";

/**
 * Loads one API path and reloads on demand. Data belongs to the path it came from: when the path changes, the old
 * data is dropped at once, so a page never shows (or saves back) the previous client's, site's or cabinet's values
 * under the new one's address while the new data loads.
 */
export function useLoad<T>(path: string | null): { data: T | null; problem: string | null; reload: () => void } {
  const [loaded, setLoaded] = useState<{ path: string; data: T } | null>(null);
  const [problem, setProblem] = useState<{ path: string; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setProblem(null);
    api<T>("GET", path).then(d => { if (live) setLoaded({ path, data: d }); }, e => { if (live) setProblem({ path, text: describeError(e) }); });
    return () => { live = false; };
  }, [path, tick]);
  return {
    data: loaded && loaded.path === path ? loaded.data : null,
    problem: problem && problem.path === path ? problem.text : null,
    reload: () => setTick(t => t + 1),
  };
}
