// A fix offered beside a finding or a runbook step: one catalog operation with its parameters, a button, the confirmation the operation asks for
// (a click, or an authenticator code bound to the exact parameters) and the answer. The button is only a convenience: the server checks the
// person's role, the write pause, the cabinet's read-only mode and the confirmation again on the command itself.
import { useState } from "react";
import { useWrite } from "../lib/commands";
import { confirmFor, minimumRoleFor } from "../lib/confirm";
import { atLeast, roleName, useSession } from "../lib/session";
import { ConfirmDialog, StepUpDialog } from "./ui";

export function OpFix({ cabinetId, cabinetName, operation, params, label, onDone }: {
  cabinetId: string; cabinetName: string; operation: string; params: Record<string, unknown>; label: string; onDone?: () => void;
}) {
  const { me } = useSession();
  const write = useWrite<unknown>(cabinetId, operation);
  const [asking, setAsking] = useState(false);
  const confirm = confirmFor(operation);
  const need = minimumRoleFor(operation);
  if (!atLeast(me, need)) return <span className="muted small">Needs {roleName(need)} to make this change.</span>;
  const after = (r: { status: string }) => { if (r.status === "succeeded") onDone?.(); };
  const what = <p><strong>{label}</strong> on {cabinetName}. {operation.startsWith("firewall") || operation.startsWith("network") ? "It goes through the safety net: if the cabinet cannot reach the platform afterwards, it goes back to its old settings by itself." : "Run the diagnosis again afterwards to confirm the change."}</p>;
  return (
    <span className="fix-action">
      <button className="btn small primary" onClick={() => setAsking(true)} disabled={write.state === "running"} aria-busy={write.state === "running"}>{write.state === "running" ? "Working…" : label}</button>
      {write.state === "done" && write.result?.status === "succeeded" && <span className="ok small" role="status"> Done. Run the diagnosis again to confirm.</span>}
      {write.state === "done" && write.result && write.result.status !== "succeeded" && <span className="error small" role="alert"> The cabinet could not make the change{write.result.error ? `: ${write.result.error.message}` : ""}.</span>}
      {write.state === "done" && write.problem && <span className="error small" role="alert"> {write.problem}</span>}
      {confirm === "click"
        ? <ConfirmDialog open={asking} onClose={() => setAsking(false)} description={what} onConfirm={async () => { await write.begin(params, undefined, after); }} />
        : <StepUpDialog open={asking} action={operation} target={cabinetId} params={params} onClose={() => setAsking(false)} description={what}
            onToken={async token => { await write.begin(params, token, after); }} />}
    </span>
  );
}
