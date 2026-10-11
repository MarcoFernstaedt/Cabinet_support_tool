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
      <p>Demo mode adds made-up clients, sites and cabinets alongside the real ones, so you can show the app at fleet size without touching a customer's cabinet.
        They are tagged <DemoTag /> everywhere and say "Demo: simulated cabinet". Real cabinets say "Live agent".</p>
      <ul className="links">
        <li>They send heartbeats and events and answer every check through the same server code a real agent uses, so what you see is what a real cabinet would show.</li>
        <li>Fixes work on them: apply a firewall policy, restart a service, correct a time zone, and each one is checked afterwards.</li>
        <li>They never get mixed up with real cabinets. A real cabinet is never answered by the simulation, and a demo one never reaches a real cabinet.</li>
        <li>Roles and confirmations are the same as for real cabinets.</li>
      </ul>
      <p className="row gap wrap">
        {demo.data?.enabled ? <Badge tone="info">Demo mode is on: {demo.data.cabinets} simulated cabinets</Badge> : <Badge tone="off">Demo mode is off</Badge>}
        <button className="btn primary" onClick={startDemoTour} disabled={!demo.data?.enabled}>Start the guided demo</button>
        {atLeast(me, "admin") && <Link to="/admin/settings#demo">Turn on, off or reset in Settings</Link>}
      </p>
      <h2>Scenario library</h2>
      {lib.data && lib.data.scenarios.length === 0 && <Empty>Turn demo mode on to see the scenarios.</Empty>}
      <ul className="findings">{lib.data?.scenarios.map(s => (
        <li key={s.id} className="finding info">
          <div className="finding-head"><strong>{s.title}</strong></div>
          <p>{s.story}</p>
          <p className="row gap wrap">{s.steps.map(st => <Link key={st.path + st.label} className="btn small" to={st.path}>{st.label}</Link>)}</p>
        </li>))}
      </ul>
      <h2>A live agent too</h2>
      <p>To show real Windows data, install the agent on a test computer from <Link to="/admin/setup">Admin → Set up and demo</Link>. You don't need demo mode for that, and its data is always live.</p>
    </div>
  );
}
