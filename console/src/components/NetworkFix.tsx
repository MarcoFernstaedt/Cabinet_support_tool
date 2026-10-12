// Network fixes the diagnosis offers (docs/spec/14-network-troubleshooting.md): renew DHCP, set the DNS servers, set a fixed
// address and gateway, apply the firewall policy. A fix for one cabinet is confirmed the way the operation says (a click for the
// firewall; an authenticator code bound to the exact change for the network), and says what happened. Many cabinets at once go
// through a fleet operation with the password. The server and the agent check the role and the confirmation again.
import { useState, type ReactNode } from "react";
import { useWrite } from "../lib/commands";
import { api, describeError } from "../lib/api";
import { useRouter } from "../lib/router";
import { atLeast, useSession } from "../lib/session";
import { confirmFor, minimumRoleFor } from "../lib/confirm";
import { ConfirmDialog, PasswordDialog, StepUpDialog } from "./ui";

export type Layer = "link" | "address" | "gateway" | "dns" | "platform" | "sync" | "firewall";
export const LAYERS: [Layer, string][] = [["link", "Link"], ["address", "Address"], ["gateway", "Gateway"], ["dns", "DNS"], ["platform", "Platform"], ["sync", "Sync cabinet"], ["firewall", "Firewall"]];
export type LayerState = "ok" | "warning" | "problem" | "unknown";

export type FixAction =
  | { kind: "apply_policy"; cabinetId: string; cabinetName: string }
  | { kind: "open"; section: string; cabinetId: string; label: string }
  | { kind: "set_dns"; cabinetId: string; cabinetName: string; interfaceIndex: number; servers: string[]; label: string }
  | { kind: "renew_lease"; cabinetId: string; cabinetName: string; interfaceIndex: number; label: string }
  | { kind: "use_dhcp"; cabinetId: string; cabinetName: string; interfaceIndex: number; label: string }
  | { kind: "set_static"; cabinetId: string; cabinetName: string; interfaceIndex: number; address: string; prefixLength: number; gateway: string; label: string };
type Doable = Exclude<FixAction, { kind: "open" }>;

/** The operation and parameters a fix sends: the operation's own, as the server's job takes them from the diagnosis. */
export function fixCommand(a: Doable): { operation: string; params: Record<string, unknown>; label: string } {
  switch (a.kind) {
    case "apply_policy": return { operation: "firewall.applyPolicy", params: {}, label: `Apply the policy on ${a.cabinetName}` };
    case "set_dns": return { operation: "network.setDns", params: { interfaceIndex: a.interfaceIndex, mode: "static", servers: a.servers }, label: a.label };
    case "renew_lease": return { operation: "network.renewLease", params: { interfaceIndex: a.interfaceIndex }, label: a.label };
    case "use_dhcp": return { operation: "network.setIp", params: { interfaceIndex: a.interfaceIndex, mode: "dhcp" }, label: a.label };
    case "set_static": return { operation: "network.setIp", params: { interfaceIndex: a.interfaceIndex, mode: "static", address: a.address, prefixLength: a.prefixLength, gateway: a.gateway }, label: a.label };
  }
}
export const JOB_LABEL: Record<string, string> = {
  "firewall.applyPolicy": "Apply the firewall policy", "network.setDns": "Set the DNS servers", "network.setIp": "Fix the address settings", "network.renewLease": "Renew the DHCP lease",
  "time.setZone": "Set each cabinet to its site's time zone", "time.sync": "Sync clocks",
};

/** Whether this person's role may run the change; the button is hidden otherwise (the server decides for real). */
export function useCanFix(operation: string): boolean {
  const { me } = useSession();
  return atLeast(me, minimumRoleFor(operation));
}

