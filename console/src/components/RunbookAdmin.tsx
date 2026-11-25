// Runbooks on the Issues page: the runbook in force for each issue type, proposals waiting for an Admin, and a form for Tier 2 and up to propose
// one. A step can carry a read-only check and a one-click fix chosen from the lists below; the server accepts only catalog reads and
// click-confirmed changes whatever is sent, and nothing is live until an Admin approves with an authenticator code.
import { Pager, usePaged } from "./Pager";
import { useState } from "react";
import { api, describeError } from "../lib/api";
import { useLoad } from "../lib/useLoad";
import { atLeast, useSession } from "../lib/session";
import { fullTime } from "../lib/time";
import { Badge, Empty, StepUpDialog } from "./ui";
import type { RunbookData, RunbookStep } from "./Runbook";

interface Overview { issues: { issueTypeId: string; name: string; runbook: RunbookData | null; waiting: number }[] }
interface Listed extends RunbookData { id: string; state: string; target: { kind: "issue"; issueTypeId: string; issueName?: string | null } | { kind: "finding"; key: string }; proposedAt: string }

const CHECKS: { id: string; label: string; operation: string; params: Record<string, unknown> }[] = [
  { id: "info", label: "System information", operation: "system.info", params: {} },
  { id: "perf", label: "Processor, memory and drives", operation: "system.performance", params: {} }, { id: "scanner", label: "Fingerprint scanner", operation: "peripheral.status", params: {} },
  { id: "usb", label: "USB ports", operation: "usb.ports", params: {} }, { id: "devices", label: "Devices with a problem", operation: "devices.list", params: { problemsOnly: true } },
  { id: "services", label: "Services", operation: "services.list", params: {} }, { id: "updates", label: "Windows updates", operation: "updates.status", params: {} },
  { id: "time", label: "Time and time zone", operation: "time.status", params: {} }, { id: "firewall", label: "Firewall", operation: "firewall.state", params: {} },
  { id: "net", label: "Network settings", operation: "network.config", params: {} }, { id: "listeners", label: "Ports listening", operation: "network.listeners", params: {} },
  { id: "gateway", label: "Ping the gateway", operation: "network.test", params: { target: "gateway", method: "ping", count: 4 } },
];
type FixKind = "time.sync" | "network.flushDns" | "firewall.applyPolicy" | "service.control" | "service.setStartType" | "power.set";
const FIXES: { id: FixKind; label: string }[] = [
  { id: "time.sync", label: "Sync the clock" }, { id: "network.flushDns", label: "Flush the DNS cache" }, { id: "firewall.applyPolicy", label: "Apply the client firewall policy" },
  // service.control and service.setStartType are not offered: the server asks for a code for them (approved programs only), and a
  // runbook fix is one click.
  { id: "power.set", label: "Change a power setting" },
];

interface Draft { title: string; detail: string; check: string; fix: "" | FixKind; fixLabel: string; name: string; action: string; startType: string; setting: string; enabled: boolean }
const blank = (): Draft => ({ title: "", detail: "", check: "", fix: "", fixLabel: "", name: "", action: "start", startType: "automatic", setting: "usb_selective_suspend", enabled: false });

function toStep(d: Draft): RunbookStep {
  const step: RunbookStep = { title: d.title.trim() };
  if (d.detail.trim()) step.detail = d.detail.trim();
  const c = CHECKS.find(x => x.id === d.check);
  if (c) step.check = { operation: c.operation, params: c.params };
  if (d.fix) {
    const params: Record<string, unknown> = d.fix === "service.control" ? { name: d.name.trim(), action: d.action } : d.fix === "service.setStartType" ? { name: d.name.trim(), startType: d.startType }
      : d.fix === "power.set" ? { setting: d.setting, enabled: d.enabled } : {};
    step.fix = { operation: d.fix, params, label: d.fixLabel.trim() || FIXES.find(f => f.id === d.fix)!.label };
  }
  return step;
}

function Steps({ steps }: { steps: RunbookStep[] }) {
  return <ol className="runbook-steps small">{steps.map((s, i) => <li key={i}><strong>{s.title}</strong>{s.detail && <span style={{ whiteSpace: "pre-wrap" }}> {s.detail}</span>}
    {s.check && <div className="muted">Check: <code>{s.check.operation}</code></div>}{s.fix && <div className="muted">Fix button: {s.fix.label} (<code>{s.fix.operation}</code>)</div>}</li>)}</ol>;
}

