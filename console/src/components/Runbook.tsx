// A runbook (docs/spec/12-milestones-8-to-12.md "Runbooks"): the steps to follow for an issue type or a finding, each with an optional read-only
// check to run and an optional one-click fix. The runbook gives no authority: checks and fixes go through the same commands, roles and
// confirmations as anywhere else in the console.
import { useState } from "react";
import { useLoad } from "../lib/useLoad";
import { useOperation } from "../lib/commands";
import { CHECKS, type Out } from "../lib/checks";
import { Badge, ResultProblem } from "./ui";
import { OpFix } from "./OpFix";

export interface RunbookStep {
  title: string; detail?: string;
  check?: { operation: string; params: Record<string, unknown> };
  fix?: { operation: string; params: Record<string, unknown>; label: string };
}
export interface RunbookData {
  id: string | null; builtIn: boolean; title: string; steps: RunbookStep[]; links: { label: string; url: string }[]; version: number; proposedBy: string | null; decidedBy: string | null;
  target: { kind: "issue"; issueTypeId: string } | { kind: "finding"; key: string };
}

const sameParams = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(a) === JSON.stringify(b);

/** One check: run it, show the answer in plain words when the console knows the check, else the answer as it came. */
function RunCheck({ cabinetId, operation, params }: { cabinetId: string; operation: string; params: Record<string, unknown> }) {
  const run = useOperation<Out>(cabinetId, operation);
  const known = CHECKS.find(c => c.operation === operation && sameParams(c.params, params));
  const out = run.result?.status === "succeeded" ? run.result.output : undefined;
  const summary = out && known ? known.summarize(out) : null;
  return (
    <div className="stack">
      <p><button className="btn small" onClick={() => void run.start(params)} disabled={run.state === "running"} aria-busy={run.state === "running"}>
        {run.state === "running" ? "Asking the cabinet…" : run.state === "done" ? "Run the check again" : "Run the check"}</button> <code className="muted small">{operation}</code></p>
      <div aria-live="polite">
        {run.problem && <p className="error small" role="alert">{run.problem}</p>}
        {run.result && run.result.status !== "succeeded" && <ResultProblem result={run.result} />}
        {summary && <p className="small"><Badge tone={summary.ok ? "ok" : "warn"}>{summary.ok ? "Looks fine" : "Look closer"}</Badge> {summary.text}</p>}
        {out !== undefined && <details><summary className="small">{summary ? "Raw answer" : "The answer"}</summary><pre style={{ maxHeight: "14rem", overflow: "auto" }}>{JSON.stringify(out, null, 2).slice(0, 6000)}</pre></details>}
      </div>
    </div>
  );
}

/** The steps of a runbook, numbered, with checks and fixes inline. */
export function RunbookSteps({ runbook, cabinetId, cabinetName }: { runbook: RunbookData; cabinetId: string; cabinetName: string }) {
  return (
    <div>
      <p className="small muted">{runbook.builtIn ? "Built in." : `Version ${runbook.version}, written by ${runbook.proposedBy ?? "someone"}${runbook.decidedBy ? `, approved by ${runbook.decidedBy}` : ""}.`} Follow the steps in order; each check only reads, and each fix asks you to confirm.</p>
      <ol className="runbook-steps">
        {runbook.steps.map((s, i) => (
          <li key={i}>
            <strong>{s.title}</strong>
            {s.detail && <p className="small" style={{ whiteSpace: "pre-wrap" }}>{s.detail}</p>}
            {s.check && <RunCheck cabinetId={cabinetId} operation={s.check.operation} params={s.check.params} />}
            {s.fix && <p><OpFix cabinetId={cabinetId} cabinetName={cabinetName} operation={s.fix.operation} params={s.fix.params} label={s.fix.label} /></p>}
          </li>))}
      </ol>
      {runbook.links.length > 0 && <p className="small">More: {runbook.links.map((l, i) => <span key={i}>{i > 0 && " · "}<a href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a></span>)}</p>}
    </div>
  );
}

/** A runbook for an issue type or a finding, opened on demand (nothing is read until it is opened). */
export function RunbookPanel({ target, cabinetId, cabinetName, label = "What to do" }: {
  target: { issueTypeId: string } | { findingKey: string }; cabinetId: string; cabinetName: string; label?: string;
}) {
  const [open, setOpen] = useState(false);
  const query = "issueTypeId" in target ? `issueTypeId=${target.issueTypeId}` : `findingKey=${encodeURIComponent(target.findingKey)}`;
  const { data, problem } = useLoad<{ runbook: RunbookData | null }>(open ? `/api/runbooks?${query}` : null);
  return (
    <details onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{label}</summary>
      {open && !data && !problem && <p className="muted small" role="status">Loading…</p>}
      {problem && <p className="error small" role="alert">{problem}</p>}
      {data && !data.runbook && <p className="muted small">No runbook has been written for this yet. A Tier 2 can propose one from the Issues page.</p>}
      {data?.runbook && <RunbookSteps runbook={data.runbook} cabinetId={cabinetId} cabinetName={cabinetName} />}
    </details>
  );
}
