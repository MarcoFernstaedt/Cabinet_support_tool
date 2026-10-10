// Demo mode's marks (docs/platform/demo.md): a banner on every page while it is on, and a Demo tag on every simulated
// client and cabinet, so nobody mistakes a simulated cabinet for a real one.
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Link, useRouter } from "../lib/router";
import { atLeast, useSession } from "../lib/session";

export function DemoBanner() {
  const { me } = useSession();
  const { path } = useRouter();
  const [demo, setDemo] = useState<{ enabled: boolean; cabinets: number } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const changed = () => setTick(t => t + 1);
    window.addEventListener("demo-changed", changed);
    return () => window.removeEventListener("demo-changed", changed);
  }, []);
  useEffect(() => { api<{ enabled: boolean; cabinets: number }>("GET", "/api/demo").then(setDemo, () => setDemo(null)); }, [path, tick]);
  if (!demo?.enabled) return null;
  return (
    <div className="banner demo" role="status">
      <strong>Demo mode is on.</strong> {demo.cabinets} simulated cabinets, marked <DemoTag />, are shown next to your real ones.
      {atLeast(me, "admin") && <> <Link to="/admin/setup">Turn it off</Link></>}
    </div>
  );
}

export function DemoTag({ long }: { long?: boolean }) {
  return <span className="badge demo" title="A simulated cabinet from demo mode, not a real one">{long ? "Demo: simulated cabinet" : "Demo"}</span>;
}
