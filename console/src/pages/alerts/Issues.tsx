// The Issues area (docs/spec/06-console-spec.md "Issues area"): issue types with their open
// alerts and live rules; each rule's match, history, who proposed and approved it and how many
// events it matched; and the proposals waiting for an Admin.
import { useState } from "react";
import { api, describeError } from "../../lib/api";
import { describeMatch, type IssueType, type Match, type Person } from "../../lib/alerts";
import { Link } from "../../lib/router";
import { atLeast, useSession } from "../../lib/session";
import { fullTime } from "../../lib/time";
import { Badge, Empty, StepUpDialog } from "../../components/ui";
import { useLoad } from "../../lib/useLoad";
import { RunbookAdmin } from "../../components/RunbookAdmin";

interface Rule {
  severity?: "major" | "minor" | null;
  id: string; issueType: { id: string; name: string } | null; kind: "map" | "suppress"; state: string; version: number; match: Match; regroup: boolean; builtIn: boolean;
  proposedBy: Person | null; approvedBy: Person | null; createdAt: string; updatedAt: string; matchedCount: number;
}
interface HistoryEntry { version: number; change: string; state: string; match: Match; changedBy: Person | null; changedAt: string }

const STATE_TONE: Record<string, "ok" | "warn" | "off" | "crit"> = { live: "ok", proposed: "warn", disabled: "off", rejected: "crit", expired: "off" };
const STATE_LABEL: Record<string, string> = { live: "Live", proposed: "Waiting for approval", disabled: "Disabled", rejected: "Rejected", expired: "Expired" };

export function IssuesPage() {
  const { me } = useSession();
  const issues = useLoad<IssueType[]>("/api/issues");
  const [state, setState] = useState<string>("proposed");
  const rules = useLoad<Rule[]>(`/api/rules?state=${state}`);
  const reload = () => { issues.reload(); rules.reload(); };
  return (
    <div className="page">
      <h1>Issues</h1>
      {issues.problem && <p className="error" role="alert">{issues.problem}</p>}
      {issues.data && (
        <table className="table">
          <caption className="sr-only">Issue types</caption>
          <thead><tr><th scope="col">Issue</th><th scope="col">Severity</th><th scope="col">Open alerts</th><th scope="col">Live rules</th></tr></thead>
          <tbody>{issues.data.map(i => (
            <tr key={i.id}>
              <th scope="row">{i.name}<div className="muted small">{i.description}</div></th>
              <td><Badge tone={i.severity === "major" ? "crit" : "info"}>{i.severity === "major" ? "Major" : "Minor"}</Badge></td>
              <td>{i.openAlerts > 0 ? <Link to={`/alerts`}>{i.openAlerts}</Link> : 0}</td>
              <td>{i.liveRules}</td>
            </tr>))}
          </tbody>
        </table>)}
      <section className="panel" aria-labelledby="rules-heading">
        <h2 id="rules-heading">Symptom rules</h2>
        <div className="subtabs" role="group" aria-label="Rule states">
          {["proposed", "live", "disabled", "rejected"].map(s => <button key={s} aria-pressed={state === s} onClick={() => setState(s)}>{STATE_LABEL[s]}</button>)}
        </div>
        {rules.problem && <p className="error" role="alert">{rules.problem}</p>}
        {rules.data && rules.data.length === 0 && <Empty>{state === "proposed" ? "No rules are waiting for approval." : "No rules here."}</Empty>}
        {rules.data && rules.data.length > 0 && <ul className="alert-list">{rules.data.map(r => <RuleRow key={r.id} rule={r} admin={atLeast(me, "admin")} onChanged={reload} />)}</ul>}
      </section>
      <RunbookAdmin />
    </div>
  );
}

