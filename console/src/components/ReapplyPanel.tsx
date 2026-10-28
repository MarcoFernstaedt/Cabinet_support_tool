// What a replacement put back on this cabinet (docs/spec/05-server-spec.md "Replacing a cabinet"): each setting, the value sent, and
// whether the cabinet's own report confirmed it. Read-only: the server runs the steps in the approving Admin's name.
import { Badge } from "./ui";
import { fullTime } from "../lib/time";
import { reapplySummary, STEP_STATE, stepLabel, stepValue, type Reapply } from "../lib/replacement";

export function ReapplyPanel({ reapply, oldName }: { reapply: Reapply; oldName: string }) {
  return (
    <section className="panel" aria-label={`Settings put back from ${oldName}`}>
      <h2>Settings put back from {oldName}</h2>
      <p className={reapply.state === "stopped" ? "notice warn" : "muted"} role="status">{reapplySummary(reapply, oldName)}</p>
      {reapply.steps.length > 0 && (
        <div className="table-wrap"><table className="table">
          <caption className="sr-only">Settings put back from {oldName}</caption>
          <thead><tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
          <tbody>
            {reapply.steps.map(s => (
              <tr key={s.kind}>
                <th scope="row">{stepLabel(s)}</th>
                <td>{stepValue(s) ?? "—"}</td>
                <td><Badge tone={STEP_STATE[s.state]?.[1] ?? "off"}>{STEP_STATE[s.state]?.[0] ?? s.state}</Badge></td>
                <td className="small">{s.detail ?? ""} <span className="muted">{fullTime(s.updatedAt)}</span></td>
              </tr>))}
          </tbody>
        </table></div>)}
    </section>
  );
}