export function RunbookAdmin() {
  const { me } = useSession();
  const overview = useLoad<Overview>("/api/runbooks/overview");
  const proposals = useLoad<{ runbooks: Listed[] }>(atLeast(me, "tier2") ? "/api/runbooks?state=proposed" : null);
  const [shown, setShown] = useState<string | null>(null);
  const [action, setAction] = useState<{ id: string; kind: "approve" | "reject" | "retire" } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const reload = () => { overview.reload(); proposals.reload(); };
  const issuesPaged = usePaged(overview.data?.issues ?? []);
  const proposalsPaged = usePaged(proposals.data?.runbooks ?? []);
  const decide = async (token: string) => { await api("POST", `/api/runbooks/${action!.id}/${action!.kind}`, { stepUpToken: token }); reload(); };
  const issueName = (r: Listed) => r.target.kind === "issue" ? (r.target.issueName ?? "an issue") : `finding ${r.target.key}`;
  return (
    <section className="panel" aria-labelledby="runbooks-heading">
      <h2 id="runbooks-heading">Runbooks</h2>
      <p className="muted small">What a support person does for each issue, step by step, with safe checks and one-click fixes inline. Tier 2 proposes; an Admin approves with an authenticator code. The platform's own show until one is approved.</p>
      {(overview.problem ?? problem) && <p className="error" role="alert">{overview.problem ?? problem}</p>}
      {overview.data && (
        <table className="table compact"><caption className="sr-only">The runbook in force for each issue type</caption>
          <thead><tr><th scope="col">Issue</th><th scope="col">Runbook</th><th scope="col">Waiting</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{issuesPaged.rows.map(i => (
            <tr key={i.issueTypeId}>
              <th scope="row">{i.name}</th>
              <td>{i.runbook ? <>{i.runbook.title} {i.runbook.builtIn ? <Badge tone="info">Built in</Badge> : <Badge tone="ok">Version {i.runbook.version}</Badge>} <span className="muted small">{i.runbook.steps.length} steps</span>
                {shown === i.issueTypeId && <Steps steps={i.runbook.steps} />}</> : <span className="muted">None yet</span>}</td>
              <td>{i.waiting > 0 ? <Badge tone="warn">{i.waiting}</Badge> : 0}</td>
              <td className="row gap wrap">
                {i.runbook && <button className="btn small" aria-expanded={shown === i.issueTypeId} onClick={() => setShown(shown === i.issueTypeId ? null : i.issueTypeId)}>{shown === i.issueTypeId ? "Hide" : "Steps"}</button>}
                {atLeast(me, "admin") && i.runbook?.id && <button className="btn small" onClick={() => setAction({ id: i.runbook!.id!, kind: "retire" })}>Retire</button>}
              </td>
            </tr>))}</tbody></table>)}
      <Pager {...issuesPaged} label="issue runbooks" />
      {atLeast(me, "tier2") && proposals.data && (<>
        <h3>Waiting for approval</h3>
        {proposals.data.runbooks.length === 0 ? <Empty>No runbooks are waiting.</Empty> : (
          <ul className="alert-list">{proposalsPaged.rows.map(r => (
            <li key={r.id} className="alert-row minor"><div>
              <div className="row gap wrap"><Badge tone="warn">Waiting</Badge><span className="title">{r.title}</span><span className="muted small">for {issueName(r)} · version {r.version} · {r.proposedBy}, {fullTime(r.proposedAt)}</span></div>
              <Steps steps={r.steps} />
              {r.links.length > 0 && <p className="small">Links: {r.links.map(l => l.url).join(", ")}</p>}
            </div>
              {atLeast(me, "admin") && <div className="actions"><button className="btn small primary" onClick={() => setAction({ id: r.id, kind: "approve" })}>Approve</button>
                <button className="btn small danger" onClick={() => setAction({ id: r.id, kind: "reject" })}>Reject</button></div>}
            </li>))}</ul>)}
        <Pager {...proposalsPaged} label="proposed runbooks" />
        <Propose issues={overview.data?.issues ?? []} onProposed={reload} onProblem={setProblem} />
      </>)}
      <StepUpDialog open={action !== null} action={`runbook.${action?.kind ?? "approve"}`} target={action?.id ?? ""} onClose={() => setAction(null)} onToken={decide}
        description={<p>{action?.kind === "approve" ? "Approve this runbook. It replaces the one in force for the same issue at once." : action?.kind === "reject" ? "Reject this proposal. It never goes live." : "Retire this runbook. The platform's own shows again."}</p>} />
    </section>
  );
}