/** One fix on one cabinet: a button, its confirmation, and the result. */
export function FixButton({ action, onDone, children }: { action: Doable; onDone?: (what: string) => void; children?: ReactNode }) {
  const { operation, params, label } = fixCommand(action);
  const write = useWrite<unknown>(action.cabinetId, operation);
  const [asking, setAsking] = useState(false);
  const can = useCanFix(operation);
  const confirm = confirmFor(operation);
  const after = (r: { status: string; error?: { message: string } }) => { if (r.status === "succeeded") onDone?.(whatWasDone); };
  const whatWasDone = label.includes(action.cabinetName) ? label : `${label} on ${action.cabinetName}`;
  const what = <p><strong>{label.includes(action.cabinetName) ? label : <>{label} on {action.cabinetName}</>}</strong>. {operation === "network.renewLease" ? "No setting changes: the cabinet asks its DHCP server for a new lease." : operation.startsWith("network") ? "If the cabinet cannot reach the platform after the change, it goes back to its old settings by itself." : "The change is checked against the client's policy."}</p>;
  if (!can) return <span className="muted small">Needs Tier 2 to change this.</span>;
  return (
    <span className="fix-action">
      <button className="btn small primary" data-tour={`fix-${action.kind}`} onClick={() => setAsking(true)} disabled={write.state === "running"} aria-busy={write.state === "running"}>
        {write.state === "running" ? "Working…" : children ?? label}</button>
      {write.state === "done" && write.result?.status === "succeeded" && <span className="ok small" role="status"> Done. Run the diagnosis again to confirm.</span>}
      {write.state === "done" && write.result && write.result.status !== "succeeded" && <span className="error small" role="alert"> The cabinet could not make the change{write.result.error ? `: ${write.result.error.message}` : ""}.</span>}
      {write.state === "done" && write.problem && <span className="error small" role="alert"> {write.problem}</span>}
      {confirm === "click"
        ? <ConfirmDialog open={asking} onClose={() => setAsking(false)} description={what} onConfirm={async () => { await write.begin(params, undefined, after); }} />
        : <StepUpDialog open={asking} action={operation} target={action.cabinetId} params={params} onClose={() => setAsking(false)} description={what}
            onToken={async token => { await write.begin(params, token, after); }} />}
    </span>
  );
}

interface Preview { change: number; skip: number; cabinets: { id: string; name: string; skip: string | null; detail: string | null }[] }

/** The same change on several cabinets: preview what each gets, confirm with the password, then follow the job. */
export function FixAll({ operation, cabinetIds, children }: { operation: string; cabinetIds: string[]; children?: ReactNode }) {
  const { navigate } = useRouter();
  const [preview, setPreview] = useState<(Preview & { jobId: string }) | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const can = useCanFix(operation);
  const batchSize = 10;
  if (!can) return <span className="muted small">Needs Tier 2 to change this.</span>;
  const open = async () => {
    setProblem(null);
    try { setPreview({ ...(await api<Preview>("POST", "/api/fleet-operations/preview", { operation, cabinetIds })), jobId: crypto.randomUUID() }); }
    catch (e) { setProblem(describeError(e)); }
  };
  return (
    <span className="fix-action">
      <button className="btn small primary" onClick={() => void open()}>{children ?? `${JOB_LABEL[operation] ?? operation} on ${cabinetIds.length} cabinets`}</button>
      {problem && <span className="error small" role="alert"> {problem}</span>}
      {preview && (
        <PasswordDialog open onClose={() => setPreview(null)} action="fleet.job" target={preview.jobId} params={{ operation, cabinetIds, batchSize }}
          description={<>
            <p><strong>{JOB_LABEL[operation] ?? operation}</strong> on <strong>{preview.change}</strong> {preview.change === 1 ? "cabinet" : "cabinets"}{preview.skip > 0 ? ` (${preview.skip} skipped)` : ""}, {batchSize} at a time. Each one is read back to check the change.</p>
            <ul className="plain small">{preview.cabinets.map(c => <li key={c.id}><strong>{c.name}</strong>: {c.skip ?? c.detail ?? "will be changed"}</li>)}</ul>
          </>}
          onToken={async token => {
            const r = await api<{ jobId: string }>("POST", "/api/fleet-operations/jobs", { jobId: preview.jobId, operation, cabinetIds, batchSize, stepUpToken: token });
            navigate(`/fleet-operations/jobs/${r.jobId}`);
          }} />)}
    </span>
  );
}

/** The path from the link up to the firewall, one cell per layer, with words as well as colour. */
export function PathBar({ layers }: { layers: Record<Layer, LayerState> | null }) {
  const label: Record<LayerState, string> = { ok: "OK", warning: "Warning", problem: "Problem", unknown: "Not checked" };
  return (
    <ol className="path" aria-label="Network path, from the link to the firewall">
      {LAYERS.map(([k, name]) => {
        const s = layers?.[k] ?? "unknown";
        return <li key={k} className={`path-step ${s}`}><span className="path-name">{name}</span><span className="path-state">{label[s]}</span></li>;
      })}
    </ol>
  );
}