function RuleRow({ rule, admin, onChanged }: { rule: Rule; admin: boolean; onChanged: () => void }) {
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [action, setAction] = useState<null | "approve" | "reject" | "disable" | "rollback">(null);
  const [version, setVersion] = useState(1);
  const [problem, setProblem] = useState<string | null>(null);
  const toggleHistory = async () => {
    if (history) { setHistory(null); return; }
    try { setHistory(await api<HistoryEntry[]>("GET", `/api/rules/${rule.id}/history`)); } catch (e) { setProblem(describeError(e)); }
  };
  const run = async (token: string) => {
    try {
      if (action === "rollback") await api("POST", `/api/rules/${rule.id}/rollback`, { version, stepUpToken: token });
      else await api("POST", `/api/rules/${rule.id}/${action}`, { stepUpToken: token });
      onChanged();
    } catch (e) { setProblem(describeError(e)); }
  };
  const words = { approve: "Approve this rule. It goes live at once and raises the issue for every new matching event.",
    reject: "Reject this proposal. It never goes live.", disable: "Disable this rule. Matching events become unrecognized again.",
    rollback: `Put back version ${version} of this rule, live.` };
  return (
    <li className="alert-row minor">
      <div>
        <div className="row gap wrap">
          <Badge tone={STATE_TONE[rule.state] ?? "off"}>{STATE_LABEL[rule.state] ?? rule.state}</Badge>
          {rule.builtIn && <Badge tone="info">Built in</Badge>}
          <span className="title">{rule.issueType?.name ?? "Suppression"}</span>
          {rule.severity && <Badge tone={rule.severity === "major" ? "crit" : "warn"}>{rule.severity === "major" ? "Major: home page and Alerts tab" : "Minor: cabinet only"}</Badge>}
          <span className="muted small">version {rule.version}</span>
        </div>
        <p className="small"><code>{describeMatch(rule.match)}</code></p>
        <div className="meta">
          {rule.proposedBy && <span>Proposed by {rule.proposedBy.name}</span>}
          {rule.approvedBy && <span>approved by {rule.approvedBy.name}</span>}
          <span>{rule.matchedCount} matched {rule.matchedCount === 1 ? "event" : "events"}</span>
          <span>changed {fullTime(rule.updatedAt)}</span>
          {rule.regroup && rule.state === "proposed" && <span>regroups open unrecognized alerts when approved</span>}
        </div>
        {problem && <p className="small error" role="alert">{problem}</p>}
        {history && (
          <ol className="history" aria-label="Rule history">
            {history.map((h, i) => <li key={i}>v{h.version} · <strong>{h.change.replace("_", " ")}</strong> by {h.changedBy?.name ?? "the platform"} · {fullTime(h.changedAt)} · <code>{describeMatch(h.match)}</code></li>)}
          </ol>)}
      </div>
      <div className="actions">
        <button className="btn small" onClick={() => void toggleHistory()} aria-expanded={history !== null}>History</button>
        {admin && rule.state === "proposed" && <>
          <button className="btn small primary" onClick={() => setAction("approve")}>Approve</button>
          <button className="btn small danger" onClick={() => setAction("reject")}>Reject</button></>}
        {admin && rule.state === "live" && <button className="btn small" onClick={() => setAction("disable")}>Disable</button>}
        {admin && !rule.builtIn && (rule.state === "live" || rule.state === "disabled") && rule.approvedBy && (
          <span className="row gap">
            <label className="sr-only" htmlFor={`v-${rule.id}`}>Version</label>
            <select id={`v-${rule.id}`} value={version} onChange={e => setVersion(Number(e.target.value))}>
              {Array.from({ length: rule.version }, (_, i) => i + 1).map(v => <option key={v} value={v}>v{v}</option>)}</select>
            <button className="btn small" onClick={() => setAction("rollback")}>Roll back</button>
          </span>)}
      </div>
      <StepUpDialog open={action !== null} action={`rule.${action ?? "approve"}`} target={rule.id} onClose={() => setAction(null)}
        params={action === "rollback" ? { version } : undefined} description={<p>{action ? words[action] : ""}</p>} onToken={run} />
    </li>
  );
}
