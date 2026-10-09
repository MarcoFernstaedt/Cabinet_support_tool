// The firewall policy for a client or the fleet, and applying it to every cabinet of a site or client that differs
// (docs/spec/12-milestones-8-to-12.md, milestone 9). Admins edit a policy with an authenticator code; a bulk apply
// (Tier 1 and up) is confirmed with the password and shows each cabinet's answer as it arrives. The server checks
// every role, confirmation, pause and limit again.
import { useState } from "react";
import { api, describeError } from "../lib/api";
import { useCommands, type CommandResult } from "../lib/commands";
import { useLoad } from "../lib/useLoad";
import { Badge, PasswordDialog, StepUpDialog } from "./ui";

export type Switch = "on" | "off";
export type Policy = { domain: Switch; private: Switch; public: Switch };
const PROFILES = ["domain", "private", "public"] as const;
const NAME = { domain: "Domain", private: "Private", public: "Public" } as const;
export const describePolicy = (p: Policy) => PROFILES.map(k => `${NAME[k]} ${p[k]}`).join(", ");

/** One level's policy: a client's own (or none, so the fleet default applies), or the fleet default itself. */
export function PolicyEditor({ current, inherited, endpoint, action, target, what, editable, onSaved }: {
  current: Policy | null; inherited: Policy | null; endpoint: string; action: string; target: string; what: string; editable: boolean; onSaved: () => void;
}) {
  const [form, setForm] = useState<Policy>(current ?? inherited ?? { domain: "off", private: "off", public: "off" });
  const [pending, setPending] = useState<Policy | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <div className="stack">
      <p>{current ? <>Set here: <strong>{describePolicy(current)}</strong></> : inherited ? <>Nothing set here; the fleet default applies: <strong>{describePolicy(inherited)}</strong>.</> : null}</p>
      {editable && (
        <form className="row gap wrap" onSubmit={e => { e.preventDefault(); setProblem(null); setSaved(false); setPending(form); }}>
          {PROFILES.map(k => (
            <label key={k} className="field inline"><span>{NAME[k]}</span>
              <select value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value as Switch }))}>
                <option value="off">Off</option><option value="on">On</option></select></label>))}
          <button className="btn" type="submit">Save</button>
          {current && inherited && <button className="btn ghost" type="button" onClick={() => { setProblem(null); setSaved(false); setPending(null); }}>Use the fleet default</button>}
          {saved && <span className="ok" role="status">Saved. Cabinets are compared with it at once.</span>}
          {problem && <span className="error" role="alert">{problem}</span>}
        </form>)}
      <StepUpDialog open={pending !== undefined} action={action} target={target} onClose={() => setPending(undefined)}
        description={<p>{pending ? <>Set the firewall policy for {what} to <strong>{describePolicy(pending)}</strong>.</> : <>Remove {what}'s own policy, so the fleet default applies.</>}
          {" "}Cabinets that differ get a minor alert; nothing changes on a cabinet until someone applies the policy.</p>}
        onToken={async token => {
          try { await api("PUT", endpoint, { policy: pending ?? null, stepUpToken: token }); setSaved(true); onSaved(); }
          catch (e) { setProblem(describeError(e)); throw e; }
        }} />
    </div>
  );
}

interface Issued { bulkId: string; issuedAt: string; expiresAt: string; commands: { commandId: string; cabinetId: string; cabinet: string }[] }
type Row = { cabinet: string; state: "running" | CommandResult["status"]; problem?: string };

/** Apply the policy to every online, writable cabinet of a site or client that differs from it, confirmed with the password. */
export function BulkPolicyApply({ scope, id, name, allowed }: { scope: "site" | "client"; id: string; name: string; allowed: boolean }) {
  const preview = useLoad<{ cabinets: { id: string; name: string }[]; limit: number }>(allowed ? `/api/bulk/firewall-policy?scope=${scope}&id=${id}` : null);
  const { wait } = useCommands();
  const [confirming, setConfirming] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  if (!allowed || !preview.data) return null;
  const count = preview.data.cabinets.length;
  return (
    <section className="panel" aria-labelledby={`bulk-${id}`}>
      <h2 id={`bulk-${id}`}>Firewall policy across {name}</h2>
      {count === 0 && !rows && <p className="muted">Every online cabinet that accepts changes already matches its firewall policy.</p>}
      {count > 0 && !rows && (<>
        <p><strong>{count}</strong> online {count === 1 ? "cabinet differs" : "cabinets differ"} from the firewall policy: {preview.data.cabinets.slice(0, 8).map(c => c.name).join(", ")}{count > 8 ? ", …" : ""}.</p>
        {count > preview.data.limit
          ? <p className="error">A bulk change covers at most {preview.data.limit} cabinets. Apply it site by site.</p>
          : <button className="btn primary" onClick={() => setConfirming(true)}>Apply the policy to {count} {count === 1 ? "cabinet" : "cabinets"}…</button>}
      </>)}
      {rows && (<>
        <ul className="plain" aria-label="Bulk apply results">{rows.map((r, i) => (
          <li key={i}>{r.cabinet}: {r.state === "running" ? <Badge tone="info">Sent</Badge> : r.state === "succeeded" ? <Badge tone="ok">Applied</Badge>
            : <Badge tone="crit">{r.state}</Badge>}{r.problem && <span className="muted small"> {r.problem}</span>}</li>))}</ul>
        <button className="btn" onClick={() => { setRows(null); preview.reload(); }}>Done</button>
      </>)}
      <PasswordDialog open={confirming} action="bulk.firewall_policy" target={id} params={{ scope, id }} onClose={() => setConfirming(false)}
        description={<p>Apply the firewall policy to <strong>{count}</strong> {count === 1 ? "cabinet" : "cabinets"} at <strong>{name}</strong>. Each takes a snapshot first and undoes the change by itself if it loses the server.</p>}
        onToken={async token => {
          const issued = await api<Issued>("POST", "/api/bulk/firewall-policy", { scope, id, stepUpToken: token });
          setRows(issued.commands.map(c => ({ cabinet: c.cabinet, state: "running" })));
          issued.commands.forEach((c, i) => {
            void wait({ commandId: c.commandId, issuedAt: issued.issuedAt, expiresAt: issued.expiresAt }).then(
              r => setRows(rs => rs && rs.map((x, j) => j === i ? { ...x, state: r.status, ...(r.error ? { problem: r.error.message } : {}) } : x)),
              e => setRows(rs => rs && rs.map((x, j) => j === i ? { ...x, state: "failed", problem: describeError(e) } : x)));
          });
        }} />
    </section>
  );
}
