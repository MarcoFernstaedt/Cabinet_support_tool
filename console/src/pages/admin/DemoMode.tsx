import { useState } from "react";
import { api, describeError } from "../../lib/api";
import { Link } from "../../lib/router";
import { Badge, StepUpDialog } from "../../components/ui";
import { useLoad } from "../../lib/useLoad";
import { startDemoTour } from "../../components/DemoTour";

export interface DemoState { enabled: boolean; clients: number; cabinets: number }

/** The demo switch: on, off, reset, the guided demo and the guide. Admins only (the server checks). */
export function DemoMode() {
  const demo = useLoad<DemoState>("/api/demo");
  const [ask, setAsk] = useState<"on" | "off" | "reset" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const on = demo.data?.enabled ?? false;
  const body = ask === "reset" ? { enabled: true, reset: true } : { enabled: ask === "on" };
  const text = { on: "Add the simulated demo clients, sites and cabinets for everyone signed in to see.",
    off: "Delete every simulated demo client, site and cabinet, with their alerts and history. Real cabinets are not touched.",
    reset: "Delete the simulated fleet and build it again from the same scenarios, as at the start of a demo. Real cabinets are not touched." };
  return (
    <section className="panel" id="demo" aria-labelledby="demo-heading">
      <h2 id="demo-heading">Demo mode {demo.data && (on ? <Badge tone="info">On</Badge> : <Badge tone="off">Off</Badge>)}</h2>
      {demo.data && <p>{on ? `${demo.data.cabinets} simulated cabinets in ${demo.data.clients} clients.` : "No simulated cabinets."}</p>}
      <div className="row gap wrap">
        {on ? <button className="btn" onClick={() => { setProblem(null); setAsk("off"); }}>Turn demo mode off</button>
          : <button className="btn" onClick={() => { setProblem(null); setAsk("on"); }}>Turn demo mode on</button>}
        {on && <button className="btn" onClick={() => { setProblem(null); setAsk("reset"); }}>Reset demo data</button>}
        <button className="btn primary" onClick={() => startDemoTour()}>Start the guided demo</button>
        <Link className="btn ghost" to="/demo">Demo guide and scenario library</Link>
      </div>
      {problem && <p className="error" role="alert">{problem}</p>}
      {/* Confirmed with an authenticator code bound to this exact change (on, off or reset). */}
      <StepUpDialog open={ask !== null} action="demo.change" target="fleet" onClose={() => setAsk(null)} params={body}
        description={<p>{ask ? text[ask] : ""}</p>}
        onToken={async token => {
          try {
            await api("PUT", "/api/admin/demo", { ...body, stepUpToken: token });
            demo.reload(); window.dispatchEvent(new Event("demo-changed"));
          } catch (e) { setProblem(describeError(e)); throw e; }
        }} />
    </section>
  );
}
