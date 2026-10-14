// Cash drawer check: finds the drawer link among the adapters, checks its IPv4 settings and packet counters (two readings a few seconds
// apart) and the firewall, and offers to turn the firewall off. The writes are the ordinary firewall profile writes; the server and the
// agent decide whether they are allowed.
import { useState } from "react";
import type { FirewallProfileState, FirewallStateOutput, NetworkConfigOutput } from "@mashura/cabinet-contracts/types";
import { useRunner } from "../../lib/commands";
import { analyseDrawer, drawerText, DRAWER_NETWORK, type DrawerAnalysis } from "../../lib/drawer";
import type { AdapterReading } from "../../components/NetworkReadings";
import { Badge } from "../../components/ui";
import type { CabinetDetail } from "./CabinetPage";
import { ProfileControl, useProfileWrite } from "./Writes";

const WAIT_SECONDS = 5;
const TONE = { ok: "ok", warn: "warn", crit: "crit", info: "info" } as const;
const WORD = { ok: "OK", warn: "Check", crit: "Problem", info: "Info" } as const;

export function DrawerCheck({ cabinet }: { cabinet: CabinetDetail }) {
  const run = useRunner();
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const [step, setStep] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<{ analysis: DrawerAnalysis; profiles: FirewallProfileState[] | null } | null>(null);
  const [copied, setCopied] = useState(false);

  const go = async () => {
    setState("running"); setProblem(null); setCopied(false);
    try {
      setStep("Reading the adapters");
      const first = await run<NetworkConfigOutput>(cabinet.id, "network.config", {});
      if (first.status !== "succeeded" || !first.output) throw new Error(first.error?.message ?? `The cabinet answered ${first.status}.`);
      setStep("Reading the firewall");
      const fw = await run<FirewallStateOutput>(cabinet.id, "firewall.state", {});
      const profiles = fw.status === "succeeded" && fw.output ? fw.output.profiles : null;
      setStep(`Counting packets for ${WAIT_SECONDS} seconds`);
      await new Promise(r => setTimeout(r, WAIT_SECONDS * 1000));
      const again = await run<NetworkConfigOutput>(cabinet.id, "network.config", {});
      const second = again.status === "succeeded" && again.output ? again.output.adapters as never as AdapterReading[] : null;
      setResult({ analysis: analyseDrawer(first.output.adapters as never as AdapterReading[], second, WAIT_SECONDS, profiles), profiles });
      setState("done");
    } catch (e) { setProblem(e instanceof Error ? e.message : "The check could not run."); setState("done"); }
  };

  const changed = () => void go();
  const write = useProfileWrite(cabinet, changed);
  const a = result?.analysis ?? null;
  const copy = async () => { if (!a) return; try { await navigator.clipboard.writeText(drawerText(cabinet.name, a)); setCopied(true); } catch { setCopied(false); } };

  return (
    <section className="panel" aria-labelledby="drawer-heading">
      <div className="row gap wrap spread">
        <h2 id="drawer-heading">Cash drawer</h2>
        <span className="muted small">Expected network {DRAWER_NETWORK.address}/{DRAWER_NETWORK.prefixLength}</span>
        <button className="btn" disabled={state === "running"} onClick={() => void go()}>{state === "running" ? step : "Check drawer"}</button>
      </div>
      {problem && <p className="notice crit" role="alert">{problem}</p>}
      {a && (<>
        <p className={`notice ${a.tone === "ok" ? "ok" : a.tone === "crit" ? "crit" : "warn"}`} role="status">{a.summary}</p>
        <table className="table compact">
          <caption className="sr-only">Drawer check</caption>
          <tbody>{a.lines.map(l => <tr key={l.id}><th scope="row">{l.label}</th><td><Badge tone={TONE[l.tone]}>{WORD[l.tone]}</Badge></td><td>{l.text}</td></tr>)}</tbody>
        </table>
        {a.profilesOn.length > 0 && result?.profiles && (
          <div className="cards">{result.profiles.filter(p => p.enabled).map(p => (
            <article key={p.profile} className="card warn" aria-label={`Drawer ${p.profile} profile`}>
              <h3>{p.profile[0]!.toUpperCase() + p.profile.slice(1)} firewall profile <Badge tone="warn">On</Badge></h3>
              <ProfileControl cabinet={cabinet} profile={p} write={write} />
            </article>))}</div>)}
        {write.outcome}{write.dialog}
        <div className="row gap"><button className="btn small" onClick={() => void copy()}>{copied ? "Copied" : "Copy as text"}</button></div>
      </>)}
    </section>
  );
}
