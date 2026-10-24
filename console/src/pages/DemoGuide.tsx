// The demo guide (docs/platform/demo.md): how demo mode works, the scenario library with links into the console, and the
// guided tour. Everyone signed in can read it; only an Admin turns demo mode on, off or resets it (Admin → Settings).
import { Link } from "../lib/router";
import { atLeast, useSession } from "../lib/session";
import { useLoad } from "../lib/useLoad";
import { Badge, Empty } from "../components/ui";
import { DemoTag } from "../components/DemoBanner";
import { startDemoTour } from "../components/DemoTour";

interface Scenario { id: string; title: string; story: string; steps: { label: string; path: string }[] }

export function DemoGuide() {
  const { me } = useSession();
  const demo = useLoad<{ enabled: boolean; cabinets: number }>("/api/demo");
  const lib = useLoad<{ scenarios: Scenario[] }>("/api/demo/scenarios");
  return (
    <div className="page narrow">
      <h1>Demo guide</h1>
      <p>Demo mode adds simulated clients, sites and cabinets beside the real ones, so you can work at fleet size without touching a customer's machine. Simulated cabinets are tagged <DemoTag />; real ones say "Live agent".</p>
      <ul className="links">
        <li>Simulated cabinets use the same server code as a real agent: heartbeats, events, checks and fixes, each verified afterwards.</li>
        <li>They are kept apart from real cabinets in both directions.</li>
        <li>Roles and confirmations apply exactly as they do for real cabinets.</li>
      </ul>
      <p className="row gap wrap">
        {demo.data?.enabled ? <Badge tone="info">Demo mode is on: {demo.data.cabinets} simulated cabinets</Badge> : <Badge tone="off">Demo mode is off</Badge>}
        <button className="btn primary" onClick={() => startDemoTour("network")}>Start the guided demo</button>
        {atLeast(me, "admin") && <Link to="/admin/settings#demo">Turn on, off or reset in Settings</Link>}
      </p>
      <h2 style={{ marginTop: "var(--space-4, 1.5rem)" }}>The demo</h2>
      {lib.data && lib.data.scenarios.length === 0 && <Empty>Turn demo mode on to see the demo.</Empty>}
      <ul className="findings">{lib.data?.scenarios.map(s => (
        <li key={s.id} className="finding info">
          <div className="finding-head"><strong>{s.title}</strong></div>
          <p>{s.story}</p>
          <p className="row gap wrap">{s.steps.map(st => <Link key={st.path + st.label} className="btn small" to={st.path}>{st.label}</Link>)}</p>
        </li>))}
      </ul>
      <h2 style={{ marginTop: "var(--space-4, 1.5rem)" }}>A live agent too</h2>
      <p>To show real Windows data, install the agent on a test computer from <Link to="/admin/setup">Admin → Setup</Link>. You don't need demo mode for that, and its data is always live.</p>
    </div>
  );
}