function Propose({ issues, onProposed, onProblem }: { issues: Overview["issues"]; onProposed: () => void; onProblem: (p: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [issue, setIssue] = useState("");
  const [title, setTitle] = useState("");
  const [steps, setSteps] = useState<Draft[]>([blank()]);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (i: number, p: Partial<Draft>) => setSteps(s => s.map((d, k) => (k === i ? { ...d, ...p } : d)));
  const submit = async () => {
    setBusy(true); onProblem(null); setDone(false);
    try {
      await api("POST", "/api/runbooks", { target: { kind: "issue", issueTypeId: issue }, title: title.trim(), steps: steps.map(toStep),
        ...(link.trim() ? { links: [{ label: "More information", url: link.trim() }] } : {}) });
      setDone(true); setOpen(false); setTitle(""); setSteps([blank()]); setLink(""); onProposed();
    } catch (e) { onProblem(describeError(e)); } finally { setBusy(false); }
  };
  if (!open) return <p>{done && <span className="ok small" role="status">Proposed. An Admin approves it. </span>}<button className="btn" onClick={() => setOpen(true)}>Propose a runbook</button></p>;
  return (
    <form className="stack" onSubmit={e => { e.preventDefault(); void submit(); }} aria-label="Propose a runbook">
      <h3>Propose a runbook</h3>
      <label className="field"><span>For the issue</span><select required value={issue} onChange={e => setIssue(e.target.value)}><option value="">Choose…</option>{issues.map(i => <option key={i.issueTypeId} value={i.issueTypeId}>{i.name}</option>)}</select></label>
      <label className="field"><span>Title</span><input required maxLength={120} value={title} onChange={e => setTitle(e.target.value)} /></label>
      {steps.map((d, i) => (
        <fieldset key={i} className="stack"><legend>Step {i + 1}</legend>
          <label className="field"><span>What to do</span><input required maxLength={120} value={d.title} onChange={e => set(i, { title: e.target.value })} /></label>
          <label className="field"><span>Details (optional)</span><textarea rows={2} maxLength={800} value={d.detail} onChange={e => set(i, { detail: e.target.value })} /></label>
          <label className="field"><span>A check to run (reads only)</span><select value={d.check} onChange={e => set(i, { check: e.target.value })}><option value="">None</option>{CHECKS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
          <label className="field"><span>A one-click fix</span><select value={d.fix} onChange={e => set(i, { fix: e.target.value as Draft["fix"] })}><option value="">None</option>{FIXES.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</select></label>
          {d.fix && <label className="field"><span>Button label</span><input maxLength={80} value={d.fixLabel} onChange={e => set(i, { fixLabel: e.target.value })} placeholder={FIXES.find(f => f.id === d.fix)!.label} /></label>}
          {(d.fix === "service.control" || d.fix === "service.setStartType") && <label className="field"><span>Service name (not its display name)</span><input required maxLength={80} value={d.name} onChange={e => set(i, { name: e.target.value })} /></label>}
          {d.fix === "service.control" && <label className="field"><span>Action</span><select value={d.action} onChange={e => set(i, { action: e.target.value })}><option value="start">Start</option><option value="stop">Stop</option><option value="restart">Restart</option></select></label>}
          {d.fix === "service.setStartType" && <label className="field"><span>Start type</span><select value={d.startType} onChange={e => set(i, { startType: e.target.value })}><option value="automatic">Automatic</option><option value="automatic_delayed">Automatic (delayed)</option><option value="manual">Manual</option><option value="disabled">Disabled</option></select></label>}
          {d.fix === "power.set" && <>
            <label className="field"><span>Setting</span><select value={d.setting} onChange={e => set(i, { setting: e.target.value })}><option value="usb_selective_suspend">USB power saving</option><option value="fast_startup">Fast startup</option></select></label>
            <label className="check"><input type="checkbox" checked={d.enabled} onChange={e => set(i, { enabled: e.target.checked })} /> Turn it on (leave unticked to turn it off)</label></>}
          {steps.length > 1 && <p><button type="button" className="btn small ghost" onClick={() => setSteps(s => s.filter((_, k) => k !== i))}>Remove this step</button></p>}
        </fieldset>))}
      {steps.length < 12 && <p><button type="button" className="btn small" onClick={() => setSteps(s => [...s, blank()])}>Add a step</button></p>}
      <label className="field"><span>A link for more information (https only, optional)</span><input type="url" maxLength={300} value={link} onChange={e => setLink(e.target.value)} /></label>
      <p className="row gap"><button className="btn primary" disabled={busy || !issue}>{busy ? "Sending…" : "Propose"}</button> <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button></p>
    </form>
  );
}
