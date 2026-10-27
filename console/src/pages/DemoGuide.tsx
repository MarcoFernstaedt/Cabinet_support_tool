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
      <p>Simulated clients, sites and cabinets alongside the real fleet. Simulated cabinets are tagged <DemoTag />; real ones show "Live agent".</p>
      <ul className="links">
        <li>Same server paths as a real agent: heartbeats, events, checks and fixes, each verified.</li>
        <li>Isolated from real cabinets in both directions.</li>
        <li>Roles and confirmations apply as for real cabinets.</li>
      </ul>
      <p className="row gap wrap">
        {demo.data?.enabled ? <Badge tone="info">Demo mode is on: {demo.data.cabinets} simulated cabinets</Badge> : <Badge tone="off">Demo mode is off</Badge>}
        <button className="btn primary" onClick={() => startDemoTour("network")}>Start the guided demo</button>
        {atLeast(me, "admin") && <Link to="/admin/settings#demo">Turn on, off or reset in Settings</Link>}
      </p>
      <h2 style={{ marginTop: "var(--space-4, 1.5rem)" }}>Scenarios</h2>
      {lib.data && lib.data.scenarios.length === 0 && <Empty>Demo mode is off.</Empty>}
      <ul className="findings">{lib.data?.scenarios.map(s => (
        <li key={s.id} className="finding info">
          <div className="finding-head"><strong>{s.title}</strong></div>
          <p>{s.story}</p>
          <p className="row gap wrap">{s.steps.map(st => <Link key={st.path + st.label} className="btn small" to={st.path}>{st.label}</Link>)}</p>
        </li>))}
      </ul>
      <h2 style={{ marginTop: "var(--space-4, 1.5rem)" }}>Live agent</h2>
      <p>For real Windows data, enroll a test computer from <Link to="/admin/setup">Admin → Setup</Link>. Independent of demo mode.</p>
    </div>
  );
}
