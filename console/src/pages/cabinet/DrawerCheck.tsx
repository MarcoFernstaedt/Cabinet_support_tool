// Drawer check: finds the drawer link among the adapters, checks its IPv4 settings and packet counters (two readings a few seconds
// apart) and the firewall, and offers to turn the firewall off. The writes are the ordinary firewall profile writes; the server and the
// agent decide whether they are allowed.
import { useState } from "react";
import type { FirewallProfileState, FirewallStateOutput, NetworkConfigOutput, NetworkSetIpOutput } from "@mashura/cabinet-contracts/types";
import { useRunner } from "../../lib/commands";
import { analyseDrawer, drawerAddressParams, drawerText, needsDrawerAddress, DRAWER_ADDRESS, DRAWER_PREFIX, type DrawerAnalysis } from "../../lib/drawer";
import type { AdapterReading } from "../../components/NetworkReadings";
import { Badge, SAFETY_NET_NOTE } from "../../components/ui";
import type { CabinetDetail } from "./CabinetPage";
import { ProfileControl, useConfirmedWrite, useCanWrite, useProfileWrite } from "./Writes";

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
  const policy = useConfirmedWrite<unknown>(cabinet, "firewall.applyPolicy", r => { if (r.status === "succeeded") changed(); });
  const canPolicy = useCanWrite(cabinet, "firewall.applyPolicy");
  const address = useConfirmedWrite<NetworkSetIpOutput>(cabinet, "network.setIp", r => { if (r.status === "succeeded") changed(); });
  const canAddress = useCanWrite(cabinet, "network.setIp");
  const a = result?.analysis ?? null;
  const copy = async () => { if (!a) return; try { await navigator.clipboard.writeText(drawerText(cabinet.name, a)); setCopied(true); } catch { setCopied(false); } };

  return (
    <section className="panel" aria-labelledby="drawer-heading" data-tour="drawer-check">
      <div className="row gap wrap spread">
        <h2 id="drawer-heading">Drawer</h2>
        <span className="muted small">Expected address {DRAWER_ADDRESS}/{DRAWER_PREFIX} (mask 255.255.255.255), static, no gateway</span>
        <button className="btn" disabled={state === "running"} onClick={() => void go()}>{state === "running" ? step : "Check drawer"}</button>
      </div>
      {problem && <p className="notice crit" role="alert">{problem}</p>}
      {policy.run.state === "done" && policy.run.result?.status !== "succeeded" && <p className="notice crit" role="alert">The cabinet could not apply the policy{policy.run.result?.error ? `: ${policy.run.result.error.message}` : ""}.</p>}
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
        {a.profilesOn.length > 0 && canPolicy && (
          <p className="row gap wrap"><button className="btn primary" data-tour="drawer-policy" onClick={() => policy.ask({}, <>
            <p>Apply the firewall policy to <strong>{cabinet.name}</strong> (its site's, else {cabinet.client.name}'s, else the fleet default): every profile the policy says is off is turned off.</p>
            <p className="muted small">A drawer's link is an unidentified network, which Windows treats as Public, so its firewall profile must be off for the drawer to work.</p></>)}>Apply the firewall policy</button></p>)}
        {canAddress && needsDrawerAddress(a) && a.adapter && (
          <form className="row gap wrap" aria-label="Set the drawer address" data-tour="drawer-address" onSubmit={e => {
            e.preventDefault();
            const params = drawerAddressParams(a.adapter!.interfaceIndex);
            address.ask(params, <>
              <p>Give <strong>{a.adapter!.name}</strong> the drawer address <strong>{params.address}/{params.prefixLength}</strong> (mask 255.255.255.255) with no gateway, as on every cabinet.</p>
              <p className="muted small">{SAFETY_NET_NOTE}</p></>);
          }}>
            <button className="btn" type="submit" disabled={address.run.state === "running"}>Set the drawer address ({DRAWER_ADDRESS})</button>
          </form>)}
        {address.run.state === "done" && address.run.result?.status !== "succeeded" && <p className="notice crit" role="alert">The cabinet could not set the address{address.run.result?.error ? `: ${address.run.result.error.message}` : ""}.</p>}
        {write.outcome}{write.dialog}{policy.dialog}{address.dialog}
        <div className="row gap"><button className="btn small" onClick={() => void copy()}>{copied ? "Copied" : "Copy as text"}</button></div>
      </>)}
    </section>
  );
}
